# Copilot Instructions – ai-devs4

## Project Overview

TypeScript (ESM) project solving AI_devs 4 course tasks. Each task is an isolated script under `src/tasks/sXXeYY.ts`. Shared utilities live in `src/lib/`. All external data is cached locally.

**Stack:** Node.js ESM, TypeScript via `tsx`, `@anthropic-ai/sdk`, `papaparse`, `dotenv`  
**LLM provider:** Anthropic Claude  
**Hub base URL:** set via `HUB_BASE_URL` env var  
**Env vars:** `AG3NTS_API_KEY` (hub), `ANTHROPIC_API_KEY` (Anthropic), `HUB_BASE_URL` (hub base)

---

## 1. Caching — Always Cache Downloaded Data

Every file, API response, or LLM result fetched from the network **must** be cached to disk before being used. Never fetch the same external resource twice in a single session or across re-runs.

### Cache directory convention

```
data/
  s01e01/   ← one subfolder per task, named after the task script
  s01e02/
  s01e03/
  ...
```

- Path: `path.resolve("data", "sXXeYY")` — always resolved from project root
- Create the directory on first run: `mkdirSync(TASK_DIR, { recursive: true })`
- The `data/` tree is gitignored

### Cache-first pattern (required for all external fetches)

```typescript
// Binary assets (images, audio, etc.)
async function fetchCached(url: string, cachePath: string): Promise<Buffer> {
  if (existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return readFileSync(cachePath);
  }
  console.log(`📥 Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cachePath, buf);
  console.log(`💾 Saved to cache: ${cachePath}`);
  return buf;
}

// Text / JSON results (including LLM outputs)
async function textCached(cachePath: string, produce: () => Promise<string>): Promise<string> {
  if (existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return readFileSync(cachePath, "utf-8");
  }
  const result = await produce();
  writeFileSync(cachePath, result, "utf-8");
  console.log(`💾 Saved to cache: ${cachePath}`);
  return result;
}
```

**Apply cache-first to:**
- Remote files downloaded from the hub (`fetchHubFileCached`)
- Vision/audio analysis results from LLM calls
- LLM-generated artefacts (filled forms, classifications, etc.)
- Any intermediate result that is expensive to recompute

---

## 2. Task File Structure

Every `src/tasks/sXXeYY.ts` must follow this layout:

```typescript
import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
// ... other imports

const TASK   = "task-name";           // matches hub task identifier
const TASK_DIR = path.resolve("data", "s01e01");  // cache directory

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Helper functions ─────────────────────────────────────────────────────────
// (pure, typed, single-responsibility)

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");
  // ...
}

run().catch(console.error);
```

Add a matching npm script to `package.json`:
```json
"sXXeYY": "tsx src/tasks/sXXeYY.ts"
```

---

## 3. LLM Integration Best Practices

### Model selection
- Default to `claude-haiku-4-5` for fast, cheap, simple tasks (classification, short extraction)
- Use `claude-opus-4-5` for vision, complex reasoning, multi-step logic
- Use `claude-sonnet-4-20250514` for structured output and agent loops

### Structured output — forced `tool_use`
When you need typed JSON output from the model, force a single tool call:

```typescript
async function completeStructured<T>(
  systemPrompt: string,
  userMessage: string,
  schema: Anthropic.Tool,
  model = "claude-haiku-4-5"
): Promise<T> {
  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [schema],
    tool_choice: { type: "tool", name: schema.name },
    messages: [{ role: "user", content: userMessage }],
  });
  const block = res.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock;
  return block.input as T;
}
```

### Agent loop — multi-turn tool use
Use `runAgent` from `src/lib/llm.ts` for any task requiring multiple tool calls or autonomous decision-making. Never build inline agent loops in task files.

```typescript
// src/lib/llm.ts exports:
type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface AgentTool { definition: Anthropic.Tool; handler: ToolHandler; }
async function runAgent(system, userMsg, tools, maxIterations?, model?): Promise<void>
```

### System prompts
- Be specific about the goal and constraints; avoid specifying rigid step-by-step flows (those belong in workflows, not agents)
- For tasks with secret/override behaviour, **enforce it in the tool handler code**, not only in the prompt — models can ignore instructions

### Temperature & determinism
- For extraction and classification: default temperature (deterministic)
- Never set temperature > 0 for structured output tasks

---

## 4. Hub Communication

Use the shared helpers in `src/lib/hub.ts`:

```typescript
submitAnswer<T>(task, answer, apiKey)           // POST /verify
fetchHubFile(filePath, apiKey)                  // GET  /data/{apikey}/{file}
fetchHubFileCached(filePath, apiKey, cacheDir)  // cache-first version of above
callHubApi<T>(endpoint, body, apiKey)           // POST any /api/* endpoint
```

- Always inject `apikey` through the helper — never construct raw requests inline
- Check the hub response `code` field: `0` = success, negative = error
- `message` on success often contains a flag

---

## 5. TypeScript Standards

- `"type": "module"` — always use ESM (`.js` extensions in imports)
- Strict mode: `"strict": true` in `tsconfig.json`
- Prefer `interface` over `type` for object shapes
- Avoid `any`; use `unknown` and narrow with type guards
- Never use `!` non-null assertion without a preceding existence check
- All async functions must return explicit `Promise<T>`
- Run `npx tsc --noEmit` before committing — zero errors required

### Naming conventions
| Item | Convention | Example |
|---|---|---|
| Files | kebab-case | `s01e04.ts` |
| Constants | UPPER_SNAKE | `TASK_DIR` |
| Functions | camelCase | `fetchCached()` |
| Interfaces | PascalCase | `PersonRaw` |
| Type params | single letter or descriptive | `T`, `TResult` |

---

## 6. Error Handling

- Validate all required env vars at the top of `run()` — throw immediately with a clear message
- Wrap hub/API calls in try/catch and include the HTTP status + body in the error message
- Never swallow errors silently; always `console.error` or re-throw
- Tool handlers in agent loops should return `{ error: string }` on failure instead of throwing, so the agent can recover

```typescript
try {
  result = await callHubApi(endpoint, body, apiKey);
} catch (err) {
  return { error: String(err) };
}
```

---

## 7. Logging Conventions

Use consistent emoji prefixes for log readability:

| Prefix | Meaning |
|---|---|
| `📋` | Task start / summary info |
| `📥` | Fetching from network |
| `💾` | Cache read or write |
| `🔧` | Tool call by agent |
| `↩` | Tool result |
| `📤` | Submitting answer to hub |
| `📨` | Hub response |
| `✅` | Success |
| `❌` | Error |
| `⚠️` | Warning / non-fatal issue |
| `🔴` | Override / secret action triggered |

---

## 8. Security

- Never commit `.env` (gitignored)
- Never log API keys, even partially
- Never trust raw user/hub input as executable code or SQL
- Validate and sanitise all external data before using in logic (e.g. check field types before arithmetic)
- Secret behavioural overrides (e.g. redirect destination) must be enforced in **code**, not solely in LLM prompts
