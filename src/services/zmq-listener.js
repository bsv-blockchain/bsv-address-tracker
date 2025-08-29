const zmq = require('zeromq');
const winston = require('winston');

class ZMQListener {
  constructor(blockTracker, depositDetector) {
    this.blockTracker = blockTracker;
    this.depositDetector = depositDetector;
    this.rawTxSocket = null;
    this.hashBlockSocket = null;
    this.isRunning = false;

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    // Configuration
    this.rawTxEndpoint = process.env.SVNODE_ZMQ_RAWTX || 'tcp://127.0.0.1:28332';
    this.hashBlockEndpoint = process.env.SVNODE_ZMQ_HASHBLOCK || 'tcp://127.0.0.1:28333';
  }

  async start() {
    if (this.isRunning) {
      this.logger.warn('ZMQ listener already running');
      return;
    }

    try {
      // Initialize sockets
      this.rawTxSocket = new zmq.Subscriber();
      this.hashBlockSocket = new zmq.Subscriber();

      // Connect to ZMQ endpoints
      await this.rawTxSocket.connect(this.rawTxEndpoint);
      await this.hashBlockSocket.connect(this.hashBlockEndpoint);

      // Subscribe to topics
      this.rawTxSocket.subscribe('rawtx');
      this.hashBlockSocket.subscribe('hashblock');

      this.logger.info('Connected to ZMQ endpoints', {
        rawTx: this.rawTxEndpoint,
        hashBlock: this.hashBlockEndpoint
      });

      this.isRunning = true;

      // Start listening for messages
      this.listenForRawTransactions();
      this.listenForBlockHashes();

      this.logger.info('ZMQ listener started successfully');

    } catch (error) {
      this.logger.error('Failed to start ZMQ listener', { error: error.message });
      await this.stop();
      throw error;
    }
  }

  async listenForRawTransactions() {
    try {
      for await (const [_topic, message] of this.rawTxSocket) {
        if (!this.isRunning) {break;}

        try {
          await this.handleRawTransaction(message);
        } catch (error) {
          this.logger.error('Error handling raw transaction', {
            error: error.message
          });
        }
      }
    } catch (error) {
      this.logger.error('Raw transaction listener error', { error: error.message });
      if (this.isRunning) {
        // Attempt to reconnect
        setTimeout(() => this.reconnectRawTx(), 5000);
      }
    }
  }

  async listenForBlockHashes() {
    try {
      for await (const [_topic, message] of this.hashBlockSocket) {
        if (!this.isRunning) {break;}

        try {
          await this.handleBlockHash(message);
        } catch (error) {
          this.logger.error('Error handling block hash', {
            error: error.message
          });
        }
      }
    } catch (error) {
      this.logger.error('Block hash listener error', { error: error.message });
      if (this.isRunning) {
        // Attempt to reconnect
        setTimeout(() => this.reconnectHashBlock(), 5000);
      }
    }
  }

  async handleRawTransaction(rawTxBuffer) {
    try {
      const txHex = rawTxBuffer.toString('hex');

      this.logger.debug('Received raw transaction', {
        txHex: txHex.substring(0, 64) + '...',
        size: rawTxBuffer.length
      });

      // Process transaction for deposits
      if (this.depositDetector && this.depositDetector.isInitialized) {
        const depositResult = await this.depositDetector.processTransaction(txHex);

        if (depositResult) {
          this.logger.info('Transaction processed with deposits', {
            txid: depositResult.txid,
            deposits: depositResult.deposits,
            totalAmount: depositResult.totalAmount
          });
        }
      }

    } catch (error) {
      this.logger.error('Failed to handle raw transaction', { error: error.message });
    }
  }

  async handleBlockHash(blockHashBuffer) {
    try {
      const blockHash = blockHashBuffer.toString('hex');

      this.logger.info('Received new block hash', { blockHash });

      // Pass to block tracker for processing
      if (this.blockTracker) {
        await this.blockTracker.processNewBlock(blockHash);
      }

    } catch (error) {
      this.logger.error('Failed to handle block hash', {
        error: error.message,
        blockHash: blockHashBuffer.toString('hex')
      });
    }
  }

  async reconnectRawTx() {
    if (!this.isRunning) {return;}

    try {
      this.logger.info('Attempting to reconnect raw transaction socket');

      if (this.rawTxSocket) {
        await this.rawTxSocket.close();
      }

      this.rawTxSocket = new zmq.Subscriber();
      await this.rawTxSocket.connect(this.rawTxEndpoint);
      this.rawTxSocket.subscribe('rawtx');

      this.listenForRawTransactions();
      this.logger.info('Raw transaction socket reconnected');

    } catch (error) {
      this.logger.error('Failed to reconnect raw transaction socket', {
        error: error.message
      });
      setTimeout(() => this.reconnectRawTx(), 10000);
    }
  }

  async reconnectHashBlock() {
    if (!this.isRunning) {return;}

    try {
      this.logger.info('Attempting to reconnect block hash socket');

      if (this.hashBlockSocket) {
        await this.hashBlockSocket.close();
      }

      this.hashBlockSocket = new zmq.Subscriber();
      await this.hashBlockSocket.connect(this.hashBlockEndpoint);
      this.hashBlockSocket.subscribe('hashblock');

      this.listenForBlockHashes();
      this.logger.info('Block hash socket reconnected');

    } catch (error) {
      this.logger.error('Failed to reconnect block hash socket', {
        error: error.message
      });
      setTimeout(() => this.reconnectHashBlock(), 10000);
    }
  }

  async stop() {
    this.logger.info('Stopping ZMQ listener');
    this.isRunning = false;

    try {
      if (this.rawTxSocket) {
        await this.rawTxSocket.close();
        this.rawTxSocket = null;
      }

      if (this.hashBlockSocket) {
        await this.hashBlockSocket.close();
        this.hashBlockSocket = null;
      }

      this.logger.info('ZMQ listener stopped');

    } catch (error) {
      this.logger.error('Error stopping ZMQ listener', { error: error.message });
    }
  }

  // Health check
  isHealthy() {
    return this.isRunning && this.rawTxSocket && this.hashBlockSocket;
  }

  // Get listener stats
  getStats() {
    return {
      isRunning: this.isRunning,
      rawTxEndpoint: this.rawTxEndpoint,
      hashBlockEndpoint: this.hashBlockEndpoint,
      isHealthy: this.isHealthy()
    };
  }
}

module.exports = ZMQListener;
