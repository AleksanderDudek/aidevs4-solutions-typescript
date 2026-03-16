// ─── Hub API ────────────────────────────────────────────────────────────────

export interface HubRequest<T = unknown> {
  apikey: string;
  task: string;
  answer: T;
}

export interface HubResponse {
  code: number;
  message: string;
  flag?: string;
}

// ─── S01E01 – People ────────────────────────────────────────────────────────

export interface PersonRaw {
  name: string;
  surname: string;
  gender: string;
  birthDate: string;   // e.g. "1975-07-07"
  birthPlace: string;  // city of birth
  birthCountry: string;
  job: string;
}

export interface PersonTagged {
  name: string;
  surname: string;
  gender: string;
  born: number;
  city: string;
  tags: string[];
}

export interface TaggingResult {
  index: number;
  tags: string[];
}

export interface TaggingResponse {
  results: TaggingResult[];
}

// ─── S01E02 – FindHim ────────────────────────────────────────────────────────

export interface Suspect {
  name: string;
  surname: string;
  birthYear: number;
}

export interface PowerPlant {
  code: string;
  name: string;
  lat: number;
  lng: number;
}

export interface LocationResponse {
  locations?: Array<{ lat: number; lng: number }>;
  // Hub may return raw array or nested object – handled in code
  [key: string]: unknown;
}

export interface AccessLevelResponse {
  accessLevel?: number;
  level?: number;
  [key: string]: unknown;
}

export interface FindHimAnswer {
  name: string;
  surname: string;
  accessLevel: number;
  powerPlant: string;
}
