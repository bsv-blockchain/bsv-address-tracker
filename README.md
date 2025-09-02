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

### SV Node Configuration

Your `bitcoin.conf` must include these ZMQ settings:

```conf
# Required for transaction index lookups
txindex=1

# ZeroMQ configuration for real-time feeds
zmqpubrawtx2=tcp://127.0.0.1:28332
zmqpubhashblock2=tcp://127.0.0.1:28333

# RPC configuration
rpcallowip=127.0.0.1
rpcuser=your_rpc_user
rpcpassword=your_rpc_password
```

For detailed ZMQ configuration options, see the [Bitcoin SV Node ZMQ Documentation](https://bitcoinsv.io/2020/04/03/zmq-bitcoin-pubsub/).

## Development Setup

For local development with MongoDB only:

```bash
# Clone the repository:
git clone https://github.com/yourusername/bsv-address-tracker.git
cd bsv-address-tracker

# Start MongoDB for development
docker-compose -f docker-compose.dev.yml up -d

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your configuration

# Start the application
npm start  # or npm run dev for auto-restart
```

## Quick Start - Production Deployment

### Docker Compose (Recommended)

Deploy the complete system with Docker Compose:

```bash
# Download the production docker-compose file
curl -O https://raw.githubusercontent.com/bsv-blockchain/bsv-address-tracker/main/docker-compose.yml

# Download the environment template
curl -O https://raw.githubusercontent.com/bsv-blockchain/bsv-address-tracker/main/.env.production

# Copy and edit the environment file
cp .env.production .env
nano .env  # Update with your SV node details and secure passwords

# Start the system
docker compose up -d

# Check logs
docker compose logs -f -n 100 bsv-address-tracker

# Verify health
curl http://localhost:3000/health
```

The system will automatically:
- Set up MongoDB with persistent storage
- Connect to your SV Node via RPC and ZeroMQ
- Start the API server on port 3000
- Begin monitoring for transactions

## API Usage

### Authentication

API authentication is optional but recommended for production deployments. When enabled, all API requests (except `/health`) require an API key.

**Enable authentication:**
```bash
# In your .env file
REQUIRE_API_KEY=true
API_KEY=your-secure-api-key-here
```

**Provide API key in requests:**
- **Header method (recommended):** `X-API-Key: your-api-key-here`
- **Query parameter:** `?api_key=your-api-key-here`

**Authentication disabled:**
When `REQUIRE_API_KEY=false` (default), no authentication is required and all examples work without API keys.

### Adding Addresses to Monitor

```bash
# Add single or multiple addresses
curl -X POST http://localhost:3000/addresses \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key-here" \
  -d '{
    "addresses": [
      "mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR",
      "mgqipciCS56nCYSjB1vTcDGskN82yxfo1G"
    ]
  }'

# Or with query parameter
curl -X POST "http://localhost:3000/addresses?api_key=your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "addresses": [
      "mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR"
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
curl -H "X-API-Key: your-api-key-here" http://localhost:3000/addresses

# Get only active addresses
curl -H "X-API-Key: your-api-key-here" "http://localhost:3000/addresses?active=true"

# With pagination and API key as query parameter
curl "http://localhost:3000/addresses?limit=50&offset=0&api_key=your-api-key-here"
```

### Getting Address Details

```bash
# Get specific address info including recent transactions
curl -H "X-API-Key: your-api-key-here" \
  http://localhost:3000/addresses/mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR
```

### Viewing Transactions

```bash
# Get all transactions
curl -H "X-API-Key: your-api-key-here" http://localhost:3000/transactions

# Filter by status (pending, confirming)
curl -H "X-API-Key: your-api-key-here" "http://localhost:3000/transactions?status=pending"

# With pagination
curl -H "X-API-Key: your-api-key-here" "http://localhost:3000/transactions?limit=50&offset=0"
```

### System Statistics

```bash
# Get system stats
curl -H "X-API-Key: your-api-key-here" http://localhost:3000/stats
```

### Removing an Address

```bash
# Deactivate address from monitoring
curl -X DELETE \
  -H "X-API-Key: your-api-key-here" \
  http://localhost:3000/addresses/mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR
```

### Webhook Management

#### Register a Webhook for Specific Addresses

```bash
# Monitor specific addresses
curl -X POST http://localhost:3000/webhooks \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://localhost:4000/webhook",
    "addresses": ["mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR", "mgqipciCS56nCYSjB1vTcDGskN82yxfo1G"]
  }'
```

#### Register a Wildcard Webhook (All Addresses)

```bash
# Monitor ALL addresses
curl -X POST http://localhost:3000/webhooks \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://localhost:4000/webhook",
    "addresses": []
  }'
```

#### List Webhooks

```bash
# Get all webhooks
curl -H "X-API-Key: your-api-key-here" http://localhost:3000/webhooks

# Get only active webhooks
curl -H "X-API-Key: your-api-key-here" "http://localhost:3000/webhooks?active=true"
```

#### Update a Webhook

```bash
# Update webhook URL
curl -X PUT http://localhost:3000/webhooks/WEBHOOK_ID \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://localhost:5000/new-webhook"
  }'
```

#### Delete a Webhook

```bash
# Remove webhook
curl -X DELETE \
  -H "X-API-Key: your-api-key-here" \
  http://localhost:3000/webhooks/WEBHOOK_ID
```

### Webhook Notifications

Webhooks are triggered for all transaction lifecycle changes:
- New transaction detected
- Transaction confirmation count updated
- Transaction fully confirmed and archived

### Webhook Payload Example

```json
{
  "timestamp": "2023-08-29T12:34:56.789Z",
  "transaction": {
    "_id": "abcd1234...",
    "addresses": ["mnai8LzKea5e3C9qgrBo7JHgpiEnHKMhwR"],
    "confirmations": 6,
    "status": "confirming",
    "block_height": 123456,
    "block_hash": "0000000000000abc...",
    "first_seen": "2023-08-29T12:30:00.000Z"
  },
  "changes": {
    "confirmations": 6,
    "block_height": 123456
  }
}
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

## Deployment

### Production with Docker

The easiest way to deploy in production is using the pre-built Docker images:

```bash
# Pull the latest image
docker pull ghcr.io/bsv-blockchain/bsv-address-tracker:latest

# Run with environment variables
docker run -d \
  --name bsv-tracker \
  -p 3000:3000 \
  --env-file .env \
  ghcr.io/bsv-blockchain/bsv-address-tracker:latest
```

Available image tags:
- `latest` - Latest stable release from main branch
- `main-<commit>` - Specific commit from main branch
- `v1.0.0` - Specific version release

### Development

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
- Verify ZMQ is enabled in bitcoin.conf with `zmqpubrawtx` and `zmqpubhashblock` settings
- Check ZMQ endpoints are correct in your .env file
- Ensure no firewall blocking ZMQ ports (default: 28332, 28333)
- Test ZMQ connection: `telnet 127.0.0.1 28332` should connect
- Restart your SV node after adding ZMQ configuration

### High Memory Usage
- Adjust `CONFIRMATION_BATCH_SIZE` for smaller batches
- Reduce RPC concurrency in confirmation tracker
- Decrease `AUTO_ARCHIVE_AFTER` to archive transactions sooner

