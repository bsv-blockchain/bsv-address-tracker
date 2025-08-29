import Fastify from 'fastify';
import winston from 'winston';

class APIServer {
  constructor(mongodb, transactionTracker, confirmationTracker, addressHistoryFetcher) {
    this.db = mongodb;
    this.transactionTracker = transactionTracker;
    this.confirmationTracker = confirmationTracker;
    this.addressHistoryFetcher = addressHistoryFetcher;

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    this.fastify = Fastify({
      logger: false, // We use winston instead
      trustProxy: true
    });

    this.setupRoutes();
  }

  setupRoutes() {
    // Health check
    this.fastify.get('/health', async (request, reply) => {
      return { status: 'ok', timestamp: new Date() };
    });

    // Add addresses to monitor
    this.fastify.post('/addresses', async (request, reply) => {
      try {
        const { addresses } = request.body;
        
        if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
          return reply.code(400).send({ 
            error: 'Invalid request', 
            message: 'Must provide an array of addresses' 
          });
        }

        // Validate addresses
        const validAddresses = [];
        const invalidAddresses = [];

        for (const address of addresses) {
          if (typeof address === 'string' && address.length > 0) {
            validAddresses.push(address);
          } else {
            invalidAddresses.push(address);
          }
        }

        if (validAddresses.length === 0) {
          return reply.code(400).send({ 
            error: 'No valid addresses', 
            invalidAddresses 
          });
        }

        // Add addresses to database
        const results = [];
        const alreadyExist = [];
        
        for (const address of validAddresses) {
          try {
            const existing = await this.db.trackedAddresses.findOne({ _id: address });
            
            if (existing) {
              alreadyExist.push(address);
            } else {
              await this.db.trackedAddresses.insertOne({
                _id: address,
                created_at: new Date(),
                active: true,
                total_received: 0,
                transaction_count: 0,
                last_seen: null,
                label: null,
                metadata: {}
              });
              results.push(address);
            }
          } catch (error) {
            this.logger.error('Failed to add address', { address, error: error.message });
            invalidAddresses.push(address);
          }
        }

        // Rebuild bloom filter to include new addresses
        if (results.length > 0 && this.transactionTracker) {
          await this.transactionTracker.rebuildBloomFilter();
        }

        // Fetch historical data for new addresses
        if (results.length > 0 && this.addressHistoryFetcher) {
          this.addressHistoryFetcher.fetchHistoricalTransactions(results).catch(error => {
            this.logger.error('Failed to fetch historical data', { error: error.message });
          });
        }

        this.logger.info('Addresses added', {
          added: results.length,
          alreadyExisted: alreadyExist.length,
          invalid: invalidAddresses.length
        });

        return {
          success: true,
          added: results,
          alreadyExist,
          invalid: invalidAddresses,
          summary: {
            totalRequested: addresses.length,
            added: results.length,
            alreadyExisted: alreadyExist.length,
            invalid: invalidAddresses.length
          }
        };

      } catch (error) {
        this.logger.error('Failed to add addresses', { error: error.message });
        return reply.code(500).send({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Get all monitored addresses
    this.fastify.get('/addresses', async (request, reply) => {
      try {
        const { active, limit = 100, offset = 0 } = request.query;
        
        const filter = {};
        if (active !== undefined) {
          filter.active = active === 'true';
        }

        const addresses = await this.db.trackedAddresses
          .find(filter)
          .limit(parseInt(limit))
          .skip(parseInt(offset))
          .toArray();

        const total = await this.db.trackedAddresses.countDocuments(filter);

        return {
          addresses: addresses.map(addr => ({
            address: addr._id,
            active: addr.active,
            created_at: addr.created_at,
            total_received: addr.total_received,
            transaction_count: addr.transaction_count,
            last_seen: addr.last_seen,
            label: addr.label
          })),
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset),
            total
          }
        };

      } catch (error) {
        this.logger.error('Failed to get addresses', { error: error.message });
        return reply.code(500).send({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Get address details
    this.fastify.get('/addresses/:address', async (request, reply) => {
      try {
        const { address } = request.params;
        
        const addressDoc = await this.db.trackedAddresses.findOne({ _id: address });
        
        if (!addressDoc) {
          return reply.code(404).send({ 
            error: 'Address not found',
            address 
          });
        }

        // Get recent transactions
        const recentTransactions = await this.db.activeTransactions
          .find({ addresses: address })
          .sort({ first_seen: -1 })
          .limit(10)
          .toArray();

        return {
          address: addressDoc._id,
          active: addressDoc.active,
          created_at: addressDoc.created_at,
          total_received: addressDoc.total_received,
          transaction_count: addressDoc.transaction_count,
          last_seen: addressDoc.last_seen,
          label: addressDoc.label,
          metadata: addressDoc.metadata,
          recent_transactions: recentTransactions.map(tx => ({
            txid: tx._id,
            amount: tx.amount,
            confirmations: tx.confirmations,
            status: tx.status,
            first_seen: tx.first_seen,
            block_height: tx.block_height
          }))
        };

      } catch (error) {
        this.logger.error('Failed to get address details', { error: error.message });
        return reply.code(500).send({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Remove address from monitoring
    this.fastify.delete('/addresses/:address', async (request, reply) => {
      try {
        const { address } = request.params;
        
        const result = await this.db.trackedAddresses.updateOne(
          { _id: address },
          { $set: { active: false, deactivated_at: new Date() } }
        );
        
        if (result.matchedCount === 0) {
          return reply.code(404).send({ 
            error: 'Address not found',
            address 
          });
        }

        // Rebuild bloom filter to exclude deactivated address
        if (this.transactionTracker) {
          await this.transactionTracker.rebuildBloomFilter();
        }

        this.logger.info('Address deactivated', { address });

        return {
          success: true,
          address,
          message: 'Address deactivated from monitoring'
        };

      } catch (error) {
        this.logger.error('Failed to deactivate address', { error: error.message });
        return reply.code(500).send({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Get active transactions
    this.fastify.get('/transactions', async (request, reply) => {
      try {
        const { status, limit = 50, offset = 0 } = request.query;
        
        const filter = {};
        if (status) {
          filter.status = status;
        }

        const transactions = await this.db.activeTransactions
          .find(filter)
          .sort({ first_seen: -1 })
          .limit(parseInt(limit))
          .skip(parseInt(offset))
          .toArray();

        const total = await this.db.activeTransactions.countDocuments(filter);

        return {
          transactions: transactions.map(tx => ({
            txid: tx._id,
            addresses: tx.addresses,
            amount: tx.amount,
            confirmations: tx.confirmations,
            status: tx.status,
            first_seen: tx.first_seen,
            block_height: tx.block_height,
            outputs: tx.outputs
          })),
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset),
            total
          }
        };

      } catch (error) {
        this.logger.error('Failed to get transactions', { error: error.message });
        return reply.code(500).send({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });

    // Get system statistics
    this.fastify.get('/stats', async (request, reply) => {
      try {
        const stats = {
          addresses: {
            total: await this.db.trackedAddresses.countDocuments(),
            active: await this.db.trackedAddresses.countDocuments({ active: true })
          },
          transactions: {
            pending: await this.db.activeTransactions.countDocuments({ status: 'pending' }),
            confirming: await this.db.activeTransactions.countDocuments({ status: 'confirming' }),
            archived: await this.db.archivedTransactions.countDocuments()
          }
        };

        if (this.confirmationTracker) {
          const confirmationStats = await this.confirmationTracker.getStats();
          stats.confirmationTracker = confirmationStats;
        }

        if (this.transactionTracker) {
          const trackerStats = await this.transactionTracker.getStats();
          stats.transactionTracker = trackerStats;
        }

        return stats;

      } catch (error) {
        this.logger.error('Failed to get stats', { error: error.message });
        return reply.code(500).send({ 
          error: 'Internal server error',
          message: error.message 
        });
      }
    });
  }

  async start(port = 3000, host = '0.0.0.0') {
    try {
      await this.fastify.listen({ port, host });
      this.logger.info('API server started', { port, host });
      return true;
    } catch (error) {
      this.logger.error('Failed to start API server', { error: error.message });
      throw error;
    }
  }

  async stop() {
    try {
      await this.fastify.close();
      this.logger.info('API server stopped');
    } catch (error) {
      this.logger.error('Error stopping API server', { error: error.message });
    }
  }
}

export default APIServer;