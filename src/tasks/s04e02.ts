/**
 * S04E02 — Windpower (windpower)
 *
 * Program the wind turbine schedule to generate power needed to start the
 * plant's management systems. Must complete within 40 seconds.
 *
 * Strategy (parallel execution to beat 40s limit):
 *  1. Call start → opens 40-second service window
 *  2. Immediately queue weather + powerplantcheck in parallel
 *  3. Fast-poll getResult for both (powerplantcheck ~10s, weather ~24s)
 *  4. Analyse forecast: find storms (wind > 14 m/s) and first production window
 *  5. Queue all unlockCodeGenerator calls in parallel
 *  6. Fast-poll for all unlock codes
 *  7. Submit batch config
 *  8. Queue turbinecheck → fast-poll → done
 *
 * Turbine specs (from documentation):
 *  - Rated power: 14 kW
 *  - Cutoff (storm): > 14 m/s → pitch=90, mode=idle
 *  - Min operational: 4 m/s
 *  - Allowed pitch: 0 (100%), 45 (65%), 90 (0%)
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const TASK = "windpower";
const TASK_DIR = path.resolve("data", "s04e02");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

const HUB_BASE = process.env.HUB_BASE_URL;
if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");
const apiKey = process.env.AG3NTS_API_KEY;
if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

const CUTOFF_WIND_MS = 14; // storm threshold
const MIN_OPERATIONAL_WIND_MS = 4; // minimum for electricity generation

// ─── Types ────────────────────────────────────────────────────────────────────

interface ForecastPoint {
  timestamp: string;
  windMs: number;
  precipitationMm: number;
  temperatureC: number;
}

interface ConfigPoint {
  startDate: string;
  startHour: string;
  windMs: number;
  pitchAngle: 0 | 45 | 90;
  turbineMode: "idle" | "production";
}

interface ApiResponse {
  code?: number;
  message?: string;
  sourceFunction?: string;
  [key: string]: unknown;
}

// ─── API helper ───────────────────────────────────────────────────────────────

const t0 = Date.now();

function log(msg: string): void {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${elapsed}s] ${msg}`);
}

async function api(answer: Record<string, unknown>): Promise<ApiResponse> {
  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, task: TASK, answer }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<ApiResponse>;
}

/**
 * Poll getResult rapidly until all named functions have responded.
 * Each name in expectedFunctions must be unique — use collectN for repeating sources.
 */
async function collectByName(
  expectedFunctions: string[],
  timeoutMs = 38000
): Promise<Record<string, ApiResponse>> {
  const results: Record<string, ApiResponse> = {};
  const deadline = Date.now() + timeoutMs;

  while (
    Object.keys(results).length < expectedFunctions.length &&
    Date.now() < deadline
  ) {
    const r = await api({ action: "getResult" });
    if (r.sourceFunction && expectedFunctions.includes(r.sourceFunction as string)) {
      results[r.sourceFunction as string] = r;
      log(`  ↩ Received: ${r.sourceFunction}`);
    } else if (r.sourceFunction) {
      log(`  ⚠️ Unexpected sourceFunction: ${r.sourceFunction} — ignoring`);
    } else {
      // Queue not ready yet — short back-off
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const missing = expectedFunctions.filter((f) => !results[f]);
  if (missing.length > 0) {
    throw new Error(`Timed out waiting for: ${missing.join(", ")}`);
  }
  return results;
}

/** Poll getResult until exactly `count` results with given sourceFunction are collected. */
async function collectN(
  sourceFunction: string,
  count: number,
  timeoutMs = 38000
): Promise<ApiResponse[]> {
  const results: ApiResponse[] = [];
  const deadline = Date.now() + timeoutMs;

  while (results.length < count && Date.now() < deadline) {
    const r = await api({ action: "getResult" });
    if (r.sourceFunction === sourceFunction) {
      results.push(r);
      log(`  ↩ Received: ${r.sourceFunction} [${results.length}/${count}]`);
    } else if (r.sourceFunction) {
      log(`  ⚠️ Unexpected sourceFunction: ${r.sourceFunction}`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  if (results.length < count) {
    throw new Error(`Timed out: got ${results.length}/${count} ${sourceFunction} results`);
  }
  return results;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

function analyseForecast(forecast: ForecastPoint[]): ConfigPoint[] {
  const configs: ConfigPoint[] = [];
  let productionConfigAdded = false;

  for (const point of forecast) {
    const [datePart, timePart] = point.timestamp.split(" ");
    const { windMs } = point;

    if (windMs > CUTOFF_WIND_MS) {
      // Storm — protect turbine: blades perpendicular to wind, generation disabled
      configs.push({
        startDate: datePart,
        startHour: timePart,
        windMs,
        pitchAngle: 90,
        turbineMode: "idle",
      });
      log(
        `  ⚠️  Storm detected: ${point.timestamp} windMs=${windMs} → protect (pitch=90, idle)`
      );
    } else if (!productionConfigAdded && windMs >= MIN_OPERATIONAL_WIND_MS) {
      // First viable production window
      configs.push({
        startDate: datePart,
        startHour: timePart,
        windMs,
        pitchAngle: 0,
        turbineMode: "production",
      });
      productionConfigAdded = true;
      log(
        `  ✅ First production window: ${point.timestamp} windMs=${windMs} → produce (pitch=0)`
      );
    }
  }

  if (!productionConfigAdded) {
    throw new Error("No suitable production window found in forecast!");
  }
  return configs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  log(`📋 Task: ${TASK} — 40-second window, parallel execution required`);

  // ── Step 1: Start service window ──────────────────────────────────────────
  const startResp = await api({ action: "start" });
  log(`🔧 Session started: ${JSON.stringify(startResp)}`);
  if (startResp.code !== 60) {
    throw new Error(`Unexpected start response: ${JSON.stringify(startResp)}`);
  }

  // ── Step 2: Queue weather + powerplantcheck + turbinecheck simultaneously ──
  // turbinecheck consistently takes ~12s — queue it NOW so it overlaps with data collection
  log("📥 Queueing weather + powerplantcheck + turbinecheck in parallel...");
  await Promise.all([
    api({ action: "get", param: "weather" }),
    api({ action: "get", param: "powerplantcheck" }),
    api({ action: "get", param: "turbinecheck" }),
  ]);
  log("  Queued all three.");

  // ── Step 3: Collect all three results ────────────────────────────────────
  log("⏳ Waiting for data + turbinecheck results...");
  const dataResults = await collectByName(["weather", "powerplantcheck", "turbinecheck"]);
  log(`All data received at ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const weatherResp = dataResults["weather"] as ApiResponse & {
    forecast: ForecastPoint[];
    intervalHours: number;
  };
  const powerResp = dataResults["powerplantcheck"];
  const turbineCheck = dataResults["turbinecheck"];

  log(`📊 Power deficit: ${powerResp.powerDeficitKw} kW`);
  log(`📊 Turbine check: ${JSON.stringify(turbineCheck)}`);
  log(`📊 Forecast points: ${weatherResp.forecast?.length}`);

  // ── Step 4: Analyse forecast → determine config points ────────────────────
  log("🧠 Analysing forecast...");
  const configPoints = analyseForecast(weatherResp.forecast);
  log(`📋 Config points identified: ${configPoints.length}`);

  // ── Step 5: Generate unlock codes SEQUENTIALLY for guaranteed matching ────
  // Responses come in random order, so we queue one at a time and collect it
  // before queuing the next — this ensures correct (params → code) mapping.
  log("🔐 Generating unlock codes sequentially...");
  const configs: Record<
    string,
    { pitchAngle: number; turbineMode: string; unlockCode: string }
  > = {};

  for (const cp of configPoints) {
    const dateTimeKey = `${cp.startDate} ${cp.startHour}`;
    await api({
      action: "unlockCodeGenerator",
      startDate: cp.startDate,
      startHour: cp.startHour,
      windMs: cp.windMs,
      pitchAngle: cp.pitchAngle,
    });
    const [codeResp] = await collectN("unlockCodeGenerator", 1);
    const unlockCode = (codeResp as ApiResponse & { unlockCode?: string }).unlockCode;
    if (!unlockCode) throw new Error(`No unlockCode in response: ${JSON.stringify(codeResp)}`);
    configs[dateTimeKey] = { pitchAngle: cp.pitchAngle, turbineMode: cp.turbineMode, unlockCode };
    log(`  🔑 ${dateTimeKey}: pitch=${cp.pitchAngle}, mode=${cp.turbineMode}, code=${unlockCode.slice(0, 8)}...`);
  }
  log(`Unlock codes ready at ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── Step 6: Submit batch config ───────────────────────────────────────────
  log("📤 Submitting batch config...");
  const configResp = await api({ action: "config", configs });
  log(`  Config response: ${JSON.stringify(configResp)}`);

  // ── Step 7: Submit done ───────────────────────────────────────────────────
  // turbinecheck was already collected in step 3 (queued early for parallelism)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`📤 Submitting done at ${elapsed}s...`);
  const doneResp = await api({ action: "done" });
  log(`📨 Done response: ${JSON.stringify(doneResp)}`);

  if (doneResp.code === 0) {
    console.log(`✅ SUCCESS! Flag: ${doneResp.message}`);
  } else {
    console.log(`❌ Failed: ${JSON.stringify(doneResp)}`);
  }
}

run().catch(console.error);
