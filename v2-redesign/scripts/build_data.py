"""Compact the VAST 2024 MC2 knowledge graph into the small file the dashboard loads.

Usage: python v2-redesign/scripts/build_data.py path/to/mc2.json path/to/Oceanus\\ Geography.geojson
"""
import json
import shutil
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "data"
BASE = datetime(2035, 1, 1)
KIND_MAP = {
    "Ecological Preserve": "preserve",
    "Fishing Ground": "fishing",
    "Island": "island",
    "city": "city",
    "buoy": "buoy",
}


def centroid(ring):
    area = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area *= 0.5
    return cx / (6 * area), cy / (6 * area)


def minutes(ts):
    return round((datetime.fromisoformat(ts) - BASE).total_seconds() / 60)


def main(mc2_path, geo_path):
    graph = json.loads(Path(mc2_path).read_text())
    geo = json.loads(Path(geo_path).read_text())

    locations, loc_index = [], {}
    for f in geo["features"]:
        p, g = f["properties"], f["geometry"]
        if g["type"] == "Point":
            lon, lat = g["coordinates"][:2]
        else:
            lon, lat = centroid(g["coordinates"][0])
        kind = KIND_MAP.get(p.get("*Kind"), "other")
        loc = {"name": p["Name"], "kind": kind, "lat": round(lat, 5), "lon": round(lon, 5)}
        if p.get("fish_species_present"):
            loc["fish"] = [s.split("/")[0] for s in p["fish_species_present"]]
        loc_index[p["Name"]] = loc_index[f"City of {p['Name']}"] = len(locations)
        locations.append(loc)

    nodes = {n["id"]: n for n in graph["nodes"]}
    vessels = [n for n in graph["nodes"] if n["type"].startswith("Entity.Vessel")]
    companies = sorted({v["company"] for v in vessels if v.get("company")})
    company_index = {c: i for i, c in enumerate(companies)}
    vessel_index = {v["id"]: i for i, v in enumerate(vessels)}

    per_vessel = defaultdict(list)
    skipped = 0
    for e in graph["links"]:
        if e["type"] != "Event.TransportEvent.TransponderPing":
            continue
        li, vi = loc_index.get(e["source"]), vessel_index.get(e["target"])
        if li is None or vi is None:
            skipped += 1
            continue
        per_vessel[vi].append((minutes(e["time"]), li, round(e.get("dwell", 0) / 60)))

    ping_loc, ping_time, ping_dwell, offsets = [], [], [], [0]
    for vi in range(len(vessels)):
        for t, li, d in sorted(per_vessel[vi]):
            ping_time.append(t)
            ping_loc.append(li)
            ping_dwell.append(d)
        offsets.append(len(ping_time))

    fish_names = sorted({n["name"].split("/")[0] for n in graph["nodes"] if n["type"] == "Entity.Commodity.Fish"})
    fish_index = {n["id"]: fish_names.index(n["name"].split("/")[0])
                  for n in graph["nodes"] if n["type"] == "Entity.Commodity.Fish"}
    cargo_fish, cargo_city = {}, {}
    for e in graph["links"]:
        if e["type"] != "Event.Transaction":
            continue
        if e["target"] in fish_index:
            cargo_fish[e["source"]] = fish_index[e["target"]]
        elif e["target"] in loc_index:
            cargo_city[e["source"]] = loc_index[e["target"]]

    cargo = {"day": [], "fish": [], "city": [], "qty": []}
    for cid in sorted(set(cargo_fish) | set(cargo_city)):
        n = nodes.get(cid)
        if not n or not n.get("date"):
            continue
        cargo["day"].append((datetime.fromisoformat(n["date"]) - BASE).days)
        cargo["fish"].append(cargo_fish.get(cid, -1))
        cargo["city"].append(cargo_city.get(cid, -1))
        cargo["qty"].append(round(float(n.get("qty_tons") or 0), 2))

    out = {
        "base": BASE.isoformat(),
        "locations": locations,
        "companies": companies,
        "fish": fish_names,
        "vessels": [{
            "id": v["id"],
            "name": v.get("Name") or v["id"],
            "company": company_index.get(v.get("company"), -1),
            "type": v["type"].split(".", 2)[-1],
            "flag": v.get("flag_country"),
            "tonnage": v.get("tonnage"),
            "length": v.get("length_overall"),
        } for v in vessels],
        "pings": {"offsets": offsets, "loc": ping_loc, "time": ping_time, "dwell": ping_dwell},
        "cargo": cargo,
    }

    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "oceanus.json").write_text(json.dumps(out, separators=(",", ":")))
    shutil.copy(geo_path, OUT_DIR / "geography.geojson")
    size = (OUT_DIR / "oceanus.json").stat().st_size / 1e6
    print(f"{len(vessels)} vessels, {len(ping_time)} pings ({skipped} skipped), "
          f"{len(cargo['day'])} cargo records -> {size:.1f} MB")


if __name__ == "__main__":
    main(*sys.argv[1:3])
