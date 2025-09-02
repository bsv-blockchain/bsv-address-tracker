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

    // API key support - if provided, allows for higher rate limits
    this.apiKey = process.env.WOC_API_KEY || null;
    this.rateLimit = parseInt(process.env.WOC_RATE_LIMIT_MS) || 1000; // 1 req/sec by default

    // Rate limiting queue - max 1 concurrent request with configured intervals
    this.queue = new PQueue({
      concurrency: 1,
      interval: this.rateLimit,
      intervalCap: 1
    });

    this.logger.info('WhatsOnChain client initialized', {
      network: this.network,
      baseUrl: this.baseUrl,
      rateLimit: this.rateLimit,
      hasApiKey: !!this.apiKey,
      requestsPerSecond: Math.floor(1000 / this.rateLimit)
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

        // Build headers with optional API key
        const headers = {
          'Accept': 'application/json',
          'User-Agent': 'BSV-Address-Tracker/1.0',
          ...options.headers
        };

        // Add Authorization header if API key is provided
        if (this.apiKey) {
          headers['Authorization'] = this.apiKey;
        }

        const response = await fetch(url, {
          method: 'GET',
          headers,
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
        if (response.nextPageToken && allTransactions.length < maxTransactions) {
          nextToken = response.nextPageToken;
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
