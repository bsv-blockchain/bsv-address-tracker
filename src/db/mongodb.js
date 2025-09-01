import { MongoClient } from 'mongodb';
import winston from 'winston';

class MongoDB {
  constructor() {
    this.client = null;
    this.db = null;
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });
  }

  async connect() {
    try {
      const url = process.env.MONGODB_URL || 'mongodb://localhost:27017/bsv_tracker';

      this.client = new MongoClient(url);
      await this.client.connect();

      // Use the default database from the connection URL
      this.db = this.client.db();

      this.logger.info('Connected to MongoDB', { 
        url: url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'),
        database: this.db.databaseName 
      });

      // Create collections and indexes
      await this.setupCollections();
      await this.createIndexes();

      return this.db;
    } catch (error) {
      this.logger.error('Failed to connect to MongoDB', { error: error.message });
      throw error;
    }
  }

  async setupCollections() {
    // Define all collections used by the system
    const collections = [
      'trackedAddresses',    // Addresses being monitored
      'activeTransactions',  // Transactions with < 288 confirmations
      'archivedTransactions' // Fully confirmed transactions
    ];

    for (const collectionName of collections) {
      try {
        // Check if collection exists
        const existingCollections = await this.db.listCollections({ name: collectionName }).toArray();

        if (existingCollections.length === 0) {
          await this.db.createCollection(collectionName);
          this.logger.info(`Created collection: ${collectionName}`);
        } else {
          this.logger.debug(`Collection already exists: ${collectionName}`);
        }
      } catch (error) {
        this.logger.error(`Failed to create collection ${collectionName}`, { error: error.message });
        throw error;
      }
    }
  }

  async createIndexes() {
    try {
      // trackedAddresses indexes
      await this.db.collection('trackedAddresses').createIndexes([
        // _id is the address itself (natural index)
        { key: { active: 1 }, name: 'active_1' },
        { key: { created_at: 1 }, name: 'created_at_1' },
        { key: { historical_fetched: 1 }, name: 'historical_fetched_1' },
        // Compound index for finding unfetched active addresses
        { key: { active: 1, historical_fetched: 1 }, name: 'active_historical_fetched_1' }
      ]);

      // activeTransactions indexes
      await this.db.collection('activeTransactions').createIndexes([
        // _id is the transaction ID (natural index)
        { key: { addresses: 1 }, name: 'addresses_1' },
        { key: { status: 1 }, name: 'status_1' },
        { key: { block_height: 1 }, name: 'block_height_1' },
        { key: { confirmations: 1 }, name: 'confirmations_1' },
        { key: { first_seen: -1 }, name: 'first_seen_desc' },
        // Compound indexes for common queries
        { key: { block_height: 1, status: 1 }, name: 'block_height_status_1' },
        { key: { status: 1, block_height: 1 }, name: 'status_block_height_1' }
      ]);

      // archivedTransactions indexes
      await this.db.collection('archivedTransactions').createIndexes([
        // _id is the transaction ID (natural index)
        { key: { addresses: 1 }, name: 'addresses_1' },
        { key: { archived_at: -1 }, name: 'archived_at_desc' },
        { key: { block_height: 1 }, name: 'block_height_1' }
      ]);

      this.logger.info('Created database indexes successfully');
    } catch (error) {
      // Ignore "index already exists" errors
      if (error.code === 85 || error.codeName === 'IndexOptionsConflict') {
        this.logger.debug('Some indexes already exist, skipping');
      } else {
        this.logger.error('Failed to create indexes', { error: error.message });
        throw error;
      }
    }
  }

  // Collection getters for easy access
  get trackedAddresses() {
    return this.db.collection('trackedAddresses');
  }

  get activeTransactions() {
    return this.db.collection('activeTransactions');
  }

  get archivedTransactions() {
    return this.db.collection('archivedTransactions');
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.logger.info('Disconnected from MongoDB');
    }
  }

  // Health check method
  async ping() {
    try {
      await this.db.admin().ping();
      return true;
    } catch (error) {
      this.logger.error('MongoDB ping failed', { error: error.message });
      return false;
    }
  }

  // Get database stats
  async getStats() {
    try {
      const stats = await this.db.stats();
      return {
        collections: stats.collections,
        dataSize: stats.dataSize,
        indexSize: stats.indexSize,
        storageSize: stats.storageSize
      };
    } catch (error) {
      this.logger.error('Failed to get database stats', { error: error.message });
      return null;
    }
  }
}

export default MongoDB;
