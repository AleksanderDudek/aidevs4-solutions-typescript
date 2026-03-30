import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { submitAnswer } from "../lib/hub.js";

const TASK = "drone";
const TASK_DIR = path.resolve("data", "s02e05");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function fetchCached(url: string, cachePath: string): Promise<Buffer> {
  if (existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return readFileSync(cachePath);
  }
  console.log(`📥 Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cachePath, buf);
  console.log(`💾 Saved to cache: ${cachePath}`);
  return buf;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  const HUB_BASE = process.env.HUB_BASE_URL;
  if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");

  // 1. Download the drone map
  const targetPlant = process.env.REACTOR_DEST ?? "";
  console.log(`📋 Task: drone — bomb the dam near ${targetPlant}`);
  const mapPath = path.join(TASK_DIR, "drone.png");
  await fetchCached(`${HUB_BASE}/data/${apiKey}/drone.png`, mapPath);

  // 2. Map analysis result (pre-computed via pixel analysis):
  //    Grid: 3 columns × 4 rows (red lines at RGB ~255,49,49)
  //    Vertical red lines at x: 0-5, 638-643, 1276-1281, 1914-1919
  //    Horizontal red lines at y: 0-5, 231-236, 462-466, 692-697, 923-928
  //    Sector (2,4) = bottom-middle has the most water (6.6% blue pixels)
  //    → This is the dam sector
  const DAM_SECTOR = { x: 2, y: 4 };
  const POWER_PLANT_ID = process.env.REACTOR_DEST;
  if (!POWER_PLANT_ID) throw new Error("Missing REACTOR_DEST in .env");

  console.log(`🎯 Dam located at sector (${DAM_SECTOR.x}, ${DAM_SECTOR.y})`);

  // 3. Build drone instructions
  //    - Target the power plant (official mission objective)
  //    - But set landing sector to the dam
  //    - Configure for bombing run with return
  const instructions = [
    `setDestinationObject(${POWER_PLANT_ID})`,
    `set(${DAM_SECTOR.x},${DAM_SECTOR.y})`,
    "set(50m)",
    "set(engineON)",
    "set(100%)",
    "set(destroy)",
    "set(return)",
    "flyToLocation",
  ];

  console.log("📤 Drone instructions:", instructions);

  // 4. Submit
  const result = await submitAnswer(
    TASK,
    { instructions },
    apiKey
  );

  console.log("📨 Result:", result);
}

run().catch(console.error);
