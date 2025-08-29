#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs').promises;
// const path = require('path'); // Not currently used
const winston = require('winston');

const MongoDB = require('../src/db/mongodb');
const DepositDetector = require('../src/services/deposit-detector');
const BSVUtils = require('../src/lib/bitcoin-utils');

class AddressImporter {
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
    this.depositDetector = null;
    this.bsvUtils = new BSVUtils();
  }

  async initialize() {
    // Initialize database
    this.db = new MongoDB();
    await this.db.connect();

    // Initialize deposit detector
    this.depositDetector = new DepositDetector(this.db);
    await this.depositDetector.initialize();
  }

  /**
   * Import addresses from various formats
   * @param {string} inputPath - Path to input file
   * @param {string} format - Format type (json, csv, txt)
   * @param {Object} options - Import options
   */
  async importAddresses(inputPath, format = 'json', options = {}) {
    try {
      this.logger.info('Starting address import', { inputPath, format, options });

      // Read and parse input file
      const addresses = await this.parseInputFile(inputPath, format);

      this.logger.info('Parsed input file', {
        addressCount: addresses.length,
        format
      });

      // Validate addresses
      const validatedAddresses = await this.validateAddresses(addresses);

      // Batch import addresses
      const results = await this.batchImportAddresses(validatedAddresses, options.batchSize || 1000);

      this.logger.info('Address import completed', results);

      return results;

    } catch (error) {
      this.logger.error('Address import failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Parse input file based on format
   * @param {string} filePath - Path to input file
   * @param {string} format - File format
   * @returns {Array} - Array of address data
   */
  async parseInputFile(filePath, format) {
    const content = await fs.readFile(filePath, 'utf8');

    switch (format.toLowerCase()) {
      case 'json':
        return this.parseJSON(content);
      case 'csv':
        return this.parseCSV(content);
      case 'txt':
        return this.parseTXT(content);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Parse JSON format
   * Expected: [{"address": "...", "user_id": "...", "metadata": {...}}, ...]
   */
  parseJSON(content) {
    try {
      const data = JSON.parse(content);

      if (!Array.isArray(data)) {
        throw new Error('JSON must be an array of address objects');
      }

      return data.map((item, index) => {
        if (!item.address) {
          throw new Error(`Missing address at index ${index}`);
        }

        return {
          address: item.address,
          user_id: item.user_id || `imported_user_${Date.now()}_${index}`,
          metadata: {
            imported_at: new Date(),
            source: 'json_import',
            ...item.metadata
          }
        };
      });

    } catch (error) {
      throw new Error(`JSON parsing failed: ${error.message}`);
    }
  }

  /**
   * Parse CSV format
   * Expected columns: address,user_id,metadata_json
   */
  parseCSV(content) {
    try {
      const lines = content.trim().split('\n');
      const addresses = [];

      // Skip header if present
      const startIndex = lines[0].toLowerCase().includes('address') ? 1 : 0;

      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) {continue;}

        const parts = line.split(',').map(part => part.trim());

        if (parts.length < 1) {
          this.logger.warn(`Skipping invalid CSV line ${i + 1}: ${line}`);
          continue;
        }

        const address = parts[0];
        const userId = parts[1] || `imported_user_${Date.now()}_${i}`;
        let metadata = { imported_at: new Date(), source: 'csv_import' };

        // Parse metadata JSON if provided
        if (parts[2]) {
          try {
            metadata = { ...metadata, ...JSON.parse(parts[2]) };
          } catch (metaError) {
            this.logger.warn(`Invalid metadata JSON at line ${i + 1}, using defaults`);
          }
        }

        addresses.push({ address, user_id: userId, metadata });
      }

      return addresses;

    } catch (error) {
      throw new Error(`CSV parsing failed: ${error.message}`);
    }
  }

  /**
   * Parse TXT format (one address per line)
   */
  parseTXT(content) {
    try {
      const lines = content.trim().split('\n');
      const addresses = [];

      for (let i = 0; i < lines.length; i++) {
        const address = lines[i].trim();
        if (!address || address.startsWith('#')) {continue;} // Skip empty lines and comments

        addresses.push({
          address,
          user_id: `imported_user_${Date.now()}_${i}`,
          metadata: {
            imported_at: new Date(),
            source: 'txt_import',
            line_number: i + 1
          }
        });
      }

      return addresses;

    } catch (error) {
      throw new Error(`TXT parsing failed: ${error.message}`);
    }
  }

  /**
   * Validate addresses before import
   * @param {Array} addresses - Address data to validate
   * @returns {Array} - Validated address data
   */
  validateAddresses(addresses) {
    const validated = [];
    const errors = [];

    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];

      try {
        // Validate address format
        if (!this.bsvUtils.isValidAddress(addr.address)) {
          throw new Error('Invalid BSV address format');
        }

        // Validate user_id
        if (!addr.user_id || typeof addr.user_id !== 'string') {
          throw new Error('Missing or invalid user_id');
        }

        validated.push(addr);

      } catch (error) {
        errors.push({
          index: i,
          address: addr.address,
          error: error.message
        });
      }
    }

    if (errors.length > 0) {
      this.logger.warn('Address validation errors', {
        totalErrors: errors.length,
        errors: errors.slice(0, 10) // Show first 10 errors
      });

      if (errors.length === addresses.length) {
        throw new Error('All addresses failed validation');
      }
    }

    this.logger.info('Address validation completed', {
      total: addresses.length,
      valid: validated.length,
      invalid: errors.length
    });

    return validated;
  }

  /**
   * Import addresses in batches
   * @param {Array} addresses - Validated address data
   * @param {number} batchSize - Batch size for imports
   * @returns {Object} - Import results
   */
  async batchImportAddresses(addresses, batchSize = 1000) {
    const totalBatches = Math.ceil(addresses.length / batchSize);
    let totalInserted = 0;
    let totalDuplicates = 0;

    this.logger.info('Starting batch import', {
      totalAddresses: addresses.length,
      batchSize,
      totalBatches
    });

    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, addresses.length);
      const batch = addresses.slice(start, end);

      try {
        const result = await this.depositDetector.addAddresses(batch);

        totalInserted += result.inserted;
        totalDuplicates += result.duplicates;

        this.logger.info(`Batch ${i + 1}/${totalBatches} imported`, {
          batchSize: batch.length,
          inserted: result.inserted,
          duplicates: result.duplicates,
          progress: `${Math.round(((i + 1) / totalBatches) * 100)}%`
        });

      } catch (error) {
        this.logger.error(`Batch ${i + 1} failed`, { error: error.message });
        throw error;
      }
    }

    return {
      totalAddresses: addresses.length,
      totalInserted,
      totalDuplicates,
      bloomFilterStats: (await this.depositDetector.getStats()).bloomFilter
    };
  }

  /**
   * Generate sample address files for testing
   * @param {number} count - Number of addresses to generate
   * @param {string} format - Output format (json, csv, txt)
   * @param {string} outputPath - Output file path
   */
  async generateSampleAddresses(count, format, outputPath) {
    this.logger.info('Generating sample addresses', { count, format, outputPath });

    const addresses = [];

    // Generate sample addresses (these are not real, just for testing format)
    for (let i = 0; i < count; i++) {
      addresses.push({
        address: `1SampleAddress${i.toString().padStart(8, '0')}ABCDEF`,
        user_id: `user_${i}`,
        metadata: {
          generated: true,
          index: i,
          created_at: new Date().toISOString()
        }
      });
    }

    let content;
    switch (format.toLowerCase()) {
      case 'json':
        content = JSON.stringify(addresses, null, 2);
        break;
      case 'csv':
        content = 'address,user_id,metadata_json\n';
        content += addresses.map(addr =>
          `${addr.address},${addr.user_id},"${JSON.stringify(addr.metadata).replace(/"/g, '""')}"`
        ).join('\n');
        break;
      case 'txt':
        content = addresses.map(addr => addr.address).join('\n');
        break;
      default:
        throw new Error(`Unsupported format: ${format}`);
    }

    await fs.writeFile(outputPath, content, 'utf8');
    this.logger.info('Sample addresses generated', { outputPath });
  }

  async cleanup() {
    if (this.db) {
      await this.db.disconnect();
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage: node import-addresses.js <command> [options]

Commands:
  import <file> [format] [batchSize]  - Import addresses from file
  generate <count> [format] <output>  - Generate sample addresses
  
Examples:
  node import-addresses.js import addresses.json
  node import-addresses.js import addresses.csv csv 500
  node import-addresses.js generate 1000 json sample.json
    `);
    process.exit(1);
  }

  const importer = new AddressImporter();

  try {
    const command = args[0];

    if (command === 'import') {
      const filePath = args[1];
      const format = args[2] || 'json';
      const batchSize = args[3] ? parseInt(args[3]) : 1000;

      if (!filePath) {
        throw new Error('Input file path required');
      }

      await importer.initialize();
      const results = await importer.importAddresses(filePath, format, { batchSize });

      console.log('\nImport Results:');
      console.log(`Total addresses: ${results.totalAddresses}`);
      console.log(`Successfully imported: ${results.totalInserted}`);
      console.log(`Duplicates skipped: ${results.totalDuplicates}`);

    } else if (command === 'generate') {
      const count = parseInt(args[1]);
      const format = args[2] || 'json';
      const outputPath = args[3];

      if (!count || !outputPath) {
        throw new Error('Count and output path required');
      }

      await importer.generateSampleAddresses(count, format, outputPath);

    } else {
      throw new Error(`Unknown command: ${command}`);
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await importer.cleanup();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = AddressImporter;
