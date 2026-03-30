import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { complete, runAgent, type AgentTool, type ContentBlock } from "../lib/llm/index.js";

const TASK = "electricity";
const TASK_DIR = path.resolve("data", "s02e02");
const HUB = process.env.HUB_BASE_URL;
if (!HUB) throw new Error("Missing HUB_BASE_URL in .env");
const POSITIONS = [
  "1x1", "1x2", "1x3",
  "2x1", "2x2", "2x3",
  "3x1", "3x2", "3x3",
];

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

type RotationMap = Record<string, number>;

// ─── Image helpers ────────────────────────────────────────────────────────────

async function fetchImage(url: string, label: string, useCache: boolean): Promise<Buffer> {
  const cachePath = path.join(TASK_DIR, `${label}.png`);
  if (useCache && existsSync(cachePath)) {
    console.log(`💾 Cache hit: ${cachePath}`);
    return readFileSync(cachePath);
  }
  console.log(`📥 Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cachePath, buf);
  console.log(`💾 Saved: ${cachePath}`);
  return buf;
}

// ─── Dual-image rotation analysis ────────────────────────────────────────────

const DUAL_SYSTEM = `You are an expert at analyzing cable puzzle grids.
You will receive two images of a 3x3 grid of cable connector tiles.
Your task is to determine how many 90-degree clockwise rotations are needed for each cell
in the CURRENT grid to match the corresponding cell in the TARGET grid.

Grid positions: rows 1-3 (top to bottom), columns 1-3 (left to right).
Position format: "RowxColumn" (e.g. "1x1"=top-left, "3x3"=bottom-right).

A 90° CW rotation shifts connections: top→right, right→bottom, bottom→left, left→top.
So rotating 0, 1, 2, or 3 times covers all possibilities.

Output ONLY a JSON object with all 9 positions as keys and rotation counts (0-3) as values.
Example: {"1x1":0,"1x2":2,"1x3":1,"2x1":0,"2x2":3,"2x3":0,"3x1":1,"3x2":2,"3x3":0}`;

const DUAL_PROMPT = `Image 1 is the TARGET (solved state).
Image 2 is the CURRENT board (needs to be rotated to match target).

For each cell position (1x1 through 3x3), determine how many times the CURRENT cell
must be rotated 90° clockwise to match the TARGET cell.

Output ONLY valid JSON with all 9 positions and their rotation counts (0, 1, 2, or 3).`;

async function computeRotationMap(
  targetBuf: Buffer,
  currentBuf: Buffer,
  attempts = 3
): Promise<RotationMap> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(`\n🔍 Analyzing boards (attempt ${attempt}/${attempts})...`);

      const blocks: ContentBlock[] = [
        { type: "image", mediaType: "image/png", data: targetBuf.toString("base64") },
        { type: "text", text: "Image 1 — TARGET (solved state)\n\n" },
        { type: "image", mediaType: "image/png", data: currentBuf.toString("base64") },
        { type: "text", text: "Image 2 — CURRENT board\n\n" + DUAL_PROMPT },
      ];

      const raw = await complete(DUAL_SYSTEM, blocks, "claude-opus-4-5");
      console.log(`🤖 Raw vision response:\n${raw}`);

      // Extract JSON from response
      const jsonMatch = raw.match(/\{[^{}]+\}/);
      if (!jsonMatch) throw new Error("No JSON object found in response");

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      // Validate all 9 positions present with values 0-3
      const rotMap: RotationMap = {};
      for (const pos of POSITIONS) {
        const val = parsed[pos];
        if (typeof val !== "number" || val < 0 || val > 3 || !Number.isInteger(val)) {
          throw new Error(`Invalid value for ${pos}: ${val}`);
        }
        rotMap[pos] = val;
      }

      console.log("✅ Rotation map:", rotMap);
      return rotMap;
    } catch (err) {
      console.error(`❌ Attempt ${attempt} failed: ${err}`);
      if (attempt === attempts) throw err;
    }
  }
  throw new Error("All attempts exhausted");
}

// ─── Hub interaction ──────────────────────────────────────────────────────────

async function doRotate(
  position: string,
  apiKey: string
): Promise<{ code: number; message: string; flag?: string }> {
  const body = {
    apikey: apiKey,
    task: TASK,
    answer: { rotate: position },
  };
  const res = await fetch(`${HUB}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from /verify`);
  const data = (await res.json()) as { code: number; message: string; flag?: string };
  return data;
}

async function resetBoard(apiKey: string): Promise<void> {
  const url = `${HUB}/data/${apiKey}/electricity.png?reset=1`;
  console.log(`\n🔄 Resetting board: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} resetting board`);
  console.log("✅ Board reset");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log("📋 S02E02 — Electricity puzzle solver (dual-image vision)");

  // 1. Reset board to known state
  await resetBoard(apiKey);

  // 2. Fetch both images
  const targetUrl = `${HUB}/i/solved_electricity.png`;
  const currentUrl = `${HUB}/data/${apiKey}/electricity.png`;

  const targetBuf = await fetchImage(targetUrl, "target", true);
  const currentBuf = await fetchImage(currentUrl, "current", false);

  // 3. Compute initial rotation map via dual-image vision
  let rotMap = await computeRotationMap(targetBuf, currentBuf);

  // 4. Define tools for agent
  let latestCurrentBuf = currentBuf;

  const tools: AgentTool[] = [
    {
      definition: {
        name: "reanalyze_boards",
        description:
          "Fetch a fresh current board image and re-run vision analysis to get an updated rotation map. Use this if rotations do not seem to be producing the expected result.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      handler: async (_input: Record<string, unknown>): Promise<unknown> => {
        console.log("\n🔧 reanalyze_boards called");
        try {
          latestCurrentBuf = await fetchImage(currentUrl, "current", false);
          rotMap = await computeRotationMap(targetBuf, latestCurrentBuf);
          return { rotationMap: rotMap };
        } catch (err) {
          return { error: String(err) };
        }
      },
    },
    {
      definition: {
        name: "rotate_cell",
        description:
          "Rotate a cell 90° clockwise once. Call this once per needed rotation for a given cell.",
        inputSchema: {
          type: "object",
          properties: {
            position: {
              type: "string",
              description: 'Cell position in "RowxColumn" format, e.g. "1x2" or "3x3"',
            },
          },
          required: ["position"],
        },
      },
      handler: async (input: Record<string, unknown>): Promise<unknown> => {
        const position = input["position"] as string;
        if (!POSITIONS.includes(position)) {
          return { error: `Invalid position: ${position}. Valid positions: ${POSITIONS.join(", ")}` };
        }
        console.log(`\n🔧 rotate_cell(${position})`);
        try {
          const result = await doRotate(position, apiKey);
          console.log(`↩ rotate result:`, result);

          if (result.flag) {
            console.log(`\n✅ FLAG: ${result.flag}`);
          }
          const flagMatch = result.message?.match(/\{FLG:[^}]+\}/);
          if (flagMatch) {
            console.log(`\n✅ FLAG in message: ${flagMatch[0]}`);
          }

          return result;
        } catch (err) {
          return { error: String(err) };
        }
      },
    },
  ];

  // 5. Run agent with rotation map
  const agentSystem = `You are solving a 3x3 cable connector puzzle.
You have been given a rotation map that tells you exactly how many 90° clockwise rotations
each cell needs to match the target (solved) state.

Rules:
- Call rotate_cell once per needed rotation for each cell
- A cell with rotation count 0 needs no rotations — skip it
- A cell with rotation count 2 needs rotate_cell called TWICE
- A cell with rotation count 3 needs rotate_cell called THREE times
- After every rotate_cell call, check the response for a flag ({"code":0} or {FLG:...})
- If you see a flag in any response, STOP — the puzzle is solved
- If after applying all rotations there is no flag, call reanalyze_boards once to refresh
  the analysis, then apply the new rotation map

Work through cells systematically. Apply all rotations before checking if the puzzle is solved.`;

  const rotMapSummary = POSITIONS.filter((p) => rotMap[p] > 0)
    .map((p) => `${p}: ${rotMap[p]} rotation(s)`)
    .join(", ");

  const agentMessage = `Initial rotation map:
${JSON.stringify(rotMap, null, 2)}

Cells needing rotations: ${rotMapSummary || "none (puzzle may already be solved)"}

Apply these rotations now.`;

  console.log(`\n🤖 Starting agent with rotation map...`);
  await runAgent(agentSystem, agentMessage, tools, 100, "claude-sonnet-4-20250514");

  console.log("\n✅ Agent finished");
}

run().catch(console.error);
