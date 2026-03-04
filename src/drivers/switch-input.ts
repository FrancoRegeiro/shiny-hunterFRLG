import { InputController, GBAButton } from '../types';
import { logger } from '../logger';

// Future implementation: serial commands to ESP32-S3 for Switch input
export class SwitchInput implements InputController {
  async init(): Promise<void> {
    logger.info('Switch input controller — not yet implemented');
    throw new Error('Switch input not implemented. Use emulator for now.');
  }

  async pressButton(_button: GBAButton, _holdMs?: number): Promise<void> {
    throw new Error('Not implemented');
  }

  async pressButtons(_buttons: GBAButton[], _holdMs?: number): Promise<void> {
    throw new Error('Not implemented');
  }

  async releaseAll(): Promise<void> {
    throw new Error('Not implemented');
  }

  async loadState(_slot: number): Promise<void> {
    throw new Error('Not implemented');
  }

  async saveState(_slot: number): Promise<void> {
    throw new Error('Not implemented');
  }

  async setTurbo(_enabled: boolean): Promise<void> {
    throw new Error('Not implemented');
  }

  async cleanup(): Promise<void> {
    // no-op
  }
}
