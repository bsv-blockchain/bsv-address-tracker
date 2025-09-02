import winston from 'winston';
import fetch from 'node-fetch';

class WebhookProcessor {
  constructor(mongodb) {
    this.db = mongodb;
    this.isProcessing = false;
    this.processingInterval = null;

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
      batchSize: parseInt(process.env.WEBHOOK_BATCH_SIZE) || 10,
      processingInterval: parseInt(process.env.WEBHOOK_PROCESSING_INTERVAL) || 5000,
      requestTimeout: parseInt(process.env.WEBHOOK_TIMEOUT) || 10000,
      maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES) || 5,
      retryDelays: [1000, 5000, 30000, 300000, 3600000], // 1s, 5s, 30s, 5m, 1h
      cleanupAfterDays: parseInt(process.env.WEBHOOK_CLEANUP_DAYS) || 7
    };
  }

  start() {
    if (this.processingInterval) {
      this.logger.warn('Webhook processor already running');
      return;
    }

    this.logger.info('Starting webhook processor', { config: this.config });

    // Start processing loop
    this.processingInterval = setInterval(() => {
      this.processQueue().catch(error => {
        this.logger.error('Error in webhook processing loop', { error: error.message });
      });
    }, this.config.processingInterval);

    // Process immediately on start
    this.processQueue().catch(error => {
      this.logger.error('Error in initial webhook processing', { error: error.message });
    });

    // Cleanup old webhook records periodically
    this.startCleanup();
  }

  async stop() {
    this.logger.info('Stopping webhook processor');

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Wait for current processing to complete
    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.logger.info('Webhook processor stopped');
  }

  async queueWebhook(webhookData) {
    try {
      // Extract transaction ID from payload if this is a transaction update
      const txid = webhookData.payload?.transaction?._id;
      const isTransactionUpdate = !!txid;

      if (isTransactionUpdate) {
        // Cancel any pending/retry webhooks for the same transaction and webhook
        const cancelResult = await this.db.webhookQueue.updateMany(
          {
            webhook_id: webhookData.webhookId,
            'payload.transaction._id': txid,
            status: { $in: ['pending', 'retry'] }
          },
          {
            $set: {
              status: 'cancelled',
              cancelled_at: new Date(),
              cancel_reason: 'Superseded by newer transaction update'
            }
          }
        );

        if (cancelResult.modifiedCount > 0) {
          this.logger.info('Cancelled outdated webhook requests', {
            webhookId: webhookData.webhookId,
            txid,
            cancelledCount: cancelResult.modifiedCount
          });
        }
      }

      const queueItem = {
        webhook_id: webhookData.webhookId,
        url: webhookData.url,
        payload: webhookData.payload,
        status: 'pending',
        attempts: 0,
        created_at: new Date(),
        next_retry: new Date(),
        // Add transaction ID for efficient querying
        transaction_id: txid || null
      };

      await this.db.webhookQueue.insertOne(queueItem);

      this.logger.info('Webhook queued', {
        webhookId: webhookData.webhookId,
        url: webhookData.url,
        txid: txid || 'N/A'
      });

    } catch (error) {
      this.logger.error('Failed to queue webhook', {
        error: error.message,
        webhookData
      });
    }
  }

  async processQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // Find pending webhooks that are ready to be processed
      const now = new Date();
      const webhooks = await this.db.webhookQueue.find({
        status: { $in: ['pending', 'retry'] },
        next_retry: { $lte: now }
      })
        .limit(this.config.batchSize)
        .toArray();

      if (webhooks.length === 0) {
        return;
      }

      // Group webhooks by webhook_id and transaction_id to find duplicates
      const transactionWebhooks = new Map();
      const nonTransactionWebhooks = [];

      for (const webhook of webhooks) {
        if (webhook.transaction_id) {
          const key = `${webhook.webhook_id}_${webhook.transaction_id}`;
          if (!transactionWebhooks.has(key)) {
            transactionWebhooks.set(key, []);
          }
          transactionWebhooks.get(key).push(webhook);
        } else {
          nonTransactionWebhooks.push(webhook);
        }
      }

      // For transaction webhooks, only process the most recent one
      const webhooksToProcess = [...nonTransactionWebhooks];
      const webhooksToCancel = [];

      for (const [_key, duplicates] of transactionWebhooks) {
        if (duplicates.length > 1) {
          // Sort by creation date, newest first
          duplicates.sort((a, b) => b.created_at - a.created_at);

          // Process the newest one
          webhooksToProcess.push(duplicates[0]);

          // Cancel the older ones
          for (let i = 1; i < duplicates.length; i++) {
            webhooksToCancel.push(duplicates[i]);
          }
        } else {
          webhooksToProcess.push(duplicates[0]);
        }
      }

      // Cancel outdated webhooks
      if (webhooksToCancel.length > 0) {
        const cancelIds = webhooksToCancel.map(w => w._id);
        await this.db.webhookQueue.updateMany(
          { _id: { $in: cancelIds } },
          {
            $set: {
              status: 'cancelled',
              cancelled_at: new Date(),
              cancel_reason: 'Superseded by newer transaction update during processing'
            }
          }
        );

        this.logger.info('Cancelled outdated webhooks during processing', {
          count: webhooksToCancel.length
        });
      }

      if (webhooksToProcess.length === 0) {
        return;
      }

      this.logger.info('Processing webhook batch', { count: webhooksToProcess.length });

      // Process webhooks in parallel
      const promises = webhooksToProcess.map(webhook => this.processWebhook(webhook));
      await Promise.allSettled(promises);

    } catch (error) {
      this.logger.error('Error processing webhook queue', { error: error.message });
    } finally {
      this.isProcessing = false;
    }
  }

  async processWebhook(webhook) {
    try {
      // Update status to processing
      await this.db.webhookQueue.updateOne(
        { _id: webhook._id },
        {
          $set: {
            status: 'processing',
            last_attempt: new Date()
          }
        }
      );

      // Make the HTTP request
      const response = await this.sendWebhook(webhook.url, webhook.payload);

      if (response.success) {
        // Mark as completed
        await this.db.webhookQueue.updateOne(
          { _id: webhook._id },
          {
            $set: {
              status: 'completed',
              completed_at: new Date(),
              response_status: response.status,
              response_body: response.body
            }
          }
        );

        this.logger.info('Webhook delivered successfully', {
          webhookId: webhook._id,
          url: webhook.url,
          status: response.status
        });

      } else {
        // Handle failure
        await this.handleWebhookFailure(webhook, response);
      }

    } catch (error) {
      this.logger.error('Error processing webhook', {
        webhookId: webhook._id,
        error: error.message
      });

      await this.handleWebhookFailure(webhook, {
        success: false,
        error: error.message
      });
    }
  }

  async sendWebhook(url, payload) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'BSV-Address-Tracker/1.0'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      const responseText = await response.text();

      return {
        success: response.status >= 200 && response.status < 300,
        status: response.status,
        body: responseText.substring(0, 1000) // Limit stored response size
      };

    } catch (error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request timeout'
        };
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  async handleWebhookFailure(webhook, response) {
    const attempts = webhook.attempts + 1;

    if (attempts >= this.config.maxRetries) {
      // Max retries reached, mark as failed
      await this.db.webhookQueue.updateOne(
        { _id: webhook._id },
        {
          $set: {
            status: 'failed',
            failed_at: new Date(),
            attempts: attempts,
            last_error: response.error || `HTTP ${response.status}`
          }
        }
      );

      this.logger.error('Webhook delivery failed permanently', {
        webhookId: webhook._id,
        url: webhook.url,
        attempts: attempts,
        error: response.error
      });

    } else {
      // Schedule retry
      const retryDelay = this.config.retryDelays[Math.min(attempts - 1, this.config.retryDelays.length - 1)];
      const nextRetry = new Date(Date.now() + retryDelay);

      await this.db.webhookQueue.updateOne(
        { _id: webhook._id },
        {
          $set: {
            status: 'retry',
            attempts: attempts,
            next_retry: nextRetry,
            last_error: response.error || `HTTP ${response.status}`
          }
        }
      );

      this.logger.warn('Webhook delivery failed, scheduled retry', {
        webhookId: webhook._id,
        url: webhook.url,
        attempts: attempts,
        nextRetry: nextRetry
      });
    }
  }

  startCleanup() {
    // Run cleanup daily
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldWebhooks().catch(error => {
        this.logger.error('Error in webhook cleanup', { error: error.message });
      });
    }, 24 * 60 * 60 * 1000);

    // Run cleanup on start
    this.cleanupOldWebhooks().catch(error => {
      this.logger.error('Error in initial webhook cleanup', { error: error.message });
    });
  }

  async cleanupOldWebhooks() {
    try {
      const cutoffDate = new Date(Date.now() - this.config.cleanupAfterDays * 24 * 60 * 60 * 1000);

      const result = await this.db.webhookQueue.deleteMany({
        status: { $in: ['completed', 'failed', 'cancelled'] },
        $or: [
          { completed_at: { $lt: cutoffDate } },
          { failed_at: { $lt: cutoffDate } },
          { cancelled_at: { $lt: cutoffDate } }
        ]
      });

      if (result.deletedCount > 0) {
        this.logger.info('Cleaned up old webhooks', { count: result.deletedCount });
      }

    } catch (error) {
      this.logger.error('Failed to cleanup old webhooks', { error: error.message });
    }
  }

  async getStats() {
    try {
      const stats = await Promise.all([
        this.db.webhookQueue.countDocuments({ status: 'pending' }),
        this.db.webhookQueue.countDocuments({ status: 'processing' }),
        this.db.webhookQueue.countDocuments({ status: 'retry' }),
        this.db.webhookQueue.countDocuments({ status: 'completed' }),
        this.db.webhookQueue.countDocuments({ status: 'failed' }),
        this.db.webhookQueue.countDocuments({ status: 'cancelled' })
      ]);

      return {
        pending: stats[0],
        processing: stats[1],
        retry: stats[2],
        completed: stats[3],
        failed: stats[4],
        cancelled: stats[5],
        isProcessing: this.isProcessing
      };

    } catch (error) {
      this.logger.error('Failed to get webhook stats', { error: error.message });
      return null;
    }
  }
}

export default WebhookProcessor;

