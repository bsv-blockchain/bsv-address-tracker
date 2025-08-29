import { jest } from '@jest/globals';
import WhatsOnChainClient from '../../src/services/whatsonchain-client.js';

// Mock the winston logger to prevent console output during tests
jest.mock('winston', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }),
  format: {
    combine: jest.fn(() => jest.fn()),
    timestamp: jest.fn(() => jest.fn()),
    json: jest.fn(() => jest.fn())
  },
  transports: {
    Console: jest.fn()
  }
}));

describe('WhatsOnChainClient', () => {
  let client;
  let originalEnv;

  beforeEach(() => {
    // Save original env
    originalEnv = process.env;
    
    // Set test environment
    process.env = {
      ...originalEnv,
      BSV_NETWORK: 'testnet',
      WOC_RATE_LIMIT_MS: '2000', // Use 2 seconds for tests to be safer
      WOC_VERBOSE_LOGGING: 'true'
    };
    
    client = new WhatsOnChainClient();
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
    
    // Clean up any pending queue items
    if (client && client.queue) {
      client.queue.clear();
    }
  });

  describe('initialization', () => {
    test('should initialize with correct testnet configuration', () => {
      expect(client.network).toBe('test');
      expect(client.baseUrl).toBe('https://api.whatsonchain.com/v1/bsv/test');
      expect(client.rateLimit).toBe(2000);
    });

    test('should initialize with mainnet as default', () => {
      process.env.BSV_NETWORK = 'mainnet';
      const mainnetClient = new WhatsOnChainClient();
      
      expect(mainnetClient.network).toBe('main');
      expect(mainnetClient.baseUrl).toBe('https://api.whatsonchain.com/v1/bsv/main');
    });
  });

  describe('network mapping', () => {
    test('should map testnet correctly', () => {
      expect(client.mapNetworkName('testnet')).toBe('test');
    });

    test('should map mainnet correctly', () => {
      expect(client.mapNetworkName('mainnet')).toBe('main');
    });

    test('should default to main for unknown networks', () => {
      expect(client.mapNetworkName('unknown')).toBe('main');
    });
  });

  describe('rate limiting', () => {
    test('should have correct queue configuration', () => {
      expect(client.queue.concurrency).toBe(1);
      // Note: p-queue doesn't expose interval/intervalCap for inspection
      // but we can verify they were set in constructor
    });

    test('should enforce rate limiting on multiple calls', async () => {
      // Mock fetch to return quickly
      global.fetch = jest.fn()
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ result: [], error: null })
        });

      const startTime = Date.now();
      
      // Make multiple calls - they should be rate limited
      const promises = [
        client.getAddressConfirmedHistory('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR'),
        client.getAddressConfirmedHistory('mgqipciCS56nCYSjB1vTcDGskN82yxfo1G')
      ];

      await Promise.all(promises);
      
      const duration = Date.now() - startTime;
      
      // Should take at least 2 seconds (2000ms rate limit) for 2 calls
      expect(duration).toBeGreaterThanOrEqual(1900); // Allow some margin for timing
      
      // Verify both calls were made
      expect(global.fetch).toHaveBeenCalledTimes(2);
      
      // Clean up
      delete global.fetch;
    }, 10000); // 10 second timeout for this test
  });

  describe('getAddressConfirmedHistory', () => {
    beforeEach(() => {
      // Mock fetch for these tests
      global.fetch = jest.fn();
    });

    afterEach(() => {
      delete global.fetch;
    });

    test('should make correct API call for address without token', async () => {
      const mockResponse = {
        result: [
          {
            tx_hash: 'abc123',
            height: 1234,
            time: 1640995200,
          }
        ],
        error: null
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await client.getAddressConfirmedHistory('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.whatsonchain.com/v1/bsv/test/address/mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR/confirmed/history',
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'BSV-Address-Tracker/1.0'
          }
        }
      );

      expect(result).toEqual(mockResponse);
    });

    test('should make correct API call for address with token', async () => {
      const mockResponse = {
        result: [],
        error: null
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      await client.getAddressConfirmedHistory('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR', 'next_token_123');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.whatsonchain.com/v1/bsv/test/address/mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR/confirmed/history?token=next_token_123',
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'BSV-Address-Tracker/1.0'
          }
        }
      );
    });

    test('should handle 404 errors gracefully', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      const result = await client.getAddressConfirmedHistory('invalid_address');
      
      // Should return default empty result for 404s
      expect(result).toEqual({ result: [], error: null });
    });

    test('should handle rate limit errors', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests'
      });

      await expect(
        client.getAddressConfirmedHistory('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR')
      ).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('getAddressConfirmedHistoryWithPagination', () => {
    beforeEach(() => {
      global.fetch = jest.fn();
    });

    afterEach(() => {
      delete global.fetch;
    });

    test('should fetch single page when no next token', async () => {
      const mockResponse = {
        result: [
          { tx_hash: 'tx1', height: 100 },
          { tx_hash: 'tx2', height: 101 }
        ],
        error: null
        // No 'next' token
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await client.getAddressConfirmedHistoryWithPagination('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR', 500);

      expect(result).toEqual(mockResponse.result);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('should fetch multiple pages when next token present', async () => {
      const page1Response = {
        result: Array.from({ length: 100 }, (_, i) => ({
          tx_hash: `tx_page1_${i}`,
          height: 100 + i,
        })),
        next: 'token_page2'
      };

      const page2Response = {
        result: Array.from({ length: 50 }, (_, i) => ({
          tx_hash: `tx_page2_${i}`,
          height: 200 + i,
        }))
        // No next token - end of results
      };

      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(page1Response)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(page2Response)
        });

      const result = await client.getAddressConfirmedHistoryWithPagination('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR', 500);

      expect(result.length).toBe(150); // 100 + 50
      expect(result[0].tx_hash).toBe('tx_page1_0');
      expect(result[100].tx_hash).toBe('tx_page2_0');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('should limit results to maxTransactions', async () => {
      const page1Response = {
        result: Array.from({ length: 100 }, (_, i) => ({
          tx_hash: `tx_page1_${i}`,
          height: 100 + i,
        })),
        next: 'token_page2'
      };

      const page2Response = {
        result: Array.from({ length: 100 }, (_, i) => ({
          tx_hash: `tx_page2_${i}`,
          height: 200 + i,
        })),
        next: 'token_page3'
      };

      global.fetch
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(page1Response)
        })
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(page2Response)
        });

      // Limit to 150 transactions
      const result = await client.getAddressConfirmedHistoryWithPagination('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR', 150);

      expect(result.length).toBe(150);
      expect(global.fetch).toHaveBeenCalledTimes(2); // Should stop after 2 pages
    });

    test('should handle empty results', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: [], error: null })
      });

      const result = await client.getAddressConfirmedHistoryWithPagination('empty_address', 500);

      expect(result).toEqual([]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});