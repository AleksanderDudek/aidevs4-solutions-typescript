/**
 * S04E03 — Domatowo (domatowo)
 *
 * Rescue mission: find the wounded partisan hiding in the tallest buildings
 * (block3 = B3 = "Blok 3p") in the bombed city of Domatowo, then call a
 * helicopter for evacuation.
 *
 * Map: 11×11, coordinates: column A-K (left→right), row 1-11 (top→bottom)
 * Survivor radio clue: "I hid in one of the tallest blocks" → block3 only
 *
 * All 14 block3 tiles (3 clusters):
 *  - Top cluster:      F1, G1, F2, G2
 *  - South-west:       A10, B10, C10, A11, B11, C11
 *  - South-east:       H10, I10, H11, I11
 *
 * AP budget: 300 pts.  Estimated worst-case usage: ~180 pts.
 *
 * Strategy:
 *  1. Create 1 transporter with 4 scout passengers (25 pts)
 *  2. Move transporter to key road positions adjacent to each block3 cluster
 *  3. Dismount scouts one by one at each stop (0 pts each)
 *  4. Each scout walks to block3 tiles and inspects (7 pts/step + 1 pt/inspect)
 *  5. Check logs after each inspect — stop on first "human found" log
 *  6. Call helicopter to confirmed position
 *
 * Road network (transporter-only):
 *  - Row 6:  A6–J6  (main east-west, spawn row)
 *  - Col D:  D1–D9  (main north-south)
 *  - Row 9:  B9–J9  (lower east-west)
 *  - E2:     spur off D2, adjacent to top cluster
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const TASK = "domatowo";
const TASK_DIR = path.resolve("data", "s04e03");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

const HUB_BASE = process.env.HUB_BASE_URL;
if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");
const apiKey = process.env.AG3NTS_API_KEY;
if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiResponse {
  code?: number;
  message?: string;
  object?: string;
  crew?: Array<{ id: string; role: string }>;
  dismounted?: string[];
  spawned?: Array<{ scout: string; where: string }>;
  objects?: Array<{ typ: string; position: string; id: string }>;
  logs?: Array<{ scout: string; msg: string; field: string }>;
  action_points_left?: number;
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function api(answer: Record<string, unknown>): Promise<ApiResponse> {
  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, task: TASK, answer }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<ApiResponse>;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/** Check if a getLogs response contains human-found confirmation */
function humanFoundInLogs(logsResp: ApiResponse): string | null {
  const logs = logsResp.logs ?? [];
  for (const entry of logs) {
    const msg = entry.msg?.toLowerCase() ?? "";
    // Positive indicators: explicit confirmation of a living person
    if (
      msg.includes("odnalezion") ||  // "cel odnaleziony" = target found
      msg.includes("mężczyzn") ||    // man/male person
      msg.includes("kobiet") ||       // woman/female person
      msg.includes("człowiek") ||     // human/person
      msg.includes("partyzant") ||    // partisan (the person we're looking for)
      msg.includes("rann") ||         // wounded
      msg.includes("ocalał") ||       // survived
      msg.includes("żyw") ||          // alive
      msg.includes("ocalon")          // rescued/saved
    ) {
      return entry.field;
    }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  log(`📋 Task: ${TASK} — rescue mission in Domatowo`);

  // ── Reset board to fresh state ────────────────────────────────────────────
  const reset = await api({ action: "reset" });
  log(`🔄 Reset: ${reset.message}`);

  // ── Create 1 transporter with 4 scout passengers: 5 + 4×5 = 25 pts ───────
  log("🔧 Creating transporter with 4 scouts...");
  const create = await api({ action: "create", type: "transporter", passengers: 4 });
  if (!create.object || !create.crew) throw new Error(`Create failed: ${JSON.stringify(create)}`);

  const transporterHash = create.object;
  const scoutHashes = create.crew.map((c) => c.id);
  log(`✅ Created: transporter=${transporterHash.slice(0, 8)}, scouts=[${scoutHashes.map((s) => s.slice(0, 6)).join(", ")}]`);
  log(`   AP left: ${create.action_points_left}`);

  // ─── Helper: move + inspect a list of block3 tiles, stop on find ──────────
  let foundAt: string | null = null;
  // Track which log entries we've already seen (to detect NEW entries from THIS inspect)
  let logEntryCount = 0;

  /**
   * Move scout to each tile in sequence, inspect each, check logs.
   * Returns the found position or null.
   */
  async function inspectTiles(scoutId: string, tiles: string[]): Promise<string | null> {
    for (const tile of tiles) {
      log(`  🚶 Scout ${scoutId.slice(0, 6)} → ${tile}`);
      await api({ action: "move", object: scoutId, where: tile });
      const inspectResp = await api({ action: "inspect", object: scoutId });
      log(`     Inspected ${tile}. entries=${inspectResp.entries}, AP left=${inspectResp.action_points_left}`);

      // Get ALL logs each time (scan all, not just new ones)
      const logsResp = await api({ action: "getLogs" });
      const allLogs = logsResp.logs ?? [];
      const newEntries = allLogs.slice(logEntryCount);
      logEntryCount = allLogs.length;

      for (const entry of newEntries) {
        log(`     📋 Log [${entry.field}]: ${entry.msg}`);
      }

      // Check ALL logs (not just new) in case detection failed earlier
      const found = humanFoundInLogs(logsResp);
      if (found) {
        log(`  🎯 HUMAN FOUND at ${found}!`);
        return found;
      }
    }
    return null;
  }

  // ── STAGE 1: Move transporter to E2 and deploy Scout 1 (top cluster) ─────
  log("\n📍 Stage 1: Deploy scout for TOP cluster (F1, G1, F2, G2)");
  const move1 = await api({ action: "move", object: transporterHash, where: "E2" });
  log(`  Transporter → E2: path_steps=${move1.path_steps}, AP left=${move1.action_points_left}`);

  const dismount1 = await api({ action: "dismount", object: transporterHash, passengers: 1 });
  const scout1Position = dismount1.spawned?.[0]?.where ?? "unknown";
  const scout1Hash = dismount1.dismounted?.[0] ?? scoutHashes[0];
  log(`  Scout 1 spawned at: ${scout1Position}`);

  // ── STAGE 2: Move transporter to C9, deploy Scout 2 (SW cluster part) ────
  log("\n📍 Stage 2: Deploy scout for SW cluster part (C10, C11)");
  const move2 = await api({ action: "move", object: transporterHash, where: "C9" });
  log(`  Transporter → C9: path_steps=${move2.path_steps}, AP left=${move2.action_points_left}`);

  const dismount2 = await api({ action: "dismount", object: transporterHash, passengers: 1 });
  const scout2Position = dismount2.spawned?.[0]?.where ?? "unknown";
  const scout2Hash = dismount2.dismounted?.[0] ?? scoutHashes[1];
  log(`  Scout 2 spawned at: ${scout2Position}`);

  // ── STAGE 3: Move transporter to B9, deploy Scout 3 (SW cluster main) ────
  log("\n📍 Stage 3: Deploy scout for SW cluster main (B10, A10, A11, B11)");
  const move3 = await api({ action: "move", object: transporterHash, where: "B9" });
  log(`  Transporter → B9: path_steps=${move3.path_steps}, AP left=${move3.action_points_left}`);

  const dismount3 = await api({ action: "dismount", object: transporterHash, passengers: 1 });
  const scout3Position = dismount3.spawned?.[0]?.where ?? "unknown";
  const scout3Hash = dismount3.dismounted?.[0] ?? scoutHashes[2];
  log(`  Scout 3 spawned at: ${scout3Position}`);

  // ── STAGE 4: Move transporter to H9, deploy Scout 4 (SE cluster) ─────────
  log("\n📍 Stage 4: Deploy scout for SE cluster (H10, I10, H11, I11)");
  const move4 = await api({ action: "move", object: transporterHash, where: "H9" });
  log(`  Transporter → H9: path_steps=${move4.path_steps}, AP left=${move4.action_points_left}`);

  const dismount4 = await api({ action: "dismount", object: transporterHash, passengers: 1 });
  const scout4Position = dismount4.spawned?.[0]?.where ?? "unknown";
  const scout4Hash = dismount4.dismounted?.[0] ?? scoutHashes[3];
  log(`  Scout 4 spawned at: ${scout4Position}`);

  // ── INSPECTION PHASE ──────────────────────────────────────────────────────

  log("\n🔍 === INSPECTION PHASE ===");

  // Scout 1: top cluster (order: F2 first since scout starts near E1/E2)
  log("\n[Scout 1] Top cluster: F2, G2, G1, F1");
  foundAt = await inspectTiles(scout1Hash, ["F2", "G2", "G1", "F1"]);
  if (foundAt) {
    log(`\n🚁 Calling helicopter to ${foundAt}!`);
    const heli = await api({ action: "callHelicopter", destination: foundAt });
    log(`📨 Helicopter response: ${JSON.stringify(heli)}`);
    if (heli.code === 0) console.log(`✅ SUCCESS! Flag: ${heli.message}`);
    return;
  }

  // Scout 2: SW cluster part 1 (C10, C11)
  log("\n[Scout 2] SW cluster (C10, C11)");
  foundAt = await inspectTiles(scout2Hash, ["C10", "C11"]);
  if (foundAt) {
    log(`\n🚁 Calling helicopter to ${foundAt}!`);
    const heli = await api({ action: "callHelicopter", destination: foundAt });
    log(`📨 Helicopter response: ${JSON.stringify(heli)}`);
    if (heli.code === 0) console.log(`✅ SUCCESS! Flag: ${heli.message}`);
    return;
  }

  // Scout 3: SW cluster part 2 (B10, A10, A11, B11)
  log("\n[Scout 3] SW cluster (B10, A10, A11, B11)");
  foundAt = await inspectTiles(scout3Hash, ["B10", "A10", "A11", "B11"]);
  if (foundAt) {
    log(`\n🚁 Calling helicopter to ${foundAt}!`);
    const heli = await api({ action: "callHelicopter", destination: foundAt });
    log(`📨 Helicopter response: ${JSON.stringify(heli)}`);
    if (heli.code === 0) console.log(`✅ SUCCESS! Flag: ${heli.message}`);
    return;
  }

  // Scout 4: SE cluster (H10, H11, I11, I10)
  log("\n[Scout 4] SE cluster (H10, H11, I11, I10)");
  foundAt = await inspectTiles(scout4Hash, ["H10", "H11", "I11", "I10"]);
  if (foundAt) {
    log(`\n🚁 Calling helicopter to ${foundAt}!`);
    const heli = await api({ action: "callHelicopter", destination: foundAt });
    log(`📨 Helicopter response: ${JSON.stringify(heli)}`);
    if (heli.code === 0) console.log(`✅ SUCCESS! Flag: ${heli.message}`);
    return;
  }

  // Final expenses check
  const expenses = await api({ action: "expenses" });
  const spent = (expenses as ApiResponse & { action_points_used?: number }).action_points_used;
  log(`\n⚠️ Survivor not found! Checked all 14 block3 tiles. AP used: ${spent}/300`);
  log("Full board state:");
  const finalObj = await api({ action: "getObjects" });
  log(JSON.stringify(finalObj, null, 2));
  const finalLogs = await api({ action: "getLogs" });
  log("All logs: " + JSON.stringify(finalLogs.logs, null, 2));
}

run().catch(console.error);
