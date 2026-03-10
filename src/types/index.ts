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

export interface PersonTagged extends Omit<PersonRaw, "job"> {
  tags: string[];
}

export interface TaggingResult {
  index: number;
  tags: string[];
}

export interface TaggingResponse {
  results: TaggingResult[];
}
