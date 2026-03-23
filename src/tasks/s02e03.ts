import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { complete, runAgent, type AgentTool } from "../lib/llm/index.js";
import { fetchHubFileCached, submitAnswer } from "../lib/hub.js";

const TASK = "failure";
const TASK_DIR = path.resolve("data", "s02e03");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token count (~4 chars per token for English) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Extract non-INFO log lines with their timestamps. */
function extractImportantEvents(logContent: string): string[] {
  return logContent
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter(
      (line) =>
        line.includes("[WARN]") ||
        line.includes("[ERRO]") ||
        line.includes("[CRIT]")
    );
}

/** Deduplicate events: keep first + last occurrence of each unique message. */
function deduplicateEvents(events: string[]): {
  deduplicated: string[];
  summary: string;
} {
  // Parse events into (timestamp, severity+message) pairs
  const parsed = events.map((line) => {
    const match = line.match(
      /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.+)$/
    );
    if (!match) return { ts: "", msg: line, full: line };
    return { ts: match[1], msg: match[2], full: line };
  });

  // Group by message
  const groups = new Map<string, { ts: string; full: string }[]>();
  for (const p of parsed) {
    const existing = groups.get(p.msg) ?? [];
    existing.push({ ts: p.ts, full: p.full });
    groups.set(p.msg, existing);
  }

  // Build deduplicated list with first/last + count annotation
  const deduped: string[] = [];
  const summaryParts: string[] = [];
  for (const [msg, occurrences] of groups) {
    const first = occurrences[0];
    deduped.push(first.full);
    if (occurrences.length > 1) {
      const last = occurrences[occurrences.length - 1];
      if (last.ts !== first.ts) {
        deduped.push(last.full);
      }
    }
    summaryParts.push(`"${msg}" — ${occurrences.length}x (first: ${first.ts}, last: ${occurrences[occurrences.length - 1].ts})`);
  }

  return { deduplicated: deduped, summary: summaryParts.join("\n") };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log("📋 S02E03 — Failure log compression");

  // 1. Download and cache log file
  const logContent = await fetchHubFileCached("failure.log", apiKey, TASK_DIR);
  const totalLines = logContent.split("\n").filter((l) => l.trim()).length;
  console.log(`📊 Total log lines: ${totalLines}`);
  console.log(`📊 Total size: ${logContent.length} bytes (~${estimateTokens(logContent)} tokens)`);

  // 2. Extract important events (non-INFO)
  const important = extractImportantEvents(logContent);
  console.log(`📊 Non-INFO events: ${important.length}`);

  // 3. Deduplicate
  const { deduplicated, summary } = deduplicateEvents(important);
  console.log(`📊 Deduplicated events: ${deduplicated.length}`);
  console.log(`📊 Unique message types: ${summary.split("\n").length}`);

  const dedupText = deduplicated.join("\n");
  console.log(`📊 Deduplicated text: ${dedupText.length} chars (~${estimateTokens(dedupText)} tokens)`);

  // Save dedup for reference
  writeFileSync(path.join(TASK_DIR, "important_dedup.txt"), dedupText, "utf-8");
  writeFileSync(path.join(TASK_DIR, "message_summary.txt"), summary, "utf-8");

  // 4. Use LLM to compress into ≤1500 tokens
  const systemPrompt = `You are a power plant log analyst. You must compress power plant failure logs into a condensed report that fits within 1500 tokens (roughly 5000 characters max, aim for 4500 to be safe).

Rules:
- One line = one event
- Each line must have: date (YYYY-MM-DD), time (HH:MM), severity level, component ID, and brief description
- Format: [YYYY-MM-DD HH:MM] [LEVEL] COMPONENT_ID brief description
- You may shorten/paraphrase descriptions — keep essential technical meaning
- Preserve the chronological order of the failure chain
- Include ALL component types that appear: ECCS8, WTANK07, WTRPMP, STMTURB12, PWR01, WSTPOOL2, FIRMWARE
- For repeated events, include first occurrence with note about frequency/recurrence
- Focus on events that explain the CAUSE CHAIN of the failure
- Keep CRIT events — they are the most important
- Include key WARN/ERRO events that show the progression toward failure
- Do NOT include any preamble or explanation — output ONLY the compressed log lines`;

  let feedback = "";
  let compressedLogs = "";

  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`\n🔄 Attempt ${attempt}/5`);

    const userMessage = `Here is a summary of all non-INFO events from the power plant failure log on 2026-03-22.
The plant started at ~06:00 and shut down at ~21:37.

UNIQUE MESSAGE TYPES WITH FREQUENCIES:
${summary}

DEDUPLICATED EVENTS (first and last occurrence of each type, chronological among firsts):
${dedupText}

${feedback ? `IMPORTANT FEEDBACK FROM PREVIOUS SUBMISSION (fix these issues):\n${feedback}\n` : ""}
Compress these into a failure analysis log. Target: under 1400 tokens (~4800 chars). Output ONLY the log lines, one per line.`;

    compressedLogs = await complete(
      systemPrompt,
      userMessage,
      "claude-sonnet-4-20250514"
    );

    // Clean up: remove any markdown formatting
    compressedLogs = compressedLogs
      .replace(/```[a-z]*\n?/g, "")
      .replace(/```/g, "")
      .trim();

    const tokenEst = estimateTokens(compressedLogs);
    const lineCount = compressedLogs.split("\n").filter((l) => l.trim()).length;
    console.log(`📊 Compressed: ${compressedLogs.length} chars, ~${tokenEst} tokens, ${lineCount} lines`);

    // Save compressed result
    writeFileSync(path.join(TASK_DIR, `compressed_v${attempt}.txt`), compressedLogs, "utf-8");

    if (tokenEst > 1500) {
      console.log("⚠️  Estimated tokens exceed 1500, asking for more compression...");
      feedback = `The previous output was too long (~${tokenEst} tokens). You MUST be more aggressive: shorten descriptions further, merge repeated events into single lines with count annotations, and remove less critical WARN events. Target under 1300 tokens.`;
      continue;
    }

    // 5. Submit to hub
    console.log(`\n📤 Submitting compressed logs...`);
    const result = await submitAnswer(TASK, { logs: compressedLogs }, apiKey);

    if (result.flag) {
      console.log(`\n✅ FLAG: ${result.flag}`);
      return;
    }

    // Check for success indicators
    const msg = typeof result.message === "string" ? result.message : JSON.stringify(result);
    if (msg.includes("{FLG:")) {
      console.log(`\n✅ FLAG in message: ${msg}`);
      return;
    }

    // Use technician feedback for next iteration
    console.log(`\n📨 Feedback: ${msg}`);
    feedback = msg;
  }

  console.log("\n❌ Failed after 5 attempts");
  console.log("Last compressed logs saved to data/s02e03/");
}

run().catch(console.error);
