import winston from 'winston';

class RPCClient {
  constructor() {
    this.host = process.env.SVNODE_RPC_HOST || '127.0.0.1';
    this.port = process.env.SVNODE_RPC_PORT || 8332;
    this.user = process.env.SVNODE_RPC_USER;
    this.password = process.env.SVNODE_RPC_PASSWORD;
    this.url = `http://${this.host}:${this.port}`;

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });
  }

  async makeRequest(method, params = [], timeout = 5000) {
    const request = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: Date.now(),
        method,
        params
      })
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(this.url, {
        ...request,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC Error: ${data.error.message} (Code: ${data.error.code})`);
      }

      return data.result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`RPC request timeout after ${timeout}ms`);
      }

      this.logger.error('RPC request failed', {
        method,
        params,
        error: error.message
      });
      throw error;
    }
  }

  // Get current block count (height)
  getBlockCount() {
    return this.makeRequest('getblockcount');
  }

  // Get block hash by height
  getBlockHash(height) {
    return this.makeRequest('getblockhash', [height]);
  }

  // Get block data by hash
  getBlock(hash, verbosity = 1) {
    return this.makeRequest('getblock', [hash, verbosity]);
  }

  // Get block header by hash
  getBlockHeader(hash, verbose = true) {
    return this.makeRequest('getblockheader', [hash, verbose]);
  }

  // Get blockchain info
  getBlockchainInfo() {
    return this.makeRequest('getblockchaininfo');
  }

  // Get raw transaction
  getRawTransaction(txid, verbose = false, blockHash = null) {
    const params = [txid, verbose];
    if (blockHash) {params.push(blockHash);}
    return this.makeRequest('getrawtransaction', params);
  }

  // Get merkle proof for transaction
  getMerkleProof(txid) {
    return this.makeRequest('getmerkleproof', [txid]);
  }

  // Test connection
  async ping() {
    try {
      await this.getBlockCount();
      return true;
    } catch (error) {
      this.logger.error('RPC ping failed', { error: error.message });
      return false;
    }
  }

  // Get network info
  getNetworkInfo() {
    return this.makeRequest('getnetworkinfo');
  }

  // Batch request for multiple blocks
  async getMultipleBlocks(heights) {
    try {
      // Get all block hashes first
      const hashPromises = heights.map(height => this.getBlockHash(height));
      const hashes = await Promise.all(hashPromises);

      // Then get all block data
      const blockPromises = hashes.map((hash, index) =>
        this.getBlock(hash, 1).then(block => ({ height: heights[index], ...block }))
      );

      return await Promise.all(blockPromises);
    } catch (error) {
      this.logger.error('Batch block request failed', {
        heights,
        error: error.message
      });
      throw error;
    }
  }

  // Get block range (inclusive)
  getBlockRange(startHeight, endHeight) {
    const heights = [];
    for (let height = startHeight; height <= endHeight; height++) {
      heights.push(height);
    }
    return this.getMultipleBlocks(heights);
  }
}

export default RPCClient;
