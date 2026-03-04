import net from 'net';
import { InputController, GBAButton, LuaCommand, LuaResponse } from '../types';
import { config } from '../config';
import { logger } from '../logger';

export class EmulatorInput implements InputController {
  private socket: net.Socket | null = null;
  private responseBuffer = '';
  private pendingResolve: ((resp: LuaResponse) => void) | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setNoDelay(true);

      this.socket.on('data', (data) => {
        this.responseBuffer += data.toString();
        const lines = this.responseBuffer.split('\n');
        // Keep the last incomplete line in buffer
        this.responseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim() && this.pendingResolve) {
            try {
              const resp: LuaResponse = JSON.parse(line);
              const resolve = this.pendingResolve;
              this.pendingResolve = null;
              resolve(resp);
            } catch {
              logger.error(`Failed to parse Lua response: ${line}`);
            }
          }
        }
      });

      this.socket.on('error', (err) => {
        logger.error(`Lua bridge connection error: ${err.message}`);
        reject(err);
      });

      this.socket.connect(config.mgba.port, config.mgba.host, () => {
        logger.info(`Connected to mGBA Lua bridge at ${config.mgba.host}:${config.mgba.port}`);
        resolve();
      });
    });
  }

  private sendCommand(cmd: LuaCommand): Promise<LuaResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected to Lua bridge'));
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingResolve = null;
        reject(new Error(`Lua bridge command timed out: ${cmd.cmd}`));
      }, 5000);

      this.pendingResolve = (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      };

      this.socket.write(JSON.stringify(cmd) + '\n');
    });
  }

  async pressButton(button: GBAButton, holdMs = 50): Promise<void> {
    await this.pressButtons([button], holdMs);
  }

  async pressButtons(buttons: GBAButton[], holdMs = 50): Promise<void> {
    // Convert ms to frames (~16.7ms per frame at 60fps)
    const frames = Math.max(1, Math.round(holdMs / 16.7));
    await this.sendCommand({ cmd: 'press', keys: buttons, frames });
    // Wait for the hold duration plus a small buffer
    await this.wait(holdMs + 17);
  }

  async releaseAll(): Promise<void> {
    await this.sendCommand({ cmd: 'release' });
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

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async cleanup(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      logger.info('Disconnected from Lua bridge');
    }
  }
}
