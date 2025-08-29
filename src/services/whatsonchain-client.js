import winston from 'winston';
import PQueue from 'p-queue';

class WhatsOnChainClient {
  constructor() {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    // Configuration - accept mainnet/testnet and map to WoC's main/test
    const envNetwork = process.env.BSV_NETWORK || 'mainnet';
    this.network = this.mapNetworkName(envNetwork);
    this.baseUrl = this.getBaseUrl();
    this.rateLimit = parseInt(process.env.WOC_RATE_LIMIT_MS) || 1000; // 1 request per second to be safe

    // Rate limiting queue - max 1 concurrent request with 1 second intervals
    this.queue = new PQueue({
      concurrency: 1,
      interval: this.rateLimit,
      intervalCap: 1
    });

    this.logger.info('WhatsOnChain client initialized', {
      network: this.network,
      baseUrl: this.baseUrl,
      rateLimit: this.rateLimit
    });
  }

  /**
   * Map our network names to WhatsOnChain API names
   * @param {string} envNetwork - Network from environment (mainnet/testnet)
   * @returns {string} - WhatsOnChain network name (main/test)
   */
  mapNetworkName(envNetwork) {
    switch (envNetwork.toLowerCase()) {
      case 'testnet':
        return 'test';
      case 'mainnet':
      default:
        return 'main';
    }
  }

  getBaseUrl() {
    return this.network === 'test'
      ? 'https://api.whatsonchain.com/v1/bsv/test'
      : 'https://api.whatsonchain.com/v1/bsv/main';
  }

  /**
   * Make a rate-limited request to WhatsOnChain API
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Fetch options
   * @returns {Object} - API response
   */
  makeRequest(endpoint, options = {}) {
    return this.queue.add(async () => {
      const url = `${this.baseUrl}${endpoint}`;

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'BSV-Address-Tracker/1.0',
            ...options.headers
          },
          ...options
        });

        if (!response.ok) {
          // Handle specific error codes
          if (response.status === 429) {
            throw new Error('Rate limit exceeded');
          }
          if (response.status === 404) {
            return null; // Address not found or no history
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data;

      } catch (error) {
        this.logger.error('WhatsOnChain API request failed', {
          url,
          error: error.message
        });
        throw error;
      }
    });
  }

  /**
   * Get confirmed transaction history for multiple addresses (bulk endpoint)
   * @param {string[]} addresses - Array of addresses (max 20 according to docs)
   * @returns {Object} - Address history mapping
   */
  async getBulkAddressHistory(addresses) {
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return {};
    }

    if (addresses.length > 20) {
      throw new Error('WhatsOnChain bulk endpoint supports maximum 20 addresses');
    }

    try {
      const addressList = addresses.join(',');
      const endpoint = `/addresses/${addressList}/history`;

      this.logger.debug('Fetching bulk address history', {
        addresses: addresses.length,
        endpoint
      });

      const response = await this.makeRequest(endpoint);

      if (!response) {
        return {};
      }

      // Response format: { "address1": [...transactions], "address2": [...transactions] }
      return response;

    } catch (error) {
      this.logger.error('Failed to fetch bulk address history', {
        addresses,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get confirmed transaction history for a single address with pagination
   * @param {string} address - BSV address
   * @param {number} from - Starting index (default: 0)
   * @param {number} to - Ending index (default: 100, max: 1000)
   * @returns {Array} - Transaction history
   */
  async getAddressHistory(address, from = 0, to = 100) {
    try {
      const endpoint = `/address/${address}/history`;
      const params = new URLSearchParams({ from: from.toString(), to: to.toString() });

      this.logger.debug('Fetching single address history', {
        address,
        from,
        to
      });

      const response = await this.makeRequest(`${endpoint}?${params}`);

      return response || [];

    } catch (error) {
      this.logger.error('Failed to fetch address history', {
        address,
        from,
        to,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get all confirmed transaction history for an address (with automatic pagination)
   * @param {string} address - BSV address
   * @param {number} maxTransactions - Maximum transactions to fetch (default: 10000)
   * @returns {Array} - Complete transaction history
   */
  async getAllAddressHistory(address, maxTransactions = 10000) {
    const allTransactions = [];
    let from = 0;
    const batchSize = 1000; // Max allowed by API

    try {
      while (from < maxTransactions) {
        const to = Math.min(from + batchSize - 1, maxTransactions - 1);

        const batch = await this.getAddressHistory(address, from, to);

        if (!batch || batch.length === 0) {
          break; // No more transactions
        }

        allTransactions.push(...batch);

        // If we got fewer transactions than requested, we've reached the end
        if (batch.length < batchSize) {
          break;
        }

        from = to + 1;

        this.logger.debug('Fetched address history batch', {
          address,
          batchSize: batch.length,
          totalFetched: allTransactions.length
        });
      }

      this.logger.info('Completed address history fetch', {
        address,
        totalTransactions: allTransactions.length
      });

      return allTransactions;

    } catch (error) {
      this.logger.error('Failed to fetch complete address history', {
        address,
        partialResults: allTransactions.length,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get transaction details by transaction ID
   * @param {string} txid - Transaction ID
   * @returns {Object|null} - Transaction details
   */
  async getTransaction(txid) {
    try {
      const endpoint = `/tx/${txid}`;
      const response = await this.makeRequest(endpoint);
      return response;

    } catch (error) {
      this.logger.error('Failed to fetch transaction', {
        txid,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get raw transaction hex by transaction ID
   * @param {string} txid - Transaction ID
   * @returns {string|null} - Raw transaction hex
   */
  async getRawTransaction(txid) {
    try {
      const endpoint = `/tx/${txid}/hex`;
      const response = await this.makeRequest(endpoint);
      return response;

    } catch (error) {
      this.logger.error('Failed to fetch raw transaction', {
        txid,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get current blockchain info
   * @returns {Object} - Blockchain information
   */
  async getChainInfo() {
    try {
      const endpoint = '/chain/info';
      const response = await this.makeRequest(endpoint);
      return response;

    } catch (error) {
      this.logger.error('Failed to fetch chain info', { error: error.message });
      throw error;
    }
  }

  /**
   * Get address balance and transaction count
   * @param {string} address - BSV address
   * @returns {Object|null} - Address balance info
   */
  async getAddressInfo(address) {
    try {
      const endpoint = `/address/${address}/balance`;
      const response = await this.makeRequest(endpoint);
      return response;

    } catch (error) {
      this.logger.error('Failed to fetch address info', {
        address,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process addresses in optimal batches using bulk endpoint where possible
   * @param {string[]} addresses - Array of addresses to process
   * @param {Function} processor - Function to process each batch result
   * @returns {Array} - Processing results
   */
  async processBulkAddresses(addresses, processor) {
    const results = [];
    const batchSize = 20; // WhatsOnChain bulk limit

    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);

      try {
        this.logger.debug('Processing address batch', {
          batchIndex: Math.floor(i / batchSize) + 1,
          totalBatches: Math.ceil(addresses.length / batchSize),
          batchSize: batch.length
        });

        const historyData = await this.getBulkAddressHistory(batch);
        const batchResult = await processor(historyData, batch);

        if (Array.isArray(batchResult)) {
          results.push(...batchResult);
        } else {
          results.push(batchResult);
        }

      } catch (error) {
        this.logger.error('Failed to process address batch', {
          batch,
          error: error.message
        });

        // Fall back to individual processing for this batch
        for (const address of batch) {
          try {
            const history = await this.getAllAddressHistory(address);
            const singleResult = await processor({ [address]: history }, [address]);

            if (Array.isArray(singleResult)) {
              results.push(...singleResult);
            } else {
              results.push(singleResult);
            }

          } catch (singleError) {
            this.logger.error('Failed to process single address fallback', {
              address,
              error: singleError.message
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Get queue statistics
   * @returns {Object} - Queue statistics
   */
  getStats() {
    return {
      network: this.network,
      baseUrl: this.baseUrl,
      rateLimit: this.rateLimit,
      queue: {
        size: this.queue.size,
        pending: this.queue.pending,
        isPaused: this.queue.isPaused
      }
    };
  }

  /**
   * Test API connectivity
   * @returns {boolean} - Connection status
   */
  async ping() {
    try {
      await this.getChainInfo();
      return true;
    } catch (error) {
      this.logger.error('WhatsOnChain API ping failed', { error: error.message });
      return false;
    }
  }

  /**
   * Pause the request queue
   */
  pause() {
    this.queue.pause();
    this.logger.info('WhatsOnChain request queue paused');
  }

  /**
   * Resume the request queue
   */
  resume() {
    this.queue.start();
    this.logger.info('WhatsOnChain request queue resumed');
  }

  /**
   * Clear the request queue
   */
  clear() {
    this.queue.clear();
    this.logger.info('WhatsOnChain request queue cleared');
  }
}

export default WhatsOnChainClient;
