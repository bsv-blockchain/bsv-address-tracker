const winston = require('winston');
const PQueue = require('p-queue').default;
const WhatsOnChainClient = require('./whatsonchain-client');
const BSVUtils = require('../lib/bitcoin-utils');

class AddressHistoryFetcher {
  constructor(mongodb, blockTracker) {
    this.db = mongodb;
    this.blockTracker = blockTracker;
    this.wocClient = new WhatsOnChainClient();
    this.bsvUtils = new BSVUtils();

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
      batchSize: 20, // WhatsOnChain bulk limit
      maxHistoryPerAddress: parseInt(process.env.MAX_HISTORY_PER_ADDRESS) || 10000,
      autoArchiveAfter: parseInt(process.env.AUTO_ARCHIVE_AFTER) || 288,
      processingConcurrency: 1, // Process one batch at a time due to rate limits
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
      batchSize: this.config.batchSize
    });

    try {
      this.isProcessing = true;
      const startTime = Date.now();

      const results = await this.wocClient.processBulkAddresses(
        addresses,
        (historyData, batchAddresses) => this.processBatchHistory(historyData, batchAddresses)
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

    const currentHeight = this.blockTracker.lastProcessedHeight;

    for (const address of batchAddresses) {
      try {
        const transactions = historyData[address] || [];

        if (transactions.length === 0) {
          this.logger.debug('No history found for address', { address });
          batchResults.processed++;
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
   * Get detailed transaction information
   * @param {string} txid - Transaction ID
   * @param {string} address - Address being processed
   * @param {Object} basicTx - Basic transaction info from history
   * @returns {Object|null} - Detailed transaction data
   */
  async getTransactionDetails(txid, address, basicTx) {
    try {
      // Try to get raw transaction hex for full parsing
      let txHex = null;
      let parsedTx = null;

      try {
        txHex = await this.wocClient.getRawTransaction(txid);
        if (txHex) {
          parsedTx = this.bsvUtils.parseTransaction(txHex);
        }
      } catch (error) {
        this.logger.debug('Failed to get raw transaction, using basic data', {
          txid,
          error: error.message
        });
      }

      // Calculate deposit amount for this address
      let depositAmount = 0;
      let outputIndex = -1;

      if (parsedTx) {
        // Use parsed transaction data
        for (let i = 0; i < parsedTx.outputs.length; i++) {
          const output = parsedTx.outputs[i];
          if (output.address === address) {
            depositAmount += output.value;
            if (outputIndex === -1) {
              outputIndex = i;
            }
          }
        }
      } else {
        // Fall back to basic transaction data
        depositAmount = basicTx.value || 0;
      }

      if (depositAmount === 0) {
        this.logger.debug('No deposit found for address in transaction', {
          txid,
          address
        });
        return null;
      }

      // Get address info for user mapping
      const addressInfo = await this.db.depositAddresses.findOne({ _id: address });
      if (!addressInfo) {
        this.logger.warn('Address not found in database', { address });
        return null;
      }

      const now = new Date();
      const confirmedAt = basicTx.height ? new Date(basicTx.time * 1000) : null;

      return {
        _id: txid,
        addresses: [address],
        amount: depositAmount,
        block_height: basicTx.height || null,
        block_hash: null, // Will be filled by block tracker if needed
        first_seen: now, // Historical, so first_seen = now
        confirmed_at: confirmedAt,
        deposits: [{
          address: address,
          amount: depositAmount,
          output_index: outputIndex,
          user_id: addressInfo.user_id,
          min_confirmations: addressInfo.metadata?.min_confirmations || 6
        }],
        raw_hex: txHex,
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
      const totalReceived = allTransactions.reduce((sum, tx) => sum + (tx.value || 0), 0);

      await this.db.depositAddresses.updateOne(
        { _id: address },
        {
          $set: {
            last_activity: new Date(),
            history_fetched_at: new Date()
          },
          $inc: {
            total_received: totalReceived,
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
        pending: this.processingQueue.pending,
        isPaused: this.processingQueue.isPaused
      },
      whatsOnChain: this.wocClient.getStats()
    };
  }

  /**
   * Clear processing queue
   */
  clearQueue() {
    this.processingQueue.clear();
    this.logger.info('Address history processing queue cleared');
  }

  /**
   * Pause processing queue
   */
  pauseQueue() {
    this.processingQueue.pause();
    this.wocClient.pause();
    this.logger.info('Address history processing paused');
  }

  /**
   * Resume processing queue
   */
  resumeQueue() {
    this.processingQueue.start();
    this.wocClient.resume();
    this.logger.info('Address history processing resumed');
  }

  /**
   * Test service connectivity
   * @returns {boolean} - Service health status
   */
  async ping() {
    try {
      return await this.wocClient.ping();
    } catch (error) {
      return false;
    }
  }
}

module.exports = AddressHistoryFetcher;
