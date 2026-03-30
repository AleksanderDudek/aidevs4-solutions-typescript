import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync } from "fs";

const TASK = "reactor";
const TASK_DIR = path.resolve("data", "s03e03");
const HUB_BASE = process.env.HUB_BASE_URL;
if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Types ────────────────────────────────────────────────────────────────────

interface Block {
  col: number;
  top_row: number;
  bottom_row: number;
  direction: "up" | "down";
}

interface GameState {
  code: number;
  message: string;
  board?: string[][];
  player?: { col: number; row: number };
  goal?: { col: number; row: number };
  blocks?: Block[];
  reached_goal?: boolean;
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function sendCommand(apiKey: string, command: string): Promise<GameState> {
  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, task: TASK, answer: { command } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<GameState>;
}

// ─── Block simulation ─────────────────────────────────────────────────────────

/**
 * Simulates one step of block movement.
 * Blocks reverse direction when reaching the top (top_row = 1) or bottom (bottom_row = 5).
 */
function simulateBlock(b: Block): Block {
  if (b.direction === "up") {
    const newTopRow = b.top_row - 1;
    const newBottomRow = b.bottom_row - 1;
    // If we've reached the top boundary, reverse direction for next step
    const newDir: "up" | "down" = newTopRow <= 1 ? "down" : "up";
    return { ...b, top_row: newTopRow, bottom_row: newBottomRow, direction: newDir };
  } else {
    const newTopRow = b.top_row + 1;
    const newBottomRow = b.bottom_row + 1;
    // If we've reached the bottom boundary, reverse direction for next step
    const newDir: "up" | "down" = newBottomRow >= 5 ? "up" : "down";
    return { ...b, top_row: newTopRow, bottom_row: newBottomRow, direction: newDir };
  }
}

function nextBlockStates(blocks: Block[]): Block[] {
  return blocks.map(simulateBlock);
}

/**
 * Returns true if, in the given block states, any block occupies the
 * robot's row (row 5) in the specified column.
 */
function isColDangerous(col: number, blocks: Block[]): boolean {
  return blocks.some(b => b.col === col && b.bottom_row >= 5);
}

// ─── Decision logic ───────────────────────────────────────────────────────────

/**
 * Chooses the next action based on current game state.
 *
 * Safety principle: check that the target cell is safe AFTER all blocks move
 * (i.e., in nextBlocks). Also check current blocks to avoid stepping into an
 * already-occupied cell.
 *
 * Priority: right > wait > left
 */
function chooseAction(playerCol: number, goalCol: number, blocks: Block[]): string {
  const next1 = nextBlockStates(blocks);
  const next2 = nextBlockStates(next1);

  // Currently dangerous in destination? (block already at row 5 before move)
  const rightColCurrentlyDangerous = isColDangerous(playerCol + 1, blocks);
  // Dangerous after I step there (blocks move simultaneously with robot)?
  const rightColDangerousAfterStep = isColDangerous(playerCol + 1, next1);
  // Dangerous one step after I arrive (would be trapped immediately)?
  const rightColDangerousNextNext = isColDangerous(playerCol + 1, next2);

  // Moving right is safe if destination is clear now AND after the step
  const canMoveRight =
    playerCol < goalCol &&
    !rightColCurrentlyDangerous &&
    !rightColDangerousAfterStep;

  // Safe to stay: current col must be safe after blocks move
  const safeToWait =
    !isColDangerous(playerCol, next1);

  // Safe to move left: destination col must be safe after blocks move
  const canMoveLeft =
    playerCol > 1 &&
    !isColDangerous(playerCol - 1, blocks) &&
    !isColDangerous(playerCol - 1, next1);

  if (canMoveRight) {
    // Prefer moving right unless destination would be immediately unsafe next step
    // (blocks close in right after we arrive) AND we can safely wait here instead
    if (rightColDangerousNextNext && safeToWait) {
      console.log(`   ⚠️  col ${playerCol + 1} safe to arrive but unsafe next step → wait`);
      return "wait";
    }
    return "right";
  }

  if (safeToWait) return "wait";
  if (canMoveLeft) return "left";

  // Last resort: wait and hope for the best
  console.log("   ⚠️  No safe move found, waiting as last resort");
  return "wait";
}

// ─── Board printer ────────────────────────────────────────────────────────────

function printBoard(board: string[][] | undefined, step: number, action: string): void {
  if (!board) return;
  const lines = board.map(row => row.join(" "));
  console.log(`\nStep ${step} → ${action}`);
  lines.forEach(l => console.log(" ", l));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log("📋 Task: reactor — navigate robot through reactor blocks");

  // Start / reset game
  let state = await sendCommand(apiKey, "start");
  console.log(`🎮 ${state.message}`);

  let step = 0;
  const MAX_STEPS = 300;

  while (step < MAX_STEPS) {
    // code 0 = success with flag
    if (state.code === 0) {
      console.log(`\n✅ Goal reached! ${state.message}`);
      if (state.message.includes("FLG:")) {
        console.log(`🚩 FLAG: ${state.message}`);
      }
      break;
    }

    if (state.code < 0) {
      console.error(`❌ Error [${state.code}]: ${state.message}`);
      // If robot died, reset and try again
      if (step < 250) {
        console.log("♻️  Resetting and restarting...");
        state = await sendCommand(apiKey, "start");
        step = 0;
        continue;
      }
      break;
    }

    if (!state.player || !state.goal || !state.blocks) {
      console.error("❌ Unexpected state shape:", state);
      break;
    }

    const { player, goal, blocks } = state;

    // Reached goal?
    if (player.col === goal.col) {
      console.log(`\n✅ Robot reached column ${goal.col}!`);
      break;
    }

    const action = chooseAction(player.col, goal.col, blocks);
    printBoard(state.board, step, action);
    console.log(
      `   Player: col ${player.col}  Goal: col ${goal.col}  Action: ${action}`
    );

    state = await sendCommand(apiKey, action);
    step++;
  }

  if (step >= MAX_STEPS) {
    console.error(`❌ Exceeded max steps (${MAX_STEPS}), giving up`);
  }
}

run().catch(console.error);
