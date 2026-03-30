/**
 * S03E04 — Negotiations
 *
 * Wystawiamy publiczne narzędzie HTTP (1 endpoint), które pozwala agentowi
 * szukać przedmiotów potrzebnych do turbiny wiatrowej i sprawdzać,
 * które miasta je oferują.
 *
 * Wejście:  POST /search  { "params": "naturalne zapytanie" }
 * Wyjście:                { "output": "..." }  (≤500 bajtów)
 *
 * Uruchomienie: najpierw odpal ngrok w osobnym terminalu:
 *   ngrok http 3000
 * a potem:
 *   PUBLIC_URL=https://xxx.ngrok-free.app npm run s03e04
 */

import "dotenv/config";
import http from "http";
import { readFileSync } from "fs";
import path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3333);
const PUBLIC_URL = process.env.PUBLIC_URL; // np. https://xxx.ngrok-free.app
const TASK = "negotiations";
const HUB_URL = `${process.env.HUB_BASE_URL}/verify`;
if (!process.env.HUB_BASE_URL) throw new Error("Missing HUB_BASE_URL in .env");

const apiKey = process.env.AG3NTS_API_KEY;
if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

// ─── Load + index data ───────────────────────────────────────────────────────

const DATA_DIR = path.resolve("data", "s03e04");

function parseCsv(filePath: string): Record<string, string>[] {
  const content = readFileSync(filePath, "utf-8").trim();
  const lines = content.split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h.trim(), (values[i] ?? "").trim()]));
  });
}

const cities = parseCsv(path.join(DATA_DIR, "cities.csv"));
const items = parseCsv(path.join(DATA_DIR, "items.csv"));
const connections = parseCsv(path.join(DATA_DIR, "connections.csv"));

// Maps for fast lookup
const cityByCode = new Map<string, string>(cities.map((c) => [c.code, c.name]));
const itemByCode = new Map<string, string>(items.map((i) => [i.code, i.name]));

// itemCode → Set<cityName>
const itemCities = new Map<string, Set<string>>();
for (const conn of connections) {
  const { itemCode, cityCode } = conn;
  const cityName = cityByCode.get(cityCode);
  if (!cityName) continue;
  if (!itemCities.has(itemCode)) itemCities.set(itemCode, new Set());
  itemCities.get(itemCode)!.add(cityName);
}

console.log(`📋 Loaded: ${cities.length} cities, ${items.length} items, ${connections.length} connections`);

// ─── Search logic ─────────────────────────────────────────────────────────────

/** Normalize Polish text to ASCII tokens */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e")
    .replace(/ł/g, "l").replace(/ń/g, "n").replace(/ó/g, "o")
    .replace(/ś/g, "s").replace(/ź/g, "z").replace(/ż/g, "z")
    .replace(/[^a-z0-9/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove common short stopwords from token list */
const STOPWORDS = new Set(["the", "dla", "lub", "jak", "czy", "nie", "do", "ze", "na"]);

function tokenize(str: string): string[] {
  return normalize(str)
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Score how well an item matches the query tokens */
function scoreItem(itemName: string, queryTokens: string[]): number {
  const normName = normalize(itemName);
  let score = 0;
  for (const token of queryTokens) {
    if (normName.includes(token)) {
      // Longer matches score higher; numeric tokens (e.g. "48v") get 3× weight
      const weight = /\d/.test(token) ? 3 : 1;
      score += token.length * weight;
    }
  }
  return score;
}

interface SearchResult {
  itemCode: string;
  itemName: string;
  score: number;
  cities: string[];
}

function search(query: string): SearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Has numeric tokens? → require at least one to match (prevents mixing voltages)
  const numericTokens = queryTokens.filter((t) => /\d/.test(t));

  const scored: SearchResult[] = [];
  for (const item of items) {
    const sc = scoreItem(item.name, queryTokens);
    if (sc === 0) continue;

    // If query has numeric tokens, item must contain at least one of them
    if (numericTokens.length > 0) {
      const normName = normalize(item.name);
      const hasNumMatch = numericTokens.some((nt) => normName.includes(nt));
      if (!hasNumMatch) continue;
    }

    const citiesSet = itemCities.get(item.code) ?? new Set();
    scored.push({
      itemCode: item.code,
      itemName: item.name,
      score: sc,
      cities: [...citiesSet].sort(),
    });
  }

  if (scored.length === 0) return [];

  // Keep items within 85% of best score
  const bestScore = Math.max(...scored.map((s) => s.score));
  return scored
    .filter((s) => s.score >= bestScore * 0.85)
    .sort((a, b) => b.score - a.score);
}

// ─── Format response (≤500 bytes) ────────────────────────────────────────────

function formatResponse(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `Brak wynikow dla: "${query}". Sprobuj np: turbina wiatrowa, inwerter, akumulator`;
  }

  // Group by unique item name (collapse duplicates)
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of results) {
    if (seen.has(r.itemName)) continue;
    seen.add(r.itemName);
    lines.push(`${r.itemName}: ${r.cities.join(", ")}`);
  }

  let output = lines.join("\n");

  // Truncate if too long (hard limit 490 bytes to be safe)
  while (Buffer.byteLength(output, "utf-8") > 490) {
    // Remove last line and add ellipsis
    const lastNl = output.lastIndexOf("\n");
    if (lastNl === -1) {
      output = output.slice(0, 480) + "...";
      break;
    }
    output = output.slice(0, lastNl) + "\n...";
    if (Buffer.byteLength(output, "utf-8") <= 490) break;
    output = output.slice(0, lastNl);
  }

  return output;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  res.setHeader("Content-Type", "application/json");

  if (method === "POST" && url === "/search") {
    const body = await readBody(req);
    let params = "";
    try {
      const parsed = JSON.parse(body) as { params?: unknown };
      params = String(parsed.params ?? "");
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ output: "Invalid JSON body" }));
      return;
    }

    console.log(`🔧 Search request: "${params}"`);
    const results = search(params);
    const output = formatResponse(results, params);
    console.log(`↩  Response (${Buffer.byteLength(output, "utf-8")}B): ${output.slice(0, 120)}`);

    res.writeHead(200);
    res.end(JSON.stringify({ output }));
    return;
  }

  // Health check
  if (method === "GET" && url === "/") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", task: "negotiations" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ output: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

// ─── Hub interaction ──────────────────────────────────────────────────────────

async function hubPost(body: unknown): Promise<unknown> {
  const res = await fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function submitTools(publicUrl: string): Promise<void> {
  // Strip trailing slash, then append path
  const base = publicUrl.replace(/\/+$/, "");
  const searchUrl = `${base}/search`;
  const payload = {
    apikey: apiKey,
    task: TASK,
    answer: {
      tools: [
        {
          URL: searchUrl,
          description:
            "Szukaj czesci turbiny wiatrowej i miast ktore je sprzedaja. " +
            "Pole params: naturalne pytanie o przedmiot (np. 'turbina wiatrowa 48V', 'inwerter DC/AC 48V', 'akumulator AGM 48V'). " +
            "Zwraca nazwe przedmiotu i liste miast. " +
            "Wywolaj dla kazdej czesci osobno, potem znajdz czesc wspolna miast.",
        },
      ],
    },
  };

  console.log(`\n📤 Submitting tools to hub...`);
  console.log(`   → search URL: ${searchUrl}`);
  const result = await hubPost(payload);
  console.log(`📨 Submit response:`, JSON.stringify(result, null, 2));
}

async function checkResult(): Promise<void> {
  const payload = {
    apikey: apiKey,
    task: TASK,
    answer: { action: "check" },
  };
  console.log(`\n📤 Checking result...`);
  const result = await hubPost(payload);
  console.log(`📨 Check response:`, JSON.stringify(result, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const mode = process.argv[2] ?? "";

  if (mode === "check") {
    // Just check result (server may or may not be running)
    await checkResult();
    process.exit(0);
  }

  if (!PUBLIC_URL) {
    console.log("\n⚠️  No PUBLIC_URL set. Server started for local testing only.");
    console.log("   To submit, run ngrok then: PUBLIC_URL=https://xxx.ngrok-free.app npm run s03e04");
    console.log('   To check result: npm run s03e04 -- check\n');
    return;
  }

  // Wait a moment for the server to be ready, then submit
  await new Promise((r) => setTimeout(r, 500));
  await submitTools(PUBLIC_URL);

  console.log("\n⏳ Waiting for agent to run (60s)...");
  await new Promise((r) => setTimeout(r, 60_000));

  await checkResult();
  console.log("\n🏁 Done. Server still running — press Ctrl+C to stop.");
}

run().catch(console.error);
