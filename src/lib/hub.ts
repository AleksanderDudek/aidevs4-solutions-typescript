import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { HubRequest, HubResponse } from "../types/index.js";

const HUB_BASE = "https://REDACTED_HUB_URL";

/**
 * Sends an answer to the hub and returns the response.
 * Reusable across all tasks.
 */
export async function submitAnswer<T>(
  task: string,
  answer: T,
  apiKey: string
): Promise<HubResponse> {
  const body: HubRequest<T> = { apikey: apiKey, task, answer };

  console.log(`\n📤 Sending answer for task "${task}"...`);

  const res = await fetch(`${HUB_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Hub returned HTTP ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as HubResponse;

  if (data.flag) {
    console.log(`\n🚩 FLAG RECEIVED: ${data.flag}`);
  } else {
    console.log(`\n📨 Hub response:`, data);
  }

  return data;
}

/**
 * Fetches a file from the hub data endpoint.
 */
export async function fetchHubFile(
  path: string,
  apiKey: string
): Promise<string> {
  const url = `${HUB_BASE}/data/${apiKey}/${path}`;
  console.log(`\n📥 Fetching: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }

  return res.text();
}

/**
 * Like fetchHubFile but checks a local cache directory first.
 * If the file is not cached yet, downloads it, saves it, and returns the content.
 * cacheDir should be a task-specific folder, e.g. "data/s01e01".
 */
export async function fetchHubFileCached(
  filePath: string,
  apiKey: string,
  cacheDir: string
): Promise<string> {
  const localPath = path.join(cacheDir, filePath);

  if (existsSync(localPath)) {
    console.log(`\n💾 Cache hit – reading from disk: ${localPath}`);
    return readFileSync(localPath, "utf-8");
  }

  const content = await fetchHubFile(filePath, apiKey);

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(localPath, content, "utf-8");
  console.log(`💾 Saved to cache: ${localPath}`);

  return content;
}
