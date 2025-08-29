# BSV Address Tracker

A high-performance Bitcoin SV address monitoring system that tracks transactions and confirmations in real-time using ZeroMQ feeds from an SV Node.

## Features

- **Real-time Transaction Monitoring** - Monitors incoming transactions via ZeroMQ feeds
- **Address Management API** - RESTful API for adding/removing addresses to monitor
- **Smart Confirmation Tracking** - Uses merkle proofs for efficient confirmation verification
- **Scalable Architecture** - Bloom filters for O(1) address pre-screening
- **Historical Data Import** - Fetches transaction history from WhatsOnChain
- **Automatic Archival** - Archives fully confirmed transactions after configurable thresholds
- **Retry Logic** - Intelligent retry mechanism for failed RPC calls with timeouts

## Architecture

The system consists of several key components:

- **Transaction Tracker** - Monitors ZMQ raw transaction feeds and identifies relevant transactions
- **Confirmation Tracker** - Verifies transactions using merkle proofs and tracks confirmation counts
- **Address History Fetcher** - Imports historical transaction data for newly added addresses
- **API Server** - RESTful API for managing addresses and viewing transactions
- **ZMQ Listener** - Subscribes to real-time blockchain events from SV Node

## Prerequisites

- Node.js 22+ 
- MongoDB 6.0+
- Bitcoin SV Node with:
  - RPC enabled
  - ZeroMQ enabled (rawtx and hashblock topics)
  - Transaction index enabled (`txindex=1`)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/bsv-address-tracker.git
cd bsv-address-tracker
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

## Configuration

Key environment variables in `.env`:

```env
# SV Node Connection
SVNODE_RPC_HOST=127.0.0.1
SVNODE_RPC_PORT=18332  # Testnet port
SVNODE_RPC_USER=your_rpc_user
SVNODE_RPC_PASSWORD=your_rpc_password
SVNODE_ZMQ_RAWTX=tcp://127.0.0.1:28332
SVNODE_ZMQ_HASHBLOCK=tcp://127.0.0.1:28333

# Database
MONGODB_URL=mongodb://admin:password@127.0.0.1:27017/bsv_tracker?authSource=admin
MONGODB_DB_NAME=bsv_tracker

# API Server
API_PORT=3000
API_HOST=0.0.0.0

# Processing Configuration
CONFIRMATION_THRESHOLDS=0,1,6,12,24,72,144,288
AUTO_ARCHIVE_AFTER=288  # Archive after 288 confirmations (~2 days)

# Network
BSV_NETWORK=testnet  # or mainnet
```

## Starting the System

1. Ensure MongoDB is running:
```bash
docker-compose up -d  # If using the provided docker-compose.yml
```

2. Start the tracker:
```bash
npm start
```

The system will:
- Connect to your SV Node via RPC
- Subscribe to ZeroMQ feeds
- Start the API server on port 3000
- Begin monitoring for transactions

## API Usage

### Adding Addresses to Monitor

```bash
# Add single or multiple addresses
curl -X POST http://localhost:3000/addresses \
  -H "Content-Type: application/json" \
  -d '{
    "addresses": [
      "mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR",
      "mgqipciCS56nCYSjB1vTcDGskN82yxfo1G"
    ]
  }'
```

Response:
```json
{
  "success": true,
  "added": ["mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR", "mgqipciCS56nCYSjB1vTcDGskN82yxfo1G"],
  "alreadyExist": [],
  "invalid": [],
  "summary": {
    "totalRequested": 2,
    "added": 2,
    "alreadyExisted": 0,
    "invalid": 0
  }
}
```

### Listing Monitored Addresses

```bash
# Get all addresses
curl http://localhost:3000/addresses

# Get only active addresses
curl "http://localhost:3000/addresses?active=true"

# With pagination
curl "http://localhost:3000/addresses?limit=50&offset=0"
```

### Getting Address Details

```bash
# Get specific address info including recent transactions
curl http://localhost:3000/addresses/mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR
```

### Viewing Transactions

```bash
# Get all transactions
curl http://localhost:3000/transactions

# Filter by status (pending, confirming)
curl "http://localhost:3000/transactions?status=pending"

# With pagination
curl "http://localhost:3000/transactions?limit=50&offset=0"
```

### System Statistics

```bash
# Get system stats
curl http://localhost:3000/stats
```

### Removing an Address

```bash
# Deactivate address from monitoring
curl -X DELETE http://localhost:3000/addresses/mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR
```

## How It Works

1. **Address Registration**: When you add an address via the API, it's stored in MongoDB and added to a Bloom filter for efficient pre-screening.

2. **Transaction Detection**: The ZMQ listener receives all raw transactions from the network. Each transaction is quickly checked against the Bloom filter, then verified against the actual address list.

3. **Confirmation Tracking**: When a new block is announced via ZMQ, the system:
   - Checks pending transactions for confirmation using `getmerkleproof` RPC calls
   - Updates confirmation counts for transactions that might cross notification thresholds
   - Archives transactions that have reached the maximum confirmation threshold

4. **Efficient Processing**: The system uses:
   - Rate-limited RPC calls (max 5 concurrent, 200ms intervals)
   - 5-second timeouts on all RPC calls
   - Intelligent retry queues for failed operations
   - Selective confirmation updates based on thresholds

## Performance Optimizations

- **Bloom Filters**: O(1) address screening with configurable false positive rate
- **Merkle Proofs**: Lightweight transaction verification without downloading full blocks
- **Threshold-Based Updates**: Only processes confirmations that might trigger notifications
- **Concurrent Processing**: Parallel processing of different confirmation tasks
- **Rate Limiting**: Prevents overwhelming the SV Node with RPC requests

## Database Schema

### Collections

- `depositAddresses` - Monitored addresses and their statistics
- `activeTransactions` - Transactions being tracked for confirmations
- `archivedTransactions` - Fully confirmed transactions (288+ confirmations)

## Development

```bash
# Run in development mode with auto-restart
npm run dev

# Run tests
npm test

# Lint code
npm run lint
```

## Monitoring

The system logs all important events. Monitor the logs for:
- Transaction detections
- Confirmation updates
- RPC timeouts and retries
- System health status

## Troubleshooting

### RPC Connection Issues
- Verify `rpcallowip` is set correctly in bitcoin.conf
- Check firewall rules for RPC port
- Ensure RPC credentials are correct

### ZeroMQ Not Receiving Messages
- Verify ZMQ is enabled in bitcoin.conf
- Check ZMQ endpoints are correct
- Ensure no firewall blocking ZMQ ports

### High Memory Usage
- Adjust `CONFIRMATION_BATCH_SIZE` for smaller batches
- Reduce `pendingTxLimit` in confirmation tracker
- Increase `AUTO_ARCHIVE_AFTER` to archive transactions sooner

