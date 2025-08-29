const winston = require('winston');

class ConfirmationTracker {
  constructor(mongodb, blockTracker) {
    this.db = mongodb;
    this.blockTracker = blockTracker;
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
      batchSize: parseInt(process.env.CONFIRMATION_BATCH_SIZE) || 1000,
      maxRetries: 3
    };

    this.logger.info('Confirmation tracker initialized', {
      thresholds: this.config.confirmationThresholds,
      autoArchiveAfter: this.config.autoArchiveAfter
    });
  }

  parseThresholds(thresholdsStr) {
    if (!thresholdsStr) {
      return [0, 1, 6, 12, 24, 72, 144, 288];
    }

    return thresholdsStr.split(',').map(t => parseInt(t.trim())).sort((a, b) => a - b);
  }

  /**
   * Process a new block and update confirmations for all affected transactions
   * @param {Object} blockData - Block information
   */
  async processNewBlock(blockData) {
    if (this.isProcessing) {
      this.logger.debug('Already processing block confirmations, queuing', {
        height: blockData.height
      });
      return;
    }

    this.isProcessing = true;

    try {
      const startTime = Date.now();

      this.logger.info('Processing confirmations for new block', {
        height: blockData.height,
        hash: blockData.hash
      });

      // Get all active transactions that need confirmation updates
      const stats = await this.updateConfirmations(blockData.height);

      // Check for transactions that need archival
      const archivedStats = await this.checkAndArchiveTransactions(blockData.height);

      const duration = Date.now() - startTime;

      this.logger.info('Block confirmation processing completed', {
        height: blockData.height,
        ...stats,
        ...archivedStats,
        durationMs: duration
      });

    } catch (error) {
      this.logger.error('Failed to process block confirmations', {
        height: blockData.height,
        error: error.message
      });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Update confirmation counts for all active transactions
   * @param {number} currentHeight - Current block height
   * @returns {Object} - Update statistics
   */
  async updateConfirmations(currentHeight) {
    try {
      let totalUpdated = 0;
      let notificationsSent = 0;
      let confirmedTransactions = 0;

      // Process transactions in batches to avoid memory issues
      const cursor = this.db.activeTransactions.find({
        block_height: { $ne: null, $lte: currentHeight },
        status: { $in: ['pending', 'confirming'] }
      }).sort({ block_height: 1 });

      const _batch = [];
      const batchUpdates = [];
      const notificationQueue = [];

      for await (const tx of cursor) {
        const confirmations = this.calculateConfirmations(tx.block_height, currentHeight);
        const oldConfirmations = tx.confirmations || 0;

        if (confirmations !== oldConfirmations) {
          // Prepare batch update
          batchUpdates.push({
            updateOne: {
              filter: { _id: tx._id },
              update: {
                $set: {
                  confirmations,
                  status: confirmations > 0 ? 'confirming' : 'pending',
                  ...(confirmations > 0 && !tx.confirmed_at ? { confirmed_at: new Date() } : {})
                }
              }
            }
          });

          // Check for notification thresholds
          const notificationTriggers = this.getNotificationTriggers(oldConfirmations, confirmations);
          for (const threshold of notificationTriggers) {
            notificationQueue.push({
              txid: tx._id,
              threshold,
              confirmations,
              addresses: tx.addresses,
              amount: tx.amount,
              deposits: tx.deposits
            });
          }

          totalUpdated++;
          if (confirmations > 0 && oldConfirmations === 0) {
            confirmedTransactions++;
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
        confirmedTransactions,
        notificationsSent
      };

    } catch (error) {
      this.logger.error('Failed to update confirmations', { error: error.message });
      throw error;
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
        deposits: tx.deposits,
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
        for (const deposit of tx.deposits || []) {
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
            deposits: tx.deposits
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

module.exports = ConfirmationTracker;
