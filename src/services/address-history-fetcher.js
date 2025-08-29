import winston from 'winston';
import PQueue from 'p-queue';
import WhatsOnChainClient from './whatsonchain-client.js';

class AddressHistoryFetcher {
  constructor(mongodb, rpcClient) {
    this.db = mongodb;
    this.rpc = rpcClient;
    this.wocClient = new WhatsOnChainClient();

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
      batchSize: 20, // No longer used for bulk - kept for compatibility
      maxHistoryPerAddress: parseInt(process.env.MAX_HISTORY_PER_ADDRESS) || 500, // Up to 500 transactions (5 pages)
      autoArchiveAfter: parseInt(process.env.AUTO_ARCHIVE_AFTER) || 288,
      processingConcurrency: 1, // Process one address at a time due to rate limits
      retryAttempts: 3,
      retryDelay: 5000 // 5 seconds
    };

    // Processing queue
    this.processingQueue = new PQueue({
      concurrency: this.config.processingConcurrency
    });

    this.isProcessing = false;
    this.stats = {
      totalProcessed: 0,
      totalTransactionsFound: 0,
      totalArchivedImmediately: 0,
      totalErrors: 0,
      lastProcessedAt: null
    };
  }

  /**
   * Fetch and process historical transactions for newly added addresses
   * @param {string[]} addresses - Array of addresses to process
   * @returns {Object} - Processing results
   */
  async fetchAddressHistories(addresses) {
    if (!addresses || addresses.length === 0) {
      return { processed: 0, found: 0, archived: 0 };
    }

    this.logger.info('Starting address history fetch', {
      addressCount: addresses.length,
      batchSize: this.config.batchSize,
      maxHistoryPerAddress: this.config.maxHistoryPerAddress,
      addresses: addresses
    });

    try {
      this.isProcessing = true;
      const startTime = Date.now();

      const results = await this.wocClient.processBulkAddresses(
        addresses,
        (historyData, batchAddresses) => this.processBatchHistory(historyData, batchAddresses),
        this.config.maxHistoryPerAddress
      );

      const summary = this.summarizeResults(results);
      const duration = Date.now() - startTime;

      this.updateStats(summary, duration);

      this.logger.info('Address history fetch completed', {
        ...summary,
        durationMs: duration,
        averagePerAddress: Math.round(duration / addresses.length)
      });

      return summary;

    } catch (error) {
      this.logger.error('Address history fetch failed', {
        addresses: addresses.length,
        error: error.message
      });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a batch of address history data
   * @param {Object} historyData - History data from WhatsOnChain
   * @param {string[]} batchAddresses - Addresses in this batch
   * @returns {Object} - Batch processing results
   */
  async processBatchHistory(historyData, batchAddresses) {
    const batchResults = {
      processed: 0,
      found: 0,
      archived: 0,
      errors: 0
    };

    // Get current blockchain height from RPC
    let currentHeight;
    try {
      currentHeight = await this.rpc.getBlockCount();
    } catch (error) {
      this.logger.error('Failed to get current block height', { error: error.message });
      currentHeight = 0; // Fallback, transactions will be processed as unconfirmed
    }

    for (const address of batchAddresses) {
      try {
        const transactions = historyData[address] || [];

        if (transactions.length === 0) {
          this.logger.debug('No history found for address', { address });
          batchResults.processed++;
          // Still mark as fetched even if no history
          await this.markAddressAsFetched(address);
          continue;
        }

        this.logger.debug('Processing address history', {
          address,
          transactionCount: transactions.length
        });

        const processedTxs = await this.processAddressTransactions(address, transactions, currentHeight);

        batchResults.processed++;
        batchResults.found += processedTxs.found;
        batchResults.archived += processedTxs.archived;

        // Mark address as historically fetched
        await this.markAddressAsFetched(address);

      } catch (error) {
        this.logger.error('Failed to process address history', {
          address,
          error: error.message
        });
        batchResults.errors++;
      }
    }

    return batchResults;
  }

  /**
   * Process transactions for a specific address
   * @param {string} address - BSV address
   * @param {Array} transactions - Transaction history from WhatsOnChain
   * @param {number} currentHeight - Current blockchain height
   * @returns {Object} - Processing results for this address
   */
  async processAddressTransactions(address, transactions, currentHeight) {
    const results = { found: 0, archived: 0 };
    const transactionsToInsert = [];
    const transactionsToArchive = [];

    for (const tx of transactions) {
      try {
        // Skip if we already have this transaction
        const existingTx = await this.db.activeTransactions.findOne({ _id: tx.tx_hash }) ||
                          await this.db.archivedTransactions.findOne({ _id: tx.tx_hash });

        if (existingTx) {
          this.logger.debug('Transaction already exists, skipping', {
            txid: tx.tx_hash
          });
          continue;
        }

        // Calculate confirmations
        const confirmations = currentHeight ? (currentHeight - tx.height + 1) : 0;

        // Get detailed transaction data
        const txDetails = await this.getTransactionDetails(tx.tx_hash, address, tx);

        if (!txDetails) {
          continue;
        }

        results.found++;

        // Decide whether to archive immediately or keep as active
        if (confirmations >= this.config.autoArchiveAfter) {
          // Archive immediately
          transactionsToArchive.push({
            ...txDetails,
            final_confirmations: confirmations,
            archived_at: new Date(),
            archive_height: currentHeight
          });
          results.archived++;

        } else {
          // Keep as active transaction
          transactionsToInsert.push({
            ...txDetails,
            confirmations,
            status: confirmations > 0 ? 'confirming' : 'pending'
          });
        }

      } catch (error) {
        this.logger.error('Failed to process transaction', {
          txid: tx.tx_hash,
          address,
          error: error.message
        });
      }
    }

    // Bulk insert transactions
    if (transactionsToInsert.length > 0) {
      await this.db.activeTransactions.insertMany(transactionsToInsert, { ordered: false });
      this.logger.debug('Inserted active transactions', {
        address,
        count: transactionsToInsert.length
      });
    }

    if (transactionsToArchive.length > 0) {
      await this.db.archivedTransactions.insertMany(transactionsToArchive, { ordered: false });
      this.logger.debug('Archived transactions immediately', {
        address,
        count: transactionsToArchive.length
      });
    }

    // Update address statistics
    await this.updateAddressStats(address, transactions, results);

    return results;
  }

  /**
   * Get basic transaction information for tracking
   * @param {string} txid - Transaction ID
   * @param {string} address - Address being processed
   * @param {Object} basicTx - Basic transaction info from history
   * @returns {Object|null} - Basic transaction data for tracking
   */
  async getTransactionDetails(txid, address, basicTx) {
    try {
      // Check if address exists in our tracked addresses
      const addressInfo = await this.db.trackedAddresses.findOne({ _id: address });
      if (!addressInfo) {
        this.logger.warn('Address not found in database', { address });
        return null;
      }

      const now = new Date();

      // Only store essential tracking data - no amounts or raw transaction data
      return {
        _id: txid,
        addresses: [address],
        block_height: basicTx.height || null,
        block_hash: null, // Will be filled by confirmation tracker if needed
        first_seen: now, // Historical, so first_seen = now
        created_at: now,
        is_historical: true
      };

    } catch (error) {
      this.logger.error('Failed to get transaction details', {
        txid,
        address,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Update address statistics after processing
   * @param {string} address - BSV address
   * @param {Array} allTransactions - All transactions found
   * @param {Object} processResults - Processing results
   */
  async updateAddressStats(address, allTransactions, processResults) {
    try {
      await this.db.trackedAddresses.updateOne(
        { _id: address },
        {
          $set: {
            last_activity: new Date(),
            history_fetched_at: new Date()
          },
          $inc: {
            transaction_count: processResults.found
          }
        }
      );

    } catch (error) {
      this.logger.error('Failed to update address stats', {
        address,
        error: error.message
      });
    }
  }

  /**
   * Queue addresses for background history processing
   * @param {string[]} addresses - Addresses to queue
   * @returns {Promise} - Queue promise
   */
  queueAddressHistoryFetch(addresses) {
    if (!addresses || addresses.length === 0) {
      return Promise.resolve();
    }

    return this.processingQueue.add(async () => {
      try {
        await this.fetchAddressHistories(addresses);
      } catch (error) {
        this.logger.error('Queued address history fetch failed', {
          addresses: addresses.length,
          error: error.message
        });
        this.stats.totalErrors++;
      }
    });
  }

  /**
   * Process addresses immediately (synchronous)
   * @param {string[]} addresses - Addresses to process
   * @returns {Object} - Processing results
   */
  processAddressesImmediately(addresses) {
    return this.fetchAddressHistories(addresses);
  }

  /**
   * Summarize batch processing results
   * @param {Array} results - Array of batch results
   * @returns {Object} - Summary statistics
   */
  summarizeResults(results) {
    return results.reduce((summary, result) => ({
      processed: summary.processed + (result.processed || 0),
      found: summary.found + (result.found || 0),
      archived: summary.archived + (result.archived || 0),
      errors: summary.errors + (result.errors || 0)
    }), { processed: 0, found: 0, archived: 0, errors: 0 });
  }

  /**
   * Update internal statistics
   * @param {Object} summary - Processing summary
   * @param {number} duration - Processing duration in ms
   */
  updateStats(summary, duration) {
    this.stats.totalProcessed += summary.processed;
    this.stats.totalTransactionsFound += summary.found;
    this.stats.totalArchivedImmediately += summary.archived;
    this.stats.totalErrors += summary.errors;
    this.stats.lastProcessedAt = new Date();
    this.stats.lastDuration = duration;
  }

  /**
   * Get service statistics
   * @returns {Object} - Service statistics
   */
  getStats() {
    return {
      isProcessing: this.isProcessing,
      config: this.config,
      stats: this.stats,
      queue: {
        size: this.processingQueue.size,
        pending: this.processingQueue.pending
      },
      whatsOnChain: this.wocClient.getStats()
    };
  }

  /**
   * Test service connectivity
   * @returns {boolean} - Service health status
   */
  ping() {
    // Always return true since we removed WhatsOnChain ping
    // The service is healthy if it's instantiated
    return true;
  }

  /**
   * Mark an address as having completed historical fetch
   * @param {string} address - Address to mark as fetched
   */
  async markAddressAsFetched(address) {
    try {
      await this.db.trackedAddresses.updateOne(
        { _id: address },
        {
          $set: {
            historical_fetched: true,
            historical_fetched_at: new Date()
          }
        }
      );
    } catch (error) {
      this.logger.error('Failed to mark address as fetched', {
        address,
        error: error.message
      });
    }
  }

  /**
   * Get addresses that haven't had their historical data fetched
   * @returns {string[]} - Array of addresses needing historical fetch
   */
  async getUnfetchedAddresses() {
    try {
      const unfetchedAddresses = await this.db.trackedAddresses.find({
        active: true,
        $or: [
          { historical_fetched: { $ne: true } },
          { historical_fetched: { $exists: false } }
        ]
      }, { projection: { _id: 1 } }).toArray();

      return unfetchedAddresses.map(doc => doc._id);
    } catch (error) {
      this.logger.error('Failed to get unfetched addresses', { error: error.message });
      return [];
    }
  }

  /**
   * Fetch historical data for any addresses that haven't been processed yet
   * Called at startup to resume incomplete historical fetches
   */
  async fetchUnfetchedHistories() {
    try {
      const unfetchedAddresses = await this.getUnfetchedAddresses();

      if (unfetchedAddresses.length === 0) {
        this.logger.debug('All addresses have historical data fetched');
        return { processed: 0, found: 0, archived: 0 };
      }

      this.logger.info('Fetching historical data for unfetched addresses', {
        count: unfetchedAddresses.length,
        addresses: unfetchedAddresses
      });

      return await this.fetchAddressHistories(unfetchedAddresses);
    } catch (error) {
      this.logger.error('Failed to fetch unfetched histories', { error: error.message });
      return { processed: 0, found: 0, archived: 0 };
    }
  }
}

export default AddressHistoryFetcher;
