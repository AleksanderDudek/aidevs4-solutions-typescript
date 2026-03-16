/**
 * S01E01 – People
 *
 * 1. Fetch people.csv from the hub
 * 2. Filter by: gender=M, born 1986-2006, city=Grudziądz
 * 3. Tag jobs with LLM (Structured Output / tool_use)
 * 4. Keep only people with tag "transport"
 * 5. Submit to hub
 */

import "dotenv/config";
import path from "path";
import Papa from "papaparse";
import { fetchHubFileCached, submitAnswer } from "../lib/hub.js";
import { completeStructured } from "../lib/llm/index.js";
import type { PersonRaw, PersonTagged, TaggingResponse } from "../types/index.js";

const TASK_DIR = path.resolve("data", "s01e01");

const TASK = "people";
const CURRENT_YEAR = 2026;
const MIN_AGE = 20;
const MAX_AGE = 40;

const TAGS = [
  "IT",
  "transport",
  "edukacja",
  "medycyna",
  "praca z ludźmi",
  "praca z pojazdami",
  "praca fizyczna",
] as const;

const TAG_DESCRIPTIONS: Record<string, string> = {
  IT: "Programowanie, systemy informatyczne, sieci, cyberbezpieczeństwo, wsparcie techniczne",
  transport:
    "Kierowcy, spedytorzy, logistycy, kurierzy, operatorzy pojazdów, zarządzanie flotą",
  edukacja: "Nauczyciele, wykładowcy, trenerzy, instruktorzy, pedagodzy",
  medycyna:
    "Lekarze, pielęgniarki, farmaceuci, ratownicy medyczni, pracownicy służby zdrowia",
  "praca z ludźmi":
    "Obsługa klienta, HR, sprzedaż, doradztwo, praca socjalna, recepcja",
  "praca z pojazdami":
    "Mechanicy, serwisanci, operatorzy maszyn, kierowcy (nakłada się z transportem)",
  "praca fizyczna":
    "Budowlańcy, magazynierzy, pracownicy produkcji, rolnicy, ochrona fizyczna",
};

// ─── 1. Fetch & parse CSV ────────────────────────────────────────────────────

async function fetchPeople(apiKey: string): Promise<PersonRaw[]> {
  const csv = await fetchHubFileCached("people.csv", apiKey, TASK_DIR);

  const parsed = Papa.parse<PersonRaw>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  if (parsed.errors.length > 0) {
    console.warn("CSV parse warnings:", parsed.errors);
  }

  const data = parsed.data;
  console.log(`✅ Fetched ${data.length} people from CSV`);

  if (data.length > 0) {
    console.log(`   Columns: ${Object.keys(data[0]).join(", ")}`);
    console.log(`   Sample row[0]:`, data[0]);
    console.log(`   Sample row[1]:`, data[1]);
  }

  return data;
}

// ─── 2. Filter ───────────────────────────────────────────────────────────────

function filterPeople(people: PersonRaw[]): PersonRaw[] {
  // Debug: gender breakdown
  const genderCounts: Record<string, number> = {};
  for (const p of people) {
    const g = String(p.gender ?? "?");
    genderCounts[g] = (genderCounts[g] ?? 0) + 1;
  }
  console.log(`   Gender breakdown:`, genderCounts);

  // Debug: age range breakdown
  const inAgeRange = people.filter((p) => {
    const year = Number(p.birthDate?.slice(0, 4));
    const age = CURRENT_YEAR - year;
    return age >= MIN_AGE && age <= MAX_AGE;
  });
  console.log(`   People in age range ${MIN_AGE}-${MAX_AGE}: ${inAgeRange.length}`);

  // Debug: cities containing "grudz" (case-insensitive)
  const grudziadzLike = people.filter((p) =>
    p.birthPlace?.toLowerCase().includes("grudz")
  );
  const uniqueGrudziadzCities = [...new Set(grudziadzLike.map((p) => `"${p.birthPlace}"`))];
  console.log(`   Cities matching "grudz*" (${grudziadzLike.length} people): ${uniqueGrudziadzCities.join(", ") || "(none)"}`);

  // Debug: show a few unique city values from the data
  const uniqueCities = [...new Set(people.map((p) => p.birthPlace))].slice(0, 20);
  console.log(`   Sample cities (first 20 unique): ${uniqueCities.join(", ")}`);

  const filtered = people.filter((p) => {
    const year = Number(p.birthDate?.slice(0, 4));
    const age = CURRENT_YEAR - year;
    return (
      p.gender === "M" &&
      age >= MIN_AGE &&
      age <= MAX_AGE &&
      p.birthPlace?.trim().toLowerCase() === "grudziądz"
    );
  });

  console.log(
    `✅ After filtering (M, age ${MIN_AGE}-${MAX_AGE}, Grudziądz): ${filtered.length} people`
  );
  return filtered;
}

// ─── 3. Tag jobs with LLM ────────────────────────────────────────────────────

async function tagJobs(people: PersonRaw[]): Promise<Map<number, string[]>> {
  const tagDescList = TAGS.map((t) => `- "${t}": ${TAG_DESCRIPTIONS[t]}`).join(
    "\n"
  );

  const systemPrompt = `Jesteś klasyfikatorem zawodów. Twoim zadaniem jest przypisanie tagów do opisów stanowisk pracy.

Dostępne tagi i ich znaczenie:
${tagDescList}

Zasady:
- Każde stanowisko może otrzymać 1 lub więcej tagów
- Kierowcy i spedytorzy powinni zawsze mieć tag "transport"
- Mechanicy pojazdów mają tag "praca z pojazdami" (i "praca fizyczna"), ale NIE "transport" jeśli nie jeżdżą pojazdami zawodowo
- Bądź precyzyjny – przypisuj tylko pasujące tagi`;

  // Build numbered list of jobs for batch processing
  const jobList = people
    .map((p, i) => `${i}: ${p.job}`)
    .join("\n");

  const userMessage = `Przypisz tagi do następujących stanowisk pracy (format: numer: opis):\n\n${jobList}`;

  console.log(`\n🤖 Tagging ${people.length} jobs with LLM (single batch)...`);
  if (people.length > 0) {
    console.log(`   First 5 jobs to tag:`);
    people.slice(0, 5).forEach((p, i) => console.log(`     [${i}] ${p.job}`));
  }

  const result = await completeStructured<TaggingResponse>(
    systemPrompt,
    userMessage,
    "tag_jobs",
    "Returns tags for each job description",
    {
      type: "object" as const,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number", description: "Row index from the input" },
              tags: {
                type: "array",
                items: {
                  type: "string",
                  enum: TAGS as unknown as string[],
                },
              },
            },
            required: ["index", "tags"],
          },
        },
      },
      required: ["results"],
    }
  );

  const tagMap = new Map<number, string[]>();
  for (const r of result.results) {
    tagMap.set(r.index, r.tags);
  }

  console.log(`✅ LLM tagged ${tagMap.size} jobs`);
  tagMap.forEach((tags, idx) => {
    console.log(`   [${idx}] ${people[idx]?.job} → [${tags.join(", ")}]`);
  });
  return tagMap;
}

// ─── 4. Assemble final answer ─────────────────────────────────────────────────

function buildAnswer(
  people: PersonRaw[],
  tagMap: Map<number, string[]>
): PersonTagged[] {
  const tagged: PersonTagged[] = people
    .map((p, i) => ({
      name: p.name,
      surname: p.surname,
      gender: p.gender,
      born: Number(p.birthDate?.slice(0, 4)),
      city: p.birthPlace,
      tags: tagMap.get(i) ?? [],
    }))
    .filter((p) => p.tags.includes("transport"));

  console.log(`✅ People with "transport" tag: ${tagged.length}`);
  tagged.forEach((p) =>
    console.log(
      `   - ${p.name} ${p.surname} (${p.born}), tags: ${p.tags.join(", ")}`
    )
  );

  return tagged;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY;
  if (!apiKey) throw new Error("Missing AG3NTS_API_KEY in .env");

  console.log(`\n📋 Task: ${TASK}`);
  console.log(`   Filter: gender=M, age ${MIN_AGE}-${MAX_AGE}, city=Grudziądz`);
  console.log(`   Current year: ${CURRENT_YEAR}\n`);

  const allPeople = await fetchPeople(apiKey);
  const filtered = filterPeople(allPeople);
  const tagMap = await tagJobs(filtered);
  const answer = buildAnswer(filtered, tagMap);

  console.log(`\n📤 Submitting ${answer.length} people as answer...`);
  console.log(`   Payload:`, JSON.stringify(answer));
  await submitAnswer(TASK, answer, apiKey);
}

// Allow running directly: tsx src/tasks/s01e01.ts
run().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
