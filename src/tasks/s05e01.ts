/**
 * S05E01 — radiomonitoring
 *
 * Strategy:
 *  1. Start the radio monitoring session
 *  2. Repeatedly call "listen" – routing each signal smartly:
 *     - transcription text → add directly to corpus
 *     - attachment with text/JSON MIME → decode Base64 locally, add to corpus
 *     - attachment with image MIME → describe via vision model (claude-opus-4-5)
 *     - unreadable binary → log and skip
 *     - pure noise (no content) → skip
 *  3. Once hub signals end-of-stream (code ≠ 100), stop listening
 *  4. Use LLM to synthesise: cityName, cityArea, warehousesCount, phoneNumber
 *  5. Transmit final report
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

import { complete, completeStructured } from "../lib/llm/index.js";
import type { ContentBlock, ImageContent } from "../lib/llm/index.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const TASK = "radiomonitoring";
const TASK_DIR = path.resolve("data", "s05e01");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

const HUB_BASE = process.env.HUB_BASE_URL;
if (!HUB_BASE) throw new Error("Missing HUB_BASE_URL in .env");
const apiKey = process.env.AG3NTS_API_KEY;
if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

const HUB_URL = `${HUB_BASE}/verify`;
const MAX_LISTEN_ROUNDS = 80;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ListenResponse {
  code: number;
  message: string;
  transcription?: string;
  attachment?: string;
  meta?: string;
  filesize?: number;
  flag?: string;
}

interface FinalReport {
  cityName: string;
  cityArea: string;
  warehousesCount: number;
  phoneNumber: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callHub(answer: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, task: TASK, answer }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function parseMime(meta: string): string {
  // Strip parameters like "; charset=utf-8"
  return meta.split(";")[0].trim().toLowerCase();
}

function isImageMime(mime: string): mime is ImageContent["mediaType"] {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime);
}

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript"
  );
}

function hasBinaryCharacters(text: string): boolean {
  // Check first 200 chars for non-printable, non-whitespace control characters
  const sample = text.slice(0, 200);
  return /[\x00-\x08\x0e-\x1f\x7f]/.test(sample);
}

async function transcribeAudio(base64data: string, idx: number): Promise<string> {
  const cacheFile = path.join(TASK_DIR, `audio_${idx}_transcription.txt`);
  if (existsSync(cacheFile)) {
    console.log(`💾 Cache hit: ${cacheFile}`);
    return readFileSync(cacheFile, "utf-8");
  }

  const mp3Path = path.join(TASK_DIR, `listen_${idx}.mp3`);
  writeFileSync(mp3Path, Buffer.from(base64data, "base64"));
  console.log(`🔧 Saved audio to ${mp3Path}, running local Whisper...`);

  try {
    const result = execSync(
      `python3 -c "
import whisper, sys
model = whisper.load_model('small')
r = model.transcribe('${mp3Path}', language='pl')
sys.stdout.write(r['text'])
"`,
      { timeout: 120000, encoding: "utf-8" }
    );
    const transcript = result.trim();
    writeFileSync(cacheFile, transcript, "utf-8");
    console.log(`💾 Audio transcript saved: ${cacheFile}`);
    console.log(`📝 Audio [${idx}]: ${transcript.slice(0, 120)}...`);
    return transcript;
  } catch (err) {
    console.log(`⚠️ Audio transcription failed for [${idx}]: ${String(err).slice(0, 100)}`);
    return "";
  }
}

async function describeImage(
  base64data: string,
  mimeType: ImageContent["mediaType"],
  idx: number
): Promise<string> {
  const cacheFile = path.join(TASK_DIR, `image_desc_${idx}.txt`);
  if (existsSync(cacheFile)) {
    console.log(`💾 Cache hit: ${cacheFile}`);
    return readFileSync(cacheFile, "utf-8");
  }

  console.log(`🔧 Describing image ${idx} via vision model (claude-opus-4-5)...`);
  const blocks: ContentBlock[] = [
    { type: "image", mediaType: mimeType, data: base64data },
    {
      type: "text",
      text: "Extract ALL text, numbers, names, codes, phone numbers, areas, and any factual data visible in this image. If it contains a document, map, or table – transcribe it fully.",
    },
  ];

  const description = await complete(
    "You are a precise data extraction assistant. Transcribe every piece of visible information from the image, especially names, numbers, phone numbers, and location data.",
    blocks,
    "claude-opus-4-5"
  );

  writeFileSync(cacheFile, description, "utf-8");
  console.log(`💾 Saved image description: ${cacheFile}`);
  return description;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  console.log(`📋 Task: ${TASK} — Intercept and analyse resistance radio comms`);

  // ── Step 1: Start session ──────────────────────────────────────────────────

  const startCacheFile = path.join(TASK_DIR, "session_start.json");
  if (!existsSync(startCacheFile)) {
    console.log(`📥 Starting monitoring session...`);
    const startResp = await callHub({ action: "start" });
    writeFileSync(startCacheFile, JSON.stringify(startResp, null, 2), "utf-8");
    console.log(`💾 Session started:`, JSON.stringify(startResp));
  } else {
    console.log(`💾 Cache hit: ${startCacheFile}`);
  }

  // ── Step 2: Listen loop ────────────────────────────────────────────────────

  const corpus: string[] = [];
  let idx = 0;

  while (idx < MAX_LISTEN_ROUNDS) {
    const cacheFile = path.join(TASK_DIR, `listen_${String(idx).padStart(3, "0")}.json`);
    let resp: ListenResponse;

    if (existsSync(cacheFile)) {
      console.log(`💾 Cache hit: ${cacheFile}`);
      resp = JSON.parse(readFileSync(cacheFile, "utf-8")) as ListenResponse;
    } else {
      console.log(`📥 Listening (round ${idx + 1})...`);
      resp = (await callHub({ action: "listen" })) as ListenResponse;
      writeFileSync(cacheFile, JSON.stringify(resp, null, 2), "utf-8");
      console.log(`💾 Saved: ${cacheFile}`);
    }

    // Detect end-of-stream
    if (resp.code !== 100) {
      console.log(`✅ End-of-stream (code=${resp.code}): ${resp.message}`);
      if (resp.message && resp.message.length > 5) {
        corpus.push(`[HUB FINAL]: ${resp.message}`);
      }
      break;
    }

    // ── Route the signal ──

    if (resp.transcription) {
      const text = resp.transcription.trim();
      if (text.length > 15) {
        console.log(`📝 Transcription [${idx}]: ${text.slice(0, 100)}...`);
        corpus.push(`[RADIO TRANSCRIPTION ${idx}]:\n${text}`);
      } else {
        console.log(`⚠️ Short transcription (noise), skipping.`);
      }
    } else if (resp.attachment && resp.meta) {
      const mime = parseMime(resp.meta);
      const size = resp.filesize ?? resp.attachment.length;
      console.log(`📎 Attachment [${idx}]: mime=${mime}, size≈${size}`);

      if (isImageMime(mime)) {
        const desc = await describeImage(resp.attachment, mime, idx);
        corpus.push(`[IMAGE DATA ${idx}]:\n${desc}`);
      } else if (mime === "audio/mpeg" || mime.startsWith("audio/")) {
        const transcript = await transcribeAudio(resp.attachment, idx);
        if (transcript) corpus.push(`[AUDIO TRANSCRIPT ${idx}]:\n${transcript}`);
      } else if (isTextMime(mime)) {
        try {
          const decoded = Buffer.from(resp.attachment, "base64").toString("utf-8");
          console.log(`📄 Text attachment decoded (${decoded.length} chars)`);
          corpus.push(`[TEXT ATTACHMENT ${idx} (${mime})]:\n${decoded}`);
        } catch {
          console.log(`⚠️ Failed to decode text attachment ${idx}`);
        }
      } else {
        // Unknown MIME – attempt UTF-8 decode; skip if binary
        try {
          const decoded = Buffer.from(resp.attachment, "base64").toString("utf-8");
          if (hasBinaryCharacters(decoded)) {
            console.log(`⚠️ Binary content (${mime}), skipping.`);
          } else {
            console.log(`📄 Unknown MIME but readable text, adding to corpus.`);
            corpus.push(`[DECODED ATTACHMENT ${idx} (${mime})]:\n${decoded}`);
          }
        } catch {
          console.log(`⚠️ Cannot decode attachment ${idx}, skipping.`);
        }
      }
    } else {
      console.log(`⚠️ No content – noise. Message: ${resp.message}`);
    }

    idx++;
  }

  console.log(`\n📋 Corpus: ${corpus.length} items from ${idx} signals`);

  if (corpus.length === 0) {
    throw new Error("❌ Corpus is empty – nothing to analyse.");
  }

  // ── Step 3: LLM synthesis ──────────────────────────────────────────────────

  const analysisCacheFile = path.join(TASK_DIR, "analysis.json");
  let report: FinalReport;

  if (existsSync(analysisCacheFile)) {
    console.log(`💾 Cache hit: ${analysisCacheFile}`);
    report = JSON.parse(readFileSync(analysisCacheFile, "utf-8")) as FinalReport;
  } else {
    const corpusText = corpus.join("\n\n---\n\n");
    console.log(`🔧 Analysing ${corpusText.length} chars with LLM...`);

    report = await completeStructured<FinalReport>(
      `You are analysing intercepted radio communications from a resistance movement.
Extract specific factual data about the hidden city called "Syjon".
- cityArea must be rounded to exactly 2 decimal places (e.g. "12.34")
- warehousesCount must be an integer
- phoneNumber: digits only, no spaces or dashes
- cityName: the real geographic name of the city called Syjon by the resistance`,
      `Here is all intercepted radio material:\n\n${corpusText}\n\nExtract all required data about the city called "Syjon".`,
      "extract_city_data",
      "Extract data about the hidden city called Syjon from intercepted radio communications",
      {
        type: "object",
        properties: {
          cityName: {
            type: "string",
            description: "The real name of the city that the resistance calls 'Syjon'",
          },
          cityArea: {
            type: "string",
            description: "Area of the city rounded to exactly 2 decimal places, e.g. '12.34'",
          },
          warehousesCount: {
            type: "integer",
            description: "Total number of warehouses in Syjon",
          },
          phoneNumber: {
            type: "string",
            description: "Phone number of the contact person from Syjon (digits only)",
          },
        },
        required: ["cityName", "cityArea", "warehousesCount", "phoneNumber"],
      },
      "claude-sonnet-4-20250514"
    );

    writeFileSync(analysisCacheFile, JSON.stringify(report, null, 2), "utf-8");
    console.log(`💾 Saved analysis: ${analysisCacheFile}`);
  }

  console.log(`\n📋 Extracted city data:`);
  console.log(`  cityName:        ${report.cityName}`);
  console.log(`  cityArea:        ${report.cityArea}`);
  console.log(`  warehousesCount: ${report.warehousesCount}`);
  console.log(`  phoneNumber:     ${report.phoneNumber}`);

  // ── Step 4: Transmit final report ─────────────────────────────────────────

  console.log(`\n📤 Transmitting final report...`);
  const transmitResp = await callHub({
    action: "transmit",
    cityName: report.cityName,
    cityArea: report.cityArea,
    warehousesCount: report.warehousesCount,
    phoneNumber: report.phoneNumber,
  });

  console.log(`📨 Hub response:`, JSON.stringify(transmitResp, null, 2));

  const respObj = transmitResp as { flag?: string; code?: number; message?: string };
  if (respObj.flag) {
    console.log(`\n🚩 FLAG: ${respObj.flag}`);
  }
}

run().catch(console.error);
