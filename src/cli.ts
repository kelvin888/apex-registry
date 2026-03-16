#!/usr/bin/env node
/**
 * APEX Distribution Server CLI
 *
 * Command-line interface for running the server
 */

import { loadConfig } from './config';
import { createServer, startServer } from './server';

async function main() {
  const config = loadConfig();
  const server = await createServer({ config });
  await startServer(server, config);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
