import zmq from 'zeromq';
import winston from 'winston';

class ZMQListener {
  constructor(confirmationTracker, transactionTracker) {
    this.confirmationTracker = confirmationTracker;
    this.transactionTracker = transactionTracker;
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
    this.verboseLogging = process.env.ZMQ_VERBOSE_LOGGING === 'true';
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
        hashBlock: this.hashBlockEndpoint,
        verboseLogging: this.verboseLogging
      });

      this.isRunning = true;

      // Start listening for messages
      this.listenForRawTransactions();
      this.listenForBlockHashes();

      this.logger.info('ZMQ listener started successfully - waiting for messages...');

      if (this.verboseLogging) {
        this.logger.info('ZMQ: Subscribed to rawtx and hashblock topics');
      }

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

      if (this.verboseLogging) {
        this.logger.info('ZMQ: Received raw transaction', {
          txHex: txHex.substring(0, 64) + '...',
          size: rawTxBuffer.length,
          fullHex: this.verboseLogging ? txHex : undefined
        });
      } else {
        this.logger.debug('Received raw transaction', {
          txHex: txHex.substring(0, 64) + '...',
          size: rawTxBuffer.length
        });
      }

      // Process transaction to check if we're tracking any addresses
      if (this.transactionTracker && this.transactionTracker.isInitialized) {
        const txResult = await this.transactionTracker.processTransaction(txHex);

        if (txResult) {
          this.logger.info('Transaction tracked', {
            txid: txResult.txid,
            outputs: txResult.outputs,
            totalAmount: txResult.totalAmount,
            addresses: txResult.addresses
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

      if (this.verboseLogging) {
        this.logger.info('ZMQ: Received new block hash', {
          blockHash,
          size: blockHashBuffer.length
        });
      } else {
        this.logger.info('Received new block hash', { blockHash });
      }

      // Pass to confirmation tracker for processing
      if (this.confirmationTracker) {
        await this.confirmationTracker.processNewBlock({ hash: blockHash });
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

export default ZMQListener;
