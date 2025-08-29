const bitcoin = require('bitcoinjs-lib');
const winston = require('winston');

class BSVUtils {
  constructor() {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });

    // BSV network parameters (same as Bitcoin mainnet for address format)
    this.network = bitcoin.networks.bitcoin;
  }

  /**
   * Parse a raw transaction hex into structured data
   * @param {string} txHex - Raw transaction hex
   * @returns {Object} - Parsed transaction data
   */
  parseTransaction(txHex) {
    try {
      const tx = bitcoin.Transaction.fromHex(txHex);

      const inputs = tx.ins.map((input, index) => ({
        index,
        txid: Buffer.from(input.hash).reverse().toString('hex'),
        vout: input.index,
        sequence: input.sequence,
        scriptSig: input.script.toString('hex'),
        scriptSigAsm: this.scriptToAsm(input.script)
      }));

      const outputs = tx.outs.map((output, index) => {
        const address = this.scriptToAddress(output.script);
        return {
          index,
          value: output.value,
          scriptPubKey: output.script.toString('hex'),
          scriptPubKeyAsm: this.scriptToAsm(output.script),
          address: address,
          type: this.getOutputType(output.script)
        };
      });

      const totalOutput = outputs.reduce((sum, out) => sum + out.value, 0);

      return {
        txid: tx.getId(),
        version: tx.version,
        locktime: tx.locktime,
        size: Buffer.from(txHex, 'hex').length,
        inputs,
        outputs,
        inputCount: inputs.length,
        outputCount: outputs.length,
        totalOutput,
        addresses: this.extractAddresses(outputs),
        hex: txHex
      };

    } catch (error) {
      this.logger.error('Failed to parse transaction', {
        error: error.message,
        txHex: txHex.substring(0, 100) + '...'
      });
      throw new Error(`Transaction parsing failed: ${error.message}`);
    }
  }

  /**
   * Extract all unique addresses from transaction outputs
   * @param {Array} outputs - Transaction outputs
   * @returns {string[]} - Array of unique addresses
   */
  extractAddresses(outputs) {
    const addresses = new Set();

    for (const output of outputs) {
      if (output.address && this.isValidAddress(output.address)) {
        addresses.add(output.address);
      }
    }

    return Array.from(addresses);
  }

  /**
   * Convert script to human-readable ASM
   * @param {Buffer} script - Script buffer
   * @returns {string} - ASM representation
   */
  scriptToAsm(script) {
    try {
      return bitcoin.script.toASM(script);
    } catch (error) {
      return `<invalid script: ${script.toString('hex')}>`;
    }
  }

  /**
   * Convert output script to address
   * @param {Buffer} script - Output script
   * @returns {string|null} - Address or null if not standard
   */
  scriptToAddress(script) {
    try {
      // Try P2PKH
      if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14) {
        const hash160 = script.slice(3, 23);
        return bitcoin.address.toBase58Check(hash160, this.network.pubKeyHash);
      }

      // Try P2SH
      if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14) {
        const hash160 = script.slice(2, 22);
        return bitcoin.address.toBase58Check(hash160, this.network.scriptHash);
      }

      // Try other standard types using bitcoinjs-lib
      const address = bitcoin.address.fromOutputScript(script, this.network);
      return address;

    } catch (error) {
      // Not a standard script type or invalid
      return null;
    }
  }

  /**
   * Get the type of output script
   * @param {Buffer} script - Output script
   * @returns {string} - Script type
   */
  getOutputType(script) {
    try {
      if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9) {
        return 'p2pkh';
      }
      if (script.length === 23 && script[0] === 0xa9) {
        return 'p2sh';
      }
      if (script.length === 35 && script[0] === 0x21 && script[34] === 0xac) {
        return 'p2pk';
      }
      if (script.length > 0 && script[script.length - 1] === 0x6a) {
        return 'nulldata';
      }
      if (script.length === 0) {
        return 'empty';
      }

      return 'nonstandard';

    } catch (error) {
      return 'unknown';
    }
  }

  /**
   * Validate if a string is a valid BSV address
   * @param {string} address - Address to validate
   * @returns {boolean} - true if valid
   */
  isValidAddress(address) {
    try {
      bitcoin.address.toOutputScript(address, this.network);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get address type (P2PKH, P2SH)
   * @param {string} address - BSV address
   * @returns {string|null} - Address type or null if invalid
   */
  getAddressType(address) {
    try {
      const decoded = bitcoin.address.fromBase58Check(address);

      if (decoded.version === this.network.pubKeyHash) {
        return 'p2pkh';
      }
      if (decoded.version === this.network.scriptHash) {
        return 'p2sh';
      }

      return 'unknown';

    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate transaction fee (requires input values)
   * @param {Object} parsedTx - Parsed transaction
   * @param {Array} inputValues - Array of input values in satoshis
   * @returns {number} - Fee in satoshis
   */
  calculateFee(parsedTx, inputValues) {
    if (!inputValues || inputValues.length !== parsedTx.inputCount) {
      throw new Error('Input values required for fee calculation');
    }

    const totalInput = inputValues.reduce((sum, value) => sum + value, 0);
    return totalInput - parsedTx.totalOutput;
  }

  /**
   * Check if transaction is likely a deposit to our addresses
   * @param {Object} parsedTx - Parsed transaction
   * @param {string[]} watchedAddresses - Array of addresses we're monitoring
   * @returns {Object} - Deposit information
   */
  checkForDeposits(parsedTx, watchedAddresses) {
    const deposits = [];
    const watchedSet = new Set(watchedAddresses);

    for (const output of parsedTx.outputs) {
      if (output.address && watchedSet.has(output.address)) {
        deposits.push({
          address: output.address,
          amount: output.value,
          outputIndex: output.index,
          scriptType: output.type
        });
      }
    }

    return {
      txid: parsedTx.txid,
      hasDeposits: deposits.length > 0,
      deposits,
      totalDepositAmount: deposits.reduce((sum, dep) => sum + dep.amount, 0),
      timestamp: new Date()
    };
  }

  /**
   * Format satoshis to BSV with proper decimal places
   * @param {number} satoshis - Amount in satoshis
   * @returns {string} - Formatted BSV amount
   */
  formatBSV(satoshis) {
    return (satoshis / 100000000).toFixed(8);
  }

  /**
   * Parse BSV amount to satoshis
   * @param {string|number} bsv - BSV amount
   * @returns {number} - Amount in satoshis
   */
  parseBSV(bsv) {
    return Math.round(parseFloat(bsv) * 100000000);
  }

  /**
   * Create a double SHA256 hash (used for transaction IDs)
   * @param {Buffer} buffer - Data to hash
   * @returns {Buffer} - Double SHA256 hash
   */
  doubleSha256(buffer) {
    return bitcoin.crypto.sha256(bitcoin.crypto.sha256(buffer));
  }

  /**
   * Get transaction statistics
   * @param {Object} parsedTx - Parsed transaction
   * @returns {Object} - Transaction statistics
   */
  getTransactionStats(parsedTx) {
    return {
      txid: parsedTx.txid,
      size: parsedTx.size,
      inputCount: parsedTx.inputCount,
      outputCount: parsedTx.outputCount,
      totalOutput: parsedTx.totalOutput,
      totalOutputBSV: this.formatBSV(parsedTx.totalOutput),
      addressCount: parsedTx.addresses.length,
      hasP2PKH: parsedTx.outputs.some(out => out.type === 'p2pkh'),
      hasP2SH: parsedTx.outputs.some(out => out.type === 'p2sh'),
      hasNonStandard: parsedTx.outputs.some(out => out.type === 'nonstandard'),
      version: parsedTx.version,
      locktime: parsedTx.locktime
    };
  }
}

module.exports = BSVUtils;
