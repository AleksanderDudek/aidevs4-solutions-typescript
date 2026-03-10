# AI_devs 4 – Rozwiązania zadań

Projekt TypeScript z modularną strukturą do rozwiązywania kolejnych zadań kursu AI_devs 4.

## Setup

```bash
npm install
cp .env.example .env
# Uzupełnij .env swoimi kluczami API
```

## Konfiguracja `.env`

```env
ANTHROPIC_API_KEY=sk-ant-...       # Klucz z console.anthropic.com
AG3NTS_API_KEY=twój-klucz          # Klucz z REDACTED_HUB_URL
```

## Uruchamianie zadań

```bash
# Konkretne zadanie bezpośrednio:
npm run s01e01

# Lub przez centralny runner:
npm run task s01e01
npm run task s01e02   # kolejne zadania
```

## Struktura projektu

```
src/
├── index.ts           # Centralny runner (npm run task <nazwa>)
├── lib/
│   ├── hub.ts         # Klient Hub API (fetchHubFile, submitAnswer)
│   └── llm.ts         # Wrapper Anthropic (complete, completeStructured)
├── types/
│   └── index.ts       # Wspólne typy TypeScript
└── tasks/
    ├── s01e01.ts      # Zadanie 1: People
    └── s01e02.ts      # (kolejne zadania dodawaj tutaj)
```

## Dodawanie nowych zadań

1. Utwórz plik `src/tasks/s0XeYY.ts`
2. Wyeksportuj funkcję `run()`:

```typescript
import "dotenv/config";
import { fetchHubFile, submitAnswer } from "../lib/hub.js";
import { complete, completeStructured } from "../lib/llm.js";

export async function run(): Promise<void> {
  const apiKey = process.env.AG3NTS_API_KEY!;
  // ... logika zadania ...
  await submitAnswer("nazwa-zadania", answer, apiKey);
}

run().catch(console.error);
```

3. Opcjonalnie dodaj skrypt w `package.json`:
```json
"s0XeYY": "tsx src/tasks/s0XeYY.ts"
```
