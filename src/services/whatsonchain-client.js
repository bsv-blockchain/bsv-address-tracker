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
        // Log WoC request if verbose logging is enabled
        if (process.env.WOC_VERBOSE_LOGGING === 'true') {
          this.logger.info('WhatsOnChain request', { url });
        }

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
            if (process.env.WOC_VERBOSE_LOGGING === 'true') {
              this.logger.info('WhatsOnChain request completed', { url, status: '429 Rate Limited' });
            }
            throw new Error('Rate limit exceeded');
          }
          if (response.status === 404) {
            if (process.env.WOC_VERBOSE_LOGGING === 'true') {
              this.logger.info('WhatsOnChain request completed', { url, status: '404 Not Found' });
            }
            return null; // Address not found or no history
          }
          if (process.env.WOC_VERBOSE_LOGGING === 'true') {
            this.logger.info('WhatsOnChain request completed', { url, status: `${response.status} ${response.statusText}` });
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Log successful completion if verbose logging is enabled
        if (process.env.WOC_VERBOSE_LOGGING === 'true') {
          this.logger.info('WhatsOnChain request completed', { url, status: 'success' });
        }

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
   * DEPRECATED: Get confirmed transaction history for multiple addresses (bulk endpoint)
   * This method is deprecated in favor of individual address calls with pagination
   * @deprecated Use getAddressConfirmedHistoryWithPagination instead
   * @param {string[]} addresses - Array of addresses (max 20 according to docs)
   * @returns {Object} - Address history mapping
   */
  async getBulkAddressHistory(addresses) {
    this.logger.warn('getBulkAddressHistory is deprecated - use individual address calls instead');

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return {};
    }

    // Convert to individual calls for compatibility
    const historyMap = {};
    for (const address of addresses) {
      try {
        const history = await this.getAddressConfirmedHistoryWithPagination(address, 100);
        historyMap[address] = history;
      } catch (error) {
        this.logger.error('Failed to fetch individual address in deprecated bulk method', {
          address,
          error: error.message
        });
        historyMap[address] = [];
      }
    }

    return historyMap;
  }

  /**
   * Get confirmed transaction history for a single address with pagination
   * @param {string} address - BSV address
   * @param {string} token - Next page token (optional)
   * @returns {Object} - Transaction history with pagination info
   */
  async getAddressConfirmedHistory(address, token = null) {
    try {
      const endpoint = `/address/${address}/confirmed/history`;
      const params = new URLSearchParams();
      if (token) {
        params.append('token', token);
      }

      const url = params.toString() ? `${endpoint}?${params}` : endpoint;

      this.logger.debug('Fetching confirmed address history', {
        address,
        token: token || 'none',
        url
      });

      const response = await this.makeRequest(url);

      return response || { result: [], error: null };

    } catch (error) {
      this.logger.error('Failed to fetch confirmed address history', {
        address,
        token,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get confirmed transaction history for a single address with pagination (legacy method)
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
   * Process addresses using individual confirmed history endpoint with pagination
   * @param {string[]} addresses - Array of addresses to process
   * @param {Function} processor - Function to process each batch result
   * @param {number} maxHistoryPerAddress - Maximum transactions per address (default: 500)
   * @returns {Array} - Processing results
   */
  async processBulkAddresses(addresses, processor, maxHistoryPerAddress = 500) {
    const results = [];

    for (const address of addresses) {
      try {
        this.logger.debug('Processing individual address history', {
          address,
          maxHistoryPerAddress
        });

        // Fetch confirmed history with pagination (up to 5 pages of 100 = 500 max)
        const history = await this.getAddressConfirmedHistoryWithPagination(address, maxHistoryPerAddress);
        const historyData = { [address]: history };

        const addressResult = await processor(historyData, [address]);

        if (Array.isArray(addressResult)) {
          results.push(...addressResult);
        } else {
          results.push(addressResult);
        }

      } catch (error) {
        this.logger.error('Failed to process individual address', {
          address,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Get confirmed transaction history for an address with automatic pagination
   * @param {string} address - BSV address
   * @param {number} maxTransactions - Maximum transactions to fetch (default: 500)
   * @returns {Array} - Complete transaction history up to maxTransactions
   */
  async getAddressConfirmedHistoryWithPagination(address, maxTransactions = 500) {
    const allTransactions = [];
    let nextToken = null;
    const pageSize = 100; // API returns up to 100 per page
    let pagesProcessed = 0;
    const maxPages = Math.ceil(maxTransactions / pageSize);

    try {
      while (pagesProcessed < maxPages) {
        this.logger.debug('Fetching confirmed history page', {
          address,
          page: pagesProcessed + 1,
          maxPages,
          nextToken: nextToken || 'first'
        });

        const response = await this.getAddressConfirmedHistory(address, nextToken);

        if (!response || !response.result || response.result.length === 0) {
          this.logger.debug('No more transactions found', { address, pagesProcessed });
          break;
        }

        const transactions = response.result;
        allTransactions.push(...transactions);
        pagesProcessed++;

        this.logger.debug('Fetched confirmed history page', {
          address,
          page: pagesProcessed,
          transactionsInPage: transactions.length,
          totalFetched: allTransactions.length
        });

        // Check if we have a next page token
        if (response.next && allTransactions.length < maxTransactions) {
          nextToken = response.next;
        } else {
          // No more pages or reached max limit
          break;
        }

        // If this page returned fewer than expected, we've reached the end
        if (transactions.length < pageSize) {
          this.logger.debug('Last page reached (partial page)', {
            address,
            transactionsInPage: transactions.length,
            expectedPageSize: pageSize
          });
          break;
        }
      }

      // Trim to exact limit if we exceeded it
      if (allTransactions.length > maxTransactions) {
        allTransactions.splice(maxTransactions);
      }

      this.logger.info('Completed confirmed address history fetch', {
        address,
        totalTransactions: allTransactions.length,
        pagesProcessed,
        maxTransactions
      });

      return allTransactions;

    } catch (error) {
      this.logger.error('Failed to fetch confirmed address history with pagination', {
        address,
        partialResults: allTransactions.length,
        pagesProcessed,
        error: error.message
      });
      throw error;
    }
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
