import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController, GBAButton } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import {
  isBattleScreen,
  isOverworldScreen,
  scanForSparkle,
  scanFramesForSparkle,
} from '../detection/battle-shiny';
import { extractBattleInfo, hasWildAppearedText, BattleEnemyInfo } from '../detection/battle-info';
import { analyzeBattlePalette, checkShinyByPalette, BattlePaletteResult } from '../detection/battle-palette';

/**
 * Wild encounter shiny hunt engine.
 *
 * Flow:
 * 1. Game is pre-saved standing in tall grass/water
 * 2. Walk in a pattern (up/down/left/right) to trigger random encounters
 * 3. When battle starts, scan for shiny sparkle animation
 * 4. If shiny: stop (user catches manually)
 * 5. If not shiny: run from battle, continue walking
 *
 * No soft resets needed — just walk continuously.
 */

type WildHuntState =
  | 'IDLE'
  | 'WALKING'
  | 'BATTLE_ENTRY'
  | 'CHECK_SPARKLE'
  | 'SHINY_FOUND'
  | 'RUN_AWAY'
  | 'WAIT_OVERWORLD';

// Walking pattern: UP then DOWN keeps you in the same spot
// This prevents walking out of the grass patch
const WALK_PATTERN: GBAButton[] = ['UP', 'DOWN'];

export class WildHuntEngine extends EventEmitter {
  private state: WildHuntState = 'IDLE';
  private encounters = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;
  private walkIndex = 0;
  private stepsSinceEncounter = 0;
  private lastBattleInfo: BattleEnemyInfo = { species: null, level: null, gender: 'unknown' };
  private waitOverworldTicks = 0;

  // Encounter log for dashboard
  public encounterLog: Array<{
    attempt: number;
    time: number;
    sparkleCount: number;
    maxCluster: number;
    isShiny: boolean;
    framesChecked: number;
    debugInfo: string;
    species: string | null;
    level: number | null;
    gender: string;
    paletteInfo: string;
  }> = [];

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
  }

  getStatus(): HuntStatus {
    const now = Date.now();
    const elapsed = this.startedAt ? (now - this.startedAt) / 1000 : 0;
    return {
      state: this.state as any,
      encounters: this.encounters,
      target: this.target,
      game: this.game,
      startedAt: this.startedAt,
      elapsedSeconds: elapsed,
      encountersPerHour: elapsed > 0 ? Math.round((this.encounters / elapsed) * 3600) : 0,
      running: this.running,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    logger.info(`[Wild Hunt] Starting: ${this.target} in ${this.game}`);
    logger.info('[Wild Hunt] Walk pattern: UP → DOWN (repeat)');
    logger.info('[Wild Hunt] Shiny detection: sparkle + palette analysis');

    // Soft reset the game to ensure clean state (not stuck in battle)
    logger.info('[Wild Hunt] Soft resetting game to ensure clean overworld state...');
    await this.input.softReset();
    await this.wait(3000); // Wait for game to start resetting

    // Mash A through the title screen / continue screen
    for (let i = 0; i < 15; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(500);
    }
    // Wait for the overworld to load after "Continue"
    await this.wait(2000);
    logger.info('[Wild Hunt] Game reset complete, starting hunt');

    this.running = true;
    this.encounters = 0;
    this.startedAt = Date.now();
    this.state = 'WALKING';
    this.walkIndex = 0;
    this.stepsSinceEncounter = 0;
    this.emit('started', this.getStatus());

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Wild Hunt] Error in state ${this.state}: ${msg}`);
        // Try to recover by going back to walking
        this.state = 'WALKING';
        await this.wait(2000);
      }
    }
  }

  stop(): void {
    logger.info(`[Wild Hunt] Stopping after ${this.encounters} encounters`);
    this.running = false;
    this.state = 'IDLE';
    this.emit('stopped', this.getStatus());
  }

  private async tick(): Promise<void> {
    switch (this.state) {
      case 'WALKING':
        await this.walkAndCheckBattle();
        break;

      case 'BATTLE_ENTRY':
        await this.handleBattleEntry();
        break;

      case 'CHECK_SPARKLE':
        await this.checkSparkle();
        break;

      case 'SHINY_FOUND':
        logger.info('[Wild Hunt] *** SHINY FOUND! Do NOT press anything — catch it manually! ***');
        this.stop();
        break;

      case 'RUN_AWAY':
        await this.runFromBattle();
        break;

      case 'WAIT_OVERWORLD':
        await this.waitForOverworld();
        break;

      case 'IDLE':
        await this.wait(100);
        break;
    }
  }

  /**
   * Take one step in the walk pattern and check if we entered a battle.
   */
  private async walkAndCheckBattle(): Promise<void> {
    const direction = WALK_PATTERN[this.walkIndex % WALK_PATTERN.length];
    this.walkIndex++;

    // Take a step — hold longer for reliability on NSO
    await this.input.pressButton(direction, 150);
    await this.wait(400); // wait for step animation + capture card latency
    this.stepsSinceEncounter++;

    // Check if we entered a battle — single frame check (saves ~1.75s per step).
    // If we miss a battle start, we'll catch it on the next step.
    const frame = await this.frameSource.captureFrame();
    const inBattle = await isBattleScreen(frame);

    if (inBattle) {
      logger.info(`[Wild Hunt] Battle detected after ${this.stepsSinceEncounter} steps!`);
      this.stepsSinceEncounter = 0;
      this.state = 'BATTLE_ENTRY';
      return;
    }

    // Log progress occasionally
    if (this.stepsSinceEncounter > 0 && this.stepsSinceEncounter % 50 === 0) {
      logger.info(`[Wild Hunt] ${this.stepsSinceEncounter} steps since last encounter (${this.encounters} total encounters)`);
    }
  }

  /**
   * Battle detected — wait for the enemy Pokemon to enter and the sparkle window.
   *
   * FRLG wild battle timeline (from actual battle start):
   *   t+0.0s: Battle transition (screen wipe)
   *   t+1.0s: Battle background loads, enemy Pokemon slides in
   *   t+1.5s: Enemy shiny sparkle plays (if shiny) — lasts ~1s
   *   t+2.0s: Battle text box visible → isBattleScreen() detects it (t=0 for us)
   *   t+3.0s: "Wild POKEMON appeared!" text
   *   t+5.0s: "Go! CHARMANDER!" — player's Pokemon enters
   *   t+5.5s: Player's shiny sparkle plays (if shiny) + SCREEN FLASH
   *   t+7.0s: Battle menu appears
   *
   * IMPORTANT: Our player's Charmander is shiny, so it sparkles with a
   * screen-wide white flash at ~t+5.5s. We MUST end scanning before t+5s.
   *
   * From battle detection (t+2s):
   *   - Wait 200ms for screen to stabilize
   *   - Scan 8 frames × 150ms = 1200ms
   *   - Total: ~1400ms → scan ends at ~t+3.4s (safe margin before t+5s)
   *
   * This catches the tail end of the enemy sparkle animation (t+1.5-2.5s).
   */
  private async handleBattleEntry(): Promise<void> {
    this.encounters++;
    logger.info(`[Wild Hunt] Encounter #${this.encounters} — reading "Wild X appeared!" text...`);

    // IMPORTANT: Don't press any buttons! Wait for "Wild X appeared!" text
    // to fully render, then OCR it. The text box has white text on dark blue.
    //
    // Timeline from battle detection (isBattleScreen = true):
    //   t+0s: Text box appears with "Wild CATERPIE appeared!" text
    //   We wait ~1.5s for text to finish typing, then OCR.
    //   Don't press A — let the text sit so we can read it reliably.

    await this.wait(1500); // Wait for text animation to finish typing

    this.lastBattleInfo = { species: null, level: null, gender: 'unknown' };

    // Try OCR multiple times — wait for "Wild X appeared!" text to be fully rendered
    for (let attempt = 0; attempt < 5 && this.running; attempt++) {
      try {
        const frame = await this.frameSource.captureFrame();

        // Check if text box has content before attempting expensive OCR
        const textReady = await hasWildAppearedText(frame);
        if (!textReady && attempt < 4) {
          await this.wait(300);
          continue;
        }

        const info = await extractBattleInfo(frame);

        // Update with best info found
        if (info.species && !this.lastBattleInfo.species) {
          this.lastBattleInfo.species = info.species;
        }
        if (info.gender !== 'unknown') this.lastBattleInfo.gender = info.gender;
        if (info.level) this.lastBattleInfo.level = info.level;

        if (this.lastBattleInfo.species) {
          logger.info(`[Wild Hunt] Identified: ${this.lastBattleInfo.species} Lv${this.lastBattleInfo.level ?? '?'} ${this.lastBattleInfo.gender}`);
          break;
        }
      } catch {}
      await this.wait(300);
    }

    if (!this.lastBattleInfo.species) {
      logger.warn('[Wild Hunt] Could not identify species from text box OCR');
    }

    this.state = 'CHECK_SPARKLE';
  }

  /**
   * Capture multiple frames during the Pokemon entry animation and check for sparkles.
   * Uses BOTH sparkle detection AND palette-based shiny detection.
   */
  private async checkSparkle(): Promise<void> {
    // Use burst capture if available (single ffmpeg call = ~3s for 10 frames).
    // Falls back to individual captures (~9s for 5 frames).
    let sparkleShiny: boolean;
    let bestResult: { sparkleCount: number; maxClusterSize: number; debugInfo: string; isShiny: boolean };
    let framesChecked: number;

    let burstFrames: Buffer[] = [];
    if (this.frameSource.captureFrameBurst) {
      burstFrames = await this.frameSource.captureFrameBurst(8, 2); // 8 frames over 2s = 250ms intervals
      ({ isShiny: sparkleShiny, bestResult, framesChecked } = await scanFramesForSparkle(burstFrames));
    } else {
      ({ isShiny: sparkleShiny, bestResult, framesChecked } = await scanForSparkle(
        () => this.frameSource.captureFrame(),
        5,    // frames to check
        150,  // ms between frames
      ));
    }

    // Palette-based species identification + shiny detection
    // Try on the best battle frame (last frames most likely to show full sprite)
    let paletteResult: BattlePaletteResult = {
      species: null, speciesId: null, isShiny: false,
      confidence: 0, normalScore: 0, shinyScore: 0, debugInfo: 'no frame',
    };
    let battleFrame: Buffer | null = null;

    if (burstFrames.length > 0) {
      for (let i = burstFrames.length - 1; i >= Math.max(0, burstFrames.length - 3); i--) {
        const isBattle = await isBattleScreen(burstFrames[i]);
        if (isBattle) {
          battleFrame = burstFrames[i];
          paletteResult = await analyzeBattlePalette(burstFrames[i]);
          break;
        }
      }
    }
    // Fallback: capture a fresh frame
    if (!paletteResult.species) {
      try {
        battleFrame = await this.frameSource.captureFrame();
        paletteResult = await analyzeBattlePalette(battleFrame);
      } catch {}
    }

    // Use battle info captured during "Wild X appeared!" text
    const species = this.lastBattleInfo.species;
    const level = this.lastBattleInfo.level;
    const gender = this.lastBattleInfo.gender;

    // Palette-based shiny check: if we identified the species, compare
    // the battle sprite against that species' known palettes.
    // This is done on a battle frame where the sprite is fully visible.
    let paletteShiny = false;
    let paletteDebug = '';
    if (species && battleFrame) {
      try {
        const paletteCheck = await checkShinyByPalette(battleFrame, species);
        paletteShiny = paletteCheck.isShiny;
        paletteDebug = paletteCheck.debugInfo;
      } catch {}
    }

    // Shiny if EITHER sparkle animation OR palette comparison detects it.
    // With known species, palette check is reliable (no species confusion).
    const isShiny = sparkleShiny || paletteShiny;

    const infoStr = species
      ? `${species} Lv${level ?? '?'} ${gender === 'male' ? '♂' : gender === 'female' ? '♀' : ''}`
      : '';

    logger.info(
      `[Wild Hunt] Encounter #${this.encounters}: ` +
      `${isShiny ? '*** SHINY! ***' : 'not shiny'} | ` +
      `${infoStr ? infoStr + ' | ' : ''}` +
      `sparkle: ${bestResult.debugInfo} | ` +
      `${paletteDebug ? 'palette: ' + paletteDebug + ' | ' : ''}` +
      `${framesChecked} frames`
    );

    // Save debug screenshots for first 10 encounters
    if (this.encounters <= 10 || bestResult.sparkleCount > 10 || paletteShiny) {
      try {
        const debugFrame = battleFrame || (burstFrames.length > 0 ? burstFrames[burstFrames.length - 1] : await this.frameSource.captureFrame());
        const debugPath = path.join(
          process.cwd(), config.paths.screenshots,
          `wild-debug-${this.encounters}-sparkle${bestResult.sparkleCount}-${Date.now()}.png`
        );
        fs.writeFile(debugPath, debugFrame).catch(() => {});
      } catch { /* ignore */ }
    }

    // Log encounter
    this.encounterLog.push({
      attempt: this.encounters,
      time: Date.now(),
      sparkleCount: bestResult.sparkleCount,
      maxCluster: bestResult.maxClusterSize,
      isShiny,
      framesChecked,
      debugInfo: bestResult.debugInfo,
      species,
      level,
      gender,
      paletteInfo: paletteDebug || paletteResult.debugInfo,
    });
    if (this.encounterLog.length > 200) this.encounterLog.shift();

    if (isShiny) {
      // Save screenshot
      const frame = await this.frameSource.captureFrame();
      const screenshotPath = path.join(
        process.cwd(), config.paths.screenshots,
        `wild-shiny-${this.target}-${Date.now()}.png`
      );
      await fs.writeFile(screenshotPath, frame);

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.encounters,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
      });

      this.state = 'SHINY_FOUND';
    } else {
      // Advance battle text: "Wild X appeared!" → "Go! CHARMANDER!" → player sparkle → menu.
      // Proven timing: initial wait + 6 A presses at 500ms intervals gets through all text.
      // If last A overshoots into menu and hits FIGHT, runFromBattle's B cancels it.
      await this.wait(1000);
      for (let i = 0; i < 6 && this.running; i++) {
        await this.input.pressButton('A', 50);
        await this.wait(500);
      }
      this.state = 'RUN_AWAY';
    }

    // Emit milestone every 100 encounters
    if (this.encounters % 100 === 0) {
      this.emit('milestone', this.getStatus());
    }
  }

  /**
   * Navigate to RUN in the battle menu and flee.
   *
   * FRLG battle menu layout:
   *   FIGHT   |  BAG
   *   POKeMON |  RUN
   *
   * Default cursor position: FIGHT (top-left)
   * To reach RUN: DOWN → RIGHT → A
   *
   * On retry (failed escape), cursor may already be on RUN,
   * so we press B first to cancel any sub-menu, then navigate fresh.
   */
  private async runFromBattle(): Promise<void> {
    // B to cancel any sub-menu (move list, bag, team screen)
    await this.input.pressButton('B', 50);
    await this.wait(300);
    await this.input.pressButton('B', 50);
    await this.wait(300);
    // Navigate to RUN: RIGHT then DOWN reaches RUN from ANY cursor position
    // FIGHT→BAG→RUN, BAG→BAG→RUN, POKEMON→RUN→RUN, RUN→RUN→RUN
    await this.input.pressButton('RIGHT', 50);
    await this.wait(100);
    await this.input.pressButton('DOWN', 50);
    await this.wait(100);
    await this.input.pressButton('A', 50);
    await this.wait(1500); // run animation

    // "Got away safely!" — use B to dismiss (B won't open START menu on overworld)
    for (let i = 0; i < 4 && this.running; i++) {
      await this.input.pressButton('B', 50);
      await this.wait(400);
    }

    // If running failed ("Can't escape!"), WAIT_OVERWORLD detects and retries.
    this.state = 'WAIT_OVERWORLD';
  }

  /**
   * Wait until we're back on the overworld after running from battle.
   * If we detect we're still in battle (run failed), try again.
   */
  private async waitForOverworld(): Promise<void> {
    const frame = await this.frameSource.captureFrame();

    // Check if we're back on overworld
    const onOverworld = await isOverworldScreen(frame);
    if (onOverworld) {
      logger.info(`[Wild Hunt] Back on overworld — continuing hunt (${this.encounters} encounters)`);
      this.waitOverworldTicks = 0;
      this.state = 'WALKING';
      return;
    }

    // Check if we're still in battle (run failed)
    const inBattle = await isBattleScreen(frame);
    if (inBattle) {
      logger.info('[Wild Hunt] Still in battle — run may have failed, trying again');
      this.waitOverworldTicks = 0;
      this.state = 'RUN_AWAY';
      return;
    }

    this.waitOverworldTicks++;

    // If stuck for >10s (neither overworld nor battle), we're probably in a menu.
    // Spam B to exit, then soft reset if still stuck.
    if (this.waitOverworldTicks > 40) { // 40 × 250ms = 10s
      logger.warn('[Wild Hunt] Stuck in unknown screen — soft resetting');
      await this.input.softReset();
      await this.wait(3000);
      for (let i = 0; i < 15; i++) {
        await this.input.pressButton('A', 50);
        await this.wait(500);
      }
      await this.wait(2000);
      this.waitOverworldTicks = 0;
      this.state = 'WALKING';
      return;
    }

    if (this.waitOverworldTicks > 20) { // 20 × 250ms = 5s — try B spam first
      await this.input.pressButton('B', 50);
    }

    await this.wait(250);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
