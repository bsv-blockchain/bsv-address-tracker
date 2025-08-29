import pkg from 'bloom-filters';
const { ScalableBloomFilter } = pkg;
import winston from 'winston';

class AddressBloomFilter {
  constructor(falsePositiveRate = 0.001, initialCapacity = 1000) {
    this.falsePositiveRate = falsePositiveRate;
    this.initialCapacity = initialCapacity;
    this.filter = null;
    this.addressCount = 0;

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    this.initialize();
  }

  initialize() {
    // Always use scalable bloom filter for dynamic address sets
    this.filter = new ScalableBloomFilter(this.initialCapacity, this.falsePositiveRate);
    this.addressCount = 0;

    this.logger.info('Scalable bloom filter initialized', {
      initialCapacity: this.initialCapacity,
      falsePositiveRate: this.falsePositiveRate
    });
  }

  /**
   * Add an address to the bloom filter
   * @param {string} address - BSV address to add
   */
  addAddress(address) {
    if (!address || typeof address !== 'string') {
      throw new Error('Address must be a non-empty string');
    }

    this.filter.add(address);
    this.addressCount++;
  }

  /**
   * Add multiple addresses efficiently
   * @param {string[]} addresses - Array of BSV addresses
   */
  addAddresses(addresses) {
    if (!Array.isArray(addresses)) {
      throw new Error('Addresses must be an array');
    }

    const startTime = Date.now();
    let added = 0;

    for (const address of addresses) {
      if (address && typeof address === 'string') {
        this.filter.add(address);
        added++;
      } else {
        this.logger.warn('Skipped invalid address', { address });
      }
    }

    this.addressCount += added;
    const duration = Date.now() - startTime;

    this.logger.info('Bulk addresses added to bloom filter', {
      totalAdded: added,
      skipped: addresses.length - added,
      durationMs: duration,
      totalAddresses: this.addressCount
    });
  }

  /**
   * Check if an address might be in our watch list
   * @param {string} address - BSV address to check
   * @returns {boolean} - true if address might be in filter (could be false positive)
   */
  mightContain(address) {
    if (!address || typeof address !== 'string') {
      return false;
    }

    return this.filter.has(address);
  }

  /**
   * Check multiple addresses at once
   * @param {string[]} addresses - Array of addresses to check
   * @returns {string[]} - Array of addresses that might be in the filter
   */
  filterAddresses(addresses) {
    if (!Array.isArray(addresses)) {
      return [];
    }

    const possibleMatches = [];

    for (const address of addresses) {
      if (this.mightContain(address)) {
        possibleMatches.push(address);
      }
    }

    return possibleMatches;
  }

  /**
   * Get statistics about the bloom filter
   */
  getStats() {
    return {
      addressCount: this.addressCount,
      initialCapacity: this.initialCapacity,
      targetFalsePositiveRate: this.falsePositiveRate,
      currentFalsePositiveRate: this.filter.rate(),
      capacity: this.filter.capacity(),
      filterType: 'scalable'
    };
  }

  /**
   * Export bloom filter state for persistence
   * @returns {Object} - Serializable filter state
   */
  export() {
    return {
      falsePositiveRate: this.falsePositiveRate,
      initialCapacity: this.initialCapacity,
      addressCount: this.addressCount,
      filterData: this.filter.saveAsJSON ? this.filter.saveAsJSON() : null,
      exportedAt: new Date()
    };
  }

  /**
   * Import bloom filter state from persistence
   * @param {Object} state - Previously exported filter state
   */
  import(state) {
    if (!state || typeof state !== 'object') {
      throw new Error('Invalid filter state for import');
    }

    this.falsePositiveRate = state.falsePositiveRate;
    this.initialCapacity = state.initialCapacity || 1000;
    this.addressCount = state.addressCount;

    // Import scalable filter
    if (state.filterData && ScalableBloomFilter.fromJSON) {
      this.filter = ScalableBloomFilter.fromJSON(state.filterData);
    } else {
      // Fallback: create new scalable filter
      this.filter = new ScalableBloomFilter(this.initialCapacity, this.falsePositiveRate);
    }

    this.logger.info('Scalable bloom filter imported from state', {
      addressCount: this.addressCount,
      initialCapacity: this.initialCapacity,
      importedAt: new Date(),
      originalExportDate: state.exportedAt
    });
  }

  /**
   * Reset the bloom filter (clear all addresses)
   */
  reset() {
    this.initialize();
    this.logger.info('Bloom filter reset');
  }

  /**
   * Check if the filter should be rebuilt due to high false positive rate
   * @returns {boolean} - true if rebuild is recommended
   */
  shouldRebuild() {
    // Scalable filters auto-manage their FPR, rarely need rebuilds
    const currentRate = this.filter.rate();
    return currentRate > (this.falsePositiveRate * 5);
  }

  /**
   * Get scalable bloom filter parameters
   * @param {number} targetFPR - Target false positive rate (default: 0.001)
   * @param {number} initialCapacity - Initial capacity (default: 1000)
   * @returns {Object} - Parameters for scalable filter
   */
  static getOptimalParameters(targetFPR = 0.001, initialCapacity = 1000) {
    return {
      falsePositiveRate: targetFPR,
      initialCapacity: initialCapacity
    };
  }
}

export default AddressBloomFilter;
