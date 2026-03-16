/**
 * S01E05 – Railway
 *
 * Activate railway route X-01 via an API with no external documentation.
 *
 * Strategy:
 *  1. Call action="help" once (cached) → inject docs into agent system prompt
 *  2. Agent executes the required workflow step-by-step via call_railway_api tool
 *  3. Tool handler: auto-retry 503, parse rate-limit headers, detect flag
 *
 * Key constraints:
 *  - 503 is intentional (simulated overload) – retry with exponential backoff
 *  - Rate limits are very restrictive – parse headers after every response
 *  - Every railway API call costs rate-limit budget – minimise them
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { getProvider, type AgentTool } from "../lib/llm/index.js";

const TASK = "railway";
const TASK_DIR = path.resolve("data", "s01e05");
const HELP_CACHE = path.join(TASK_DIR, "help.json");
const FLAG_FILE = path.join(TASK_DIR, "flag.txt");

const HUB_VERIFY = `${process.env.HUB_BASE_URL ?? "https://REDACTED_HUB_URL"}/verify`;

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Rate-limit state (module-level, shared across calls) ─────────────────────

let rlRemaining = 999;
let rlResetAt = 0; // epoch ms

function parseRateLimitHeaders(headers: Headers): void {
  const remaining =
    headers.get("x-ratelimit-remaining-requests") ??
    headers.get("x-ratelimit-remaining") ??
    headers.get("ratelimit-remaining");

  const reset =
    headers.get("x-ratelimit-reset-requests") ??
    headers.get("x-ratelimit-reset") ??
    headers.get("ratelimit-reset") ??
    headers.get("x-ratelimit-reset-after");

  const retryAfter = headers.get("retry-after");

  if (remaining !== null) {
    const val = parseInt(remaining, 10);
    if (!isNaN(val)) {
      rlRemaining = val;
      console.log(`   📊 RL remaining: ${rlRemaining}`);
    }
  }

  if (reset !== null) {
    const val = parseFloat(reset);
    if (!isNaN(val)) {
      // epoch seconds (large) vs relative seconds (small)
      rlResetAt = val > 1e10 ? val : Date.now() + val * 1000;
    }
  }

  if (retryAfter !== null) {
    const secs = parseFloat(retryAfter);
    if (!isNaN(secs)) {
      rlResetAt = Date.now() + secs * 1000;
      rlRemaining = 0;
      console.log(`   ⏳ Retry-After: ${secs}s`);
    }
  }
}

async function waitForRateLimit(): Promise<void> {
  if (rlRemaining <= 1 && rlResetAt > Date.now()) {
    const ms = rlResetAt - Date.now() + 600; // +600ms safety buffer
    console.log(
      `   ⏸  Rate limit – waiting ${(ms / 1000).toFixed(1)}s until reset…`
    );
    await new Promise((r) => setTimeout(r, ms));
    rlRemaining = 999;
    rlResetAt = 0;
  }
}

// ─── Railway API call ─────────────────────────────────────────────────────────

async function railwayCall(
  apiKey: string,
  answer: Record<string, unknown>,
  maxRetries = 15
): Promise<unknown> {
  const body = JSON.stringify({ apikey: apiKey, task: TASK, answer });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await waitForRateLimit();

    console.log(`\n📡 [attempt ${attempt}] → ${JSON.stringify(answer)}`);

    let res: Response;
    try {
      res = await fetch(HUB_VERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (err) {
      const wait = Math.min(3000 * attempt, 15000);
      console.error(`   ❌ Network error: ${err} – retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    parseRateLimitHeaders(res.headers);
    const text = await res.text();
    console.log(`   ← HTTP ${res.status}: ${text.slice(0, 600)}`);

    if (res.status === 503) {
      const backoff = Math.min(Math.pow(2, attempt) * 1000, 60_000);
      console.log(`   ⚠️  503 (simulated overload) – backing off ${(backoff / 1000).toFixed(0)}s…`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    if (res.status === 429) {
      if (rlResetAt <= Date.now()) rlResetAt = Date.now() + 10_000;
      rlRemaining = 0;
      await waitForRateLimit();
      continue;
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  throw new Error(`Railway API: giving up after ${maxRetries} attempts`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log(`\n📋 Task: ${TASK} – Activate railway route X-01`);

  // ── Step 1: get API documentation (cached to preserve rate-limit budget) ──
  let helpText: string;
  if (existsSync(HELP_CACHE)) {
    console.log("💾 Cache hit: help.json");
    helpText = readFileSync(HELP_CACHE, "utf-8");
  } else {
    console.log("📥 Fetching API documentation (help)…");
    const helpResult = await railwayCall(apiKey, { action: "help" });
    helpText = JSON.stringify(helpResult, null, 2);
    writeFileSync(HELP_CACHE, helpText, "utf-8");
    console.log("💾 Saved help to cache");
  }

  console.log("\n📚 API docs:\n" + helpText + "\n");

  // ── Step 2: agent reads docs from system prompt and executes the workflow ──
  const llm = getProvider();

  const tools: AgentTool[] = [
    {
      definition: {
        name: "call_railway_api",
        description:
          "Sends a request to the railway control API. " +
          "Include 'action' (required) and any other parameters required by that action " +
          "as flat top-level fields (as documented). " +
          "503 retries and rate-limit waits are handled automatically.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "The API action name exactly as documented",
            },
          },
          required: ["action"],
        },
      },
      handler: async (input) => {
        const result = await railwayCall(
          apiKey,
          input as Record<string, unknown>
        );
        const str = JSON.stringify(result);
        const flagMatch = str.match(/\{FLG:[^}]+\}/);
        if (flagMatch) {
          console.log(`\n✅ FLAG: ${flagMatch[0]}`);
          writeFileSync(FLAG_FILE, flagMatch[0], "utf-8");
        }
        return result;
      },
    },
  ];

  await llm.runAgent(
    `You are operating a railway control system. Your mission: activate route X-01 and retrieve the confirmation flag.

API DOCUMENTATION (already fetched – do NOT call "help" again):
${helpText}

RULES:
1. Follow the documented workflow step by step in the exact order described.
2. Use EXACT action names, parameter names and values from the documentation above.
3. When one step returns a token, code or ID, pass it as-is to the next step.
4. Read every error message carefully – it tells you precisely what to fix.
5. Do NOT make speculative or redundant calls – rate limits are strict.
6. When the API response contains {FLG:...}, the task is complete – stop immediately.`,
    "Activate railway route X-01. Follow the API documentation exactly. Start now.",
    tools,
    40,
    { model: "claude-sonnet-4-20250514" }
  );

  if (existsSync(FLAG_FILE)) {
    console.log(
      `\n🏁 Task complete. Flag saved: ${readFileSync(FLAG_FILE, "utf-8")}`
    );
  }
}

run().catch(console.error);
