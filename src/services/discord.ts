import fs from 'fs/promises';
import { config } from '../config';
import { logger } from '../logger';
import { HuntStatus } from '../types';

interface ShinyEvent {
  pokemon: string;
  encounters: number;
  elapsedSeconds: number;
  screenshotPath: string;
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

async function sendWebhook(payload: Record<string, unknown>): Promise<void> {
  if (!config.discord.webhookUrl) {
    logger.debug('Discord webhook not configured, skipping notification');
    return;
  }

  try {
    const response = await fetch(config.discord.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(`Discord webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Discord webhook error: ${msg}`);
  }
}

async function sendWebhookWithFile(
  payload: Record<string, unknown>,
  filePath: string
): Promise<void> {
  if (!config.discord.webhookUrl) return;

  try {
    const fileData = await fs.readFile(filePath);
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('file', new Blob([fileData], { type: 'image/png' }), 'shiny.png');

    const response = await fetch(config.discord.webhookUrl, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      logger.error(`Discord webhook failed: ${response.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Discord file upload error: ${msg}`);
  }
}

export async function notifyShinyFound(event: ShinyEvent): Promise<void> {
  const rate = event.elapsedSeconds > 0
    ? Math.round((event.encounters / event.elapsedSeconds) * 3600)
    : 0;

  const payload = {
    embeds: [
      {
        title: `✨ SHINY ${event.pokemon.toUpperCase()} FOUND! ✨`,
        color: 0xffd700, // Gold
        fields: [
          { name: 'Encounters', value: event.encounters.toLocaleString(), inline: true },
          { name: 'Time', value: formatDuration(event.elapsedSeconds), inline: true },
          { name: 'Rate', value: `${rate}/hr`, inline: true },
        ],
        image: { url: 'attachment://shiny.png' },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await sendWebhookWithFile(payload, event.screenshotPath);
  logger.info('Discord notification sent: shiny found!');
}

export async function notifyMilestone(status: HuntStatus): Promise<void> {
  const payload = {
    embeds: [
      {
        title: `Shiny Hunt Progress — ${status.target}`,
        color: 0x3498db, // Blue
        fields: [
          { name: 'Encounters', value: status.encounters.toLocaleString(), inline: true },
          { name: 'Time', value: formatDuration(status.elapsedSeconds), inline: true },
          { name: 'Rate', value: `${status.encountersPerHour}/hr`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await sendWebhook(payload);
  logger.info(`Discord milestone notification: ${status.encounters} encounters`);
}

export async function notifyHuntStarted(target: string, game: string): Promise<void> {
  await sendWebhook({
    content: `🎮 Shiny hunt started: **${target}** in **${game}**`,
  });
}

export async function notifyHuntStopped(status: HuntStatus): Promise<void> {
  await sendWebhook({
    content: `🛑 Hunt stopped after **${status.encounters}** encounters (${formatDuration(status.elapsedSeconds)})`,
  });
}
