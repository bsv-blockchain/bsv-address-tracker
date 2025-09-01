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
    this.fastify.get('/health', (_request, _reply) => {
      return { status: 'ok', timestamp: new Date() };
    });

    // Add addresses to monitor
    this.fastify.post('/addresses', async (request, reply) => {
      try {
        const { addresses, force } = request.body;

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
        const forcedRefetch = [];

        for (const address of validAddresses) {
          try {
            const existing = await this.db.trackedAddresses.findOne({ _id: address });

            if (existing) {
              if (force) {
                // Reset historical fetch flags to force re-fetching
                await this.db.trackedAddresses.updateOne(
                  { _id: address },
                  {
                    $set: {
                      historical_fetched: false,
                      historical_fetched_at: null
                    }
                  }
                );
                forcedRefetch.push(address);
                this.logger.info('Forcing historical data refetch for existing address', { address });
              } else {
                alreadyExist.push(address);
              }
            } else {
              await this.db.trackedAddresses.insertOne({
                _id: address,
                created_at: new Date(),
                active: true,
                transaction_count: 0,
                last_seen: null,
                label: null,
                metadata: {},
                historical_fetched: false,
                historical_fetched_at: null
              });
              results.push(address);
            }
          } catch (error) {
            this.logger.error('Failed to add address', { address, error: error.message });
            invalidAddresses.push(address);
          }
        }

        // Add new addresses to the in-memory filter
        if (results.length > 0 && this.transactionTracker) {
          this.transactionTracker.addressFilter.addAddresses(results);
          this.logger.info('Added addresses to in-memory filter', {
            addresses: results,
            totalInFilter: this.transactionTracker.addressFilter.getStats().addressCount
          });
        }

        // Fetch historical data for new addresses and forced refetches
        const addressesToFetch = [...results, ...forcedRefetch];
        if (addressesToFetch.length > 0 && this.addressHistoryFetcher) {
          this.addressHistoryFetcher.fetchAddressHistories(addressesToFetch).catch(error => {
            this.logger.error('Failed to fetch historical data', { error: error.message });
          });
        }

        this.logger.info('Addresses processed', {
          added: results.length,
          alreadyExisted: alreadyExist.length,
          forcedRefetch: forcedRefetch.length,
          invalid: invalidAddresses.length,
          force: !!force
        });

        return {
          success: true,
          added: results,
          alreadyExist,
          forcedRefetch,
          invalid: invalidAddresses,
          summary: {
            totalRequested: addresses.length,
            added: results.length,
            alreadyExisted: alreadyExist.length,
            forcedRefetch: forcedRefetch.length,
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
          transaction_count: addressDoc.transaction_count,
          last_seen: addressDoc.last_seen,
          label: addressDoc.label,
          metadata: addressDoc.metadata,
          recent_transactions: recentTransactions.map(tx => ({
            txid: tx._id,
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

        // Remove address from filter
        if (this.transactionTracker && this.transactionTracker.addressFilter) {
          this.transactionTracker.addressFilter.removeAddress(address);
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
            confirmations: tx.confirmations,
            status: tx.status,
            first_seen: tx.first_seen,
            block_height: tx.block_height
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

    // Manual confirmation tracker trigger
    this.fastify.post('/trigger/confirmations', async (request, reply) => {
      try {
        if (!this.confirmationTracker) {
          return reply.code(503).send({
            error: 'Service unavailable',
            message: 'Confirmation tracker not available'
          });
        }

        this.logger.info('Manual confirmation tracker run triggered via API');

        // Get current block height and run the same logic as processNewBlock
        const currentHeight = await this.confirmationTracker.rpc.getBlockCount();

        this.logger.info('Running manual confirmation processing', { currentHeight });

        // Process in parallel for efficiency (same as processNewBlock)
        const [transactionStats, archiveStats] = await Promise.all([
          this.confirmationTracker.processAllTransactions(),
          this.confirmationTracker.checkAndArchiveTransactions(currentHeight)
        ]);

        // Process retry queue
        await this.confirmationTracker.processRetryQueue();

        const results = {
          currentHeight,
          transactionStats,
          archiveStats
        };

        return {
          success: true,
          message: 'Confirmation tracker run completed',
          results: results
        };

      } catch (error) {
        this.logger.error('Manual confirmation tracker run failed', { error: error.message });
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
