import fs from 'fs/promises';
import { FrameSource } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { EmulatorInput } from './emulator-input';

export class EmulatorFrames implements FrameSource {
  private input: EmulatorInput;

  constructor(input: EmulatorInput) {
    this.input = input;
  }

  async init(): Promise<void> {
    // Input connection already established; nothing extra needed
    logger.info('Emulator frame source initialized (via Lua screenshot)');
  }

  async captureFrame(): Promise<Buffer> {
    const framePath = config.paths.tmpFrame;

    // Ask mGBA to write a screenshot
    await this.input.captureScreenshot(framePath);

    // Small delay to ensure file is written
    await new Promise((r) => setTimeout(r, 30));

    // Read the PNG file
    const buffer = await fs.readFile(framePath);
    return buffer;
  }

  async cleanup(): Promise<void> {
    // Clean up temp file
    try {
      await fs.unlink(config.paths.tmpFrame);
    } catch {
      // File may not exist
    }
  }
}
