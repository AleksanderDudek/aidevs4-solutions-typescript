import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { callHubApi, submitAnswer } from "../lib/hub.js";

const TASK = "firmware";
const TASK_DIR = path.resolve("data", "s03e02");

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Shell helper ─────────────────────────────────────────────────────────────

interface ShellResponse {
  code: number;
  message: string;
  data?: string | string[];
  path?: string;
}

async function shell(cmd: string, apiKey: string): Promise<ShellResponse> {
  console.log(`🔧 $ ${cmd}`);
  const res = await callHubApi<ShellResponse>("/api/shell", { cmd }, apiKey);
  console.log(`↩  [${res.code}] ${typeof res.data === "string" ? res.data.slice(0, 200) : res.message}`);
  return res;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log("📋 Task: firmware — fix and run ECCS firmware on virtual machine");

  // 1. Read password
  const passRes = await shell("cat /home/operator/notes/pass.txt", apiKey);
  const password = typeof passRes.data === "string" ? passRes.data.trim() : "";
  console.log(`🔑 Password: ${password}`);

  // 2. Remove lock file if it exists
  await shell("rm /opt/firmware/cooler/cooler-is-blocked.lock", apiKey);

  // 3. Fix settings.ini:
  //    - Uncomment SAFETY_CHECK (line 2)
  //    - Disable test_mode (line 6)
  //    - Enable cooling (line 10)
  await shell("editline /opt/firmware/cooler/settings.ini 2 SAFETY_CHECK=pass", apiKey);
  await shell("editline /opt/firmware/cooler/settings.ini 6 enabled=false", apiKey);
  await shell("editline /opt/firmware/cooler/settings.ini 10 enabled=true", apiKey);

  // 4. Verify settings
  const settingsRes = await shell("cat /opt/firmware/cooler/settings.ini", apiKey);
  console.log("📋 Settings:", settingsRes.data);

  // 5. Run the firmware binary
  const runRes = await shell(`/opt/firmware/cooler/cooler.bin ${password}`, apiKey);
  const output = typeof runRes.data === "string" ? runRes.data : "";

  // 6. Extract ECCS confirmation code
  const match = output.match(/ECCS-[a-f0-9]+/);
  if (!match) throw new Error(`❌ No ECCS code found in output: ${output}`);

  const confirmation = match[0];
  console.log(`✅ Confirmation code: ${confirmation}`);

  // Cache the result
  writeFileSync(path.join(TASK_DIR, "confirmation.txt"), confirmation, "utf-8");

  // 7. Submit answer
  const result = await submitAnswer(TASK, { confirmation }, apiKey);
  console.log("📨 Result:", result);
}

run().catch(console.error);
