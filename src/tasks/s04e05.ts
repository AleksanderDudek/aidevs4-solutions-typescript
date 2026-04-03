/**
 * S04E05 — foodwarehouse
 *
 * Strategy:
 *  1. Fetch food4cities.json (cache it) – city requirements
 *  2. Query SQLite: destinations table → city name → numeric destination code
 *  3. Query SQLite: users table → pick first active user for creatorID/login/birthday
 *  4. Reset orders state
 *  5. For each city: generate SHA1 signature → create order → append items (batch)
 *  6. Call `done` for final verification + flag
 *
 * DB tables: destinations, roles, users
 * signatureGenerator requires: action:"generate", login, birthday (YYYY-MM-DD), destination (numeric)
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const TASK = "foodwarehouse";
const TASK_DIR = path.resolve("data", "s04e05");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

const HUB_BASE = process.env.HUB_BASE_URL;
if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");
const apiKey = process.env.AG3NTS_API_KEY;
if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

const FOOD4CITIES_URL = "https://hub.ag3nts.org/dane/food4cities.json";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CityRequirements {
  [cityName: string]: Record<string, number>;
}

interface ApiResponse {
  code?: number;
  message?: string;
  flag?: string;
  rows?: unknown[];
  [key: string]: unknown;
}

interface DbUser {
  user_id: number;
  login: string;
  name_surname: string;
  birthday: string;
  role: number;
  is_active: number;
}

interface DbDestination {
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchCached(url: string, cachePath: string): Promise<string> {
  if (existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return readFileSync(cachePath, "utf-8");
  }
  console.log(`📥 Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const text = await res.text();
  writeFileSync(cachePath, text, "utf-8");
  console.log(`💾 Saved to cache: ${cachePath}`);
  return text;
}

async function dbQueryCached(query: string, cachePath: string): Promise<ApiResponse> {
  if (existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return JSON.parse(readFileSync(cachePath, "utf-8")) as ApiResponse;
  }
  const result = await callWarehouse({ tool: "database", query });
  writeFileSync(cachePath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`💾 Saved to cache: ${cachePath}`);
  return result;
}

async function callWarehouse(answer: Record<string, unknown>): Promise<ApiResponse> {
  const body = { apikey: apiKey, task: TASK, answer };
  console.log(`\n📤 Warehouse call: tool=${String(answer.tool)}${answer.action ? ` action=${String(answer.action)}` : ""}`);

  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ApiResponse;
  console.log(`📨 Response (code=${data.code}): ${JSON.stringify(data).substring(0, 200)}`);
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  // ── Step 1: Fetch city requirements ─────────────────────────────────────────
  console.log("\n📋 Step 1: Fetching food4cities.json");
  const citiesRaw = await fetchCached(
    FOOD4CITIES_URL,
    path.join(TASK_DIR, "food4cities.json")
  );
  const cityRequirements = JSON.parse(citiesRaw) as CityRequirements;
  const cityNames = Object.keys(cityRequirements);
  console.log(`📋 Cities: ${cityNames.join(", ")}`);

  // ── Step 2: Query destinations table (paginated, API limit=30 rows) ──────────
  console.log("\n📋 Step 2: Reading destinations table");
  const destResult = await dbQueryCached(
    "select * from destinations limit 100",
    path.join(TASK_DIR, "table_destinations.json")
  );
  let destRows = (destResult.rows ?? []) as DbDestination[];

  // If we hit the 30-row server limit, fetch remaining rows with OFFSET
  if (destRows.length === 30) {
    const destResult2 = await dbQueryCached(
      "select * from destinations limit 100 offset 30",
      path.join(TASK_DIR, "table_destinations_p2.json")
    );
    destRows = [...destRows, ...((destResult2.rows ?? []) as DbDestination[])];
  }
  console.log(`🗄️  Destinations total: ${destRows.length} rows`);

  // ── Step 2b: Get destinations schema to understand columns ──────────────────
  const destSchemaResult = await dbQueryCached(
    "SHOW CREATE TABLE destinations",
    path.join(TASK_DIR, "schema_destinations.json")
  );
  console.log("🗄️  Destinations schema:", JSON.stringify(destSchemaResult, null, 2));

  // ── Step 3: Find transport role and query matching users ──────────────────────
  console.log("\n📋 Step 3: Finding transport role and eligible users");
  const rolesResult = await dbQueryCached(
    "select * from roles",
    path.join(TASK_DIR, "table_roles.json")
  );
  const rolesRows = (rolesResult.rows ?? []) as { role_id: number; name: string }[];
  const transportRole = rolesRows.find(r => r.name.toLowerCase().includes("transport"));
  if (!transportRole) throw new Error("No transport role found in roles table");
  console.log(`👤 Transport role: id=${transportRole.role_id}, name=${transportRole.name}`);

  const usersResult = await dbQueryCached(
    `select * from users where role=${transportRole.role_id} and is_active=1 limit 5`,
    path.join(TASK_DIR, "table_users_transport.json")
  );
  const usersRows = (usersResult.rows ?? []) as DbUser[];
  console.log("🗄️  Transport users:", JSON.stringify(usersRows, null, 2));

  // Pick first active transport user as creator
  const creator = usersRows[0];
  if (!creator) throw new Error("No transport users found in database");
  console.log(`👤 Creator: id=${creator.user_id}, login=${creator.login}, birthday=${creator.birthday}`);

  // ── Step 4: Build destination map: city name → numeric code ─────────────────
  console.log("\n📋 Step 4: Building destination map");
  const destinationMap: Record<string, number> = {};

  if (destRows.length > 0) {
    const cols = Object.keys(destRows[0]);
    console.log("🗄️  Destination row keys:", cols);
    // Try to identify city name col and code col
    const nameCol = cols.find(c =>
      c.toLowerCase().includes("city") || c.toLowerCase().includes("name") || c.toLowerCase().includes("miasto")
    );
    const codeCol = cols.find(c =>
      c.toLowerCase().includes("code") || c.toLowerCase().includes("id") || c.toLowerCase().includes("destination")
    );
    console.log(`🗺️  Name col: ${nameCol}, Code col: ${codeCol}`);
    if (nameCol && codeCol) {
      for (const row of destRows) {
        const name = String(row[nameCol]).toLowerCase().trim();
        const code = Number(row[codeCol]);
        destinationMap[name] = code;
      }
    }
  }
  console.log("🗺️  Destination map:", destinationMap);

  // Verify all cities have destinations
  const missingCities = cityNames.filter(c => !(c.toLowerCase() in destinationMap));
  if (missingCities.length > 0) {
    console.log(`⚠️  Cities missing destination codes: ${missingCities.join(", ")}`);
    console.log("📋 All destination city names:", Object.keys(destinationMap));
    throw new Error(`Cannot proceed: missing destination codes for: ${missingCities.join(", ")}`);
  }

  // ── Step 5: Reset orders state ───────────────────────────────────────────────
  console.log("\n📋 Step 5: Resetting order state");
  await callWarehouse({ tool: "reset" });

  // ── Step 6: Create orders for each city ─────────────────────────────────────
  console.log("\n📋 Step 6: Creating orders for each city");

  for (const city of cityNames) {
    const items = cityRequirements[city];
    const destination = destinationMap[city.toLowerCase()];

    // Generate signature
    console.log(`\n🔧 Generating signature: city=${city}, dest=${destination}, login=${creator.login}`);
    const sigResponse = await callWarehouse({
      tool: "signatureGenerator",
      action: "generate",
      login: creator.login,
      birthday: creator.birthday,
      destination,
    });
    const signature = (sigResponse.hash ?? sigResponse.signature) as string | undefined;
    if (!signature || typeof signature !== "string") {
      throw new Error(`No signature returned for ${city}: ${JSON.stringify(sigResponse)}`);
    }
    console.log(`↩  Signature: ${signature}`);

    // Create order
    console.log(`\n🔧 Creating order for city: ${city}`);
    const orderResponse = await callWarehouse({
      tool: "orders",
      action: "create",
      title: `Dostawa dla ${city[0].toUpperCase()}${city.slice(1)}`,
      creatorID: creator.user_id,
      destination,
      signature,
    });

    const orderData = orderResponse.order as { id?: string } | undefined;
    const orderId = orderData?.id ?? orderResponse.id ?? orderResponse.reply;
    if (!orderId) {
      throw new Error(`No order ID returned for ${city}: ${JSON.stringify(orderResponse)}`);
    }
    console.log(`↩  Order ID: ${String(orderId)}`);

    // Append items (batch mode)
    console.log(`\n🔧 Appending items to order ${String(orderId)}:`, items);
    const appendResponse = await callWarehouse({
      tool: "orders",
      action: "append",
      id: orderId,
      items,
    });
    console.log(`↩  Append: code=${appendResponse.code}`);
  }

  // ── Step 7: Final verification ───────────────────────────────────────────────
  console.log("\n📋 Step 7: Calling done");
  const doneResponse = await callWarehouse({ tool: "done" });

  if (doneResponse.flag) {
    console.log(`\n✅ FLAG: ${doneResponse.flag}`);
  } else {
    console.log(`\n📨 Done response: ${JSON.stringify(doneResponse)}`);
  }
}

run().catch(console.error);
