#!/usr/bin/env node

import Fastify from 'fastify';

const PORT = process.env.PORT || 4000;
const fastify = Fastify({
  logger: false
});

// Add request logging hook
fastify.addHook('preHandler', async (request, reply) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] ${request.method} ${request.url}`);
  
  if (Object.keys(request.headers).length > 0) {
    console.log('  Headers:');
    Object.entries(request.headers).forEach(([key, value]) => {
      // Skip noisy headers
      if (!['host', 'user-agent', 'accept', 'accept-encoding', 'connection'].includes(key.toLowerCase())) {
        console.log(`    ${key}: ${value}`);
      }
    });
  }
  
  if (request.body && Object.keys(request.body).length > 0) {
    console.log('  Body:');
    console.log(JSON.stringify(request.body, null, 4).split('\n').map(line => `    ${line}`).join('\n'));
  }
  
  console.log('  ---');
});

// Handle all HTTP methods on any path
fastify.all('/*', async (request, reply) => {
  // Add random delay to simulate real webhook processing
  const delay = Math.floor(Math.random() * 50);
  
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  // Return success responses most of the time
  const statuses = [200, 200, 200, 201, 202];
  const status = statuses[Math.floor(Math.random() * statuses.length)];
  
  return reply.status(status).send({
    received: true,
    timestamp: new Date().toISOString(),
    method: request.method,
    path: request.url,
    status: status
  });
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n🛑 Webhook listener stopped (${signal})`);
  await fastify.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    
    console.log('🎯 Fastify Webhook Listener');
    console.log('============================');
    console.log(`Listening on: http://localhost:${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
    console.log('');
    console.log('Ready to receive webhooks!');
    console.log('Press Ctrl+C to stop');
    console.log('============================');
    console.log('');
  } catch (err) {
    console.error('Error starting webhook listener:', err);
    process.exit(1);
  }
};

start();