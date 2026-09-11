"""
Canonical venues + cross-source show de-duplication.

Songkick and Do604 (and Songkick with itself) spell the same room several ways:
"Rickshaw Theatre" / "The Rickshaw", "Guilt & Co" / "Guilt & Company",
"The Astoria" / "Astoria Pub", "Biltmore Cabaret" / "The Bitmore" (sic).
Keying on raw names produced duplicate shows and split venue counts.

Approach:
  1. venue_key(name): fold accents, drop articles/parentheticals, "&"->"and",
     "company"->"co", strip venue-type words (theatre, pub, cabaret, hall...).
  2. Cluster keys that are (a) identical, (b) near-identical (typos, difflib >= .88),
     (c) geo-located within GEO_M metres AND sharing a name word, or (d) listed as aliases
     in cities.json ("venue_aliases": {"Green Auto": ["Green Auto Body", ...]}).
  3. Each cluster gets one canonical display name (most frequent raw name, Songkick
     preferred) and a stable venue_id (slug of the canonical name).
  4. Shows with the same venue_id + date whose act lists overlap are one show:
     keep the Songkick record, add any extra acts the other source billed.
"""
import difflib
import math
import re
import unicodedata

GEO_M = 120                # geo match radius, only trusted when the names also resemble each other
                           # (Granville St has four rooms within 100 m of each other)
TYPE_WORDS = {
    "theatre", "theater", "pub", "cabaret", "cabarat", "hall", "club", "lounge", "bar", "ballroom",
    "room", "cafe", "eatery", "society", "arts", "centre", "center", "co", "company", "studio", "studios",
    "live", "venue", "stage", "main", "body", "music", "presents", "at", "the", "of", "for", "performing",
}
STOP_KEYS = {"", "vancouver", "house show", "sofar sounds", "tba"}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(ch for ch in s if not unicodedata.combining(ch)).encode("ascii", "ignore").decode()


def venue_key(name: str) -> str:
    v = fold(name).lower()
    v = re.sub(r"\(.*?\)", " ", v)
    v = v.replace("&", " and ").replace("'", "")
    v = re.sub(r"[^a-z0-9]+", " ", v)
    words = [w for w in v.split() if w not in TYPE_WORDS and w != "and"]
    key = " ".join(words)
    if not key:                                   # "The Key", "The Room": type words were the whole name
        key = " ".join(w for w in v.split() if w not in {"the", "at"})
    return key


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", fold(name).lower()).strip("-")[:60]


def _dist_m(a, b) -> float:
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    x = (lo2 - lo1) * p * math.cos((la1 + la2) * p / 2)
    y = (la2 - la1) * p
    return 6371000 * math.hypot(x, y)


class _UF:
    def __init__(self): self.p = {}
    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x
    def union(self, a, b): self.p[self.find(a)] = self.find(b)


def canonicalize(events: list[dict], aliases: dict | None = None) -> dict:
    """Assign venue_id + canonical venue name to every event (in place).
    Returns {venue_id: {"name", "aliases": [...], "lat", "lng"}}."""
    aliases = aliases or {}
    raw_names = {}
    for e in events:
        n = (e.get("venue") or "").strip()
        if not n:
            continue
        r = raw_names.setdefault(n, {"count": 0, "songkick": 0, "geo": None})
        r["count"] += 1
        r["songkick"] += e.get("source", "songkick") == "songkick"
        if e.get("lat") and e.get("lng") and not r["geo"]:
            r["geo"] = (float(e["lat"]), float(e["lng"]))

    uf = _UF()
    keys = {n: venue_key(n) for n in raw_names}
    names = list(raw_names)
    for n in names:
        uf.find(n)
    # (a) identical keys
    by_key = {}
    for n, k in keys.items():
        if k in STOP_KEYS:
            continue
        if k in by_key:
            uf.union(n, by_key[k])
        else:
            by_key[k] = n
    # (b) near-identical keys (typos) and (c) geo proximity
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ka, kb = keys[a], keys[b]
            if ka in STOP_KEYS or kb in STOP_KEYS:
                continue
            if len(ka) >= 6 and len(kb) >= 6 and difflib.SequenceMatcher(None, ka, kb).ratio() >= 0.88:
                uf.union(a, b)
                continue
            ga, gb = raw_names[a]["geo"], raw_names[b]["geo"]
            if ga and gb and _dist_m(ga, gb) <= GEO_M:
                wa, wb = set(ka.split()), set(kb.split())
                similar = (wa & wb) or difflib.SequenceMatcher(None, ka, kb).ratio() >= 0.6
                if similar:
                    uf.union(a, b)
    # (d) configured aliases
    for canon, alts in aliases.items():
        for alt in alts:
            for n in names:
                if venue_key(n) in (venue_key(canon), venue_key(alt)):
                    uf.union(n, canon if canon in raw_names else n)

    clusters = {}
    for n in names:
        clusters.setdefault(uf.find(n), []).append(n)
    venues, name_to_id = {}, {}
    for members in clusters.values():
        # canonical: configured alias key if one applies, else most frequent (Songkick first) name
        canon = next((c for c in aliases if venue_key(c) in {keys[m] for m in members}), None)
        if not canon:
            canon = max(members, key=lambda m: (raw_names[m]["songkick"], raw_names[m]["count"], -len(m)))
        vid = slug(canon)
        geo = next((raw_names[m]["geo"] for m in members if raw_names[m]["geo"]), None)
        venues[vid] = {"name": canon, "aliases": sorted(m for m in members if m != canon),
                       "lat": geo[0] if geo else None, "lng": geo[1] if geo else None}
        for m in members:
            name_to_id[m] = vid
    for e in events:
        n = (e.get("venue") or "").strip()
        vid = name_to_id.get(n)
        if vid:
            e["venue_raw"] = n
            e["venue_id"] = vid
            e["venue"] = venues[vid]["name"]
            if not e.get("lat") and venues[vid]["lat"]:
                e["lat"], e["lng"] = venues[vid]["lat"], venues[vid]["lng"]
    return venues


def _act_key(name: str) -> str:
    v = fold(name).lower()
    v = re.sub(r"\(.*?\)", " ", v).replace("&", " and ")
    v = re.sub(r"\b(the|a|an)\b", " ", v)
    return re.sub(r"[^a-z0-9]+", " ", v).strip()


def dedupe_shows(events: list[dict]) -> tuple[list[dict], int]:
    """Merge records of the same show. Same venue_id + date and overlapping acts
    (or a common headliner) = same show. Songkick's record wins; extra acts from
    the other record are appended (kept strict so they still need an exact match)."""
    order = {"songkick": 0, "do604": 1}
    events = sorted(events, key=lambda e: (e.get("start") or "", order.get(e.get("source", "songkick"), 2)))
    groups = {}
    for e in events:
        groups.setdefault(((e.get("venue_id") or venue_key(e.get("venue") or "")), (e.get("start") or "")[:10]), []).append(e)
    out, merged = [], 0
    for members in groups.values():
        members.sort(key=lambda e: order.get(e.get("source", "songkick"), 2))
        kept = []
        for e in members:
            acts = {_act_key(p["name"]) for p in e["performers"]}
            target = None
            for k in kept:
                kacts = {_act_key(p["name"]) for p in k["performers"]}
                same = bool(acts & kacts)
                if not same and e["performers"] and k["performers"]:
                    h1, h2 = _act_key(e["performers"][0]["name"]), _act_key(k["performers"][0]["name"])
                    # Headliner match, or one record's headliner appears in the other's listing title
                    # (covers a garbled Do604 title like "Bear McCreary - The Singularity: Ekleipsis Tour").
                    t1, t2 = _act_key(e.get("name") or ""), _act_key(k.get("name") or "")
                    same = h1 == h2 or (len(h2) >= 5 and f" {h2} " in f" {t1} ") or (len(h1) >= 5 and f" {h1} " in f" {t2} ")
                if same:
                    target = k
                    break
            if target is None:
                kept.append(e)
                continue
            merged += 1
            have = {_act_key(p["name"]) for p in target["performers"]}
            for p in e["performers"]:
                if _act_key(p["name"]) not in have:
                    target["performers"].append({**p, "strict": True})
                    have.add(_act_key(p["name"]))
            target.setdefault("also_listed", []).append({"source": e.get("source"), "url": e.get("url")})
        out.extend(kept)
    return out, merged
