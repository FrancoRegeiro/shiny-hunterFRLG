import { FrameSource } from '../types';
import { logger } from '../logger';

// Future implementation: capture frames from USB capture card via ffmpeg
export class CaptureCardFrames implements FrameSource {
  async init(): Promise<void> {
    logger.info('Capture card frame source — not yet implemented');
    throw new Error('Capture card frame source not implemented. Use emulator for now.');
  }

  async captureFrame(): Promise<Buffer> {
    throw new Error('Not implemented');
  }

  async cleanup(): Promise<void> {
    // no-op
  }
}
