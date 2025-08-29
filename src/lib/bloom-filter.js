const { BloomFilter } = require('bloom-filters');
const winston = require('winston');

class AddressBloomFilter {
  constructor(expectedElements = 1000000, falsePositiveRate = 0.001) {
    this.expectedElements = expectedElements;
    this.falsePositiveRate = falsePositiveRate;
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
    // Create a new Bloom filter optimized for the expected number of addresses
    this.filter = new BloomFilter(this.expectedElements, this.falsePositiveRate);
    this.addressCount = 0;

    this.logger.info('Bloom filter initialized', {
      expectedElements: this.expectedElements,
      falsePositiveRate: this.falsePositiveRate,
      estimatedMemory: `${Math.round(this.filter.bitArray.length / 8 / 1024)} KB`
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
    const bitArray = this.filter.bitArray;
    const bitsSet = bitArray.reduce((count, byte) => {
      // Count bits set in each byte
      let bits = 0;
      let value = byte;
      while (value) {
        bits += value & 1;
        value >>= 1;
      }
      return count + bits;
    }, 0);

    const fillRatio = bitsSet / (bitArray.length * 8);
    const currentFalsePositiveRate = Math.pow(fillRatio, this.filter.hashFunctions);

    return {
      addressCount: this.addressCount,
      expectedElements: this.expectedElements,
      targetFalsePositiveRate: this.falsePositiveRate,
      currentFalsePositiveRate: currentFalsePositiveRate.toExponential(3),
      fillRatio: (fillRatio * 100).toFixed(2) + '%',
      memoryUsageKB: Math.round(bitArray.length / 8 / 1024),
      hashFunctions: this.filter.hashFunctions,
      bitsPerElement: Math.round((bitArray.length * 8) / this.addressCount) || 0
    };
  }

  /**
   * Export bloom filter state for persistence
   * @returns {Object} - Serializable filter state
   */
  export() {
    return {
      expectedElements: this.expectedElements,
      falsePositiveRate: this.falsePositiveRate,
      addressCount: this.addressCount,
      bitArray: Array.from(this.filter.bitArray),
      hashFunctions: this.filter.hashFunctions,
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

    this.expectedElements = state.expectedElements;
    this.falsePositiveRate = state.falsePositiveRate;
    this.addressCount = state.addressCount;

    // Reconstruct the bloom filter
    this.filter = new BloomFilter(this.expectedElements, this.falsePositiveRate);

    if (state.bitArray && Array.isArray(state.bitArray)) {
      this.filter.bitArray = new Uint8Array(state.bitArray);
    }

    this.logger.info('Bloom filter imported from state', {
      addressCount: this.addressCount,
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
    const stats = this.getStats();
    const currentFP = parseFloat(stats.currentFalsePositiveRate);

    // Rebuild if current false positive rate is 10x higher than target
    return currentFP > (this.falsePositiveRate * 10);
  }

  /**
   * Estimate optimal parameters for a given number of addresses
   * @param {number} numAddresses - Expected number of addresses
   * @param {number} targetFPR - Target false positive rate (default: 0.001)
   * @returns {Object} - Optimal parameters
   */
  static getOptimalParameters(numAddresses, targetFPR = 0.001) {
    // Optimal number of hash functions: k = (m/n) * ln(2)
    // Optimal number of bits: m = -(n * ln(p)) / (ln(2)^2)

    const optimalBits = Math.ceil(-(numAddresses * Math.log(targetFPR)) / (Math.log(2) ** 2));
    const optimalHashFunctions = Math.ceil((optimalBits / numAddresses) * Math.log(2));
    const memoryKB = Math.ceil(optimalBits / 8 / 1024);

    return {
      expectedElements: numAddresses,
      falsePositiveRate: targetFPR,
      optimalBits,
      optimalHashFunctions,
      estimatedMemoryKB: memoryKB
    };
  }
}

module.exports = AddressBloomFilter;
