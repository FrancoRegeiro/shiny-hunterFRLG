import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { HuntEngine } from './engine/hunt-engine';
import { getAllHunts, getShinyFinds, getHuntStats } from './services/stats';

export function createServer(engine: HuntEngine): express.Application {
  const app = express();
  app.use(express.json());

  // Current hunt status
  app.get('/api/status', (_req, res) => {
    const status = engine.getStatus();
    const stats = getHuntStats();
    res.json({ ...status, lifetime: stats });
  });

  // Hunt history
  app.get('/api/history', (_req, res) => {
    const hunts = getAllHunts();
    const finds = getShinyFinds();
    res.json({ hunts, finds });
  });

  // Start a new hunt
  app.post('/api/hunt/start', async (_req, res) => {
    if (engine.getStatus().running) {
      res.status(400).json({ error: 'Hunt already running' });
      return;
    }

    // Start hunt in background (don't await — it runs indefinitely)
    engine.start().catch((err) => {
      logger.error(`Hunt failed: ${err.message}`);
    });

    res.json({ message: 'Hunt started', status: engine.getStatus() });
  });

  // Stop current hunt
  app.post('/api/hunt/stop', (_req, res) => {
    if (!engine.getStatus().running) {
      res.status(400).json({ error: 'No hunt running' });
      return;
    }

    engine.stop();
    res.json({ message: 'Hunt stopped', status: engine.getStatus() });
  });

  // Lifetime stats
  app.get('/api/stats', (_req, res) => {
    res.json(getHuntStats());
  });

  return app;
}

export function startServer(engine: HuntEngine): void {
  const app = createServer(engine);
  app.listen(config.server.port, () => {
    logger.info(`Server listening on http://localhost:${config.server.port}`);
  });
}
