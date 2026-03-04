import dotenv from 'dotenv';
dotenv.config();

export const config = {
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },
  mgba: {
    host: process.env.MGBA_HOST || '127.0.0.1',
    port: parseInt(process.env.MGBA_PORT || '8888', 10),
  },
  hunt: {
    target: process.env.TARGET_POKEMON || 'charmander',
    game: process.env.GAME || 'fire-red',
    saveStateSlot: parseInt(process.env.SAVE_STATE_SLOT || '1', 10),
    turboEnabled: process.env.TURBO_ENABLED !== 'false',
    milestoneInterval: 500,
  },
  server: {
    port: parseInt(process.env.PORT || '3002', 10),
  },
  paths: {
    db: 'data/shiny-hunter.db',
    screenshots: 'screenshots',
    tmpFrame: '/tmp/shiny-hunter-frame.png',
  },
};
