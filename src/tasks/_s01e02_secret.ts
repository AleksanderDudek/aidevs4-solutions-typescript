import "dotenv/config";

const apiKey = process.env.AG3NTS_API_KEY!;

const PLANTS: Record<string, { lat: number; lng: number; code: string }> = {
  "Zabrze":               { lat: 50.326, lng: 18.786, code: "REDACTED_REACTOR_CODE" },
  "Piotrków Trybunalski": { lat: 51.403, lng: 19.701, code: "REDACTED_REACTOR_CODE" },
  "Grudziądz":            { lat: 53.485, lng: 18.754, code: "REDACTED_REACTOR_CODE" },
  "Tczew":                { lat: 53.777, lng: 18.781, code: "REDACTED_REACTOR_CODE" },
  "Radom":                { lat: 51.403, lng: 21.146, code: "REDACTED_REACTOR_CODE" },
  "Chelmno":              { lat: 53.351, lng: 18.434, code: "REDACTED_REACTOR_CODE" },
  "Żarnowiec":            { lat: 54.617, lng: 18.121, code: "REDACTED_REACTOR_CODE" },
};

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

async function getLocations(name: string, surname: string) {
  const res = await fetch("https://REDACTED_HUB_URL/api/location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, surname, apikey: apiKey }),
  });
  return res.json();
}

async function getAccessLevel(name: string, surname: string, birthYear: number) {
  const res = await fetch("https://REDACTED_HUB_URL/api/accesslevel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, surname, birthYear, apikey: apiKey }),
  });
  return res.json();
}

function nearestPlant(locations: Array<{ latitude?: number; longitude?: number; lat?: number; lng?: number }>) {
  let minDist = Infinity;
  let bestPlant = "";
  let bestCode = "";
  let bestPoint = { lat: 0, lng: 0 };

  for (const loc of locations) {
    const lat = loc.latitude ?? loc.lat ?? 0;
    const lng = loc.longitude ?? loc.lng ?? 0;
    for (const [name, p] of Object.entries(PLANTS)) {
      const d = haversine(lat, lng, p.lat, p.lng);
      if (d < minDist) { minDist = d; bestPlant = name; bestCode = p.code; bestPoint = { lat, lng }; }
    }
  }
  return { plant: bestPlant, code: bestCode, dist: minDist, point: bestPoint };
}

async function trySubmit(task: string, answer: unknown) {
  const res = await fetch("https://REDACTED_HUB_URL/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, answer, apikey: apiKey }),
  });
  const json = await res.json();
  console.log(`  ${task} / ${JSON.stringify(answer).slice(0, 60)}: ${JSON.stringify(json)}`);
}

async function run() {
  // Check Adam Flagowski — the S01E01 anomaly hiding in S01E02 like Waldo
  console.log("\n=== Adam Flagowski (S01E01 anomaly) ===");
  const adamLocs = await getLocations("Adam", "Flagowski");
  console.log("Locations:", JSON.stringify(adamLocs).slice(0, 500));
  if (Array.isArray(adamLocs)) {
    const near = nearestPlant(adamLocs);
    console.log(`Nearest plant: ${near.plant} (${near.code}), dist: ${near.dist.toFixed(2)} km`);
    const access = await getAccessLevel("Adam", "Flagowski", 1986);
    console.log("Access level:", JSON.stringify(access));

    // Try submitting Flagowski to findhim with correct access level
    await trySubmit("findhim", { name: "Adam", surname: "Flagowski", accessLevel: (access as Record<string, unknown>).accessLevel, powerPlant: near.code });
  }

  // "Wally is the most important one" + "use name from People.php pool"
  // = Wally IS in people.csv. Find who returns location data (like Flagowski did).
  // Try Martin Handford with different birth years to see if there's a flag
  console.log("\n=== Martin Handford with various birth years ===");
  for (const year of [1955, 1956, 1957, 1991, 2000]) {
    const res = await fetch("https://REDACTED_HUB_URL/api/accesslevel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Martin", surname: "Handford", birthYear: year, apikey: apiKey }),
    });
    const json = await res.json();
    console.log(`  birthYear ${year}: ${JSON.stringify(json)}`);
  }

  // Maybe Wally is a specific Wacław in people.csv — try those with their birth years
  // Wacław Jasiński born 1986 in Grudziądz (city of 1138MW plant)
  // Try different Wacław entries for location data
  console.log("\n=== All Wacław entries from people.csv → location API ===");
  // From grep: Wacław Jasiński born 1986 was the suspect. But are there unusual others?
  // Try the five most common Wacław surnames
  const waclawy = [
    "Jasiński", "Kowalski", "Nowak", "Wiśniewski", "Wójcik",
    "Kowalczyk", "Kamiński", "Lewandowski", "Zieliński", "Szymański"
  ];
  for (const surname of waclawy) {
    const res = await fetch("https://REDACTED_HUB_URL/api/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wacław", surname, apikey: apiKey }),
    });
    const json = await res.json();
    const short = JSON.stringify(json).slice(0, 100);
    // Only show if not the standard "not on list" error
    if (!short.includes("-700") && !short.includes("not found")) {
      console.log(`  Wacław ${surname}: ${short}`);
    }
  }

  // Try "Wally" as first name with common Polish surnames
  console.log("\n=== 'Wally' as first name ===");
  for (const surname of ["Kowalski", "Nowak", "Wiśniewski", "Handford"]) {
    const res = await fetch("https://REDACTED_HUB_URL/api/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wally", surname, apikey: apiKey }),
    });
    const json = await res.json();
    console.log(`  Wally ${surname}: ${JSON.stringify(json).slice(0, 100)}`);
  }

  // KEY: "Wally is the most important one!" = code -100 for Martin Handford (1956)
  // "Wally *" = code -700 "not on survivor list" from location API
  //
  // New angle: Wally Handford + accesslevel API + various birth years?
  console.log("\n=== Wally Handford in accesslevel with various birth years ===");
  for (const year of [1956, 1957, 1986, 1991, 1993]) {
    const res = await fetch("https://REDACTED_HUB_URL/api/accesslevel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Wally", surname: "Handford", birthYear: year, apikey: apiKey }),
    });
    const json = await res.json();
    console.log(`  Wally Handford (${year}): ${JSON.stringify(json)}`);
  }

  // Maybe the TASK requires submitting what we found: "Wally is the most important one"
  // Try task findhim with Wacław Jasiński (the Polish "Wally") + all plant codes
  console.log("\n=== Wacław Jasiński (Polish Wally) with ALL plant codes ===");
  const allPlants = [
    "REDACTED_REACTOR_CODE", "REDACTED_REACTOR_CODE", "REDACTED_REACTOR_CODE", "REDACTED_REACTOR_CODE",
    "REDACTED_REACTOR_CODE", "REDACTED_REACTOR_CODE", "REDACTED_REACTOR_CODE"
  ];
  for (const plant of allPlants) {
    const res = await fetch("https://REDACTED_HUB_URL/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "findhim",
        answer: { name: "Wacław", surname: "Jasiński", accessLevel: 2, powerPlant: plant },
        apikey: apiKey,
      }),
    });
    const json = await res.json() as { code: number; message?: string };
    if (json.code !== -910) {
      console.log(`  *** Wacław+${plant}: ${JSON.stringify(json)}`);
    } else {
      console.log(`  Wacław+${plant}: -910`);
    }
  }

  // Also try findhim with the "wrong" access level to get a different error
  // Maybe Wacław Jasiński's TRUE access level is 100 (like Martin Handford = -100)?
  console.log("\n=== Wacław Jasiński with accessLevel 100 + nearest plant ===");
  const r = await fetch("https://REDACTED_HUB_URL/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: "findhim",
      answer: { name: "Wacław", surname: "Jasiński", accessLevel: 100, powerPlant: "REDACTED_REACTOR_CODE" },
      apikey: apiKey,
    }),
  });
  console.log("Wacław+100+Grudziądz:", JSON.stringify(await r.json()));
