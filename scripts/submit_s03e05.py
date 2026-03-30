#!/usr/bin/env python3
"""Submit the solution for S03E05 savethem task."""

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


# === Solution ===
# Map:
# ........WW  row 0
# .......WW.  row 1
# .T....WW..  row 2
# ......W...  row 3
# ..T...W.G.  row 4  <- G at (4,8)
# ....R.W...  row 5
# ...RR.WW..  row 6
# SR.....W..  row 7  <- S at (7,0)
# ......WW..  row 8
# .....WW...  row 9
#
# Path: rocket up x3, right x5, dismount, walk right x3
# Positions: (7,0)->(6,0)->(5,0)->(4,0)->(4,1)->(4,2)[T]->(4,3)->(4,4)->(4,5)
#            dismount, walk: (4,5)->(4,6)[W]->(4,7)->(4,8)[G]
#
# Resource check:
#   Rocket (8 steps): fuel = 7*1.0 + 1*(1.0+0.2) = 8.2, food = 8*0.1 = 0.8
#   Walk   (3 steps): food = 3*2.5 = 7.5
#   Total:            fuel=8.2/10, food=8.3/10 => within budget!

answer = ["rocket", "up", "up", "up", "right", "right", "right", "right", "right", "dismount", "right", "right", "right"]

print("Submitting answer:", answer)
print()

res = post("/verify", {"apikey": API_KEY, "task": "savethem", "answer": answer})
print("Response:", json.dumps(res, indent=2))
