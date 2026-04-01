/**
 * S04E01 — OKO Editor (okoeditor)
 *
 * Goal: Update the OKO web panel to reflect what actually happened in Skolwin
 * (beavers blocking the road, not thieves) and add a new Komarowo incident.
 *
 * Flow:
 *  1. Login to OKO web panel as Zofia
 *  2. Browse /incydenty to identify Skolwin record ID
 *  3. Browse /zadania to identify Skolwin task ID
 *  4. Find a "spare" incident record to repurpose for Komarowo
 *  5. Update Skolwin incident → MOVE04 (animal movement)
 *  6. Update Skolwin zadanie → done=YES with beaver explanation
 *  7. Create Komarowo incident → MOVE01 (human movement)
 *  8. Call action=done → returns flag
 *
 * Incident codes:
 *  MOVE01 = human movement
 *  MOVE02 = vehicle movement
 *  MOVE03 = vehicle + human movement
 *  MOVE04 = animal movement
 *
 * ⚠️  WARNING: NEVER access /edit/{id} URLs — triggers security breach detection + API ban
 * ⚠️  If banned: logout via OKO web → re-login to restore access
 *
 * Verified solution flag: {FLG:NEWREALITY}
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const TASK = "okoeditor";
const TASK_DIR = path.resolve("data", "s04e01");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

const OKO_BASE = "https://oko.ag3nts.org";
const HUB_BASE = process.env.HUB_BASE_URL;
if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");
const apiKey = process.env.AG3NTS_API_KEY;
if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

// Known record IDs (discovered by browsing the OKO panel)
const SKOLWIN_ID = "380792b2c86d9c5be670b3bde48e187b";
const SPARE_ID = "351c0d9c90d66b4c040fff1259dd191d"; // repurposed as Komarowo incident

// ─── OKO API helper ───────────────────────────────────────────────────────────

interface OkoResponse {
  code?: number;
  message?: string;
  [key: string]: unknown;
}

async function okoApi(body: Record<string, string>): Promise<OkoResponse> {
  const formData = new URLSearchParams(body);
  const res = await fetch(`${OKO_BASE}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });
  if (!res.ok) throw new Error(`OKO API HTTP ${res.status}`);
  const data = (await res.json()) as OkoResponse;
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  console.log(`📋 Task: ${TASK} — Update OKO panel records`);

  // Step 1: Login to OKO
  console.log("📥 Logging in to OKO as Zofia...");
  await okoApi({
    action: "login",
    login: "Zofia",
    password: "Zofia2026!",
    access_key: apiKey,
  });
  console.log("✅ Logged in");

  // Step 2: Update Skolwin incydent → MOVE04 (animal movement — beavers)
  console.log(`🔧 Updating Skolwin incydent (${SKOLWIN_ID}) → MOVE04 animals`);
  const incidentUpdate = await okoApi({
    action: "update",
    page: "incydenty",
    id: SKOLWIN_ID,
    title: "MOVE04 Ruch zwierzyny w okolicach miasta Skolwin",
    content:
      "Odnotowano masowy ruch zwierząt leśnych w okolicach miasta Skolwin. " +
      "Bobry wybudowały tamę blokującą główną drogę dojazdową. " +
      "Sytuacja nie stanowi zagrożenia dla ludzi - zalecany objazd.",
  });
  console.log(`↩ Incident update:`, JSON.stringify(incidentUpdate));

  // Step 3: Update Skolwin zadanie → done=YES with beaver explanation
  console.log(`🔧 Updating Skolwin zadanie (${SKOLWIN_ID}) → done + beavers`);
  const taskUpdate = await okoApi({
    action: "update",
    page: "zadania",
    id: SKOLWIN_ID,
    done: "YES",
    content:
      "Zadanie wykonane. Zidentyfikowano przyczynę blokady drogi do Skolwin: " +
      "bobry wybudowały tamę na rzece, powodując zalanie drogi. " +
      "Nie stwierdzono działalności ludzkiej ani pojazdów. " +
      "Sprawa zamknięta — brak zagrożenia dla bezpieczeństwa publicznego.",
  });
  console.log(`↩ Task update:`, JSON.stringify(taskUpdate));

  // Step 4: Repurpose spare incydent as Komarowo MOVE01 (human movement)
  console.log(`🔧 Creating Komarowo incydent (${SPARE_ID}) → MOVE01 humans`);
  const komarowoUpdate = await okoApi({
    action: "update",
    page: "incydenty",
    id: SPARE_ID,
    title: "MOVE01 Wykryty ruch ludzi w okolicach miasta Komarowo",
    content:
      "Zarejestrowano ruch pieszych w okolicach miasta Komarowo. " +
      "Obserwowano grupę ok. 3-5 osób przemieszczających się w kierunku centrum. " +
      "Brak oznak zagrożenia. Monitorowanie kontynuowane.",
  });
  console.log(`↩ Komarowo update:`, JSON.stringify(komarowoUpdate));

  // Step 5: Signal completion to hub → returns flag
  console.log("📤 Signalling done to hub...");
  const doneResult = await okoApi({ action: "done" });
  console.log(`📨 Hub response:`, JSON.stringify(doneResult));

  if (doneResult.code === 0) {
    console.log(`✅ Success! Flag: ${doneResult.message}`);
  } else {
    console.log(`❌ Failed: ${JSON.stringify(doneResult)}`);
  }
}

run().catch(console.error);
