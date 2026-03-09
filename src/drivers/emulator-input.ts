import net from 'net';
import { InputController, GBAButton, LuaCommand, LuaResponse } from '../types';
import { config } from '../config';
import { logger } from '../logger';

export class EmulatorInput implements InputController {
  private socket: net.Socket | null = null;
  private connected = false;
  private responseBuffer = '';
  private pendingResolve: ((resp: LuaResponse) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  async init(): Promise<void> {
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cleanup();

      this.socket = new net.Socket();
      this.socket.setNoDelay(true);
      this.responseBuffer = '';

      this.socket.on('data', (data) => {
        this.responseBuffer += data.toString();
        const lines = this.responseBuffer.split('\n');
        this.responseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim() && this.pendingResolve) {
            try {
              const resp: LuaResponse = JSON.parse(line);
              const res = this.pendingResolve;
              this.pendingResolve = null;
              this.pendingReject = null;
              res(resp);
            } catch {
              logger.error(`Failed to parse Lua response: ${line}`);
            }
          }
        }
      });

      this.socket.on('close', () => {
        logger.warn('Lua bridge connection closed');
        this.connected = false;
        // Reject any pending command
        if (this.pendingReject) {
          const rej = this.pendingReject;
          this.pendingResolve = null;
          this.pendingReject = null;
          rej(new Error('Connection closed'));
        }
      });

      this.socket.on('error', (err) => {
        logger.error(`Lua bridge connection error: ${err.message}`);
        this.connected = false;
      });

      this.socket.connect(config.mgba.port, config.mgba.host, () => {
        logger.info(`Connected to mGBA Lua bridge at ${config.mgba.host}:${config.mgba.port}`);
        this.connected = true;
        resolve();
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error(`Could not connect to Lua bridge at ${config.mgba.host}:${config.mgba.port}`));
        }
      }, 5000);
    });
  }

  private async reconnect(): Promise<void> {
    logger.info('Attempting to reconnect to Lua bridge...');
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.connect();
        // Wait for Lua side to process the new connection in its frame callback
        await this.wait(200);
        logger.info(`Reconnected on attempt ${attempt}`);
        return;
      } catch {
        logger.warn(`Reconnect attempt ${attempt}/5 failed`);
        await this.wait(1000 * attempt);
      }
    }
    throw new Error('Failed to reconnect to Lua bridge after 5 attempts');
  }

  private async sendCommand(cmd: LuaCommand): Promise<LuaResponse> {
    // Auto-reconnect if disconnected
    if (!this.connected || !this.socket) {
      await this.reconnect();
    }

    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected to Lua bridge'));
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(new Error(`Lua bridge command timed out: ${cmd.cmd}`));
      }, 5000);

      this.pendingResolve = (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      };
      this.pendingReject = (err) => {
        clearTimeout(timeout);
        reject(err);
      };

      this.socket.write(JSON.stringify(cmd) + '\n');
    });
  }

  async pressButton(button: GBAButton, holdMs = 50): Promise<void> {
    await this.pressButtons([button], holdMs);
  }

  async pressButtons(buttons: GBAButton[], holdMs = 50): Promise<void> {
    const frames = Math.max(1, Math.round(holdMs / 16.7));
    await this.sendCommand({ cmd: 'press', keys: buttons, frames });
    // Minimal wait — just enough for the key to register
    await this.wait(Math.max(34, holdMs));
  }

  async releaseAll(): Promise<void> {
    await this.sendCommand({ cmd: 'release' });
  }

  async softReset(): Promise<void> {
    await this.sendCommand({ cmd: 'reset' });
    logger.info('Soft reset');
    // Give the emulator time to complete the reset before sending more commands.
    // emu:reset() can disrupt the Lua socket briefly.
    await this.wait(500);
  }

  async loadState(slot: number): Promise<void> {
    await this.sendCommand({ cmd: 'loadState', slot });
    logger.info(`Loaded save state slot ${slot}`);
  }

  async saveState(slot: number): Promise<void> {
    await this.sendCommand({ cmd: 'saveState', slot });
    logger.info(`Saved state to slot ${slot}`);
  }

  async setTurbo(enabled: boolean): Promise<void> {
    await this.sendCommand({ cmd: 'turbo', enabled });
    logger.info(`Turbo mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  async captureScreenshot(path: string): Promise<void> {
    await this.sendCommand({ cmd: 'screenshot', path });
  }

  async readMemory(address: number, size: number = 4): Promise<number> {
    const resp = await this.sendCommand({ cmd: 'readMemory', address, size });
    return resp.value ?? 0;
  }

  logEncounter(encounter: number, isShiny: boolean, pokemon: string, details?: string): void {
    const level = isShiny ? 'SHINY' : 'INFO';
    const msg = isShiny
      ? `*** SHINY ${pokemon.toUpperCase()} FOUND *** Encounter #${encounter}`
      : `Encounter #${encounter} — ${pokemon} (normal)`;
    const detailStr = details ? ` | ${details}` : '';
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `${timestamp} [${level}] [ENCOUNTER] ${msg}${detailStr}\n`;
    const fs = require('fs');
    try {
      fs.appendFileSync(require('path').join(process.cwd(), 'logs', 'lua-bridge.log'), line);
    } catch { /* ignore */ }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async cleanup(): Promise<void> {
    this.connected = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}
