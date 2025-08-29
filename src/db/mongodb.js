const { MongoClient } = require('mongodb');
const winston = require('winston');

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
      const url = process.env.MONGODB_URL || 'mongodb://localhost:27017';
      const dbName = process.env.MONGODB_DB_NAME || 'bsv_tracker';

      this.client = new MongoClient(url);
      await this.client.connect();
      this.db = this.client.db(dbName);

      this.logger.info('Connected to MongoDB', { url, dbName });

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
    // Create collections if they don't exist
    const collections = ['blocks', 'deposit_addresses', 'active_transactions', 'archived_transactions'];

    for (const collectionName of collections) {
      try {
        await this.db.createCollection(collectionName);
        this.logger.debug(`Created collection: ${collectionName}`);
      } catch (error) {
        if (error.code !== 48) { // Collection already exists
          this.logger.error(`Failed to create collection ${collectionName}`, { error: error.message });
          throw error;
        }
      }
    }
  }

  async createIndexes() {
    try {
      // Blocks collection indexes
      await this.db.collection('blocks').createIndexes([
        { key: { height: 1 }, name: 'height_1', unique: true },
        { key: { hash: 1 }, name: 'hash_1', unique: true },
        { key: { is_main_chain: 1 }, name: 'is_main_chain_1' },
        { key: { height: 1, is_main_chain: 1 }, name: 'height_main_chain_1' }
      ]);

      // Active transactions indexes
      await this.db.collection('active_transactions').createIndexes([
        { key: { block_height: 1 }, name: 'block_height_1' },
        { key: { addresses: 1 }, name: 'addresses_1' },
        { key: { status: 1 }, name: 'status_1' },
        { key: { confirmations: 1 }, name: 'confirmations_1' },
        { key: { block_height: 1, status: 1 }, name: 'block_height_status_1' }
      ]);

      // Deposit addresses indexes (natural _id index is sufficient for address lookups)

      // Archived transactions indexes
      await this.db.collection('archived_transactions').createIndexes([
        { key: { address: 1 }, name: 'address_1' },
        { key: { archived_at: 1 }, name: 'archived_at_1' },
        { key: { block_height: 1 }, name: 'block_height_1' }
      ]);

      this.logger.info('Created database indexes successfully');
    } catch (error) {
      this.logger.error('Failed to create indexes', { error: error.message });
      throw error;
    }
  }

  // Collection getters for easy access
  get blocks() {
    return this.db.collection('blocks');
  }

  get depositAddresses() {
    return this.db.collection('deposit_addresses');
  }

  get activeTransactions() {
    return this.db.collection('active_transactions');
  }

  get archivedTransactions() {
    return this.db.collection('archived_transactions');
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

module.exports = MongoDB;
