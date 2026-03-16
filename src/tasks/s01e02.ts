/**
 * S01E02 – FindHim
 *
 * Using suspects from S01E01, find who was seen near a nuclear power plant.
 * Reports that person's access level and the power plant code.
 *
 * Approach: Agent with Function Calling (tool_use).
 * The LLM orchestrates calls to /api/location and /api/accesslevel,
 * computes geographic proximity using Haversine, and submits the answer.
 */

import "dotenv/config";
import path from "path";
import { fetchHubFileCached, callHubApi, submitAnswer } from "../lib/hub.js";
import { runAgent, type AgentTool } from "../lib/llm.js";
import type { Suspect, PowerPlant, LocationResponse, AccessLevelResponse, FindHimAnswer } from "../types/index.js";

const TASK = "findhim";
const TASK_DIR = path.resolve("data", "s01e02");

// ─── Suspects from S01E01 ─────────────────────────────────────────────────────

const SUSPECTS: Suspect[] = [
  { name: "Cezary",   surname: "Żurek",      birthYear: 1987 },
  { name: "Jacek",    surname: "Nowak",       birthYear: 1991 },
  { name: "Oskar",    surname: "Sieradzki",   birthYear: 1993 },
  { name: "Wojciech", surname: "Bielik",      birthYear: 1986 },
  { name: "Wacław",   surname: "Jasiński",    birthYear: 1986 },
];

// ─── Haversine formula ────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ─── Power plant JSON normalisation ──────────────────────────────────────────

// Approximate city coordinates (plants JSON has no lat/lng)
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  "Zabrze":                  { lat: 50.326, lng: 18.786 },
  "Piotrków Trybunalski":    { lat: 51.403, lng: 19.701 },
  "Grudziądz":               { lat: 53.485, lng: 18.754 },
  "Tczew":                   { lat: 53.777, lng: 18.781 },
  "Radom":                   { lat: 51.403, lng: 21.146 },
  "Chelmno":                 { lat: 53.351, lng: 18.434 },
  "Chełmno":                 { lat: 53.351, lng: 18.434 },
  "Żarnowiec":               { lat: 54.617, lng: 18.121 },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalisePlants(raw: any): PowerPlant[] {
  // Actual JSON shape: { power_plants: { "CityName": { code, is_active, power } } }
  const dict: Record<string, Record<string, unknown>> =
    raw.power_plants ?? (typeof raw === "object" && !Array.isArray(raw) ? raw : {});

  const plants: PowerPlant[] = [];
  for (const [cityName, info] of Object.entries(dict)) {
    const coords = CITY_COORDS[cityName];
    if (!coords) {
      console.warn(`⚠️  No coordinates for city: "${cityName}" – skipping`);
      continue;
    }
    plants.push({
      code: String((info as Record<string, unknown>).code ?? ""),
      name: cityName,
      lat: coords.lat,
      lng: coords.lng,
    });
  }
  return plants;
}

// ─── Tool builders ────────────────────────────────────────────────────────────

function buildTools(apiKey: string, plants: PowerPlant[]): AgentTool[] {
  return [
    // ── 1. check_proximity_to_plants ──────────────────────────────────────
    {
      definition: {
        name: "check_proximity_to_plants",
        description:
          "Fetches the recorded locations for a suspect and returns the closest nuclear power plant and its distance in km. Call this for every suspect.",
        input_schema: {
          type: "object" as const,
          properties: {
            name:    { type: "string", description: "First name of the suspect" },
            surname: { type: "string", description: "Surname of the suspect" },
          },
          required: ["name", "surname"],
        },
      },
      handler: async ({ name, surname }) => {
        const data = await callHubApi<LocationResponse>(
          "/api/location",
          { name, surname },
          apiKey
        );
        console.log(`   Raw location response for ${name} ${surname}:`, JSON.stringify(data).slice(0, 300));

        // Normalise location list – hub may wrap in different keys
        const rawPoints: unknown[] = Array.isArray(data)
          ? data
          : (data.locations ?? data.coords ?? data.coordinates ?? data.data ?? []) as unknown[];

        if (rawPoints.length === 0) {
          return { error: `No location data found for ${name} ${surname}` };
        }

        let bestPlant: PowerPlant | null = null;
        let bestDist = Infinity;
        let bestPoint: { lat: number; lng: number } | null = null;

        for (const point of rawPoints) {
          const p = point as Record<string, unknown>;
          const pLat = Number(p.lat ?? p.latitude);
          const pLng = Number(p.lng ?? p.lon ?? p.longitude);
          if (isNaN(pLat) || isNaN(pLng)) continue;

          for (const plant of plants) {
            const dist = haversineKm(pLat, pLng, plant.lat, plant.lng);
            if (dist < bestDist) {
              bestDist = dist;
              bestPlant = plant;
              bestPoint = { lat: pLat, lng: pLng };
            }
          }
        }

        if (!bestPlant) {
          return { error: `Could not compute distances for ${name} ${surname}` };
        }

        return {
          name,
          surname,
          nearest_plant_code: bestPlant.code,
          nearest_plant_name: bestPlant.name,
          min_distance_km: Math.round(bestDist * 100) / 100,
          seen_at: bestPoint,
        };
      },
    },

    // ── 2. get_access_level ───────────────────────────────────────────────
    {
      definition: {
        name: "get_access_level",
        description:
          "Returns the system access level for a suspect. Requires their birth year.",
        input_schema: {
          type: "object" as const,
          properties: {
            name:      { type: "string",  description: "First name of the suspect" },
            surname:   { type: "string",  description: "Surname of the suspect" },
            birthYear: { type: "number",  description: "Birth year (e.g. 1987)" },
          },
          required: ["name", "surname", "birthYear"],
        },
      },
      handler: async ({ name, surname, birthYear }) => {
        const data = await callHubApi<AccessLevelResponse>(
          "/api/accesslevel",
          { name, surname, birthYear: Number(birthYear) },
          apiKey
        );
        console.log(`   Raw access level response:`, data);
        const level = data.accessLevel ?? data.level ?? data.access_level;
        return { accessLevel: level };
      },
    },

    // ── 3. submit_answer ──────────────────────────────────────────────────
    {
      definition: {
        name: "submit_answer",
        description:
          "Submits the final answer to the hub. Call this once you have identified the suspect near a power plant and their access level.",
        input_schema: {
          type: "object" as const,
          properties: {
            name:        { type: "string",  description: "First name of the suspect" },
            surname:     { type: "string",  description: "Surname of the suspect" },
            accessLevel: { type: "number",  description: "Access level from get_access_level" },
            powerPlant:  { type: "string",  description: "Power plant code (e.g. PWR1234PL)" },
          },
          required: ["name", "surname", "accessLevel", "powerPlant"],
        },
      },
      handler: async ({ name, surname, accessLevel, powerPlant }) => {
        const answer: FindHimAnswer = {
          name: name as string,
          surname: surname as string,
          accessLevel: Number(accessLevel),
          powerPlant: powerPlant as string,
        };
        const result = await submitAnswer(TASK, answer, apiKey);
        return result;
      },
    },
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log(`\n📋 Task: ${TASK}`);
  console.log(`   Suspects: ${SUSPECTS.map((s) => `${s.name} ${s.surname}`).join(", ")}`);

  // 1. Load (and cache) power plant locations
  const plantsRaw = await fetchHubFileCached("findhim_locations.json", apiKey, TASK_DIR);
  const plants = normalisePlants(JSON.parse(plantsRaw));
  console.log(`\n⚛️  Loaded ${plants.length} power plants:`);
  plants.forEach((p) => console.log(`   ${p.code}: ${p.name} (${p.lat}, ${p.lng})`));

  // 2. Build tools with closures over apiKey + plants
  const tools = buildTools(apiKey, plants);

  // 3. System prompt – give the agent all context up front
  const suspectsList = SUSPECTS.map(
    (s) => `- ${s.name} ${s.surname} (born ${s.birthYear})`
  ).join("\n");

  const systemPrompt = `You are an investigator agent.
Your goal: identify which ONE of the 5 suspects below was seen near a nuclear power plant, determine their access level, and submit the answer.

Suspects:
${suspectsList}

Instructions:
1. Call check_proximity_to_plants for EACH suspect (all 5).
2. After getting all proximity results, identify the suspect with the SMALLEST min_distance_km.
3. Call get_access_level for that suspect (use their birthYear).
4. Call submit_answer with name, surname, accessLevel, and powerPlant code.
5. You are done when submit_answer has been called.

Be systematic. Do not skip any suspect.`;

  // 4. Run agent loop (max 20 iterations – safety guard)
  await runAgent(
    systemPrompt,
    "Start the investigation. Check all suspects and find who was near a nuclear power plant.",
    tools,
    20
  );
}

run().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
