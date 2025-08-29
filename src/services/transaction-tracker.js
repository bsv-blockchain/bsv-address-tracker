import winston from 'winston';
import AddressBloomFilter from '../lib/bloom-filter.js';
import BSVUtils from '../lib/bitcoin-utils.js';

class TransactionTracker {
  constructor(mongodb, addressHistoryFetcher = null) {
    this.db = mongodb;
    this.addressHistoryFetcher = addressHistoryFetcher;
    this.bloomFilter = null;
    this.bsvUtils = new BSVUtils();
    this.isInitialized = false;

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    // Configuration
    this.config = {
      falsePositiveRate: parseFloat(process.env.BLOOM_FPR) || 0.001
    };
  }

  async initialize() {
    try {
      this.logger.info('Initializing transaction tracker');

      // Initialize scalable bloom filter
      this.bloomFilter = new AddressBloomFilter(
        this.config.falsePositiveRate
      );

      // Load addresses into bloom filter
      await this.loadAddressesIntoBloomFilter();

      this.isInitialized = true;
      this.logger.info('Transaction tracker initialized successfully', {
        addressCount: this.bloomFilter.addressCount,
        ...this.bloomFilter.getStats()
      });

    } catch (error) {
      this.logger.error('Failed to initialize transaction tracker', { error: error.message });
      throw error;
    }
  }

  async loadAddressesIntoBloomFilter() {
    this.logger.info('Loading addresses into bloom filter');

    const startTime = Date.now();
    let totalLoaded = 0;
    const batchSize = 10000;

    try {
      // Stream addresses from database in batches
      const cursor = this.db.trackedAddresses.find(
        { status: 'active' },
        { projection: { _id: 1 } }
      );

      let batch = [];

      for await (const doc of cursor) {
        batch.push(doc._id); // _id is the address

        if (batch.length >= batchSize) {
          this.bloomFilter.addAddresses(batch);
          totalLoaded += batch.length;
          batch = [];

          // Log progress every 100k addresses
          if (totalLoaded % 100000 === 0) {
            this.logger.debug('Loading progress', {
              addressesLoaded: totalLoaded,
              durationMs: Date.now() - startTime
            });
          }
        }
      }

      // Load remaining batch
      if (batch.length > 0) {
        this.bloomFilter.addAddresses(batch);
        totalLoaded += batch.length;
      }

      const duration = Date.now() - startTime;

      this.logger.info('Addresses loaded into bloom filter', {
        totalLoaded,
        durationMs: duration,
        addressesPerSecond: Math.round(totalLoaded / (duration / 1000))
      });

    } catch (error) {
      this.logger.error('Failed to load addresses into bloom filter', { error: error.message });
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
      // Parse the transaction
      const parsedTx = this.bsvUtils.parseTransaction(txHex);

      // Quick bloom filter pre-screening
      const candidateAddresses = this.bloomFilter.filterAddresses(parsedTx.addresses);

      if (candidateAddresses.length === 0) {
        // No possible matches, skip expensive database lookup
        return null;
      }

      // Verify which addresses we're actually tracking
      const trackedOutputs = await this.verifyTrackedAddresses(parsedTx, candidateAddresses);

      if (trackedOutputs.length === 0) {
        // False positive from bloom filter
        this.logger.debug('Bloom filter false positive', {
          txid: parsedTx.txid,
          candidateAddresses
        });
        return null;
      }

      // Record the transaction
      const transactionRecord = await this.recordTransaction(parsedTx, trackedOutputs);

      this.logger.info('Transaction tracked', {
        txid: parsedTx.txid,
        outputCount: trackedOutputs.length,
        totalAmount: trackedOutputs.reduce((sum, o) => sum + o.amount, 0),
        addresses: trackedOutputs.map(o => o.address)
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
   * @param {Object} parsedTx - Parsed transaction
   * @param {string[]} candidateAddresses - Addresses that passed bloom filter
   * @returns {Array} - Verified tracked outputs
   */
  async verifyTrackedAddresses(parsedTx, candidateAddresses) {
    try {
      // Look up which addresses are actually in our database
      const trackedAddresses = await this.db.trackedAddresses.find(
        {
          _id: { $in: candidateAddresses },
          status: 'active'
        },
        { projection: { _id: 1, user_id: 1, metadata: 1 } }
      ).toArray();

      const trackedMap = new Map(trackedAddresses.map(addr => [addr._id, addr]));
      const trackedOutputs = [];

      // Check each output for tracked addresses
      for (const output of parsedTx.outputs) {
        if (output.address && trackedMap.has(output.address)) {
          const addressInfo = trackedMap.get(output.address);

          trackedOutputs.push({
            address: output.address,
            amount: output.value,
            outputIndex: output.index,
            userId: addressInfo.user_id,
            scriptType: output.type
          });
        }
      }

      return trackedOutputs;

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
   * @param {Array} trackedOutputs - Verified tracked outputs
   * @returns {Object} - Recorded transaction info
   */
  async recordTransaction(parsedTx, trackedOutputs) {
    try {
      const now = new Date();

      // Prepare transaction record
      const transactionRecord = {
        _id: parsedTx.txid,
        addresses: trackedOutputs.map(o => o.address),
        amount: trackedOutputs.reduce((sum, o) => sum + o.amount, 0),
        block_height: null, // Will be set when confirmed
        block_hash: null,
        confirmations: 0,
        first_seen: now,
        confirmed_at: null,
        status: 'pending',
        outputs: trackedOutputs.map(o => ({
          address: o.address,
          amount: o.amount,
          output_index: o.outputIndex,
          user_id: o.userId
        })),
        raw_hex: parsedTx.hex,
        created_at: now
      };

      // Insert transaction record
      await this.db.activeTransactions.replaceOne(
        { _id: parsedTx.txid },
        transactionRecord,
        { upsert: true }
      );

      // Update address last activity
      await this.updateAddressActivity(trackedOutputs.map(o => o.address), now);

      return {
        txid: parsedTx.txid,
        outputs: trackedOutputs.length,
        totalAmount: transactionRecord.amount,
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
          $inc: { total_received: 0 } // Will be updated when confirmed
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
      this.bloomFilter.addAddresses(newAddresses);

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
        bloomFilterStats: this.bloomFilter.getStats()
      };

    } catch (error) {
      this.logger.error('Failed to add addresses', { error: error.message });
      throw error;
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
      bloomFilter: this.bloomFilter ? this.bloomFilter.getStats() : null,
      needsRebuild: this.bloomFilter ? this.bloomFilter.shouldRebuild() : false
    };
  }

  /**
   * Rebuild bloom filter if false positive rate is too high
   */
  async rebuildBloomFilter() {
    this.logger.info('Rebuilding bloom filter');

    try {
      const oldStats = this.bloomFilter.getStats();

      // Initialize new scalable bloom filter
      this.bloomFilter = new AddressBloomFilter(
        this.config.falsePositiveRate
      );

      // Reload addresses
      await this.loadAddressesIntoBloomFilter();

      const newStats = this.bloomFilter.getStats();

      this.logger.info('Bloom filter rebuilt', {
        old: oldStats,
        new: newStats
      });

    } catch (error) {
      this.logger.error('Failed to rebuild bloom filter', { error: error.message });
      throw error;
    }
  }
}

export default TransactionTracker;
