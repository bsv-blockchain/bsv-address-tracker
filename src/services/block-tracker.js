const winston = require('winston');

class BlockTracker {
  constructor(mongodb, rpcClient) {
    this.db = mongodb;
    this.rpc = rpcClient;
    this.isProcessing = false;
    this.lastProcessedHeight = null;

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [new winston.transports.Console()]
    });
  }

  async initialize() {
    try {
      // Get our current blockchain state
      const latestBlock = await this.getLatestMainChainBlock();
      this.lastProcessedHeight = latestBlock ? latestBlock.height : -1;

      this.logger.info('BlockTracker initialized', {
        lastProcessedHeight: this.lastProcessedHeight
      });

      // Check for gaps and catch up if needed
      await this.catchUpWithNode();

    } catch (error) {
      this.logger.error('Failed to initialize BlockTracker', { error: error.message });
      throw error;
    }
  }

  async getLatestMainChainBlock() {
    try {
      return await this.db.blocks.findOne(
        { is_main_chain: true },
        { sort: { height: -1 } }
      );
    } catch (error) {
      this.logger.error('Failed to get latest main chain block', { error: error.message });
      return null;
    }
  }

  async processNewBlock(blockHash) {
    if (this.isProcessing) {
      this.logger.debug('Already processing block, queuing', { blockHash });
      return;
    }

    this.isProcessing = true;

    try {
      // Get block data from RPC
      const blockData = await this.rpc.getBlock(blockHash);

      this.logger.info('Processing new block', {
        height: blockData.height,
        hash: blockHash
      });

      // Check if this block connects to our chain
      await this.handleNewBlock(blockData);

    } catch (error) {
      this.logger.error('Failed to process new block', {
        blockHash,
        error: error.message
      });
    } finally {
      this.isProcessing = false;
    }
  }

  async handleNewBlock(blockData) {
    const { height, hash, previousblockhash, time } = blockData;

    // Check if we already have this block
    const existingBlock = await this.db.blocks.findOne({ hash });
    if (existingBlock) {
      this.logger.debug('Block already exists', { height, hash });
      return;
    }

    // Check if this block connects to our main chain
    const prevBlock = await this.db.blocks.findOne({
      hash: previousblockhash,
      is_main_chain: true
    });

    if (prevBlock && prevBlock.height === height - 1) {
      // Block connects to main chain - simple case
      await this.addMainChainBlock(height, hash, previousblockhash, time);
      this.lastProcessedHeight = height;

    } else if (height > this.lastProcessedHeight + 1) {
      // Gap detected - need to catch up
      this.logger.warn('Gap detected in blockchain', {
        currentHeight: this.lastProcessedHeight,
        newHeight: height
      });
      await this.fillGap(this.lastProcessedHeight + 1, height - 1);
      await this.addMainChainBlock(height, hash, previousblockhash, time);
      this.lastProcessedHeight = height;

    } else {
      // Potential reorg - need to investigate
      await this.handlePotentialReorg(blockData);
    }

    // Emit event for other services
    this.emit('newBlock', { height, hash, previousblockhash, time });
  }

  async addMainChainBlock(height, hash, previousblockhash, timestamp) {
    const blockDoc = {
      height,
      hash,
      prev_hash: previousblockhash,
      is_main_chain: true,
      timestamp: new Date(timestamp * 1000),
      created_at: new Date()
    };

    try {
      await this.db.blocks.insertOne(blockDoc);
      this.logger.info('Added main chain block', { height, hash });
    } catch (error) {
      if (error.code === 11000) { // Duplicate key error
        this.logger.debug('Block already exists', { height, hash });
      } else {
        throw error;
      }
    }
  }

  async fillGap(startHeight, endHeight) {
    this.logger.info('Filling gap in blockchain', { startHeight, endHeight });

    try {
      const blocks = await this.rpc.getBlockRange(startHeight, endHeight);

      const bulkOps = blocks.map(block => ({
        insertOne: {
          document: {
            height: block.height,
            hash: block.hash,
            prev_hash: block.previousblockhash,
            is_main_chain: true,
            timestamp: new Date(block.time * 1000),
            created_at: new Date()
          }
        }
      }));

      if (bulkOps.length > 0) {
        await this.db.blocks.bulkWrite(bulkOps, { ordered: false });
        this.logger.info('Filled blockchain gap', {
          blocksAdded: bulkOps.length,
          startHeight,
          endHeight
        });
      }

    } catch (error) {
      this.logger.error('Failed to fill gap', {
        startHeight,
        endHeight,
        error: error.message
      });
      throw error;
    }
  }

  async handlePotentialReorg(newBlockData) {
    const { height, hash, previousblockhash } = newBlockData;

    this.logger.warn('Potential reorg detected', { height, hash, previousblockhash });

    // Find where the chains diverge
    const reorgPoint = await this.findReorgPoint(previousblockhash);

    if (reorgPoint) {
      await this.processReorg(reorgPoint.height, newBlockData);
    } else {
      // This might be an orphaned block or we're missing data
      this.logger.error('Unable to find reorg point', {
        height,
        hash,
        previousblockhash
      });
    }
  }

  async findReorgPoint(blockHash) {
    // Walk backwards from the new block to find common ancestor
    let currentHash = blockHash;
    let depth = 0;
    const maxDepth = 100; // Limit reorg depth for safety

    while (depth < maxDepth) {
      const block = await this.db.blocks.findOne({ hash: currentHash });

      if (block && block.is_main_chain) {
        return block; // Found common ancestor
      }

      // Get the previous block from RPC
      try {
        const blockData = await this.rpc.getBlock(currentHash);
        currentHash = blockData.previousblockhash;
        depth++;
      } catch (error) {
        this.logger.error('Failed to trace reorg', { currentHash, depth, error: error.message });
        break;
      }
    }

    return null;
  }

  async processReorg(reorgFromHeight, _newBlockData) {
    this.logger.warn('Processing blockchain reorg', { reorgFromHeight });

    try {
      // Mark orphaned blocks as not main chain
      await this.db.blocks.updateMany(
        { height: { $gt: reorgFromHeight }, is_main_chain: true },
        { $set: { is_main_chain: false, orphaned_at: new Date() } }
      );

      // Get the new chain from RPC starting after reorg point
      const nodeHeight = await this.rpc.getBlockCount();
      const newChainBlocks = await this.rpc.getBlockRange(reorgFromHeight + 1, nodeHeight);

      // Add new chain blocks
      const bulkOps = newChainBlocks.map(block => ({
        replaceOne: {
          filter: { hash: block.hash },
          replacement: {
            height: block.height,
            hash: block.hash,
            prev_hash: block.previousblockhash,
            is_main_chain: true,
            timestamp: new Date(block.time * 1000),
            created_at: new Date()
          },
          upsert: true
        }
      }));

      if (bulkOps.length > 0) {
        await this.db.blocks.bulkWrite(bulkOps);
      }

      this.lastProcessedHeight = nodeHeight;

      this.logger.info('Reorg processed successfully', {
        reorgFromHeight,
        newChainLength: newChainBlocks.length,
        currentHeight: nodeHeight
      });

      // Emit reorg event for other services
      this.emit('reorg', { reorgFromHeight, newHeight: nodeHeight });

    } catch (error) {
      this.logger.error('Failed to process reorg', {
        reorgFromHeight,
        error: error.message
      });
      throw error;
    }
  }

  async catchUpWithNode() {
    try {
      const nodeHeight = await this.rpc.getBlockCount();

      if (nodeHeight > this.lastProcessedHeight) {
        this.logger.info('Catching up with node', {
          currentHeight: this.lastProcessedHeight,
          nodeHeight
        });

        await this.fillGap(this.lastProcessedHeight + 1, nodeHeight);
        this.lastProcessedHeight = nodeHeight;
      }

    } catch (error) {
      this.logger.error('Failed to catch up with node', { error: error.message });
      throw error;
    }
  }

  // Get confirmation count for a block height
  getConfirmations(blockHeight) {
    if (this.lastProcessedHeight === null || blockHeight > this.lastProcessedHeight) {
      return 0;
    }
    return this.lastProcessedHeight - blockHeight + 1;
  }

  // Simple event emitter implementation
  emit(event, data) {
    // In a full implementation, this would use EventEmitter
    // For now, just log the event
    this.logger.debug('Event emitted', { event, data });
  }

  // Get current blockchain stats
  async getStats() {
    const mainChainBlocks = await this.db.blocks.countDocuments({ is_main_chain: true });
    const orphanedBlocks = await this.db.blocks.countDocuments({ is_main_chain: false });

    return {
      lastProcessedHeight: this.lastProcessedHeight,
      mainChainBlocks,
      orphanedBlocks,
      isProcessing: this.isProcessing
    };
  }
}

module.exports = BlockTracker;
