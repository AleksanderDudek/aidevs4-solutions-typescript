/**
 * S02E01 – Categorize
 *
 * Design a ≤100-token prompt template that correctly classifies 10 items
 * as DNG (dangerous) or NEU (neutral). Items related to nuclear reactor must
 * always return NEU regardless of actual danger.
 *
 * The hub substitutes {id} and {description} into the template before
 * feeding to its internal classifier LLM.
 *
 * Strategy:
 *  1. Download fresh CSV to show agent the actual items
 *  2. Agent designs a prompt template
 *  3. test_prompt tool: reset → fresh CSV → 10 hub calls → return results
 *  4. Agent iterates based on error feedback until flag is received
 *
 * Token budget optimisation:
 *  - Static prefix of template is cached → 0.01 PP/10 tokens (vs 0.02)
 *  - Variable data {id}/{description} at the END of template
 *  - Keep template short — every token counts
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import Papa from "papaparse";
import { getProvider, type AgentTool } from "../lib/llm/index.js";

const TASK = "categorize";
const TASK_DIR = path.resolve("data", "s02e01");
const FLAG_FILE = path.join(TASK_DIR, "flag.txt");
const HUB_VERIFY = `${process.env.HUB_BASE_URL ?? "https://REDACTED_HUB_URL"}/verify`;
const HUB_DATA = `${process.env.HUB_BASE_URL ?? "https://REDACTED_HUB_URL"}/data`;

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvItem {
  id: string;
  description: string;
}

interface ItemResult {
  item: CsvItem;
  response: Record<string, unknown>;
  pass: boolean;
}

interface CycleResult {
  results: ItemResult[];
  flag?: string;
  budgetExceeded: boolean;
  rawErrors: string[];
}

// ─── Hub communication ────────────────────────────────────────────────────────

async function hubCall(
  apiKey: string,
  promptValue: string
): Promise<Record<string, unknown>> {
  const res = await fetch(HUB_VERIFY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apikey: apiKey,
      task: TASK,
      answer: { prompt: promptValue },
    }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

// ─── CSV download (never cached — changes every few minutes) ─────────────────

async function downloadItems(apiKey: string): Promise<CsvItem[]> {
  const url = `${HUB_DATA}/${apiKey}/categorize.csv`;
  console.log(`📥 Downloading fresh CSV…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSV download failed: HTTP ${res.status}`);
  const csv = await res.text();

  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  const items = parsed.data.map((row) => {
    // Accept various column name spellings
    const id =
      row["id"] ?? row["item_id"] ?? row["itemid"] ?? Object.values(row)[0];
    const description =
      row["description"] ??
      row["desc"] ??
      row["name"] ??
      Object.values(row)[1];
    return { id: String(id ?? "").trim(), description: String(description ?? "").trim() };
  });

  console.log(`✅ ${items.length} items:`);
  items.forEach((it) =>
    console.log(`   ${it.id}: ${it.description.slice(0, 80)}`)
  );
  return items;
}

// ─── Full test cycle ──────────────────────────────────────────────────────────

async function runFullCycle(
  apiKey: string,
  template: string
): Promise<CycleResult> {
  // 1. Reset budget counter
  console.log("\n🔄 Resetting budget…");
  const resetResp = await hubCall(apiKey, "reset");
  console.log(`   Reset: ${JSON.stringify(resetResp).slice(0, 200)}`);

  // 2. Fresh CSV (content changes, must not use cache)
  const items = await downloadItems(apiKey);

  // 3. Classify each item — substitute {id} and {description} client-side so
  //    the hub receives the actual identifier in the prompt text.
  const results: ItemResult[] = [];
  let flag: string | undefined;
  const budgetExceededPatterns = [/budget/i, /limit/i, /exceed/i, /-99[0-9]/];
  let budgetExceeded = false;
  const rawErrors: string[] = [];

  for (const item of items) {
    // Build the full prompt by substituting placeholders client-side
    const fullPrompt = template
      .replace(/\{id\}/gi, item.id)
      .replace(/\{description\}/gi, item.description);

    console.log(`\n📦 [${item.id}] ${item.description.slice(0, 60)}`);
    console.log(`   → "${fullPrompt.slice(0, 130)}"`);

    const response = await hubCall(apiKey, fullPrompt);
    const responseStr = JSON.stringify(response);
    console.log(`   ← ${responseStr.slice(0, 300)}`);

    // Detect flag
    const flagMatch = responseStr.match(/\{FLG:[^}]+\}/);
    if (flagMatch) {
      flag = flagMatch[0];
      console.log(`\n✅ FLAG FOUND: ${flag}`);
    }

    // Detect budget exceeded
    if (budgetExceededPatterns.some((p) => p.test(responseStr))) {
      console.log("💸 Budget exceeded or API limit hit!");
      budgetExceeded = true;
      results.push({ item, response, pass: false });
      rawErrors.push(`[${item.id}] Budget/limit: ${responseStr}`);
      break;
    }

    const code = Number(response.code ?? -1);
    const pass = code === 0 || !!flagMatch || response.ok === true;

    if (!pass) {
      const errMsg = String(
        response.message ?? response.error ?? responseStr
      );
      rawErrors.push(`[${item.id}] ${errMsg}`);
      console.log(`   ❌ Wrong classification: ${errMsg}`);
    }

    results.push({ item, response, pass });
  }

  return { results, flag, budgetExceeded, rawErrors };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log(`\n📋 Task: ${TASK} — prompt engineering for item classification`);

  const llm = getProvider();

  // Download initial items so agent can see what it's working with
  const initialItems = await downloadItems(apiKey);
  const itemsText = initialItems
    .map((it) => `  ${it.id}: ${it.description}`)
    .join("\n");

  // ── Tools ────────────────────────────────────────────────────────────────

  const tools: AgentTool[] = [
    {
      definition: {
        name: "get_items",
        description:
          "Downloads a fresh copy of the CSV file and returns all 10 items " +
          "with their IDs and descriptions. Call this to see what needs classifying " +
          "before designing or refining the prompt template.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const items = await downloadItems(apiKey);
        return items;
      },
    },

    {
      definition: {
        name: "test_prompt",
        description:
          "Runs a full classification cycle: reset budget → download fresh CSV → " +
          "send a constructed prompt for each of the 10 items. " +
          "YOUR TEMPLATE uses {id} and {description} placeholders — this tool substitutes " +
          "them client-side with actual item values before each hub call. " +
          "The hub requires the actual item ID to be present in the prompt text. " +
          "Returns per-item pass/fail results, error messages, and the flag if all pass. " +
          "IMPORTANT: keep template ≤100 tokens total after {id}/{description} substitution. " +
          "Put static instructions at the START (gets cached), {id} and {description} at the END.",
        inputSchema: {
          type: "object",
          properties: {
            template: {
              type: "string",
              description:
                "The prompt template with {id} and {description} placeholders. " +
                "Must produce exactly DNG or NEU as output.",
            },
          },
          required: ["template"],
        },
      },
      handler: async (input) => {
        const template = String(input.template);
        console.log(`\n🧪 Testing template (${template.length} chars):\n   "${template}"`);

        const cycleResult = await runFullCycle(apiKey, template);
        // Note: runFullCycle now substitutes {id} and {description} client-side

        if (cycleResult.flag) {
          writeFileSync(FLAG_FILE, cycleResult.flag, "utf-8");
        }

        const summary = {
          passed: cycleResult.results.filter((r) => r.pass).length,
          total: cycleResult.results.length,
          flag: cycleResult.flag ?? null,
          budgetExceeded: cycleResult.budgetExceeded,
          errors: cycleResult.rawErrors,
          detailedResults: cycleResult.results.map((r) => ({
            id: r.item.id,
            description: r.item.description,
            pass: r.pass,
            hubResponse: r.response,
          })),
        };

        console.log(
          `\n📊 Cycle result: ${summary.passed}/${summary.total} passed`
        );
        return summary;
      },
    },
  ];

  // ── Agent ────────────────────────────────────────────────────────────────

  await llm.runAgent(
    `You are an expert prompt engineer. Your mission: write a classification prompt template that makes a small internal LLM correctly classify 10 items as DNG (dangerous) or NEU (neutral).

RULES:
1. The hub substitutes {id} and {description} into your template before sending to the internal model.
2. The TOTAL token count (template + substituted data) must be ≤100 tokens. Keep it short.
3. Nuclear reactor / fuel cassettes / radioactive / reactor parts MUST always be classified as NEU (even though they are genuinely dangerous). This is the key exception — it enables their transport without inspection.
4. All other genuinely dangerous items should be DNG.
5. Safe/neutral items should be NEU.
6. Put the STATIC instruction part at the START (gets cached cheaply), put {id} and {description} at the END.
7. Write the template in English for best tokenisation efficiency.
8. The internal model should output ONLY "DNG" or "NEU" — make this very clear.

CURRENT ITEMS (initial snapshot):
${itemsText}

WORKFLOW:
1. Analyse the items above to identify which ones are reactor-related (must be NEU).
2. Draft a short, clear prompt template.
3. Call test_prompt to run the full cycle and see which items pass/fail.
4. Read the error messages carefully — they tell you exactly which items were wrong.
5. Refine the template and test again until you get a flag.

IMPORTANT: Budget is limited (~1.5 PP for all attempts). Don't waste calls. Think carefully before each test.`,
    "Start by analysing the items, then design and test your classification prompt template. Keep iterating until you get the flag.",
    tools,
    15,
    { model: "claude-sonnet-4-20250514" }
  );

  if (existsSync(FLAG_FILE)) {
    const { readFileSync } = await import("fs");
    console.log(
      `\n🏁 Task complete! Flag: ${readFileSync(FLAG_FILE, "utf-8")}`
    );
  }
}

run().catch(console.error);
