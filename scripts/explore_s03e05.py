#!/usr/bin/env python3
"""Script to explore the S03E05 savethem task tools and solve the pathfinding."""

import urllib.request
import urllib.parse
import json
import sys

API_KEY = "REDACTED_API_KEY"
HUB = "https://REDACTED_HUB_URL"


def post(endpoint: str, body: dict) -> dict:
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


def toolsearch(query: str) -> dict:
    return post("/api/toolsearch", {"apikey": API_KEY, "query": query})


def call_tool(endpoint: str, query: str) -> dict:
    return post(endpoint, {"apikey": API_KEY, "query": query})


def call_tool_nokey(endpoint: str, query: str) -> dict:
    return post(endpoint, {"query": query})


if __name__ == "__main__":
    # --- Discover all tools ---
    print("=" * 60)
    print("TOOL DISCOVERY")
    print("=" * 60)

    discovery_queries = [
        "map terrain grid obstacles",
        "vehicles fuel consumption speed",
        "books notes journey travel rules",
        "movement cost food energy",
        "Skolwin city destination",
        "water river crossing",
        "forest mountain road",
    ]

    all_tools = {}
    for q in discovery_queries:
        res = toolsearch(q)
        tools = res.get("tools", [])
        for t in tools:
            name = t["name"]
            if name not in all_tools:
                all_tools[name] = t
                print(f"  Found tool: {name} -> {t['url']}  [{t['description']}]")

    print(f"\nTotal unique tools: {list(all_tools.keys())}")

    # --- Query each tool ---
    print("\n" + "=" * 60)
    print("QUERYING TOOLS")
    print("=" * 60)

    # From 404 error messages:
    # /api/maps   -> expects a city name
    # /api/wehicles -> expects a vehicle name: rocket, horse, walk, car

    print("\n--- /api/maps with city names ---")
    for city in ["Skolwin", "start", "beginning", "origin", "unknown", "A"]:
        print(f"\n  Query: {city!r}")
        res = call_tool("/api/maps", city)
        print(f"  Response: {json.dumps(res, indent=4)}")

    print("\n--- /api/wehicles with vehicle names ---")
    for veh in ["rocket", "horse", "walk", "car"]:
        print(f"\n  Query: {veh!r}")
        res = call_tool("/api/wehicles", veh)
        print(f"  Response: {json.dumps(res, indent=4)}")

    print("\n--- /api/books with various queries ---")
    for q in [
        "movement rules terrain",
        "cost per terrain type",
        "how to cross river",
        "travel notes journey",
        "food fuel rules",
        "Skolwin",
        "map",
        "vehicle",
    ]:
        print(f"\n  Query: {q!r}")
        res = call_tool("/api/books", q)
        print(f"  Response: {json.dumps(res, indent=4)}")
