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
      merkleProofConcurrency: parseInt(process.env.MERKLE_PROOF_CONCURRENCY) || 4, // Limit concurrent merkle proof requests
      pendingTxLimit: 50, // Max pending transactions to verify per block
      retryDelayMs: 30000 // 30 seconds before retrying failed transactions
    };

    // Processing queues
    this.merkleProofQueue = new PQueue({
      concurrency: this.config.merkleProofConcurrency,
      interval: 200, // 200ms between batches to avoid overwhelming RPC
      intervalCap: this.config.merkleProofConcurrency
    });

    this.retryQueue = new Map(); // Map of txid -> retry info
    this.lastBlockProcessed = null;

    this.logger.info('Confirmation tracker initialized', {
      autoArchiveAfter: this.config.autoArchiveAfter,
      merkleProofConcurrency: this.config.merkleProofConcurrency,
      pendingTxLimit: this.config.pendingTxLimit
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
        queueSize: this.merkleProofQueue.size,
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
        queueSize: this.merkleProofQueue.size,
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
   * Process all active transactions by verifying with merkle proofs
   * @returns {Object} - Processing statistics
   */
  async processAllTransactions() {
    const enableVerboseLogging = process.env.CONFIRMATION_TRACKER_VERBOSE_LOGGING === 'true';

    try {
      // Get ALL active transactions for merkle proof verification
      const allTxs = await this.db.activeTransactions.find({
        status: { $in: ['pending', 'confirming'] }
      }).limit(this.config.pendingTxLimit).toArray();

      if (enableVerboseLogging) {
        this.logger.debug('Found transactions to process for merkle proofs', {
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

      // Queue merkle proof verifications with rate limiting
      const verificationPromises = allTxs.map(tx =>
        this.merkleProofQueue.add(async () => {
          try {
            const verified = await this.verifyTransactionWithMerkleProof(tx._id);
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
    try {
      let archivedCount = 0;

      // Find transactions ready for archival
      const transactionsToArchive = await this.db.activeTransactions.find({
        block_height: { $ne: null, $lte: currentHeight - this.config.autoArchiveAfter + 1 },
        status: 'confirming'
      }).toArray();

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
   * Handle blockchain reorganization
   * @param {Object} reorgData - Reorg information
   */
  async handleReorg(reorgData) {
    try {
      this.logger.warn('Processing blockchain reorganization', {
        reorgFromHeight: reorgData.reorgFromHeight,
        newHeight: reorgData.newHeight
      });

      // Find transactions affected by the reorg
      const affectedTxs = await this.db.activeTransactions.find({
        block_height: { $gt: reorgData.reorgFromHeight }
      }).toArray();

      if (affectedTxs.length === 0) {
        this.logger.info('No active transactions affected by reorg');
        return;
      }

      this.logger.info('Reprocessing affected transactions', {
        count: affectedTxs.length,
        fromHeight: reorgData.reorgFromHeight
      });

      // Reset transactions that were in orphaned blocks
      const resetOps = affectedTxs.map(tx => ({
        updateOne: {
          filter: { _id: tx._id },
          update: {
            $set: {
              block_height: null,
              block_hash: null,
              confirmations: 0,
              status: 'pending'
            }
          }
        }
      }));

      await this.db.activeTransactions.bulkWrite(resetOps, { ordered: false });

      // Update confirmations based on new chain
      await this.updateConfirmations(reorgData.newHeight);

      this.logger.info('Reorg processing completed', {
        resetTransactions: affectedTxs.length,
        newHeight: reorgData.newHeight
      });

    } catch (error) {
      this.logger.error('Failed to handle reorg', { error: error.message });
      throw error;
    }
  }

  /**
   * Verify transaction using merkle proof and update block info with timeout and retry
   * @param {string} txid - Transaction ID
   * @returns {boolean} - Whether verification was successful
   */
  async verifyTransactionWithMerkleProof(txid) {
    const enableVerboseLogging = process.env.CONFIRMATION_TRACKER_VERBOSE_LOGGING === 'true';

    if (enableVerboseLogging) {
      this.logger.debug('Verifying transaction with merkle proof', { txid });
    }

    try {
      // Use RPC timeout
      if (enableVerboseLogging) {
        this.logger.debug('Requesting merkle proof for transaction', { txid });
      }
      const merkleProof = await this.rpc.makeRequest('getmerkleproof', [txid], this.config.rpcTimeout);

      if (enableVerboseLogging) {
        this.logger.debug('Received merkle proof response', {
          txid,
          hasTarget: !!merkleProof?.target,
          targetHash: merkleProof?.target?.hash,
          targetHeight: merkleProof?.target?.height
        });
      }

      if (merkleProof && merkleProof.target && merkleProof.target.hash) {
        if (enableVerboseLogging) {
          this.logger.debug('Merkle proof received', {
            txid,
            blockHash: merkleProof.target.hash,
            blockHeight: merkleProof.target.height,
            proofLength: merkleProof.nodes ? merkleProof.nodes.length : 0
          });
        }

        // We already have block info in the merkle proof target, no need for separate getblockheader call
        const blockHash = merkleProof.target.hash;
        const blockHeight = merkleProof.target.height;

        if (enableVerboseLogging) {
          this.logger.debug('Using block info from merkle proof', { blockHash, blockHeight });
        }

        // Update transaction with merkle proof info
        // For historical transactions that already have block_height, we only set block_hash
        // For new transactions without block_height, we set everything
        const updateFields = {
          block_hash: blockHash,
          merkle_proof: merkleProof,
          last_verified: new Date()
        };

        // Only set block_height and confirmations if not already set
        const existingTx = await this.db.activeTransactions.findOne({ _id: txid });
        if (existingTx && existingTx.block_height === null) {
          updateFields.block_height = blockHeight;
          updateFields.confirmations = 1;
          updateFields.status = 'confirming';
        }

        if (enableVerboseLogging) {
          this.logger.debug('Updating transaction with merkle proof data', {
            txid,
            existingBlockHeight: existingTx ? existingTx.block_height : 'not found',
            updateFields: {
              ...updateFields,
              merkle_proof: undefined // Don't log the full proof, too verbose
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
          this.logger.info('Transaction verified with merkle proof', {
            txid,
            blockHeight: blockHeight,
            blockHash: blockHash,
            wasHistorical: existingTx && existingTx.block_height !== null
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
          this.logger.warn('Transaction not found for merkle proof update', { txid });
        }
      } else {
        if (enableVerboseLogging) {
          this.logger.debug('No valid merkle proof received', {
            txid,
            merkleProof: merkleProof ? {
              hasTarget: !!merkleProof.target,
              targetHash: merkleProof.target?.hash
            } : null
          });
        }
        this.logger.debug('No merkle proof available for transaction', { txid });
      }

      return false;

    } catch (error) {
      if (enableVerboseLogging) {
        this.logger.debug('Merkle proof verification error details', {
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
        this.logger.debug('Transaction not yet confirmed or merkle proof unavailable', {
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
        const verified = await this.verifyTransactionWithMerkleProof(item.txid);
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
