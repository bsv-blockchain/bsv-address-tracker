# BSV Address Tracker

A BSV Blockchain address monitoring system for tracking deposits, confirmations, and transaction lifecycle management.

## Overview

This project demonstrates how to build a robust address tracking system for the BSV Blockchain. It monitors addresses for incoming transactions, tracks confirmation counts, and automatically manages the transaction lifecycle with configurable archival thresholds.

**Key Features:**
- Real-time deposit detection via SV Node ZMQ events
- Blockchain state tracking with reorg handling
- Efficient batch confirmation updates using block height indexing
- Configurable archival (default: 288 confirmations)
- MongoDB-based persistence with optimized indexing
- Automatic gap detection and recovery

## Use Cases

This system can be used to:
- Track deposits to exchange addresses
- Monitor transaction confirmations in real-time
- Handle blockchain reorganizations properly
- Manage transaction archival automatically
- Serve as a reference implementation for production systems

## Important Note

**This is an example implementation.** For production exchange usage, you should either:
- Adapt this code to your specific requirements
- Integrate the concepts into your existing infrastructure
- Build your own system using this as a reference

Production systems require additional considerations like high availability, scalability, security hardening, and integration with existing exchange infrastructure.

## Quick Start

### Prerequisites
- Node.js 22+
- SV Node with ZMQ enabled
- Docker (for MongoDB)

### Setup

1. **Clone and install dependencies:**
   ```bash
   git clone <repository-url>
   cd bsv-address-tracker
   npm install
   ```

2. **Start MongoDB:**
   ```bash
   docker-compose up -d mongodb
   ```

3. **Configure your SV Node** (add to `bitcoin.conf`):
   ```conf
   zmqpubrawtx=tcp://127.0.0.1:28332
   zmqpubhashblock=tcp://127.0.0.1:28333
   ```

4. **Set environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your SV Node credentials
   ```

5. **Start the tracker:**
   ```bash
   npm run dev
   ```

## Architecture

The system uses a multi-layered architecture:
- **ZMQ Event Processing**: Real-time blockchain events
- **Block Tracker**: Local blockchain state with reorg handling  
- **MongoDB Storage**: Efficient indexing for 1M+ addresses
- **Bloom Filters**: O(1) address lookup optimization

See [CLAUDE.md](./CLAUDE.md) for detailed architecture and development guidance.

## License

Copyright 2025 BSV Association

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.