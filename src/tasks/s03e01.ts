import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { submitAnswer } from "../lib/hub.js";

const TASK = "evaluation";
const TASK_DIR = path.resolve("data", "s03e01");
const SENSORS_DIR = path.join(TASK_DIR, "sensors");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Sensor config ────────────────────────────────────────────────────────────

const TYPE_TO_FIELD: Record<string, string> = {
  temperature: "temperature_K",
  pressure: "pressure_bar",
  water: "water_level_meters",
  voltage: "voltage_supply_v",
  humidity: "humidity_percent",
};

const ALL_FIELDS = new Set(Object.values(TYPE_TO_FIELD));

const RANGES: Record<string, [number, number]> = {
  temperature_K: [553, 873],
  pressure_bar: [60, 160],
  water_level_meters: [5.0, 15.0],
  voltage_supply_v: [229.0, 231.0],
  humidity_percent: [40.0, 80.0],
};

// Operator notes opening phrases that indicate a problem report
const NEGATIVE_STARTS = [
  "The numbers feel inconsistent",
  "This state looks unstable",
  "These readings look suspicious",
  "The latest behavior is concerning",
  "This check did not look right",
  "The signal profile looks unusual",
  "This is not the pattern I expected",
  "This report raises serious doubts",
  "I am seeing an unexpected pattern",
  "I can see a clear irregularity",
  "The current result seems unreliable",
  "There is a visible anomaly here",
  "The report does not look healthy",
  "The situation requires attention",
  "I am not comfortable with this result",
  "Something is clearly off",
  "This run shows questionable behavior",
  "The output quality is doubtful",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface SensorReading {
  sensor_type: string;
  timestamp: number;
  temperature_K: number;
  pressure_bar: number;
  water_level_meters: number;
  voltage_supply_v: number;
  humidity_percent: number;
  operator_notes: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkData(rec: SensorReading): string[] {
  const issues: string[] = [];
  const activeTypes = rec.sensor_type.split("/").map((t) => t.trim());
  const activeFields = new Set<string>();

  for (const at of activeTypes) {
    const field = TYPE_TO_FIELD[at];
    if (field) activeFields.add(field);
    else issues.push(`Unknown sensor type: ${at}`);
  }

  const inactiveFields = new Set([...ALL_FIELDS].filter((f) => !activeFields.has(f)));

  for (const field of activeFields) {
    const val = (rec as unknown as Record<string, number>)[field] ?? 0;
    const [lo, hi] = RANGES[field];
    if (val < lo || val > hi) {
      issues.push(`${field}=${val} out of range [${lo},${hi}]`);
    }
  }

  for (const field of inactiveFields) {
    const val = (rec as unknown as Record<string, number>)[field] ?? 0;
    if (val !== 0) {
      issues.push(`${field}=${val} should be 0 (inactive)`);
    }
  }

  return issues;
}

function noteSaysProblem(note: string): boolean {
  const firstClause = note.split(",")[0].trim();
  return NEGATIVE_STARTS.some((neg) => firstClause.startsWith(neg));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  const HUB_BASE = process.env.HUB_BASE_URL;
  if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");

  // 1. Download and extract if needed
  const zipPath = path.join(TASK_DIR, "sensors.zip");
  if (!existsSync(SENSORS_DIR)) {
    if (!existsSync(zipPath)) {
      console.log("📥 Downloading sensors.zip...");
      const res = await fetch(`${HUB_BASE}/dane/sensors.zip`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import("fs");
      writeFileSync(zipPath, buf);
    }
    console.log("📦 Extracting sensors.zip...");
    mkdirSync(SENSORS_DIR, { recursive: true });
    execSync(`unzip -q "${zipPath}" -d "${SENSORS_DIR}"`);
  }

  // 2. Read all sensor files
  const files = readdirSync(SENSORS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  console.log(`📋 Loaded ${files.length} sensor files`);

  // 3. Detect anomalies
  const anomalyIds: string[] = [];

  for (const fname of files) {
    const fid = fname.replace(".json", "");
    const raw = readFileSync(path.join(SENSORS_DIR, fname), "utf-8");
    const rec = JSON.parse(raw) as SensorReading;

    const dataIssues = checkData(rec);
    const opProblem = noteSaysProblem(rec.operator_notes);

    let isAnomaly = false;

    // Data anomaly (range violation or unexpected data)
    if (dataIssues.length > 0) isAnomaly = true;

    // Operator false alarm (says problem but data is OK)
    if (dataIssues.length === 0 && opProblem) isAnomaly = true;

    if (isAnomaly) anomalyIds.push(fid);
  }

  console.log(`🔍 Found ${anomalyIds.length} anomalies`);

  // 4. Submit
  const result = await submitAnswer(TASK, { recheck: anomalyIds }, apiKey);
  console.log("📨 Result:", result);
}

run().catch(console.error);
