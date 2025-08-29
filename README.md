# BSV Address Tracker

A demonstration of how to monitor Bitcoin SV addresses and track transaction lifecycles through the confirmation process. This system showcases real-time transaction detection, confirmation tracking via getrawtransaction, and historical data integration.

**Purpose**: This is a educational/demonstration system that shows how to link transactions to addresses and track their confirmation journey. Other systems would handle transaction amounts, balances, and business logic.

## Features

- **Real-time Transaction Detection** - Monitors incoming transactions via ZeroMQ feeds
- **Address Management API** - RESTful API for adding/removing addresses to monitor  
- **Transaction Lifecycle Tracking** - Tracks transactions from detection through final confirmation
- **Transaction Verification** - Uses getrawtransaction for comprehensive confirmation details
- **Scalable Architecture** - In-memory Set for O(1) address pre-screening with zero false positives
- **Historical Data Integration** - Fetches transaction history from WhatsOnChain API
- **Automatic Archival** - Archives fully confirmed transactions after 144+ confirmations
- **Intelligent Retry Logic** - Handles failed operations with exponential backoff

## Architecture

The system demonstrates a complete transaction lifecycle tracking pipeline:

- **Transaction Tracker** - Detects transactions involving monitored addresses from ZMQ feeds
- **Confirmation Tracker** - Tracks confirmations using getrawtransaction (stores blockhash, height, time, and hex)
- **Address History Fetcher** - Integrates historical transactions from WhatsOnChain API
- **API Server** - RESTful interface for address management and transaction status queries
- **ZMQ Listener** - Real-time blockchain event subscription from SV Node

**Key Principle**: The system only tracks transaction IDs and their relationship to addresses. Transaction amounts, balances, and detailed parsing are intentionally excluded to keep the demonstration focused on the core lifecycle tracking pattern.

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
AUTO_ARCHIVE_AFTER=144  # Archive after 144 confirmations (~1 day)

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

## Transaction Lifecycle Demo

This system demonstrates a complete transaction tracking workflow:

1. **Address Registration**: Addresses are added to monitoring via API, stored in MongoDB, and indexed in Bloom filters for O(1) pre-screening.

2. **Transaction Detection**: ZMQ listener receives all network transactions, pre-screens them with Bloom filters, then verifies actual address involvement.

3. **Historical Integration**: New addresses get their transaction history fetched from WhatsOnChain API (up to 500 transactions), showing how to integrate existing data.

4. **Confirmation Lifecycle**: As blocks are mined:
   - Transactions receive increasing confirmation counts as new blocks are added
   - getrawtransaction verifies confirmations and provides full transaction details
   - Transactions are archived after reaching 144+ confirmations

5. **Efficient Operations**: 
   - Rate-limited RPC calls (max 4 concurrent, 5s timeouts)
   - Intelligent retry queues for failed operations  
   - Updates all tracked transactions on each new block
   - No raw transaction data storage or parsing

## Performance Optimizations

- **In-Memory Set**: O(1) address screening with zero false positives
- **getrawtransaction**: Comprehensive transaction verification with blockhash, height, and time
- **Comprehensive Updates**: Updates all tracked transactions efficiently on each new block
- **Concurrent Processing**: Parallel processing of different confirmation tasks
- **Rate Limiting**: Prevents overwhelming the SV Node with RPC requests

## Database Schema

### Collections

- `depositAddresses` - Monitored addresses and their statistics
- `activeTransactions` - Transactions being tracked for confirmations
- `archivedTransactions` - Fully confirmed transactions (144+ confirmations)

## Important: What This System Does NOT Do

This is an educational demonstration focused on transaction lifecycle tracking. It intentionally **does not**:

- ❌ Track transaction amounts or values
- ❌ Calculate address balances  
- ❌ Store raw transaction data
- ❌ Parse transaction inputs/outputs in detail
- ❌ Handle payments, settlements, or financial logic
- ❌ Implement wallet functionality

**What it DOES demonstrate**:
- ✅ Real-time transaction detection for monitored addresses
- ✅ Confirmation tracking through the blockchain lifecycle  
- ✅ Historical transaction integration from external APIs
- ✅ Efficient address monitoring with in-memory Set
- ✅ Transaction verification using getrawtransaction
- ✅ Scalable architecture patterns for blockchain monitoring

This system shows **how to link transactions to addresses and track their confirmation journey**. Production systems would extend this foundation with business logic, amount tracking, balance calculations, and application-specific features.

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
- Reduce RPC concurrency in confirmation tracker
- Decrease `AUTO_ARCHIVE_AFTER` to archive transactions sooner

