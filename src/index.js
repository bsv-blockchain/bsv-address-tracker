require('dotenv').config();
const winston = require('winston');

// Import services
const MongoDB = require('./db/mongodb');
const RPCClient = require('./services/rpc-client');
const BlockTracker = require('./services/block-tracker');
const ZMQListener = require('./services/zmq-listener');
const DepositDetector = require('./services/deposit-detector');
const ConfirmationTracker = require('./services/confirmation-tracker');
const AddressHistoryFetcher = require('./services/address-history-fetcher');

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
    this.blockTracker = null;
    this.zmqListener = null;
    this.depositDetector = null;
    this.confirmationTracker = null;
    this.addressHistoryFetcher = null;
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

      // Initialize block tracker first (needed for history fetcher)
      this.blockTracker = new BlockTracker(this.db, this.rpc);
      await this.blockTracker.initialize();

      // Initialize address history fetcher
      this.addressHistoryFetcher = new AddressHistoryFetcher(this.db, this.blockTracker);

      // Initialize deposit detector with history fetcher
      this.depositDetector = new DepositDetector(this.db, this.addressHistoryFetcher);
      await this.depositDetector.initialize();

      // Initialize confirmation tracker
      this.confirmationTracker = new ConfirmationTracker(this.db, this.blockTracker);

      // Set up block tracker event handling for confirmation updates
      this.setupBlockTrackerEvents();

      // Initialize ZMQ listener
      this.zmqListener = new ZMQListener(this.blockTracker, this.depositDetector);
      await this.zmqListener.start();

      this.isRunning = true;
      this.logger.info('BSV Address Tracker started successfully');

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

  setupBlockTrackerEvents() {
    // Set up event handling for block tracker events
    // Note: In a full implementation, this would use EventEmitter
    // For now, we'll manually call confirmation tracker methods

    // Override the block tracker's emit method to handle events
    const originalEmit = this.blockTracker.emit;
    this.blockTracker.emit = (event, data) => {
      originalEmit.call(this.blockTracker, event, data);

      if (event === 'newBlock' && this.confirmationTracker) {
        // Process confirmations for new block
        this.confirmationTracker.processNewBlock(data).catch(error => {
          this.logger.error('Failed to process confirmations for new block', {
            height: data.height,
            error: error.message
          });
        });
      }

      if (event === 'reorg' && this.confirmationTracker) {
        // Handle blockchain reorganization
        this.confirmationTracker.handleReorg(data).catch(error => {
          this.logger.error('Failed to handle reorg in confirmation tracker', {
            reorgFromHeight: data.reorgFromHeight,
            error: error.message
          });
        });
      }
    };
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
      health.components.zmq = this.zmqListener.isHealthy();

      // Block tracker health
      if (this.blockTracker) {
        const stats = await this.blockTracker.getStats();
        health.components.blockTracker = {
          healthy: !stats.isProcessing || stats.lastProcessedHeight !== null,
          lastHeight: stats.lastProcessedHeight,
          mainChainBlocks: stats.mainChainBlocks,
          orphanedBlocks: stats.orphanedBlocks
        };
      }

      // Deposit detector health
      if (this.depositDetector) {
        const stats = await this.depositDetector.getStats();
        health.components.depositDetector = {
          healthy: stats.isInitialized && !stats.needsRebuild,
          isInitialized: stats.isInitialized,
          addressCount: stats.bloomFilter ? stats.bloomFilter.addressCount : 0,
          needsRebuild: stats.needsRebuild
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

      // Stop ZMQ listener
      if (this.zmqListener) {
        await this.zmqListener.stop();
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

    if (this.blockTracker) {
      stats.blockTracker = await this.blockTracker.getStats();
    }

    if (this.zmqListener) {
      stats.zmq = this.zmqListener.getStats();
    }

    if (this.depositDetector) {
      stats.depositDetector = await this.depositDetector.getStats();
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
if (require.main === module) {
  const tracker = new BSVAddressTracker();
  tracker.start().catch(error => {
    console.error('Failed to start application:', error);
    process.exit(1);
  });
}

module.exports = BSVAddressTracker;
