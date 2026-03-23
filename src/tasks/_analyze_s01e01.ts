import "dotenv/config";
import Papa from "papaparse";
import { readFileSync } from "fs";

const csv = readFileSync("data/s01e01/people.csv", "utf-8");
const parsed = Papa.parse<any>(csv, { header: true, skipEmptyLines: true, dynamicTyping: true });
const people = parsed.data as any[];

console.log("Total people:", people.length);

// Focus: M-gender persons with feminine pronouns (Jej/Ona) in job description
// These are the RARE mismatches — the "anomaly"
const maleFeminePronouns = people.filter((p: any) => {
  if (p.gender !== "M") return false;
  const job: string = p.job || "";
  return job.includes("Jej ") || job.includes(" ona ") || job.startsWith("Ona ") ||
         job.includes("Jej zadaniem") || job.includes("Jej praca") || job.includes("Jej cel");
});
console.log("\n=== Male persons with FEMININE pronouns in job:", maleFeminePronouns.length);
maleFeminePronouns.forEach((p: any) => console.log(`${p.name} ${p.surname} [${p.gender}] ${p.birthDate} ${p.birthPlace}\n  -> ${p.job}\n`));

// Also check F-gender with masculine pronouns (probably many)
const femaleMascPronouns = people.filter((p: any) => {
  if (p.gender !== "F") return false;
  const job: string = p.job || "";
  return job.includes("Jego ") || job.includes(" on ") || job.startsWith("On ") ||
         job.includes("Jest odpowiedzialny") || job.includes("Jest mistrzem");
});
console.log("=== Female persons with masculine pronouns in job:", femaleMascPronouns.length);

// Non-Polish birthCountry
const nonPolish = people.filter((p: any) => p.birthCountry && p.birthCountry !== "Polska");
console.log("\n=== Non-'Polska' birthCountry:", nonPolish.length);
nonPolish.forEach((p: any) => console.log(p.name, p.surname, p.birthCountry, p.birthPlace));

// People from Grudziądz (all)
const grudziadz = people.filter((p: any) => p.birthPlace?.toLowerCase().includes("grudz"));
console.log("\n=== People from Grudziądz:", grudziadz.length);
grudziadz.forEach((p: any) => console.log(`${p.name} ${p.surname} [${p.gender}] ${p.birthDate} ${p.birthPlace}  job: ${p.job?.slice(0, 60)}...`));
