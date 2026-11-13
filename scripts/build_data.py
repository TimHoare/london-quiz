"""Turn the raw downloads in data-raw/ into the compact JSON the app loads.

Sources (see README for how they were fetched):
  osm-places.json          Overpass: place=suburb|neighbourhood|quarter|town|village in Greater London
  wikidata-sitelinks.json  Wikidata sitelink counts per place (used as a fame score)
  london-boroughs.geojson  Borough boundaries (github.com/radoi90/housequest-data)
  tfl-stations.geojson     TfL stations with lines and zones (github.com/oobrien/vis)
  landmarks-geocoded.json  Curated landmark list, geocoded with Nominatim

Run: python3 scripts/build_data.py
"""
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data-raw")
OUT = os.path.join(ROOT, "public", "data")


def load(name):
    with open(os.path.join(RAW, name)) as f:
        return json.load(f)


def dump(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"wrote {name}: {os.path.getsize(os.path.join(OUT, name)) // 1024} KB")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def km(a, b):
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


# ---------- boroughs ----------

INNER = {
    "Camden", "City of London", "Hackney", "Hammersmith and Fulham", "Islington",
    "Kensington and Chelsea", "Lambeth", "Lewisham", "Southwark", "Tower Hamlets",
    "Wandsworth", "Westminster", "Greenwich",
}


def simplify(points, tol):
    """Douglas-Peucker on [lng, lat] pairs."""
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-12
    best, idx = -1, 0
    for i in range(1, len(points) - 1):
        x, y = points[i]
        d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm if (dx or dy) else math.hypot(x - x1, y - y1)
        if d > best:
            best, idx = d, i
    if best > tol:
        return simplify(points[: idx + 1], tol)[:-1] + simplify(points[idx:], tol)
    return [points[0], points[-1]]


def simplify_ring(ring, tol=0.00018):
    # Split closed ring in two so the endpoints aren't degenerate.
    mid = len(ring) // 2
    out = simplify(ring[: mid + 1], tol)[:-1] + simplify(ring[mid:], tol)
    return [[round(x, 5), round(y, 5)] for x, y in out]


def point_in_ring(lng, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


boroughs_raw = load("london-boroughs.geojson")
boroughs = []
for f in boroughs_raw["features"]:
    rings = [simplify_ring(r) for r in f["geometry"]["coordinates"]]
    boroughs.append({
        "type": "Feature",
        "properties": {"name": f["properties"]["name"], "id": slug(f["properties"]["name"]),
                       "tier": 1 if f["properties"]["name"] in INNER else 2},
        "geometry": {"type": "Polygon", "coordinates": rings},
    })


def borough_of(lat, lng):
    for b in boroughs:
        rings = b["geometry"]["coordinates"]
        if point_in_ring(lng, lat, rings[0]) and not any(point_in_ring(lng, lat, h) for h in rings[1:]):
            return b["properties"]["name"]
    # Fall back to the nearest borough vertex for points that sit on the simplified edge.
    best = min(
        ((km((lat, lng), (y, x)), b["properties"]["name"]) for b in boroughs for x, y in b["geometry"]["coordinates"][0]),
    )
    return best[1] if best[0] < 0.4 else None


dump("boroughs.geojson", {"type": "FeatureCollection", "features": boroughs})

# ---------- neighbourhoods ----------

# Areas almost anyone who has spent time in London will have heard of.
WELL_KNOWN = """
Notting Hill, Hackney, Camden Town, Shoreditch, Soho, Mayfair, Chelsea, Kensington, South Kensington,
Knightsbridge, Belgravia, Marylebone, Fitzrovia, Bloomsbury, Covent Garden, Holborn, Clerkenwell, Islington,
Angel, King's Cross, Hampstead, Highgate, Primrose Hill, St. John's Wood, Maida Vale, Paddington, Bayswater,
Pimlico, Westminster, Victoria, Waterloo, Southwark, Bermondsey, Brixton, Clapham, Battersea, Fulham,
Hammersmith, Shepherd's Bush, Putney, Wimbledon, Richmond, Greenwich, Canary Wharf, Stratford, Whitechapel,
Bethnal Green, Dalston, Peckham, Camberwell, Elephant and Castle, Vauxhall, Stockwell, Balham, Tooting,
Wembley, Ealing, Chiswick, Croydon, Walthamstow, Tottenham, Wapping, Limehouse, Spitalfields, Aldgate,
Barbican, Earl's Court, Kentish Town, Stoke Newington, Hoxton, Deptford, Lewisham, Woolwich, Kew, Twickenham,
Kingston upon Thames, Bow, Mile End, Finsbury Park, Holloway, Highbury, Crouch End, Muswell Hill,
Golders Green, Kilburn, Wandsworth, Dulwich, Blackheath, Crystal Palace, Hackney Wick, Canada Water,
Rotherhithe, Chalk Farm, Bank, Temple, South Bank, Nine Elms, Kennington, Herne Hill, Streatham, Clapham Junction,
Harrow, Romford, Bromley, Ilford, Barking, Acton, Isle of Dogs, The Borough, Belsize Park,
East Dulwich, Brockley, Forest Hill, Leyton, Leytonstone, Euston, Lambeth, Holland Park
"""
WELL_KNOWN = {s.strip() for s in WELL_KNOWN.replace("\n", " ").split(",") if s.strip()}

DISPLAY_NAME = {"St. John's Wood": "St John's Wood", "St. George in the East": "St George in the East"}
SKIP = {"Greenwich Town Centre", "Blackheath Royal Standard", "Bermondsey Village", "Hendon Central",
        "Catford South", "Hounslow West", "Charlton Riverside", "Barking Riverside", "Old Kent Road"}

sitelinks = load("wikidata-sitelinks.json")
rank_of_type = {"town": 0, "suburb": 1, "quarter": 2, "neighbourhood": 3, "village": 4}

candidates = []
for el in load("osm-places.json")["elements"]:
    t = el["tags"]
    name = t.get("name")
    if not name or name in SKIP:
        continue
    borough = borough_of(el["lat"], el["lon"])
    if not borough:
        continue
    links = sitelinks.get(t.get("wikidata"), {}).get("sitelinks", 0)
    candidates.append({
        "name": DISPLAY_NAME.get(name, name), "osm": name, "lat": round(el["lat"], 5), "lng": round(el["lon"], 5),
        "borough": borough, "links": links, "type": t["place"],
    })

# Well-known areas OSM only maps as polygons (or not at all), placed by hand at their accepted centre.
for name, lat, lng in [("Holland Park", 51.50450, -0.20400), ("Euston", 51.52750, -0.13350)]:
    candidates.append({"name": name, "osm": name, "lat": lat, "lng": lng, "borough": borough_of(lat, lng),
                       "links": 0, "type": "suburb"})

# Most famous first, so dedupe keeps the better-known node.
candidates.sort(key=lambda c: (c["osm"] not in WELL_KNOWN, -c["links"], rank_of_type[c["type"]]))
places = []
for c in candidates:
    if any(p["name"] == c["name"] and km((p["lat"], p["lng"]), (c["lat"], c["lng"])) < 3 for p in places):
        continue
    # Fame tiers. Below 6 Wikipedia language editions it's mostly estates and
    # map-only hamlets, which make for frustrating rather than fun questions.
    if c["osm"] in WELL_KNOWN:
        tier = 1
    elif c["links"] >= 12:
        tier = 2
    elif c["links"] >= 6 and "Estate" not in c["name"] and c["name"] != "Church End":
        tier = 3
    else:
        continue
    places.append({**c, "tier": tier})

# Same name in two different places: disambiguate with the borough.
counts = {}
for p in places:
    counts[p["name"]] = counts.get(p["name"], 0) + 1
for p in places:
    if counts[p["name"]] > 1:
        p["qualifier"] = p["borough"]

# How far from the centre (km) still counts as being in the place. Most neighbourhoods
# are a kilometre or so across; OSM "towns" are bigger, and a few areas are far bigger.
PLACE_RADIUS = {"neighbourhood": 0.5, "quarter": 0.5, "suburb": 0.5, "village": 0.5, "town": 0.7}
BIG_PLACES = {"Isle of Dogs": 1.3}

out = []
for p in sorted(places, key=lambda p: p["name"]):
    pid = slug(p["name"] + ("-" + p["borough"] if p.get("qualifier") else ""))
    item = {"id": pid, "name": p["name"], "lat": p["lat"], "lng": p["lng"], "borough": p["borough"], "tier": p["tier"]}
    r = BIG_PLACES.get(p["name"], PLACE_RADIUS[p["type"]])
    if r != 0.5:
        item["r"] = r
    if p.get("qualifier"):
        item["qualifier"] = p["qualifier"]
    out.append(item)
missing = WELL_KNOWN - {p["osm"] for p in places}
print("well-known names not found in OSM:", sorted(missing))
print("places per tier:", {t: sum(1 for p in out if p["tier"] == t) for t in (1, 2, 3)})
dump("places.json", out)

# ---------- tube stations ----------

TUBE = {"Bakerloo", "Central", "Circle", "District", "Hammersmith & City", "Jubilee", "Metropolitan",
        "Northern", "Piccadilly", "Victoria", "Waterloo & City"}
stations = []
for f in load("tfl-stations.geojson")["features"]:
    p = f["properties"]
    lines = sorted({l["name"] for l in p["lines"] if l["name"] in TUBE and l.get("opened", 0) <= 2026 and not l.get("closed")})
    if not lines:
        continue
    lng, lat = f["geometry"]["coordinates"]
    zones = [int(z) for z in re.findall(r"\d+", str(p.get("zone", "9")))] or [9]
    zone = min(zones)
    big_interchange = len(lines) >= 3
    tier = 1 if zone == 1 or big_interchange else 2 if zone <= 3 else 3
    stations.append({"id": slug(p["name"]), "name": p["name"], "lat": round(lat, 5), "lng": round(lng, 5),
                     "lines": lines, "zone": zone, "tier": tier, "borough": borough_of(lat, lng) or "outside Greater London"})
seen = set()
stations = [s for s in sorted(stations, key=lambda s: s["name"]) if not (s["id"] in seen or seen.add(s["id"]))]
print("stations per tier:", {t: sum(1 for s in stations if s["tier"] == t) for t in (1, 2, 3)})
dump("stations.json", stations)

# ---------- landmarks ----------

FIX = {  # Nominatim misses or picked a neighbouring feature; values checked by hand.
    "Olympic Stadium": (51.53865, -0.01662),
    "Stamford Bridge": (51.48167, -0.19098),
    "The O2": (51.50303, 0.00317),
    # Nominatim's point sat off to one side of these; moved to the centroid of the OSM outline.
    "Kew Gardens": (51.47748, -0.29695),
    "Richmond Park": (51.44186, -0.27660),
    "Hampstead Heath": (51.56520, -0.16957),
    "Bushy Park": (51.41538, -0.33871),
    "Victoria Park": (51.53790, -0.03802),
    "Wormwood Scrubs": (51.52148, -0.23997),
    "Walthamstow Wetlands": (51.58555, -0.05058),
}
# Landmarks that are bigger than a building: how far from the centre (km) still counts
# as being on it. Parks and airports are sized from the area of their OSM outline.
LANDMARK_RADIUS = {
    "Heathrow Airport": 2.0, "Richmond Park": 1.8, "Bushy Park": 1.3, "Hampstead Heath": 1.1,
    "Walthamstow Wetlands": 0.9, "Hyde Park": 0.75, "Kew Gardens": 0.75, "Regent's Park": 0.7,
    "Victoria Park": 0.6, "Hackney Marshes": 0.6, "Wanstead Flats": 0.6, "Battersea Park": 0.55,
    "Clapham Common": 0.55, "Crystal Palace Park": 0.5, "Wormwood Scrubs": 0.5, "Osterley Park": 0.5,
    "London City Airport": 0.5, "Brick Lane": 0.45, "Peckham Rye": 0.35, "Kensal Green Cemetery": 0.35,
    "Royal Arsenal": 0.35, "Primrose Hill": 0.3, "Hampton Court Palace": 0.3, "Alexandra Palace": 0.3,
    "Syon House": 0.3, "Camden Market": 0.3, "Barbican Centre": 0.3, "Thames Barrier": 0.3,
    "Highgate Cemetery": 0.25, "Brompton Cemetery": 0.25, "Buckingham Palace": 0.25, "London Zoo": 0.25,
    "All England Club (Wimbledon)": 0.25, "Olympic Stadium": 0.25,
}
EXTRA = [
    {"name": "The Oval", "tier": 2, "lat": 51.48375, "lng": -0.11496},
    {"name": "All England Club (Wimbledon)", "tier": 2, "lat": 51.43407, "lng": -0.21436},
    {"name": "Old Bailey", "tier": 2, "lat": 51.51553, "lng": -0.10194},
    {"name": "Neasden Temple", "tier": 3, "lat": 51.54747, "lng": -0.26103},
]
RENAME = {"Walkie-Talkie (20 Fenchurch St)": "The Walkie-Talkie"}
landmarks = []
for l in load("landmarks-geocoded.json") + EXTRA:
    lat, lng = FIX.get(l["name"], (l["lat"], l["lng"]))
    name = RENAME.get(l["name"], l["name"])
    item = {"id": slug(name), "name": name, "lat": lat, "lng": lng, "tier": l["tier"], "borough": borough_of(lat, lng)}
    if name in LANDMARK_RADIUS:
        item["r"] = LANDMARK_RADIUS[name]
    landmarks.append(item)
missing = set(LANDMARK_RADIUS) - {l["name"] for l in landmarks}
assert not missing, f"sized landmarks not in the list: {missing}"
landmarks.sort(key=lambda l: l["name"])
print("landmarks per tier:", {t: sum(1 for s in landmarks if s["tier"] == t) for t in (1, 2, 3)})
dump("landmarks.json", landmarks)
