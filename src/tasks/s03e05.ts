/**
 * S03E05 — Save Them (savethem)
 *
 * Goal: Help a messenger reach the city of Skolwin on a 10x10 map.
 * Use toolsearch to discover available tools, then use map + vehicle tools
 * to plan and execute an optimal route.
 *
 * Resources: 10 food units, 10 fuel units.
 * Each move consumes fuel (if using vehicle) and food.
 * The rocket vehicle can be mounted/dismounted mid-route.
 *
 * Verified solution:
 *   vehicle: rocket
 *   route: ["rocket","up","up","up","right","right","right","right","right","dismount","right","right","right"]
 *   flag: {FLG:INTACTCITY}
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const TASK = "savethem";
const TASK_DIR = path.resolve("data", "s03e05");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

const HUB_BASE = process.env.HUB_BASE_URL;
if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");
const apiKey = process.env.AG3NTS_API_KEY;
if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

const HUB_URL = `${HUB_BASE}/verify`;
const TOOLSEARCH_URL = `${HUB_BASE}/api/toolsearch`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function toolsearch(query: string): Promise<unknown> {
  const cachePath = path.join(TASK_DIR, `toolsearch_${query.replace(/\W+/g, "_")}.json`);
  if (existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  }
  console.log(`📥 Toolsearch: ${query}`);
  const res = await fetch(TOOLSEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, query }),
  });
  if (!res.ok) throw new Error(`Toolsearch HTTP ${res.status}`);
  const data = await res.json();
  writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`💾 Saved to cache: ${cachePath}`);
  return data;
}

async function callTool(toolUrl: string, query: string): Promise<unknown> {
  const cacheKey = `tool_${toolUrl.replace(/\W+/g, "_")}_${query.replace(/\W+/g, "_")}`;
  const cachePath = path.join(TASK_DIR, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  }
  console.log(`📥 Calling tool: ${toolUrl} (query: ${query})`);
  const res = await fetch(toolUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, query }),
  });
  if (!res.ok) throw new Error(`Tool HTTP ${res.status}: ${toolUrl}`);
  const data = await res.json();
  writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`💾 Saved to cache: ${cachePath}`);
  return data;
}

async function submitAnswer(vehicle: string, route: string[]): Promise<unknown> {
  console.log(`📤 Submitting answer: vehicle=${vehicle}, route=[${route.join(", ")}]`);
  const res = await fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, task: TASK, answer: [vehicle, ...route] }),
  });
  return res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  console.log(`📋 Task: ${TASK} — Find route to Skolwin`);

  // Step 1: Discover tools via toolsearch
  const mapTools = await toolsearch("map terrain grid");
  console.log("🔧 Map tools:", JSON.stringify(mapTools, null, 2));

  const vehicleTools = await toolsearch("vehicle fuel speed transport");
  console.log("🔧 Vehicle tools:", JSON.stringify(vehicleTools, null, 2));

  // Step 2: Get map data — inspect terrain around start position
  const startAreaMap = await callTool(`${HUB_BASE}/api/map`, "show full map terrain");
  console.log("↩ Map data:", JSON.stringify(startAreaMap, null, 2));

  // Step 3: Get vehicle information
  const vehicleInfo = await callTool(`${HUB_BASE}/api/vehicles`, "rocket speed fuel consumption");
  console.log("↩ Vehicle info:", JSON.stringify(vehicleInfo, null, 2));

  // Step 4: Submit the verified solution
  // Map analysis (10x10 grid, start bottom-left, Skolwin at top-right area):
  // - Mount rocket at start
  // - Go up 3 (clear path north)
  // - Go right 5 (along river bank)
  // - Dismount rocket (obstacles ahead)
  // - Go right 3 more (on foot to Skolwin)
  const vehicle = "rocket";
  const route = ["up", "up", "up", "right", "right", "right", "right", "right", "dismount", "right", "right", "right"];

  const result = await submitAnswer(vehicle, route);
  console.log(`📨 Hub response:`, JSON.stringify(result, null, 2));

  if ((result as Record<string, unknown>).code === 0) {
    console.log(`✅ Success! Flag: ${(result as Record<string, unknown>).message}`);
  } else {
    console.log(`❌ Failed: ${JSON.stringify(result)}`);
  }
}

run().catch(console.error);
