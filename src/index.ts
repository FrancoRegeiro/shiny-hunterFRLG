import { config } from './config';
import { logger } from './logger';
import { initDb } from './db';
import { EmulatorInput } from './drivers/emulator-input';
import { EmulatorFrames } from './drivers/emulator-frames';
import { HuntEngine } from './engine/hunt-engine';
import { startServer } from './server';
import {
  createHunt,
  endHunt,
  updateHuntEncounters,
  recordShinyFind,
} from './services/stats';
import {
  notifyShinyFound,
  notifyMilestone,
  notifyHuntStarted,
  notifyHuntStopped,
} from './services/discord';

async function main() {
  logger.info('=== Shiny Hunter starting ===');
  logger.info(`Target: ${config.hunt.target} | Game: ${config.hunt.game}`);

  // Init database
  initDb();

  // Init drivers
  const input = new EmulatorInput();
  const frames = new EmulatorFrames(input);

  try {
    await input.init();
    await frames.init();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to connect to mGBA: ${msg}`);
    logger.info('Make sure mGBA is running with lua/bridge.lua loaded.');
    logger.info('Starting server without hunt capability...');
  }

  // Create hunt engine
  const engine = new HuntEngine(frames, input);

  // Track active hunt in DB
  let currentHuntId: number | null = null;

  engine.on('started', async (status) => {
    currentHuntId = createHunt(status.target, status.game);
    await notifyHuntStarted(status.target, status.game);
  });

  engine.on('stopped', async (status) => {
    if (currentHuntId) {
      endHunt(currentHuntId, 'abandoned', status.encounters);
    }
    await notifyHuntStopped(status);
    currentHuntId = null;
  });

  engine.on('shiny', async (event) => {
    if (currentHuntId) {
      recordShinyFind(
        currentHuntId,
        event.pokemon,
        event.encounters,
        event.elapsedSeconds,
        event.screenshotPath
      );
      endHunt(currentHuntId, 'found', event.encounters);
    }
    await notifyShinyFound(event);
    currentHuntId = null;
  });

  engine.on('milestone', async (status) => {
    if (currentHuntId) {
      updateHuntEncounters(currentHuntId, status.encounters);
    }
    await notifyMilestone(status);
  });

  // Periodic encounter count save (every 50 encounters)
  let lastSavedEncounters = 0;
  const saveInterval = setInterval(() => {
    if (currentHuntId && engine.getStatus().running) {
      const enc = engine.getStatus().encounters;
      if (enc - lastSavedEncounters >= 50) {
        updateHuntEncounters(currentHuntId, enc);
        lastSavedEncounters = enc;
      }
    }
  }, 10000);

  // Start Express server
  startServer(engine);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(saveInterval);
    engine.stop();
    await input.cleanup();
    await frames.cleanup();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('=== Shiny Hunter ready ===');
  logger.info(`API: http://localhost:${config.server.port}/api/status`);
  logger.info('POST /api/hunt/start to begin hunting');
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
