import AddressExtractor from '../../src/lib/address-extractor.js';

describe('AddressExtractor', () => {
  let extractor;

  beforeEach(() => {
    extractor = new AddressExtractor();
  });

  describe('extractAddressesFromTx', () => {
    it('should extract input and output addresses from testnet transaction', () => {
      // Real testnet transaction
      // txid: f1a7b1854ba8ea120f9cd47db7a8ff190b5c5bc2385b01cbd8fcc5a9df8598c0
      const realTxHex = '01000000014f226ee6c5e75ea5528219c9e98ad372fcb5cd3c9ac300d1cd25680370903dd02e0000006b483045022100e27577999098d75ae8afc04cad0253a879ef052e2776ccd9e1b921d4339a08a102203c9291d9c32ca06799d53567cb05df2ab973f4281a0a2a4bb85066e9d6964aaa41210292acdb57c788c1e8c83cdb0ae8f23e079139ba7ba1bccf67b31653c7af12c4b4ffffffff0140860100000000001976a914be83350213ab6483e111f675268b5bbaba7cdcae88ac00000000';

      const result = extractor.extractAddressesFromTx(realTxHex, 'testnet');

      // Should extract exactly 2 addresses
      expect(result.allAddresses).toHaveLength(2);

      // Should have 1 input address
      expect(result.inputAddresses).toHaveLength(1);
      expect(result.inputAddresses[0]).toBe('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR');

      // Should have 1 output address
      expect(result.outputAddresses).toHaveLength(1);
      expect(result.outputAddresses[0]).toBe('mxtHrvoExpf55rts14HyyKeZc7FtwSoxY5');

      // Should have correct transaction ID
      expect(result.txid).toBe('f1a7b1854ba8ea120f9cd47db7a8ff190b5c5bc2385b01cbd8fcc5a9df8598c0');

      // All addresses should be included in the combined array
      expect(result.allAddresses).toContain('mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR');
      expect(result.allAddresses).toContain('mxtHrvoExpf55rts14HyyKeZc7FtwSoxY5');
    });

    it('should throw error for invalid transaction hex', () => {
      const invalidHex = 'invalid_hex_data';

      expect(() => {
        extractor.extractAddressesFromTx(invalidHex, 'testnet');
      }).toThrow('Address extraction failed');
    });

  });
});
