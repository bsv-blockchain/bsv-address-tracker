import winston from 'winston';
import PQueue from 'p-queue';

class ConfirmationTracker {
  constructor(mongodb, rpcClient) {
    this.db = mongodb;
    this.rpc = rpcClient;
    this.isProcessing = false;

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
      autoArchiveAfter: parseInt(process.env.AUTO_ARCHIVE_AFTER) || 144,
      batchSize: parseInt(process.env.CONFIRMATION_BATCH_SIZE) || 100,
      maxRetries: 3,
      rpcTimeout: 5000,
      rpcConcurrency: parseInt(process.env.RPC_CONCURRENCY) || 4, // Limit concurrent RPC requests
      retryDelayMs: 30000 // 30 seconds before retrying failed transactions
    };

    // Processing queues
    this.rpcQueue = new PQueue({
      concurrency: this.config.rpcConcurrency,
      interval: 200, // 200ms between batches to avoid overwhelming RPC
      intervalCap: this.config.rpcConcurrency
    });

    this.retryQueue = new Map(); // Map of txid -> retry info
    this.lastBlockProcessed = null;

    this.logger.info('Confirmation tracker initialized', {
      autoArchiveAfter: this.config.autoArchiveAfter,
      rpcConcurrency: this.config.rpcConcurrency
    });
  }


  /**
   * Process a new block and update confirmations intelligently
   * @param {Object} blockData - Block information
   */
  async processNewBlock(blockData) {
    if (this.isProcessing) {
      this.logger.debug('Already processing block confirmations, skipping', {
        hash: blockData.hash
      });
      return;
    }

    this.isProcessing = true;

    try {
      const startTime = Date.now();

      // Get current blockchain height
      const currentHeight = await this.rpc.getBlockCount();

      this.logger.info('Processing confirmations for new block', {
        hash: blockData.hash,
        currentHeight,
        queueSize: this.rpcQueue.size,
        retryQueueSize: this.retryQueue.size
      });

      // Process in parallel for efficiency
      const [transactionStats, archiveStats] = await Promise.all([
        this.processAllTransactions(),
        this.checkAndArchiveTransactions(currentHeight)
      ]);

      // Process retry queue
      await this.processRetryQueue();

      const duration = Date.now() - startTime;

      this.logger.info('Block confirmation processing completed', {
        currentHeight,
        ...transactionStats,
        ...archiveStats,
        queueSize: this.rpcQueue.size,
        retryQueueSize: this.retryQueue.size,
        durationMs: duration
      });

      this.lastBlockProcessed = currentHeight;

    } catch (error) {
      this.logger.error('Failed to process block confirmations', {
        hash: blockData.hash,
        error: error.message
      });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process all active transactions by verifying confirmations
   * @returns {Object} - Processing statistics
   */
  async processAllTransactions() {
    const enableVerboseLogging = process.env.CONFIRMATION_TRACKER_VERBOSE_LOGGING === 'true';

    try {
      // Get ALL active transactions for confirmation verification
      const allTxs = await this.db.activeTransactions.find({
        status: { $in: ['pending', 'confirming'] }
      }, {
        projection: { _id: 1, status: 1, confirmations: 1 }
      }).toArray();

      if (enableVerboseLogging) {
        this.logger.debug('Found transactions to process for confirmations', {
          totalFound: allTxs.length,
          transactions: allTxs.map(tx => ({
            txid: tx._id,
            status: tx.status,
            blockHeight: tx.block_height,
            confirmations: tx.confirmations || 0
          }))
        });
      }

      let verifiedCount = 0;
      let failedCount = 0;

      // Queue RPC verifications with rate limiting
      const verificationPromises = allTxs.map(tx =>
        this.rpcQueue.add(async () => {
          try {
            const verified = await this.verifyTransaction(tx._id);
            if (verified) {verifiedCount++;}
            return verified;
          } catch (error) {
            failedCount++;
            this.addToRetryQueue(tx._id, error.message);
            return false;
          }
        })
      );

      await Promise.allSettled(verificationPromises);

      return {
        transactionsChecked: allTxs.length,
        verifiedCount,
        failedCount
      };

    } catch (error) {
      this.logger.error('Failed to process transactions', { error: error.message });
      return { transactionsChecked: 0, verifiedCount: 0, failedCount: 0 };
    }
  }



  /**
   * Calculate confirmations based on block heights
   * @param {number} txBlockHeight - Transaction block height
   * @param {number} currentHeight - Current blockchain height
   * @returns {number} - Number of confirmations
   */
  calculateConfirmations(txBlockHeight, currentHeight) {
    if (!txBlockHeight || txBlockHeight > currentHeight) {
      return 0;
    }
    return currentHeight - txBlockHeight + 1;
  }




  /**
   * Check for transactions that need archival and move them
   * @param {number} currentHeight - Current block height
   * @returns {Object} - Archival statistics
   */
  async checkAndArchiveTransactions(currentHeight) {
    const enableVerboseLogging = process.env.CONFIRMATION_TRACKER_VERBOSE_LOGGING === 'true';

    try {
      let archivedCount = 0;
      const maxBlockHeightForArchival = currentHeight - this.config.autoArchiveAfter + 1;

      if (enableVerboseLogging) {
        this.logger.debug('Checking for transactions to archive', {
          currentHeight,
          autoArchiveAfter: this.config.autoArchiveAfter,
          maxBlockHeightForArchival
        });
      }

      // Find transactions ready for archival (>= 144 confirmations)
      // A transaction with block_height X has (currentHeight - X + 1) confirmations
      // We want confirmations >= 144, so: currentHeight - block_height + 1 >= 144
      // Therefore: block_height <= currentHeight - 144 + 1
      const transactionsToArchive = await this.db.activeTransactions.find({
        block_height: { $ne: null, $lte: maxBlockHeightForArchival },
        status: 'confirming'
      }).toArray();

      if (enableVerboseLogging) {
        this.logger.debug('Found transactions for potential archival', {
          count: transactionsToArchive.length,
          transactions: transactionsToArchive.map(tx => ({
            txid: tx._id,
            blockHeight: tx.block_height,
            confirmations: this.calculateConfirmations(tx.block_height, currentHeight)
          }))
        });
      }

      if (transactionsToArchive.length === 0) {
        return { archivedCount: 0 };
      }

      this.logger.info('Archiving fully confirmed transactions', {
        count: transactionsToArchive.length,
        minHeight: Math.min(...transactionsToArchive.map(tx => tx.block_height)),
        maxHeight: Math.max(...transactionsToArchive.map(tx => tx.block_height))
      });

      // Prepare archived documents
      const archivedDocs = transactionsToArchive.map(tx => ({
        _id: tx._id,
        addresses: tx.addresses,
        block_height: tx.block_height,
        block_hash: tx.block_hash,
        final_confirmations: this.calculateConfirmations(tx.block_height, currentHeight),
        first_seen: tx.first_seen,
        is_historical: tx.is_historical || false, // Default to false for ZMQ-detected transactions
        archived_at: new Date(),
        archive_height: currentHeight
      }));

      // Insert into archived collection
      await this.db.archivedTransactions.insertMany(archivedDocs, { ordered: false });

      // Remove from active collection
      const txids = transactionsToArchive.map(tx => tx._id);
      await this.db.activeTransactions.deleteMany({ _id: { $in: txids } });

      // Update address statistics
      await this.updateAddressStatistics(transactionsToArchive);

      archivedCount = transactionsToArchive.length;

      this.logger.info('Transactions archived successfully', {
        archivedCount,
        currentHeight
      });

      return { archivedCount };

    } catch (error) {
      this.logger.error('Failed to archive transactions', { error: error.message });
      throw error;
    }
  }

  /**
   * Update address statistics after archival
   * @param {Array} archivedTransactions - Transactions that were archived
   */
  async updateAddressStatistics(archivedTransactions) {
    try {
      const addressUpdates = new Map();

      // Calculate totals for each address
      for (const tx of archivedTransactions) {
        for (const address of tx.addresses || []) {
          const current = addressUpdates.get(address) || { count: 0 };
          addressUpdates.set(address, {
            count: current.count + 1
          });
        }
      }

      // Update address totals
      const bulkOps = Array.from(addressUpdates.entries()).map(([address, stats]) => ({
        updateOne: {
          filter: { _id: address },
          update: {
            $inc: {
              transaction_count: stats.count
            }
          }
        }
      }));

      if (bulkOps.length > 0) {
        await this.db.trackedAddresses.bulkWrite(bulkOps, { ordered: false });
      }

    } catch (error) {
      this.logger.error('Failed to update address statistics', { error: error.message });
    }
  }

  /**
   * Verify transaction and get confirmation details
   * @param {string} txid - Transaction ID
   * @returns {boolean} - Whether verification was successful
   */
  async verifyTransaction(txid) {
    const enableVerboseLogging = process.env.CONFIRMATION_TRACKER_VERBOSE_LOGGING === 'true';

    if (enableVerboseLogging) {
      this.logger.debug('Verifying transaction', { txid });
    }

    try {
      // Get transaction details with verbosity 1
      if (enableVerboseLogging) {
        this.logger.debug('Requesting transaction details', { txid });
      }
      const txData = await this.rpc.getRawTransaction(txid, 1);

      if (enableVerboseLogging) {
        this.logger.debug('Received transaction response', {
          txid,
          hasBlockhash: !!txData?.blockhash,
          confirmations: txData?.confirmations,
          blockheight: txData?.blockheight
        });
      }

      if (txData && txData.blockhash) {
        if (enableVerboseLogging) {
          this.logger.debug('Transaction confirmed', {
            txid,
            blockHash: txData.blockhash,
            blockHeight: txData.blockheight,
            confirmations: txData.confirmations,
            blocktime: txData.blocktime
          });
        }

        // Extract block info from transaction data
        const blockHash = txData.blockhash;
        const blockHeight = txData.blockheight;

        if (enableVerboseLogging) {
          this.logger.debug('Using block info from transaction', { blockHash, blockHeight });
        }

        // Always update all fields since reorgs can happen
        const updateFields = {
          block_hash: blockHash,
          block_height: blockHeight,
          confirmations: txData.confirmations || 0,
          block_time: txData.blocktime ? new Date(txData.blocktime * 1000) : null,
          hex: txData.hex,
          last_verified: new Date(),
          status: txData.confirmations > 0 ? 'confirming' : 'pending'
        };

        if (enableVerboseLogging) {
          this.logger.debug('Updating transaction with confirmation data', {
            txid,
            updateFields: {
              ...updateFields,
              hex: undefined // Don't log the full hex, too verbose
            }
          });
        }

        const result = await this.db.activeTransactions.updateOne(
          { _id: txid },
          { $set: updateFields }
        );

        if (result.matchedCount > 0) {
          if (enableVerboseLogging) {
            this.logger.debug('Database update successful', {
              txid,
              matchedCount: result.matchedCount,
              modifiedCount: result.modifiedCount
            });
          }
          this.logger.info('Transaction verified', {
            txid,
            blockHeight: blockHeight,
            blockHash: blockHash,
            confirmations: txData.confirmations
          });

          // Remove from retry queue if present
          this.retryQueue.delete(txid);


          return true;
        } else {
          if (enableVerboseLogging) {
            this.logger.debug('Database update failed - no matching transaction', {
              txid,
              matchedCount: result.matchedCount
            });
          }
          this.logger.warn('Transaction not found for update', { txid });
        }
      } else {
        if (enableVerboseLogging) {
          this.logger.debug('Transaction not confirmed yet', {
            txid,
            txData: txData ? {
              hasBlockhash: !!txData.blockhash,
              confirmations: txData.confirmations
            } : null
          });
        }
        this.logger.debug('Transaction not confirmed yet', { txid });
      }

      return false;

    } catch (error) {
      if (enableVerboseLogging) {
        this.logger.debug('Transaction verification error details', {
          txid,
          errorName: error.name,
          errorMessage: error.message,
          isTimeout: error.message.includes('timeout')
        });
      }

      // Don't log timeout errors as errors, they're expected
      if (error.message.includes('timeout')) {
        this.logger.debug('RPC timeout verifying transaction', { txid });
      } else {
        this.logger.debug('Transaction not yet confirmed or unavailable', {
          txid,
          error: error.message
        });
      }
      throw error;
    }
  }

  /**
   * Add transaction to retry queue
   * @param {string} txid - Transaction ID
   * @param {string} errorMessage - Error message
   */
  addToRetryQueue(txid, errorMessage) {
    const existing = this.retryQueue.get(txid);
    const retryCount = existing ? existing.retryCount + 1 : 1;

    if (retryCount <= this.config.maxRetries) {
      this.retryQueue.set(txid, {
        txid,
        retryCount,
        lastError: errorMessage,
        nextRetryAt: Date.now() + this.config.retryDelayMs,
        addedAt: existing ? existing.addedAt : Date.now()
      });

      this.logger.debug('Added transaction to retry queue', {
        txid,
        retryCount,
        maxRetries: this.config.maxRetries
      });
    } else {
      this.logger.warn('Transaction exceeded max retries', {
        txid,
        retryCount,
        maxRetries: this.config.maxRetries,
        lastError: errorMessage
      });
      this.retryQueue.delete(txid);
    }
  }

  /**
   * Process transactions in retry queue
   */
  async processRetryQueue() {
    if (this.retryQueue.size === 0) {return;}

    const now = Date.now();
    const readyToRetry = Array.from(this.retryQueue.values())
      .filter(item => item.nextRetryAt <= now)
      .slice(0, 10); // Limit retries per block

    if (readyToRetry.length === 0) {return;}

    this.logger.debug('Processing retry queue', {
      readyToRetry: readyToRetry.length,
      totalInQueue: this.retryQueue.size
    });

    for (const item of readyToRetry) {
      try {
        const verified = await this.verifyTransaction(item.txid);
        if (!verified) {
          this.addToRetryQueue(item.txid, 'Still not confirmed');
        }
      } catch (error) {
        this.addToRetryQueue(item.txid, error.message);
      }
    }
  }

  /**
   * Process a confirmed transaction (when included in a block)
   * @param {string} txid - Transaction ID
   * @param {number} blockHeight - Block height
   * @param {string} blockHash - Block hash
   */
  async processConfirmedTransaction(txid, blockHeight, blockHash) {
    try {
      const result = await this.db.activeTransactions.updateOne(
        { _id: txid },
        {
          $set: {
            block_height: blockHeight,
            block_hash: blockHash,
            confirmations: 1,
            status: 'confirming'
          }
        }
      );

      if (result.matchedCount > 0) {
        this.logger.info('Transaction confirmed in block', {
          txid,
          blockHeight,
          blockHash
        });

      }

    } catch (error) {
      this.logger.error('Failed to process confirmed transaction', {
        txid,
        blockHeight,
        error: error.message
      });
    }
  }

  /**
   * Get confirmation tracker statistics
   */
  async getStats() {
    try {
      const activeStats = await this.db.activeTransactions.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]).toArray();

      const archivedCount = await this.db.archivedTransactions.countDocuments();

      const confirmationBreakdown = await this.db.activeTransactions.aggregate([
        {
          $bucket: {
            groupBy: '$confirmations',
            boundaries: [0, 1, 6, 12, 24, 72, 144, 288, Infinity],
            default: 'other',
            output: {
              count: { $sum: 1 }
            }
          }
        }
      ]).toArray();

      return {
        isProcessing: this.isProcessing,
        config: this.config,
        activeTransactions: activeStats.reduce((acc, stat) => {
          acc[stat._id] = {
            count: stat.count,
            totalAmount: stat.totalAmount
          };
          return acc;
        }, {}),
        archivedTransactions: archivedCount,
        confirmationBreakdown,
        lastProcessed: new Date()
      };

    } catch (error) {
      this.logger.error('Failed to get confirmation tracker stats', { error: error.message });
      return { error: error.message };
    }
  }
}

export default ConfirmationTracker;
