import { logger } from '../logger';

interface SaveInput {
  pressButton(button: string, holdMs: number): Promise<void>;
}

/**
 * Exit the summary screen and save the game in FRLG.
 *
 * Call this while on the Pokemon summary screen.
 *
 * Exit flow (verified via screenshots):
 *   Summary → B → party context menu → B → party selection → B → START menu → B → overworld
 *   (extra B presses are harmless on overworld)
 *
 * Save flow:
 *   START → DOWN×3 to SAVE → A → "Would you like to save?" A(YES)
 *   → "Overwrite existing file?" A(YES) → SAVING... → "[Player] saved the game!" A
 *
 * Early-game menu (no Pokedex): POKéMON, BAG, [player], SAVE, OPTION, EXIT
 * SAVE is at index 3 (DOWN×3 from top).
 */
export async function exitSummaryAndSave(input: SaveInput): Promise<void> {
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  logger.info('[Save] Exiting summary screen...');

  // Exit summary → party → overworld (B×6 with generous waits)
  for (let i = 0; i < 6; i++) {
    await input.pressButton('B', 50);
    await wait(1000);
  }

  // Open START menu
  await input.pressButton('START', 50);
  await wait(600);

  // Navigate to SAVE (DOWN×3 from top)
  for (let i = 0; i < 3; i++) {
    await input.pressButton('DOWN', 50);
    await wait(200);
  }

  // Select SAVE
  await input.pressButton('A', 50);
  await wait(1500);

  // "Would you like to save the game?" → YES
  await input.pressButton('A', 50);
  await wait(1500);

  // "There is already a saved file. Is it okay to overwrite it?" → YES
  await input.pressButton('A', 50);
  await wait(5000); // Save write takes ~2-3s, wait extra to be safe

  // Dismiss any remaining dialogue (mash A a few times)
  for (let i = 0; i < 3; i++) {
    await input.pressButton('A', 50);
    await wait(500);
  }

  // Close menu
  await input.pressButton('B', 50);
  await wait(300);

  logger.info('[Save] Game saved successfully!');
}
