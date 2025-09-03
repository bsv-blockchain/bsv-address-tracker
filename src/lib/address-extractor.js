import { Transaction, PublicKey, Utils } from '@bsv/sdk';
import winston from 'winston';

class AddressExtractor {
  constructor() {
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
   * Extract all addresses involved in a transaction from raw hex
   * @param {string} txHex - Raw transaction hex
   * @param {string} network - Network type ('mainnet' or 'testnet')
   * @returns {Object} - Object with inputAddresses and outputAddresses arrays
   */
  extractAddressesFromTx(txHex, network = 'testnet') {
    try {
      // Check transaction size limit (hex string length / 2 = bytes)
      const txSizeBytes = txHex.length / 2;
      const maxTxSizeBytes = parseInt(process.env.MAX_TX_SIZE_BYTES) || 4194304; // 4MB default

      this.logger.debug('Processing transaction size check', {
        txSizeBytes,
        maxTxSizeBytes,
        txHex: txHex.substring(0, 64) + '...'
      });

      if (txSizeBytes > maxTxSizeBytes) {
        throw new Error(`Transaction size ${txSizeBytes} bytes exceeds maximum ${maxTxSizeBytes} bytes`);
      }

      const tx = Transaction.fromHex(txHex);

      const all = new Set();
      const inputAddresses = this.extractInputAddresses(tx, network, all);
      const outputAddresses = this.extractOutputAddresses(tx, network, all);
      const allAddresses = [...all];

      this.logger.debug('Address extraction successful', {
        txid: tx.id('hex'),
        txSizeBytes,
        allAddresses
      });

      return {
        txid: tx.id('hex'),
        inputAddresses,
        outputAddresses,
        allAddresses
      };

    } catch (error) {
      this.logger.error('Transaction address extraction failed', {
        error: error.message,
        txHex: txHex.substring(0, 100) + '...'
      });
      throw new Error(`Address extraction failed: ${error.message}`);
    }
  }

  /**
   * Extract addresses from transaction inputs
   * @param {Transaction} tx - Parsed transaction
   * @param {string} network - Network type (testnet or mainnet)
   * @param {Set<string>} allAddresses - Set to store all addresses
   * @returns {string[]} - Array of input addresses
   */
  extractInputAddresses(tx, network, allAddresses) {
    const addresses = new Set();

    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i];

      if (input.unlockingScript) {
        try {
          const chunks = input.unlockingScript.chunks;

          // For P2PKH unlock: <signature> <pubkey>
          if (chunks.length === 2) {
            const pubkeyDER = chunks[1].data;
            if (pubkeyDER && pubkeyDER.length === 33) {
              const address = PublicKey.fromDER(pubkeyDER).toAddress(network);
              addresses.add(address);
              allAddresses.add(address);
            }
          }
        } catch (e) {
          this.logger.warn('Input address extraction failed', {
            inputIndex: i,
            error: e.message
          });
        }
      }
    }

    return [...addresses];
  }

  /**
   * Extract addresses from transaction outputs
   * @param {Transaction} tx - Parsed transaction
   * @param {string} network - Network type (testnet or mainnet)
   * @param {Set<string>} allAddresses - Set to store all addresses
   * @returns {string[]} - Array of output addresses
   */
  extractOutputAddresses(tx, network, allAddresses) {
    const addresses = new Set();
    const prefix = network === 'testnet' ? [0x6f] : [0x00];

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];

      if (output.lockingScript) {
        try {
          const chunks = output.lockingScript.chunks;

          // For P2PKH: OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG
          if (chunks.length === 5 &&
              chunks[0].op === 118 && // OP_DUP (0x76)
              chunks[1].op === 169 && // OP_HASH160 (0xa9)
              chunks[2].data && chunks[2].data.length === 20 && // 20-byte hash
              chunks[3].op === 136 && // OP_EQUALVERIFY (0x88)
              chunks[4].op === 172) { // OP_CHECKSIG (0xac)

            const address = Utils.toBase58Check(chunks[2].data, prefix);
            addresses.add(address);
            allAddresses.add(address);
          }
        } catch (e) {
          this.logger.warn('Output address extraction failed', {
            outputIndex: i,
            error: e.message
          });
        }
      }
    }

    return [...addresses];
  }
}

export default AddressExtractor;
