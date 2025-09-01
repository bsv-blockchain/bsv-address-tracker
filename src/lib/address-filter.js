import winston from 'winston';

class AddressFilter {
  constructor() {
    this.addresses = new Set();

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });
  }

  /**
   * Add an address to the filter
   * @param {string} address - BSV address to add
   */
  addAddress(address) {
    this.addresses.add(address);
  }

  /**
   * Remove an address from the filter
   * @param {string} address - BSV address to remove
   */
  removeAddress(address) {
    this.addresses.delete(address);
  }

  /**
   * Add multiple addresses efficiently
   * @param {string[]} addresses - Array of BSV addresses
   */
  addAddresses(addresses) {
    const startTime = Date.now();

    for (const address of addresses) {
      this.addresses.add(address);
    }

    const duration = Date.now() - startTime;

    this.logger.info('Bulk addresses added to filter', {
      totalAdded: addresses.length,
      durationMs: duration,
      totalAddresses: this.addresses.size
    });
  }

  /**
   * Check if an address is in our watch list
   * @param {string} address - BSV address to check
   * @returns {boolean} - true if address is in filter
   */
  contains(address) {
    if (!address || typeof address !== 'string') {
      return false;
    }

    return this.addresses.has(address);
  }

  /**
   * Check multiple addresses at once
   * @param {string[]} addresses - Array of addresses to check
   * @returns {string[]} - Array of addresses that are in the filter
   */
  filterAddresses(addresses) {
    if (!Array.isArray(addresses)) {
      return [];
    }

    const matches = [];

    for (const address of addresses) {
      if (this.contains(address)) {
        matches.push(address);
      }
    }

    return matches;
  }

  /**
   * Get statistics about the filter
   */
  getStats() {
    return {
      addressCount: this.addresses.size,
      filterType: 'set'
    };
  }

  /**
   * Load addresses from MongoDB
   * @param {Object} db - MongoDB database instance
   */
  async loadAddressesFromMongo(db) {
    const startTime = Date.now();
    this.logger.info('Loading tracked addresses from MongoDB...');

    try {
      const addresses = await db.collection('trackedAddresses').find(
        { active: true },
        { projection: { _id: 1 } }
      ).toArray();

      for (const doc of addresses) {
        this.addresses.add(doc._id); // _id contains the address
      }

      const duration = Date.now() - startTime;
      this.logger.info('Successfully loaded addresses from MongoDB', {
        addressCount: this.addresses.size,
        durationMs: duration
      });

      return this.addresses.size;
    } catch (error) {
      this.logger.error('Failed to load addresses from MongoDB', { error: error.message });
      throw error;
    }
  }
}

export default AddressFilter;
