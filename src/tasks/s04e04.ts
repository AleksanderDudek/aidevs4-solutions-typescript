import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync } from "fs";

const TASK = "filesystem";
const TASK_DIR = path.resolve("data", "s04e04");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

const HUB_BASE = process.env.HUB_BASE_URL;

interface FsAction {
  action: string;
  path?: string;
  content?: string;
}

async function sendFsAction(
  actions: FsAction | FsAction[],
  apiKey: string
): Promise<unknown> {
  const body = {
    apikey: apiKey,
    task: TASK,
    answer: actions,
  };

  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");
  if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");

  // ── Data extracted from Natan's notes ───────────────────────────────────────

  // Cities and what they NEED (ogłoszenia.txt)
  // Keys = nominative singular, no Polish chars; values = quantity without units
  const cities: Record<string, Record<string, number>> = {
    opalino:    { chleb: 45, woda: 120, mlotek: 6 },
    domatowo:   { makaron: 60, woda: 150, lopata: 8 },
    brudzewo:   { ryz: 55, woda: 140, wiertarka: 5 },
    darzlubie:  { wolowina: 25, woda: 130, kilof: 7 },
    celbowo:    { kurczak: 40, woda: 125, mlotek: 6 },
    mechowo:    { ziemniaki: 100, kapusta: 70, marchew: 65, woda: 165, lopata: 9 },
    puck:       { chleb: 50, ryz: 45, woda: 175, wiertarka: 7 },
    karlinkowo: { makaron: 52, wolowina: 22, ziemniaki: 95, woda: 155, kilof: 6 },
  };

  // People responsible for trade → city (rozmowy.txt)
  const people: Record<string, string> = {
    natan_rams:    "domatowo",
    iga_kapecka:   "opalino",
    rafal_kisiel:  "brudzewo",
    marta_frantz:  "darzlubie",
    oskar_radtke:  "celbowo",
    eliza_redmann: "mechowo",
    damian_kroll:  "puck",
    lena_konkel:   "karlinkowo",
  };

  // Goods for SALE: good → cities that SELL it (transakcje.txt, source city = seller)
  const goods: Record<string, string[]> = {
    ryz:       ["darzlubie", "opalino", "karlinkowo"],
    marchew:   ["puck"],
    chleb:     ["domatowo", "celbowo", "brudzewo"],
    wolowina:  ["opalino"],
    kilof:     ["puck", "mechowo", "celbowo"],
    wiertarka: ["karlinkowo", "domatowo"],
    maka:      ["brudzewo", "mechowo"],
    mlotek:    ["karlinkowo", "mechowo"],
    kapusta:   ["celbowo"],
    ziemniaki: ["domatowo", "darzlubie"],
    makaron:   ["opalino"],
    kurczak:   ["darzlubie"],
    lopata:    ["brudzewo", "puck"],
  };

  // ── Build batch (sequential: reset → dirs → cities → people → goods) ───────

  const batch: FsAction[] = [];

  // 1. Reset filesystem
  batch.push({ action: "reset" });

  // 2. Create directories
  batch.push({ action: "createDirectory", path: "/miasta" });
  batch.push({ action: "createDirectory", path: "/osoby" });
  batch.push({ action: "createDirectory", path: "/towary" });

  // 3. Create city files with JSON (needs)
  for (const [city, needs] of Object.entries(cities)) {
    batch.push({
      action: "createFile",
      path: `/miasta/${city}`,
      content: JSON.stringify(needs),
    });
  }

  // 4. Create person files: name + markdown link to their city
  for (const [personFile, city] of Object.entries(people)) {
    const displayName = personFile
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
    const cityDisplay = city[0].toUpperCase() + city.slice(1);

    batch.push({
      action: "createFile",
      path: `/osoby/${personFile}`,
      content: `${displayName} [${cityDisplay}](/miasta/${city})`,
    });
  }

  // 5. Create goods files: links to all cities selling that good
  for (const [good, sellerCities] of Object.entries(goods)) {
    const links = sellerCities
      .map((c) => `[${c[0].toUpperCase() + c.slice(1)}](/miasta/${c})`)
      .join("\n");

    batch.push({
      action: "createFile",
      path: `/towary/${good}`,
      content: links,
    });
  }

  console.log(`📋 Batch has ${batch.length} operations`);

  // Send batch
  console.log("\n📤 Sending batch to create filesystem...");
  const batchResult = await sendFsAction(batch, apiKey);
  console.log("📨 Batch result:", JSON.stringify(batchResult, null, 2));

  // Validate with done (must be separate call, not in batch)
  console.log("\n📤 Calling done to validate...");
  const doneResult = await sendFsAction({ action: "done" }, apiKey);
  console.log("📨 Done result:", JSON.stringify(doneResult, null, 2));
}

run().catch(console.error);
