/* eslint-disable no-console */
import { Server } from 'http';
import config from './app/config';
import prisma from './app/utils/prisma';
import { connectRedis } from './app/utils/redis';
import app from './app';
import { startAllSchedulers } from './app/modules/settings/scheduler';

let server: Server;

async function main() {
  try {
    await prisma.$connect();
    console.log('Prisma connected ✓');
    await connectRedis();
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }

  server = app.listen(config.port, () => {
    console.log(`Smart MMC API listening on port ${config.port}`);
  });

  // In-process schedulers. Skips in test env (see scheduler.ts).
  // Long-running Node hosts (single VPS / container) are the target —
  // short-lived serverless platforms are explicitly out of scope.
  // Currently registers the absent-warning weekly cron and the
  // exam-absence daily cron — both share the same per-minute tick.
  startAllSchedulers();
}

main();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  if (server) {
    server.close(() => {
      process.exit(1);
    });
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down gracefully...`);
  if (server) {
    server.close(async () => {
      try {
        await prisma.$disconnect();
        console.log('Prisma disconnected');
      } catch (e) {
        console.error('Prisma disconnect error:', e);
      }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
