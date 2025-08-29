import WhatsOnChainClient from '../../src/services/whatsonchain-client.js';

// Integration test that actually calls WhatsOnChain API
// Run with: npm run test:integration
describe('WhatsOnChain API Integration', () => {
  let client;
  
  // Test addresses provided by user
  const TEST_ADDRESSES = [
    'mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR',
    'mgqipciCS56nCYSjB1vTcDGskN82yxfo1G'
  ];

  beforeAll(() => {
    // Set up test environment
    process.env.BSV_NETWORK = 'testnet';
    process.env.WOC_RATE_LIMIT_MS = '1000';
    process.env.WOC_VERBOSE_LOGGING = 'true';
    process.env.LOG_LEVEL = 'debug';
    
    client = new WhatsOnChainClient();
  });

  afterAll(async () => {
    // Clean up queue
    if (client && client.queue) {
      client.queue.clear();
    }
  });

  // Removed ping and chain info tests since those methods are no longer needed

  describe('address confirmed history', () => {
    test('should fetch confirmed history for test address', async () => {
      const address = TEST_ADDRESSES[0];
      const history = await client.getAddressConfirmedHistory(address);
      
      expect(history).toBeDefined();
      
      if (history && history.result) {
        expect(Array.isArray(history.result)).toBe(true);
        
        // If there are transactions, verify structure
        if (history.result.length > 0) {
          const tx = history.result[0];
          expect(tx).toHaveProperty('tx_hash');
          expect(tx).toHaveProperty('height');
          expect(typeof tx.tx_hash).toBe('string');
          expect(typeof tx.height).toBe('number');
        }
      }
    }, 10000);

    test('should fetch confirmed history with pagination', async () => {
      const address = TEST_ADDRESSES[0];
      const history = await client.getAddressConfirmedHistoryWithPagination(address, 200);
      
      expect(Array.isArray(history)).toBe(true);
      
      // Verify each transaction has expected properties
      for (const tx of history) {
        expect(tx).toHaveProperty('tx_hash');
        expect(tx).toHaveProperty('height');
        expect(typeof tx.tx_hash).toBe('string');
        expect(typeof tx.height).toBe('number');
      }
      
      console.log(`Fetched ${history.length} confirmed transactions for ${address}`);
    }, 30000); // Allow more time for pagination

    test('should respect rate limiting between calls', async () => {
      const startTime = Date.now();
      
      // Make calls to both test addresses sequentially
      for (const address of TEST_ADDRESSES) {
        await client.getAddressConfirmedHistory(address);
      }
      
      const duration = Date.now() - startTime;
      
      // Should take at least 1 second between calls
      expect(duration).toBeGreaterThanOrEqual(900); // Allow some margin
      
      console.log(`Two sequential API calls took ${duration}ms`);
    }, 15000);
  });

  describe('processBulkAddresses with individual calls', () => {
    test('should process addresses using individual calls', async () => {
      const processor = async (historyData, addresses) => {
        const results = [];
        
        for (const address of addresses) {
          const transactions = historyData[address] || [];
          results.push({
            address,
            transactionCount: transactions.length,
            hasTransactions: transactions.length > 0
          });
        }
        
        return results;
      };

      const results = await client.processBulkAddresses(TEST_ADDRESSES, processor, 100);
      
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(TEST_ADDRESSES.length);
      
      for (const result of results) {
        expect(result).toHaveProperty('address');
        expect(result).toHaveProperty('transactionCount');
        expect(result).toHaveProperty('hasTransactions');
        expect(TEST_ADDRESSES.includes(result.address)).toBe(true);
        expect(typeof result.transactionCount).toBe('number');
        
        console.log(`Address ${result.address}: ${result.transactionCount} transactions`);
      }
      
    }, 30000);
  });

  describe('error handling', () => {
    test('should handle invalid address gracefully', async () => {
      try {
        const result = await client.getAddressConfirmedHistory('invalid_address_123');
        // If no error thrown, should return null or empty result
        expect(result === null || (result && result.result && result.result.length === 0)).toBe(true);
      } catch (error) {
        // WhatsOnChain may return 500 for invalid addresses, which is acceptable
        expect(error.message).toMatch(/(500|404|Rate limit exceeded)/);
      }
    }, 10000);

    test('should handle non-existent address gracefully', async () => {
      try {
        // Use a valid format but non-existent address (valid testnet address format)
        const result = await client.getAddressConfirmedHistory('miiEyZ6uL1kHwN7X4Mxya4F3Rn7VX2GvRh');
        // Should return null or empty result for valid but unused addresses
        expect(result === null || (result && result.result && result.result.length === 0)).toBe(true);
      } catch (error) {
        // Some addresses might still cause 500 errors, which is acceptable
        expect(error.message).toMatch(/(500|404|Rate limit exceeded)/);
      }
    }, 10000);
  });
});