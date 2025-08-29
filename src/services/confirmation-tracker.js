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
      confirmationThresholds: this.parseThresholds(process.env.CONFIRMATION_THRESHOLDS),
      autoArchiveAfter: parseInt(process.env.AUTO_ARCHIVE_AFTER) || 288,
      batchSize: parseInt(process.env.CONFIRMATION_BATCH_SIZE) || 100,
      maxRetries: 3,
      rpcTimeout: 5000,
      merkleProofConcurrency: 5, // Limit concurrent merkle proof requests
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
      thresholds: this.config.confirmationThresholds,
      autoArchiveAfter: this.config.autoArchiveAfter,
      merkleProofConcurrency: this.config.merkleProofConcurrency,
      pendingTxLimit: this.config.pendingTxLimit
    });
  }

  parseThresholds(thresholdsStr) {
    if (!thresholdsStr) {
      return [0, 1, 6, 12, 24, 72, 144, 288];
    }

    return thresholdsStr.split(',').map(t => parseInt(t.trim())).sort((a, b) => a - b);
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
      const [merkleStats, confirmationStats, archiveStats] = await Promise.all([
        this.processUnconfirmedTransactions(),
        this.updateConfirmationsSelectively(currentHeight),
        this.checkAndArchiveTransactions(currentHeight)
      ]);

      // Process retry queue
      await this.processRetryQueue();

      const duration = Date.now() - startTime;

      this.logger.info('Block confirmation processing completed', {
        currentHeight,
        ...merkleStats,
        ...confirmationStats,
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
   * Process unconfirmed transactions with merkle proof verification
   * @returns {Object} - Processing statistics
   */
  async processUnconfirmedTransactions() {
    try {
      // Get pending transactions that haven't been tried recently
      const pendingTxs = await this.db.activeTransactions.find({
        block_height: null,
        status: 'pending'
      }).limit(this.config.pendingTxLimit).toArray();

      let verifiedCount = 0;
      let failedCount = 0;

      // Queue merkle proof verifications with rate limiting
      const verificationPromises = pendingTxs.map(tx =>
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
        pendingChecked: pendingTxs.length,
        verifiedCount,
        failedCount
      };

    } catch (error) {
      this.logger.error('Failed to process unconfirmed transactions', { error: error.message });
      return { pendingChecked: 0, verifiedCount: 0, failedCount: 0 };
    }
  }

  /**
   * Update confirmations only for transactions that might cross thresholds
   * @param {number} currentHeight - Current block height
   * @returns {Object} - Update statistics
   */
  async updateConfirmationsSelectively(currentHeight) {
    try {
      let totalUpdated = 0;
      let notificationsSent = 0;

      // Only check transactions that might cross thresholds based on current height
      const maxThreshold = Math.max(...this.config.confirmationThresholds);
      const minBlockHeight = Math.max(1, currentHeight - maxThreshold);

      const cursor = this.db.activeTransactions.find({
        block_height: { $gte: minBlockHeight, $lte: currentHeight },
        status: 'confirming'
      }).sort({ block_height: 1 });

      const batchUpdates = [];
      const notificationQueue = [];

      for await (const tx of cursor) {
        const newConfirmations = this.calculateConfirmations(tx.block_height, currentHeight);
        const oldConfirmations = tx.confirmations || 0;

        // Only update if confirmations changed AND might trigger notifications
        if (newConfirmations !== oldConfirmations) {
          const triggers = this.getNotificationTriggers(oldConfirmations, newConfirmations);

          if (triggers.length > 0) {
            // Update transaction
            batchUpdates.push({
              updateOne: {
                filter: { _id: tx._id },
                update: { $set: { confirmations: newConfirmations } }
              }
            });

            // Queue notifications
            for (const threshold of triggers) {
              notificationQueue.push({
                txid: tx._id,
                threshold,
                confirmations: newConfirmations,
                addresses: tx.addresses,
                amount: tx.amount,
                outputs: tx.outputs
              });
            }

            totalUpdated++;
          }
        }

        // Process batch when full
        if (batchUpdates.length >= this.config.batchSize) {
          await this.processBatchUpdates(batchUpdates, notificationQueue);
          notificationsSent += notificationQueue.length;
          batchUpdates.length = 0;
          notificationQueue.length = 0;
        }
      }

      // Process remaining batch
      if (batchUpdates.length > 0) {
        await this.processBatchUpdates(batchUpdates, notificationQueue);
        notificationsSent += notificationQueue.length;
      }

      return {
        totalUpdated,
        notificationsSent
      };

    } catch (error) {
      this.logger.error('Failed to update confirmations selectively', { error: error.message });
      return { totalUpdated: 0, notificationsSent: 0 };
    }
  }

  /**
   * Process batch updates for transactions
   * @param {Array} batchUpdates - MongoDB bulk operations
   * @param {Array} notificationQueue - Notifications to send
   */
  async processBatchUpdates(batchUpdates, notificationQueue) {
    try {
      // Execute database updates
      if (batchUpdates.length > 0) {
        await this.db.activeTransactions.bulkWrite(batchUpdates, { ordered: false });
      }

      // Send notifications (async, don't wait)
      if (notificationQueue.length > 0) {
        this.sendNotificationsAsync(notificationQueue).catch(error => {
          this.logger.error('Notification sending failed', { error: error.message });
        });
      }

    } catch (error) {
      this.logger.error('Batch update failed', {
        updates: batchUpdates.length,
        notifications: notificationQueue.length,
        error: error.message
      });
      throw error;
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
   * Get notification thresholds that were crossed
   * @param {number} oldConfirmations - Previous confirmation count
   * @param {number} newConfirmations - New confirmation count
   * @returns {number[]} - Thresholds that were crossed
   */
  getNotificationTriggers(oldConfirmations, newConfirmations) {
    const triggers = [];

    for (const threshold of this.config.confirmationThresholds) {
      if (oldConfirmations < threshold && newConfirmations >= threshold) {
        triggers.push(threshold);
      }
    }

    return triggers;
  }

  /**
   * Send notifications asynchronously
   * @param {Array} notificationQueue - Notifications to send
   */
  async sendNotificationsAsync(notificationQueue) {
    try {
      // TODO: Integrate with actual notification service
      for (const notification of notificationQueue) {
        this.logger.debug('Notification triggered', notification);

        // Record notification in database
        await this.recordNotification(notification);
      }

    } catch (error) {
      this.logger.error('Failed to send notifications', { error: error.message });
    }
  }

  /**
   * Record notification in database for tracking
   * @param {Object} notification - Notification data
   */
  async recordNotification(notification) {
    try {
      await this.db.activeTransactions.updateOne(
        { _id: notification.txid },
        {
          $set: {
            [`notifications.${notification.threshold}`]: new Date()
          }
        }
      );
    } catch (error) {
      this.logger.error('Failed to record notification', {
        txid: notification.txid,
        threshold: notification.threshold,
        error: error.message
      });
    }
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
        amount: tx.amount,
        block_height: tx.block_height,
        block_hash: tx.block_hash,
        final_confirmations: this.calculateConfirmations(tx.block_height, currentHeight),
        confirmed_at: tx.confirmed_at,
        first_seen: tx.first_seen,
        outputs: tx.outputs,
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
        for (const deposit of tx.outputs || []) {
          const current = addressUpdates.get(deposit.address) || { total: 0, count: 0 };
          addressUpdates.set(deposit.address, {
            total: current.total + deposit.amount,
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
              total_received: stats.total,
              transaction_count: stats.count
            }
          }
        }
      }));

      if (bulkOps.length > 0) {
        await this.db.depositAddresses.bulkWrite(bulkOps, { ordered: false });
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
              status: 'pending',
              confirmed_at: null
            },
            $unset: {
              notifications: 1
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
    try {
      // Use RPC timeout
      const merkleProof = await this.rpc.makeRequest('getmerkleproof', [txid], this.config.rpcTimeout);

      if (merkleProof && merkleProof.blockHash) {
        // Get block header to get height with timeout
        const blockHeader = await this.rpc.makeRequest('getblockheader', [merkleProof.blockHash, true], this.config.rpcTimeout);

        const result = await this.db.activeTransactions.updateOne(
          { _id: txid, block_height: null },
          {
            $set: {
              block_height: blockHeader.height,
              block_hash: merkleProof.blockHash,
              confirmations: 1,
              status: 'confirming',
              confirmed_at: new Date(),
              merkle_proof: merkleProof,
              last_verified: new Date()
            }
          }
        );

        if (result.matchedCount > 0) {
          this.logger.info('Transaction verified with merkle proof', {
            txid,
            blockHeight: blockHeader.height,
            blockHash: merkleProof.blockHash
          });

          // Remove from retry queue if present
          this.retryQueue.delete(txid);

          // Trigger 0-confirmation notification
          const tx = await this.db.activeTransactions.findOne({ _id: txid });
          if (tx) {
            await this.sendNotificationsAsync([{
              txid,
              threshold: 0,
              confirmations: 1,
              addresses: tx.addresses,
              amount: tx.amount,
              outputs: tx.outputs
            }]);
          }

          return true;
        }
      }

      return false;

    } catch (error) {
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
        { _id: txid, block_height: null },
        {
          $set: {
            block_height: blockHeight,
            block_hash: blockHash,
            confirmations: 1,
            status: 'confirming',
            confirmed_at: new Date()
          }
        }
      );

      if (result.matchedCount > 0) {
        this.logger.info('Transaction confirmed in block', {
          txid,
          blockHeight,
          blockHash
        });

        // Trigger 0-confirmation notification
        const tx = await this.db.activeTransactions.findOne({ _id: txid });
        if (tx) {
          await this.sendNotificationsAsync([{
            txid,
            threshold: 0,
            confirmations: 1,
            addresses: tx.addresses,
            amount: tx.amount,
            outputs: tx.outputs
          }]);
        }
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
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
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
              count: { $sum: 1 },
              totalAmount: { $sum: '$amount' }
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
