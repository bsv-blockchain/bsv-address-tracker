import winston from 'winston';
import AddressFilter from '../lib/address-filter.js';
import AddressExtractor from '../lib/address-extractor.js';

class TransactionTracker {
  constructor(mongodb, addressHistoryFetcher = null, webhookProcessor = null) {
    this.db = mongodb;
    this.addressHistoryFetcher = addressHistoryFetcher;
    this.webhookProcessor = webhookProcessor;
    this.addressFilter = null;
    this.addressExtractor = new AddressExtractor();
    this.isInitialized = false;

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    // No configuration needed for Set-based filter
  }

  async initialize() {
    try {
      this.logger.info('Initializing transaction tracker');

      // Initialize address filter
      this.addressFilter = new AddressFilter();

      // Load addresses into filter from MongoDB
      await this.addressFilter.loadAddressesFromMongo(this.db.db);

      this.isInitialized = true;
      this.logger.info('Transaction tracker initialized successfully', {
        ...this.addressFilter.getStats()
      });

    } catch (error) {
      this.logger.error('Failed to initialize transaction tracker', { error: error.message });
      throw error;
    }
  }


  /**
   * Process a raw transaction and check if we're tracking any addresses in it
   * @param {string} txHex - Raw transaction hex
   * @returns {Object|null} - Transaction information or null if not tracking any addresses
   */
  async processTransaction(txHex) {
    if (!this.isInitialized) {
      throw new Error('Transaction tracker not initialized');
    }

    try {
      // Extract addresses using BSV SDK
      const network = process.env.BSV_NETWORK || 'testnet';
      const parsedTx = this.addressExtractor.extractAddressesFromTx(txHex, network);

      // Quick bloom filter pre-screening
      const candidateAddresses = this.addressFilter.filterAddresses(parsedTx.allAddresses);

      if (candidateAddresses.length === 0) {
        // No possible matches, skip expensive database lookup
        return null;
      }

      // Verify which addresses we're actually tracking
      const trackedAddressData = await this.verifyTrackedAddresses(parsedTx, candidateAddresses);

      if (trackedAddressData.length === 0) {
        // False positive from bloom filter
        this.logger.debug('Bloom filter false positive', {
          txid: parsedTx.txid,
          candidateAddresses
        });
        return null;
      }

      // Record the transaction
      const transactionRecord = await this.recordTransaction(parsedTx, trackedAddressData);

      this.logger.info('Transaction tracked', {
        txid: parsedTx.txid,
        addressCount: trackedAddressData.length,
        addresses: trackedAddressData.map(a => a.address)
      });

      return transactionRecord;

    } catch (error) {
      this.logger.error('Failed to process transaction', {
        error: error.message,
        txHex: txHex.substring(0, 100) + '...'
      });
      return null;
    }
  }

  /**
   * Verify which candidate addresses are actually being tracked
   * @param {Object} parsedTx - Parsed transaction with address lists
   * @param {string[]} candidateAddresses - Addresses that passed bloom filter
   * @returns {Array} - Verified tracked addresses
   */
  async verifyTrackedAddresses(parsedTx, candidateAddresses) {
    try {
      // Look up which addresses are actually in our database
      const trackedAddresses = await this.db.trackedAddresses.find(
        {
          _id: { $in: candidateAddresses },
          active: true
        },
        { projection: { _id: 1, label: 1, metadata: 1 } }
      ).toArray();

      const trackedMap = new Map(trackedAddresses.map(addr => [addr._id, addr]));
      const trackedAddressData = [];

      // Check all addresses found in the transaction
      for (const address of parsedTx.allAddresses) {
        if (trackedMap.has(address)) {
          const addressInfo = trackedMap.get(address);

          trackedAddressData.push({
            address: address,
            label: addressInfo.label,
            isInput: parsedTx.inputAddresses.includes(address),
            isOutput: parsedTx.outputAddresses.includes(address)
          });
        }
      }

      return trackedAddressData;

    } catch (error) {
      this.logger.error('Failed to verify tracked addresses', {
        error: error.message,
        txid: parsedTx.txid,
        candidateAddresses
      });
      return [];
    }
  }

  /**
   * Record transaction to the database
   * @param {Object} parsedTx - Parsed transaction
   * @param {Array} trackedAddressData - Tracked address data
   * @returns {Object} - Recorded transaction info
   */
  async recordTransaction(parsedTx, trackedAddressData) {
    try {
      const now = new Date();

      // Prepare transaction record - just link transaction to addresses
      const transactionRecord = {
        _id: parsedTx.txid,
        addresses: trackedAddressData.map(a => a.address),
        block_height: null, // Will be set when confirmed
        block_hash: null,
        confirmations: 0,
        first_seen: now,
        status: 'pending'
      };

      // Insert transaction record
      await this.db.activeTransactions.replaceOne(
        { _id: parsedTx.txid },
        transactionRecord,
        { upsert: true }
      );

      // Update address last activity
      await this.updateAddressActivity(trackedAddressData.map(a => a.address), now);

      // Trigger webhook for new transaction
      if (this.webhookProcessor) {
        await this.triggerTransactionWebhook(parsedTx.txid, {
          status: 'new',
          first_seen: now
        });
      }

      return {
        txid: parsedTx.txid,
        addressCount: trackedAddressData.length,
        addresses: transactionRecord.addresses,
        status: 'recorded'
      };

    } catch (error) {
      this.logger.error('Failed to record transaction', {
        error: error.message,
        txid: parsedTx.txid
      });
      throw error;
    }
  }

  /**
   * Update last activity timestamp for addresses
   * @param {string[]} addresses - Addresses to update
   * @param {Date} timestamp - Activity timestamp
   */
  async updateAddressActivity(addresses, timestamp) {
    try {
      await this.db.trackedAddresses.updateMany(
        { _id: { $in: addresses } },
        {
          $set: { last_activity: timestamp },
          $inc: {
            transaction_count: 1, // Increment transaction count for each transaction
            total_received: 0 // Will be updated when confirmed
          }
        }
      );
    } catch (error) {
      this.logger.error('Failed to update address activity', {
        error: error.message,
        addresses
      });
    }
  }

  /**
   * Add new addresses to the tracking system
   * @param {Array} addressData - Array of address objects
   * @returns {Object} - Import results
   */
  async addAddresses(addressData) {
    try {
      const startTime = Date.now();
      const now = new Date();

      // Prepare addresses for insertion
      const addressDocs = addressData.map(addr => ({
        _id: addr.address,
        user_id: addr.user_id,
        created_at: now,
        last_activity: null,
        total_received: 0,
        status: 'active',
        metadata: addr.metadata || {}
      }));

      // Insert addresses
      const result = await this.db.trackedAddresses.insertMany(
        addressDocs,
        { ordered: false } // Continue on duplicates
      );

      // Add to bloom filter
      const newAddresses = addressDocs.map(doc => doc._id);
      this.addressFilter.addAddresses(newAddresses);

      // Queue address history fetching for newly inserted addresses
      const insertedAddresses = result.insertedCount > 0 ?
        addressDocs.slice(0, result.insertedCount).map(doc => doc._id) : [];

      let historyFetchPromise = null;
      if (insertedAddresses.length > 0 && this.addressHistoryFetcher) {
        this.logger.info('Queuing address history fetch for new addresses', {
          count: insertedAddresses.length
        });

        // Queue history fetching in background
        historyFetchPromise = this.addressHistoryFetcher.queueAddressHistoryFetch(insertedAddresses);
      }

      const duration = Date.now() - startTime;

      this.logger.info('Addresses added to tracking system', {
        requested: addressData.length,
        inserted: result.insertedCount,
        duplicates: addressData.length - result.insertedCount,
        historyQueuedFor: insertedAddresses.length,
        durationMs: duration
      });

      return {
        total: addressData.length,
        inserted: result.insertedCount,
        duplicates: addressData.length - result.insertedCount,
        historyQueuedFor: insertedAddresses.length,
        historyFetchPromise,
        filterStats: this.addressFilter.getStats()
      };

    } catch (error) {
      this.logger.error('Failed to add addresses', { error: error.message });
      throw error;
    }
  }

  /**
   * Trigger webhook for transaction changes
   * @param {string} txid - Transaction ID
   * @param {Object} changes - What changed in the transaction
   */
  async triggerTransactionWebhook(txid, changes) {
    if (!this.webhookProcessor) {
      return;
    }

    try {
      // Get the transaction record
      const transaction = await this.db.activeTransactions.findOne({ _id: txid });

      if (!transaction || !transaction.addresses || transaction.addresses.length === 0) {
        return;
      }

      // Find webhooks for these addresses (including wildcard webhooks)
      const webhooks = await this.db.webhooks.find({
        $and: [
          { active: true },
          {
            $or: [
              { monitor_all: true }, // Wildcard webhooks
              { addresses: { $in: transaction.addresses } } // Specific address webhooks
            ]
          }
        ]
      }).toArray();

      if (webhooks.length === 0) {
        return;
      }

      this.logger.info('Triggering webhooks for new transaction', {
        txid,
        webhookCount: webhooks.length,
        addresses: transaction.addresses
      });

      // Queue webhooks
      for (const webhook of webhooks) {
        // For wildcard webhooks, include all addresses. For specific webhooks, filter to monitored ones
        const relevantAddresses = webhook.monitor_all
          ? transaction.addresses
          : transaction.addresses.filter(addr => webhook.addresses.includes(addr));

        await this.webhookProcessor.queueWebhook({
          webhookId: webhook._id,
          url: webhook.url,
          payload: {
            timestamp: new Date(),
            transaction: {
              _id: transaction._id,
              addresses: relevantAddresses,
              confirmations: transaction.confirmations,
              status: transaction.status,
              block_height: transaction.block_height,
              block_hash: transaction.block_hash,
              first_seen: transaction.first_seen
            },
            changes: changes
          }
        });
      }
    } catch (error) {
      this.logger.error('Failed to trigger webhook', {
        txid,
        error: error.message
      });
    }
  }

  /**
   * Get transaction tracker statistics
   */
  async getStats() {
    const dbStats = await this.db.trackedAddresses.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    const activeTransactionCount = await this.db.activeTransactions.countDocuments();

    return {
      isInitialized: this.isInitialized,
      config: this.config,
      addresses: dbStats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {}),
      activeTransactions: activeTransactionCount,
      filter: this.addressFilter ? this.addressFilter.getStats() : null
    };
  }

}

export default TransactionTracker;
