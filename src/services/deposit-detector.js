const winston = require('winston');
const AddressBloomFilter = require('../lib/bloom-filter');
const BSVUtils = require('../lib/bitcoin-utils');

class DepositDetector {
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
      expectedAddresses: parseInt(process.env.EXPECTED_ADDRESSES) || 1000000,
      falsePositiveRate: parseFloat(process.env.BLOOM_FPR) || 0.001,
      minDepositAmount: parseInt(process.env.MIN_DEPOSIT_AMOUNT) || 1000, // satoshis
      rebuildThreshold: 0.01 // Rebuild if FPR exceeds 1%
    };
  }

  async initialize() {
    try {
      this.logger.info('Initializing deposit detector');

      // Initialize bloom filter with optimal parameters
      const params = AddressBloomFilter.getOptimalParameters(
        this.config.expectedAddresses,
        this.config.falsePositiveRate
      );

      this.bloomFilter = new AddressBloomFilter(
        params.expectedElements,
        params.falsePositiveRate
      );

      // Load addresses into bloom filter
      await this.loadAddressesIntoBloomFilter();

      this.isInitialized = true;
      this.logger.info('Deposit detector initialized successfully', {
        addressCount: this.bloomFilter.addressCount,
        ...this.bloomFilter.getStats()
      });

    } catch (error) {
      this.logger.error('Failed to initialize deposit detector', { error: error.message });
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
      const cursor = this.db.depositAddresses.find(
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
   * Process a raw transaction and detect deposits
   * @param {string} txHex - Raw transaction hex
   * @returns {Object|null} - Deposit information or null if no deposits
   */
  async processTransaction(txHex) {
    if (!this.isInitialized) {
      throw new Error('Deposit detector not initialized');
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

      // Verify actual deposits with database lookup
      const deposits = await this.verifyDeposits(parsedTx, candidateAddresses);

      if (deposits.length === 0) {
        // False positive from bloom filter
        this.logger.debug('Bloom filter false positive', {
          txid: parsedTx.txid,
          candidateAddresses
        });
        return null;
      }

      // Record the deposits
      const depositRecord = await this.recordDeposits(parsedTx, deposits);

      this.logger.info('Deposits detected', {
        txid: parsedTx.txid,
        depositCount: deposits.length,
        totalAmount: deposits.reduce((sum, d) => sum + d.amount, 0),
        addresses: deposits.map(d => d.address)
      });

      return depositRecord;

    } catch (error) {
      this.logger.error('Failed to process transaction for deposits', {
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
   * @returns {Array} - Verified deposit information
   */
  async verifyDeposits(parsedTx, candidateAddresses) {
    try {
      // Look up which addresses are actually in our database
      const trackedAddresses = await this.db.depositAddresses.find(
        {
          _id: { $in: candidateAddresses },
          status: 'active'
        },
        { projection: { _id: 1, user_id: 1, min_confirmations: 1 } }
      ).toArray();

      const trackedMap = new Map(trackedAddresses.map(addr => [addr._id, addr]));
      const deposits = [];

      // Check each output for deposits
      for (const output of parsedTx.outputs) {
        if (output.address && trackedMap.has(output.address)) {
          const addressInfo = trackedMap.get(output.address);

          // Apply minimum deposit amount filter
          if (output.value >= this.config.minDepositAmount) {
            deposits.push({
              address: output.address,
              amount: output.value,
              outputIndex: output.index,
              userId: addressInfo.user_id,
              minConfirmations: addressInfo.min_confirmations || 6,
              scriptType: output.type
            });
          } else {
            this.logger.debug('Deposit below minimum threshold', {
              txid: parsedTx.txid,
              address: output.address,
              amount: output.value,
              minimum: this.config.minDepositAmount
            });
          }
        }
      }

      return deposits;

    } catch (error) {
      this.logger.error('Failed to verify deposits', {
        error: error.message,
        txid: parsedTx.txid,
        candidateAddresses
      });
      return [];
    }
  }

  /**
   * Record deposits to the database
   * @param {Object} parsedTx - Parsed transaction
   * @param {Array} deposits - Verified deposits
   * @returns {Object} - Recorded transaction info
   */
  async recordDeposits(parsedTx, deposits) {
    try {
      const now = new Date();

      // Prepare transaction record
      const transactionRecord = {
        _id: parsedTx.txid,
        addresses: deposits.map(d => d.address),
        amount: deposits.reduce((sum, d) => sum + d.amount, 0),
        block_height: null, // Will be set when confirmed
        block_hash: null,
        confirmations: 0,
        first_seen: now,
        confirmed_at: null,
        status: 'pending',
        deposits: deposits.map(d => ({
          address: d.address,
          amount: d.amount,
          output_index: d.outputIndex,
          user_id: d.userId,
          min_confirmations: d.minConfirmations
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
      await this.updateAddressActivity(deposits.map(d => d.address), now);

      return {
        txid: parsedTx.txid,
        deposits: deposits.length,
        totalAmount: transactionRecord.amount,
        addresses: transactionRecord.addresses,
        status: 'recorded'
      };

    } catch (error) {
      this.logger.error('Failed to record deposits', {
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
      await this.db.depositAddresses.updateMany(
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
      const result = await this.db.depositAddresses.insertMany(
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
   * Get deposit detector statistics
   */
  async getStats() {
    const dbStats = await this.db.depositAddresses.aggregate([
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

      // Initialize new bloom filter
      const params = AddressBloomFilter.getOptimalParameters(
        this.config.expectedAddresses,
        this.config.falsePositiveRate
      );

      this.bloomFilter = new AddressBloomFilter(
        params.expectedElements,
        params.falsePositiveRate
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

module.exports = DepositDetector;
