import fs from 'fs/promises';
import { config } from '../config';
import { logger } from '../logger';
import { HuntStatus } from '../types';

interface ShinyEvent {
  pokemon: string;
  encounters: number;
  elapsedSeconds: number;
  screenshotPath: string;
  // RNG stats (optional — present for Switch RNG engine)
  nature?: string;
  gender?: string;
  tid?: number | null;
  deducedSID?: number | null;
  activeSIDs?: number;
  eliminatedSIDs?: number;
  pidObservations?: number;
  advanceHits?: number;
  advanceWindow?: { min: number; max: number };
  targetSeed?: string;
  targetSIDs?: number;
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

  const fields = [
    { name: 'Encounters', value: event.encounters.toLocaleString(), inline: true },
    { name: 'Time', value: formatDuration(event.elapsedSeconds), inline: true },
    { name: 'Rate', value: `${rate}/hr`, inline: true },
  ];

  // Add RNG-specific stats if available
  if (event.nature) {
    fields.push({ name: 'Nature', value: event.nature, inline: true });
  }
  if (event.gender) {
    fields.push({ name: 'Gender', value: event.gender === 'male' ? '♂ Male' : event.gender === 'female' ? '♀ Female' : '?', inline: true });
  }
  if (event.tid != null) {
    const sidStr = event.deducedSID != null
      ? `${event.deducedSID} (0x${event.deducedSID.toString(16).padStart(4, '0')})`
      : 'Unknown';
    fields.push({ name: 'TID / SID', value: `${event.tid} / ${sidStr}`, inline: true });
  }
  if (event.targetSeed) {
    fields.push({ name: 'Target Seed', value: `${event.targetSeed} (${event.targetSIDs} SIDs)`, inline: true });
  }
  if (event.activeSIDs != null) {
    fields.push({ name: 'SID Status', value: `${event.activeSIDs} active / ${event.eliminatedSIDs} eliminated`, inline: true });
  }
  if (event.advanceWindow) {
    fields.push({ name: 'Advance Window', value: `${event.advanceWindow.min}-${event.advanceWindow.max} (${event.advanceHits ?? 0} hits)`, inline: true });
  }
  if (event.pidObservations != null) {
    fields.push({ name: 'PID Observations', value: `${event.pidObservations}`, inline: true });
  }

  // Calculate multi-SID odds for the winning seed
  const standardOdds = 8192;
  let oddsStr = `1/${standardOdds} standard`;
  if (event.activeSIDs && event.targetSIDs) {
    const multiOdds = Math.round(1 / ((event.targetSIDs / event.activeSIDs) * (1 / 201)));
    oddsStr = `1/${multiOdds} multi-SID vs ${oddsStr}`;
  }
  fields.push({ name: 'Odds', value: oddsStr, inline: false });

  const payload = {
    embeds: [
      {
        title: `✨ SHINY ${event.pokemon.toUpperCase()} FOUND! ✨`,
        color: 0xffd700, // Gold
        fields,
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

export async function notifyDailySummary(stats: {
  encounters: number;
  shinies: number;
  hoursActive: number;
  avgRate: number;
  target: string;
  game: string;
}): Promise<void> {
  const fields = [
    { name: 'Encounters Today', value: stats.encounters.toLocaleString(), inline: true },
    { name: 'Shinies Found', value: stats.shinies.toString(), inline: true },
    { name: 'Hours Active', value: `${stats.hoursActive.toFixed(1)}h`, inline: true },
    { name: 'Avg Rate', value: `${stats.avgRate}/hr`, inline: true },
  ];

  const payload = {
    embeds: [
      {
        title: `📊 Daily Summary — ${stats.target} in ${stats.game}`,
        color: 0x9b59b6, // Purple
        fields,
        footer: { text: 'Shiny Hunter Daily Report' },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await sendWebhook(payload);
  logger.info(`Discord daily summary sent: ${stats.encounters} encounters today`);
}
