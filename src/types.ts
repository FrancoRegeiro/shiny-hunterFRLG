// === Frame Source ===
export interface FrameSource {
  captureFrame(): Promise<Buffer>;
  captureFrameBurst?(count: number, durationSec: number): Promise<Buffer[]>;
  getLatestFrame?(): { frame: Buffer; timestamp: number } | null;
  init(): Promise<void>;
  cleanup(): Promise<void>;
}

// === Input Controller ===
export type GBAButton = 'A' | 'B' | 'START' | 'SELECT' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'L' | 'R';

export interface InputController {
  pressButton(button: GBAButton, holdMs?: number): Promise<void>;
  pressButtons(buttons: GBAButton[], holdMs?: number): Promise<void>;
  releaseAll(): Promise<void>;
  softReset(): Promise<void>;
  loadState(slot: number): Promise<void>;
  saveState(slot: number): Promise<void>;
  setTurbo(enabled: boolean): Promise<void>;
  logEncounter?(encounter: number, isShiny: boolean, pokemon: string, details?: string): void;
  init(): Promise<void>;
  cleanup(): Promise<void>;
}

// === Lua Bridge Protocol ===
export interface LuaCommand {
  cmd: 'press' | 'release' | 'loadState' | 'saveState' | 'turbo' | 'screenshot' | 'reset' | 'log' | 'readMemory';
  keys?: string[];
  frames?: number;
  slot?: number;
  enabled?: boolean;
  path?: string;
  message?: string;
  address?: number;
  size?: number;
}

export interface LuaResponse {
  status: 'ok' | 'error';
  frame?: number;
  message?: string;
  hex?: string;
  value?: number;
}

// === Detection ===
export interface HueRange {
  min: number;
  max: number;
}

export interface ColorSignature {
  hueRanges: HueRange[];
  satMin: number;
  valMin: number;
}

export interface PokemonPalette {
  normal: ColorSignature;
  shiny: ColorSignature;
}

export interface DetectionResult {
  isShiny: boolean;
  confidence: number;
  normalPixels: number;
  shinyPixels: number;
  totalSampled: number;
  debugInfo?: string;
}

export interface SpriteRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenType = 'overworld' | 'dialogue' | 'party_menu' | 'summary' | 'battle' | 'unknown';

export interface ScreenDetectionResult {
  screen: ScreenType;
  confidence: number;
}

// === Hunt Engine ===
export type HuntState =
  | 'IDLE'
  | 'SOFT_RESET'
  | 'WAIT_BOOT'
  | 'TITLE_SCREEN'
  | 'LOAD_SAVE'
  | 'WAIT_OVERWORLD'
  | 'PICK_STARTER'
  | 'OPEN_SUMMARY'
  | 'CAPTURE_AND_DETECT'
  | 'SHINY_FOUND'
  | 'RESET';

export interface HuntStatus {
  state: HuntState;
  encounters: number;
  target: string;
  game: string;
  startedAt: number | null;
  elapsedSeconds: number;
  encountersPerHour: number;
  running: boolean;
}

// === Button Sequences ===
export type SequenceStep =
  | { action: 'press'; keys: GBAButton[]; holdMs: number }
  | { action: 'wait'; ms: number }
  | { action: 'mashA'; count: number; intervalMs: number }
  | { action: 'mashB'; count: number; intervalMs: number }
  | { action: 'screenshot'; label: string };

export type ButtonSequence = SequenceStep[];

// === Engine Interface ===
export interface IHuntEngine {
  getStatus(): HuntStatus;
  start(): Promise<void>;
  stop(): void;
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

// === Database ===
export interface HuntRecord {
  id: number;
  target: string;
  game: string;
  started_at: number;
  ended_at: number | null;
  encounters: number;
  status: 'active' | 'found' | 'abandoned';
}

export interface ShinyFindRecord {
  id: number;
  hunt_id: number;
  pokemon: string;
  encounters: number;
  elapsed_seconds: number;
  screenshot_path: string | null;
  found_at: number;
}
