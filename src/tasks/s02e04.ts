import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { submitAnswer } from "../lib/hub.js";
import { runAgent, type AgentTool } from "../lib/llm/index.js";

const TASK = "mailbox";
const TASK_DIR = path.resolve("data", "s02e04");
const HUB = process.env.HUB_BASE_URL;
if (!HUB) throw new Error("Missing HUB_BASE_URL in .env");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── zmail API helper ─────────────────────────────────────────────────────────

async function zmailCall(
  apiKey: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const body = { apikey: apiKey, ...params };
  const res = await fetch(`${HUB}/api/zmail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`zmail HTTP ${res.status}`);
  return res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log("📋 S02E04 — Mailbox search");

  // State to collect answers
  const found: { password?: string; date?: string; confirmation_code?: string } = {};

  // Define agent tools
  const tools: AgentTool[] = [
    {
      definition: {
        name: "zmail_help",
        description: "Show available zmail API actions and parameters.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      handler: async () => {
        console.log("🔧 zmail_help");
        return zmailCall(apiKey, { action: "help" });
      },
    },
    {
      definition: {
        name: "zmail_inbox",
        description: "Get inbox threads list. Returns metadata (no message body).",
        inputSchema: {
          type: "object",
          properties: {
            page: { type: "number", description: "Page number (default 1)" },
            perPage: { type: "number", description: "Items per page 5-20 (default 5)" },
          },
          required: [],
        },
      },
      handler: async (input: Record<string, unknown>) => {
        console.log(`🔧 zmail_inbox(page=${input["page"] ?? 1})`);
        return zmailCall(apiKey, {
          action: "getInbox",
          page: input["page"] ?? 1,
          perPage: input["perPage"] ?? 20,
        });
      },
    },
    {
      definition: {
        name: "zmail_search",
        description:
          "Search emails. Supports: words, \"phrase\", -exclude, from:, to:, subject:, OR, AND. Returns metadata + snippet (no full body).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query with Gmail-like operators" },
            page: { type: "number", description: "Page number" },
            perPage: { type: "number", description: "Items per page 5-20" },
          },
          required: ["query"],
        },
      },
      handler: async (input: Record<string, unknown>) => {
        console.log(`🔧 zmail_search("${input["query"]}")`);
        return zmailCall(apiKey, {
          action: "search",
          query: input["query"],
          page: input["page"] ?? 1,
          perPage: input["perPage"] ?? 20,
        });
      },
    },
    {
      definition: {
        name: "zmail_get_thread",
        description: "Get list of message IDs in a thread. No message body.",
        inputSchema: {
          type: "object",
          properties: {
            threadID: { type: "number", description: "Thread ID" },
          },
          required: ["threadID"],
        },
      },
      handler: async (input: Record<string, unknown>) => {
        console.log(`🔧 zmail_get_thread(${input["threadID"]})`);
        return zmailCall(apiKey, {
          action: "getThread",
          threadID: input["threadID"],
        });
      },
    },
    {
      definition: {
        name: "zmail_get_messages",
        description:
          "Get full message content by rowID or messageID (32-char hash). Can pass a single ID or array of IDs.",
        inputSchema: {
          type: "object",
          properties: {
            ids: {
              description: "Single rowID/messageID or array of them",
            },
          },
          required: ["ids"],
        },
      },
      handler: async (input: Record<string, unknown>) => {
        console.log(`🔧 zmail_get_messages(${JSON.stringify(input["ids"])})`);
        return zmailCall(apiKey, {
          action: "getMessages",
          ids: input["ids"],
        });
      },
    },
    {
      definition: {
        name: "submit_answer",
        description:
          "Submit found values to the hub. Pass any combination of password, date, confirmation_code. Hub returns feedback on what's correct/missing.",
        inputSchema: {
          type: "object",
          properties: {
            password: { type: "string", description: "Employee system password" },
            date: { type: "string", description: "Attack date YYYY-MM-DD" },
            confirmation_code: {
              type: "string",
              description: "SEC ticket confirmation code (SEC- + 32 chars)",
            },
          },
          required: [],
        },
      },
      handler: async (input: Record<string, unknown>) => {
        const answer: Record<string, string> = {};
        if (input["password"]) answer["password"] = input["password"] as string;
        if (input["date"]) answer["date"] = input["date"] as string;
        if (input["confirmation_code"])
          answer["confirmation_code"] = input["confirmation_code"] as string;

        console.log(`📤 submit_answer(${JSON.stringify(answer)})`);
        try {
          const result = await submitAnswer(TASK, answer, apiKey);
          const msg = typeof result.message === "string" ? result.message : JSON.stringify(result);
          if (msg.includes("{FLG:")) {
            console.log(`\n✅ FLAG: ${msg}`);
          }
          return result;
        } catch (err) {
          return { error: String(err) };
        }
      },
    },
  ];

  const systemPrompt = `You are searching an email inbox to find 3 pieces of information:
1. DATE - when the security department plans to attack the power plant (format: YYYY-MM-DD)
2. PASSWORD - password to the employee system
3. CONFIRMATION_CODE - confirmation code from a security ticket (format: SEC- + 32 chars = 36 total)

What you know:
- Wiktor sent an email from a proton.me domain reporting suspicious activity
- The mailbox belongs to operator04227@system.nwo
- The inbox is active - new messages may arrive

Strategy:
1. Search for emails from proton.me to find Wiktor's report
2. Search for security-related threads (SEC tickets, attack plans)
3. Search for password emails
4. Read full message bodies to extract exact values
5. Submit all 3 values when found

Use zmail_search with Gmail-like operators. After searching, use zmail_get_messages with messageIDs to read full content. The mailbox is active—if you can't find something, search again.`;

  await runAgent(
    systemPrompt,
    "Find the 3 values (date, password, confirmation_code) from this operator's mailbox and submit them.",
    tools,
    30,
    "claude-sonnet-4-20250514"
  );

  console.log("\n✅ Agent finished");
}

run().catch(console.error);
