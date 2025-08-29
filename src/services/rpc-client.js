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
    const requestId = Date.now();
    const enableVerboseLogging = process.env.RPC_VERBOSE_LOGGING === 'true';

    if (enableVerboseLogging) {
      this.logger.debug('RPC request initiated', {
        method,
        params,
        requestId,
        timeout
      });
    }

    const request = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: requestId,
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
        if (enableVerboseLogging) {
          this.logger.debug('RPC request failed with error', {
            method,
            params,
            requestId,
            error: data.error
          });
        }
        throw new Error(`RPC Error: ${data.error.message} (Code: ${data.error.code})`);
      }

      if (enableVerboseLogging) {
        this.logger.debug('RPC request completed successfully', {
          method,
          params,
          requestId,
          resultSize: JSON.stringify(data.result).length
        });
      }

      return data.result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        if (enableVerboseLogging) {
          this.logger.debug('RPC request timed out', {
            method,
            params,
            requestId,
            timeout
          });
        }
        throw new Error(`RPC request timeout after ${timeout}ms`);
      }

      this.logger.error('RPC request failed', {
        method,
        params,
        requestId,
        error: error.message
      });
      throw error;
    }
  }

  // Get current block count (height)
  getBlockCount() {
    return this.makeRequest('getblockcount');
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
}

export default RPCClient;
