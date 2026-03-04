// === Frame Source ===
export interface FrameSource {
  captureFrame(): Promise<Buffer>;
  init(): Promise<void>;
  cleanup(): Promise<void>;
}

// === Input Controller ===
export type GBAButton = 'A' | 'B' | 'START' | 'SELECT' | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'L' | 'R';

export interface InputController {
  pressButton(button: GBAButton, holdMs?: number): Promise<void>;
  pressButtons(buttons: GBAButton[], holdMs?: number): Promise<void>;
  releaseAll(): Promise<void>;
  loadState(slot: number): Promise<void>;
  saveState(slot: number): Promise<void>;
  setTurbo(enabled: boolean): Promise<void>;
  init(): Promise<void>;
  cleanup(): Promise<void>;
}

// === Lua Bridge Protocol ===
export interface LuaCommand {
  cmd: 'press' | 'release' | 'loadState' | 'saveState' | 'turbo' | 'screenshot';
  keys?: string[];
  frames?: number;
  slot?: number;
  enabled?: boolean;
  path?: string;
}

export interface LuaResponse {
  status: 'ok' | 'error';
  frame?: number;
  message?: string;
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
  | 'LOAD_STATE'
  | 'WAIT_SETTLE'
  | 'PICK_STARTER'
  | 'OPEN_PARTY'
  | 'SELECT_POKEMON'
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
  | { action: 'mashB'; count: number; intervalMs: number };

export type ButtonSequence = SequenceStep[];

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
