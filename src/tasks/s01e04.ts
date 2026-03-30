/**
 * S01E04 – SendIt
 *
 * Fill in an SPK (System Przesyłek Konduktorskich) transport declaration
 * and submit it to the hub.
 *
 * Key data:
 *  - Sender:       450202122
 *  - Origin:       Gdańsk
 *  - Destination:  Żarnowiec
 *  - Weight:       2800 kg
 *  - Budget:       0 PP (system-funded)
 *  - Contents:     kasety z paliwem do reaktora
 *  - Special notes: none
 */

import "dotenv/config";
import path from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { getProvider, type ContentBlock } from "../lib/llm/index.js";
import { submitAnswer } from "../lib/hub.js";

const TASK = "sendit";
const TASK_DIR = path.resolve("data", "s01e04");
const ROUTES_CACHE = path.join(TASK_DIR, "trasy-wylaczone-vision.txt");
const DECLARATION_CACHE = path.join(TASK_DIR, "declaration.txt");

const apiKey = process.env.AG3NTS_API_KEY!;
const llm = getProvider();

if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });

// ─── Step 1: Fetch and analyse the excluded routes image ─────────────────────

async function analyseExcludedRoutesImage(): Promise<string> {
  if (existsSync(ROUTES_CACHE)) {
    console.log("💾 Cache hit – reading vision result from disk:", ROUTES_CACHE);
    return readFileSync(ROUTES_CACHE, "utf-8");
  }

  console.log("🖼️  Downloading trasy-wylaczone.png …");
  const hubBase = process.env.HUB_BASE_URL;
  if (!hubBase) throw new Error("Missing HUB_BASE_URL in .env");
  const imgRes = await fetch(`${hubBase}/dane/doc/trasy-wylaczone.png`);
  const buf = await imgRes.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");

  console.log("🔍 Analysing image with vision …");
  const content: ContentBlock[] = [
    { type: "image", mediaType: "image/png", data: b64 },
    {
      type: "text",
      text: `To jest obraz z dokumentacji systemu SPK. Zawiera listę lub tabelę TRAS WYŁĄCZONYCH Z UŻYTKU.
Przepisz dokładnie całą zawartość obrazu - każdy wiersz tabeli z kodem trasy, przebiegiem i statusem.
Zwróć szczególną uwagę na wszelkie trasy zawierające "Żarnowiec" lub "Gdańsk".
Odpowiedz w formacie: każda trasa w osobnej linii.`,
    },
  ];
  const result = await llm.complete("", content, { model: "claude-opus-4-5", maxTokens: 2048 });
  writeFileSync(ROUTES_CACHE, result, "utf-8");
  console.log("💾 Saved vision result to:", ROUTES_CACHE);
  console.log("📋 Excluded routes from image:\n", result);
  return result;
}

// ─── Step 2: Use Claude to fill in the declaration ───────────────────────────

async function buildDeclaration(excludedRoutesText: string): Promise<string> {
  if (existsSync(DECLARATION_CACHE)) {
    console.log("💾 Cache hit – reading declaration from disk:", DECLARATION_CACHE);
    return readFileSync(DECLARATION_CACHE, "utf-8");
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const declarationTemplate = `SYSTEM PRZESYŁEK KONDUKTORSKICH - DEKLARACJA ZAWARTOŚCI
======================================================
DATA: [YYYY-MM-DD]
PUNKT NADAWCZY: [miasto nadania]
------------------------------------------------------
NADAWCA: [identyfikator płatnika]
PUNKT DOCELOWY: [miasto docelowe]
TRASA: [kod trasy]
------------------------------------------------------
KATEGORIA PRZESYŁKI: A/B/C/D/E
------------------------------------------------------
OPIS ZAWARTOŚCI (max 200 znaków): [...]
------------------------------------------------------
DEKLAROWANA MASA (kg): [...]
------------------------------------------------------
WDP: [liczba]
------------------------------------------------------
UWAGI SPECJALNE: [...]
------------------------------------------------------
KWOTA DO ZAPŁATY: [PP]
------------------------------------------------------
OŚWIADCZAM, ŻE PODANE INFORMACJE SĄ PRAWDZIWE.
BIORĘ NA SIEBIE KONSEKWENCJĘ ZA FAŁSZYWE OŚWIADCZENIE.
======================================================`;

  const rulesContext = `
ZASADY SPK (skrót):
- Kategorie przesyłek: A-Strategiczna (0 PP), B-Medyczna (0 PP), C-Żywnościowa (2 PP), D-Gospodarcza (5 PP), E-Osobista (10 PP)
- Kategoria A i B: opłata bazowa = 0 PP, pokrywana przez System. Przesyłki kat. A i B są ZWOLNIONE Z OPŁAT.
- Dodatkowe wagony: standardowy skład = 2 wagony × 500 kg = 1000 kg. Dodatkowe wagony: 55 PP/wagon. Dla przesyłek Strategicznych (A) i Medycznych (B): opłata za dodatkowe wagony NIE jest naliczana.
- WDP = Wagony Dodatkowe Płatne (liczba dodatkowych wagonów PŁATNYCH). Dla kat. A/B = 0 (bo nie są płatne).
- Opłata trasowa: w obrębie jednego regionu = 1 PP/100 km, dla kategorii A/B = bezpłatna (ogólne zwolnienie z opłat).
- Trasy do Żarnowca: wyłączone z użytku (Dyrektywa 7.7), ALE mogą być używane przez przesyłki kat. A i B.
- Gdańsk = Węzeł Regionalny Północny (WR-Północ).
- UWAGI SPECJALNE: "brak" lub pozostaw puste.

WYKLUCZONE TRASY (z obrazu):
${excludedRoutesText}

DANE PRZESYŁKI:
- Nadawca (identyfikator): 450202122
- Punkt nadawczy: Gdańsk
- Punkt docelowy: Żarnowiec
- Waga: 2800 kg
- Kategoria: A (kasety z paliwem do reaktora = materiały strategiczne dla elektrowni)
- Budżet: 0 PP
- Uwagi specjalne: BRAK (nie dodawaj żadnych uwag specjalnych)
- Data: ${today}
`;

  const prompt = `${rulesContext}

Na podstawie powyższych zasad i danych, wypełnij DOKŁADNIE poniższy wzór deklaracji.
Wzór (zmień tylko pola w nawiasach kwadratowych):

${declarationTemplate}

Zasady wypełnienia:
1. DATA: podaj ${today}
2. PUNKT NADAWCZY: Gdańsk
3. NADAWCA: 450202122
4. PUNKT DOCELOWY: Żarnowiec
5. TRASA: użyj kodu trasy Gdańsk→Żarnowiec z listy tras wyłączonych (bo ta trasa jest wyłączona ale dozwolona dla kat. A)
6. KATEGORIA PRZESYŁKI: A
7. OPIS ZAWARTOŚCI: kasety z paliwem do reaktora (nic więcej, nie dodawaj szczegółów)
8. DEKLAROWANA MASA (kg): 2800
9. WDP: 4 (standardowy skład = 2 wagony × 500 kg = 1000 kg. Na 2800 kg potrzeba 4 dodatkowych wagonów: ceil((2800-1000)/500) = 4. Wagony są wymagane fizycznie, mimo że dla kat. A nie są płatne.)
10. UWAGI SPECJALNE: brak (NAPISZ DOSŁOWNIE "brak")
11. KWOTA DO ZAPŁATY: 0 PP (kategoria A jest w całości zwolniona z opłat)

WAŻNE: Zwróć TYLKO sam tekst deklaracji, bez żadnych wyjaśnień, komentarzy ani markdown.`;

  console.log("✍️  Asking Claude to fill in the declaration …");
  const declaration = await llm.complete("", prompt, { model: "claude-opus-4-5", maxTokens: 1024 });
  const trimmed = declaration.trim();
  writeFileSync(DECLARATION_CACHE, trimmed, "utf-8");
  console.log("💾 Saved declaration to:", DECLARATION_CACHE);
  console.log("\n📄 DECLARATION:\n" + trimmed);
  return trimmed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const excludedRoutesText = await analyseExcludedRoutesImage();
  const declaration = await buildDeclaration(excludedRoutesText);

  console.log("\n📤 Submitting to hub …");
  const result = await submitAnswer<{ declaration: string }>(
    TASK,
    { declaration },
    apiKey
  );
  console.log("📨 Hub response:", result);
}

run().catch(console.error);
