#!/usr/bin/env python3
"""Fetch map and vehicle data for S03E05."""

import urllib.request
import json

API_KEY = "REDACTED_API_KEY"
HUB = "https://REDACTED_HUB_URL"


def post(endpoint: str, body: dict):
    url = HUB + endpoint
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            try:
                return json.loads(txt)
            except Exception:
                return {"raw": txt}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        return {"http_error": e.code, "body": body_text}


# --- MAP ---
print("=== MAP: Skolwin ===")
res = post("/api/maps", {"apikey": API_KEY, "query": "Skolwin"})
print(json.dumps(res, indent=2))

# --- VEHICLES ---
for veh in ["walk", "horse", "car", "rocket"]:
    print(f"\n=== VEHICLE: {veh} ===")
    res = post("/api/wehicles", {"apikey": API_KEY, "query": veh})
    print(json.dumps(res, indent=2))

# --- BOOKS: fuel/food consumption values ---
print("\n=== BOOKS: fuel consumption values ===")
res = post("/api/books", {"apikey": API_KEY, "query": "fuel consumption per step move"})
print(json.dumps(res, indent=2))

print("\n=== BOOKS: food consumption per step ===")
res = post("/api/books", {"apikey": API_KEY, "query": "food consumption per step"})
print(json.dumps(res, indent=2))

print("\n=== BOOKS: starting resources initial ===")
res = post("/api/books", {"apikey": API_KEY, "query": "starting resources initial fuel food amount"})
print(json.dumps(res, indent=2))

print("\n=== BOOKS: walk food consumption ===")
res = post("/api/books", {"apikey": API_KEY, "query": "walk food consumption rate walking"})
print(json.dumps(res, indent=2))

print("\n=== BOOKS: rocks impassable terrain ===")
res = post("/api/books", {"apikey": API_KEY, "query": "rocks impassable terrain blocked"})
print(json.dumps(res, indent=2))
