import 'dotenv/config';
import winston from 'winston';

// Import services
import MongoDB from './db/mongodb.js';
import RPCClient from './services/rpc-client.js';
import ZMQListener from './services/zmq-listener.js';
import TransactionTracker from './services/transaction-tracker.js';
import ConfirmationTracker from './services/confirmation-tracker.js';
import AddressHistoryFetcher from './services/address-history-fetcher.js';
import WebhookProcessor from './services/webhook-processor.js';
import APIServer from './api/server.js';

class BSVAddressTracker {
  constructor() {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    this.db = null;
    this.rpc = null;
    this.zmqListener = null;
    this.transactionTracker = null;
    this.confirmationTracker = null;
    this.addressHistoryFetcher = null;
    this.webhookProcessor = null;
    this.apiServer = null;
    this.isRunning = false;
  }

  async start() {
    try {
      this.logger.info('Starting BSV Address Tracker');

      // Initialize database connection
      this.db = new MongoDB();
      await this.db.connect();

      // Initialize RPC client
      this.rpc = new RPCClient();

      // Test RPC connection
      const rpcHealthy = await this.rpc.ping();
      if (!rpcHealthy) {
        throw new Error('Failed to connect to SV Node via RPC');
      }

      this.logger.info('Connected to SV Node');

      // Initialize address history fetcher
      this.addressHistoryFetcher = new AddressHistoryFetcher(this.db, this.rpc);

      // Initialize webhook processor first if enabled
      if (process.env.ENABLE_WEBHOOKS === 'true') {
        this.webhookProcessor = new WebhookProcessor(this.db);
        this.webhookProcessor.start();
      }

      // Initialize transaction tracker with history fetcher and webhook processor
      this.transactionTracker = new TransactionTracker(this.db, this.addressHistoryFetcher, this.webhookProcessor);
      await this.transactionTracker.initialize();

      // Initialize confirmation tracker (pass webhook processor if enabled)
      this.confirmationTracker = new ConfirmationTracker(
        this.db,
        this.rpc,
        this.webhookProcessor
      );

      // Initialize ZMQ listener
      this.zmqListener = new ZMQListener(this.confirmationTracker, this.transactionTracker);
      await this.zmqListener.start();

      // Initialize API server
      this.apiServer = new APIServer(
        this.db,
        this.transactionTracker,
        this.confirmationTracker,
        this.addressHistoryFetcher
      );

      const apiPort = parseInt(process.env.API_PORT) || 3000;
      const apiHost = process.env.API_HOST || '0.0.0.0';
      await this.apiServer.start(apiPort, apiHost);

      this.isRunning = true;
      this.logger.info('BSV Address Tracker started successfully', {
        apiPort,
        apiHost
      });

      // Fetch historical data for any unfetched addresses on startup
      if (this.addressHistoryFetcher) {
        this.addressHistoryFetcher.fetchUnfetchedHistories().catch(error => {
          this.logger.error('Failed to fetch unfetched histories on startup', {
            error: error.message
          });
        });
      }

      // Setup health monitoring
      this.setupHealthMonitoring();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

    } catch (error) {
      this.logger.error('Failed to start BSV Address Tracker', {
        error: error.message
      });
      await this.stop();
      process.exit(1);
    }
  }


  setupHealthMonitoring() {
    // Monitor system health every 30 seconds
    this.healthInterval = setInterval(async () => {
      try {
        const health = await this.getHealthStatus();

        if (!health.overall) {
          this.logger.warn('System health check failed', health);
        } else {
          this.logger.debug('Health check passed', health);
        }

      } catch (error) {
        this.logger.error('Health check error', { error: error.message });
      }
    }, 30000);
  }

  async getHealthStatus() {
    const health = {
      timestamp: new Date(),
      overall: true,
      components: {}
    };

    try {
      // Database health
      health.components.database = await this.db.ping();

      // RPC health
      health.components.rpc = await this.rpc.ping();

      // ZMQ health
      if (this.zmqListener) {
        try {
          const zmqHealthy = this.zmqListener.isHealthy();
          health.components.zmq = {
            healthy: zmqHealthy,
            isRunning: this.zmqListener.isRunning,
            hasRawTxSocket: !!this.zmqListener.rawTxSocket,
            hasHashBlockSocket: !!this.zmqListener.hashBlockSocket
          };
        } catch (error) {
          health.components.zmq = {
            healthy: false,
            error: error.message
          };
          this.logger.warn('ZMQ health check failed', { error: error.message });
        }
      } else {
        health.components.zmq = {
          healthy: false,
          error: 'ZMQ listener not initialized'
        };
      }


      // Transaction tracker health
      if (this.transactionTracker) {
        const stats = await this.transactionTracker.getStats();
        health.components.transactionTracker = {
          healthy: stats.isInitialized,
          isInitialized: stats.isInitialized,
          addressCount: stats.filter ? stats.filter.addressCount : 0
        };
      }

      // Confirmation tracker health
      if (this.confirmationTracker) {
        const stats = await this.confirmationTracker.getStats();
        health.components.confirmationTracker = {
          healthy: !stats.isProcessing,
          isProcessing: stats.isProcessing,
          activeTransactions: Object.values(stats.activeTransactions || {}).reduce((sum, stat) => sum + stat.count, 0),
          archivedTransactions: stats.archivedTransactions
        };
      }

      // Address history fetcher health
      if (this.addressHistoryFetcher) {
        const stats = this.addressHistoryFetcher.getStats();
        health.components.addressHistoryFetcher = {
          healthy: await this.addressHistoryFetcher.ping(),
          isProcessing: stats.isProcessing,
          queueSize: stats.queue.size,
          totalProcessed: stats.stats.totalProcessed,
          totalErrors: stats.stats.totalErrors
        };
      }

      // Overall health
      health.overall = Object.values(health.components).every(component =>
        typeof component === 'boolean' ? component : component.healthy
      );

    } catch (error) {
      health.overall = false;
      health.error = error.message;
    }

    return health;
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      this.logger.info('Received shutdown signal', { signal });
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGQUIT', shutdown);

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      this.stop().then(() => process.exit(1));
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection', { reason, promise });
      this.stop().then(() => process.exit(1));
    });
  }

  async stop() {
    if (!this.isRunning) {return;}

    this.logger.info('Stopping BSV Address Tracker');
    this.isRunning = false;

    try {
      // Clear health monitoring
      if (this.healthInterval) {
        clearInterval(this.healthInterval);
      }

      // Stop API server
      if (this.apiServer) {
        await this.apiServer.stop();
      }

      // Stop ZMQ listener
      if (this.zmqListener) {
        await this.zmqListener.stop();
      }

      // Stop webhook processor
      if (this.webhookProcessor) {
        await this.webhookProcessor.stop();
      }

      // Disconnect from database
      if (this.db) {
        await this.db.disconnect();
      }

      this.logger.info('BSV Address Tracker stopped');

    } catch (error) {
      this.logger.error('Error during shutdown', { error: error.message });
    }
  }

  // API for getting system stats
  async getStats() {
    const stats = {
      timestamp: new Date(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      isRunning: this.isRunning
    };

    if (this.db) {
      stats.database = await this.db.getStats();
    }


    if (this.zmqListener) {
      stats.zmq = this.zmqListener.getStats();
    }

    if (this.transactionTracker) {
      stats.transactionTracker = await this.transactionTracker.getStats();
    }

    if (this.confirmationTracker) {
      stats.confirmationTracker = await this.confirmationTracker.getStats();
    }

    if (this.addressHistoryFetcher) {
      stats.addressHistoryFetcher = this.addressHistoryFetcher.getStats();
    }

    return stats;
  }
}

// Start the application if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tracker = new BSVAddressTracker();
  tracker.start().catch(error => {
    console.error('Failed to start application:', error);
    process.exit(1);
  });
}

export default BSVAddressTracker;
