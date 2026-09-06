"""
GigAmp enrichment: matches scraped performers to Spotify artists (client-credentials
flow, no user login needed), pulls genres and the two top tracks per artist, and
writes the per-city dataset the site consumes.

Env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET

Usage:
  python scraper/enrich.py            # all cities with a raw file
  python scraper/enrich.py --city vancouver

Output: docs/data/<city>.json, docs/data/index.json, docs/data/cache/artists.json
"""
import argparse
import base64
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "scraper" / "cities.json").read_text())
DATA_DIR = ROOT / "docs" / "data"
RAW_DIR = DATA_DIR / "raw"
CACHE_FILE = DATA_DIR / "cache" / "artists.json"
CACHE_TTL_DAYS = 10          # top tracks drift; refresh cached artists every ~10 days
TRACKS_PER_ARTIST = 2

API = "https://api.spotify.com/v1"


# --- Spotify client ----------------------------------------------------------
class Spotify:
    def __init__(self, client_id: str, client_secret: str):
        self.client_id, self.client_secret = client_id, client_secret
        self.token, self.token_expiry = None, 0
        self.s = requests.Session()
        self.calls = 0

    def _auth(self):
        if self.token and time.time() < self.token_expiry - 60:
            return
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        r = self.s.post("https://accounts.spotify.com/api/token",
                        data={"grant_type": "client_credentials"},
                        headers={"Authorization": f"Basic {basic}"}, timeout=30)
        r.raise_for_status()
        j = r.json()
        self.token, self.token_expiry = j["access_token"], time.time() + j.get("expires_in", 3600)

    def get(self, path: str, **params):
        self._auth()
        for attempt in range(6):
            r = self.s.get(f"{API}{path}", params=params,
                           headers={"Authorization": f"Bearer {self.token}"}, timeout=30)
            self.calls += 1
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", "5"))
                body = {}
                try:
                    body = r.json()
                except ValueError:
                    pass
                if body.get("reason") == "QUOTA_EXCEEDED" or wait > 120:
                    raise RuntimeError(f"Spotify quota exceeded (Retry-After {wait}s). Stopping.")
                time.sleep(wait + 1)
                continue
            if r.status_code == 401:
                self.token = None
                self._auth()
                continue
            if r.status_code in (500, 502, 503):
                time.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"Spotify GET {path} failed after retries")


# --- Matching ----------------------------------------------------------------
def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower().replace("&", "and")
    s = re.sub(r"\b(the|a|an)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def pick_artist(name: str, candidates: list[dict]) -> dict | None:
    """Search results are relevance-ranked. Prefer an exact name match, then a
    containing match; among ties keep Spotify's order (followers/popularity are
    no longer returned to Development Mode apps, so we can't rank on them)."""
    target = norm(name)
    exact = [c for c in candidates if norm(c["name"]) == target]
    if exact:
        exact.sort(key=lambda c: (c.get("followers") or {}).get("total") or 0, reverse=True)
        return exact[0]
    fuzzy = [c for c in candidates if target and (target in norm(c["name"]) or norm(c["name"]) in target)]
    if fuzzy and len(target) >= 4:
        return fuzzy[0]
    return None


def _track_dict(t: dict) -> dict:
    return {
        "id": t["id"],
        "uri": t["uri"],
        "name": t["name"],
        "popularity": t.get("popularity"),
        "album": t["album"]["name"],
        "album_type": t["album"].get("album_type"),
        "release_date": t["album"].get("release_date"),
        "duration_ms": t.get("duration_ms"),
        "explicit": t.get("explicit"),
    }


def _dedupe_take(tracks: list[dict], n: int) -> list[dict]:
    out, seen = [], set()
    for t in tracks:
        key = norm(t["name"])
        if key in seen:
            continue                          # same song on album + single
        seen.add(key)
        out.append(_track_dict(t))
        if len(out) == n:
            break
    return out


def top_tracks(sp: Spotify, artist: dict, market: str) -> tuple[list[dict], str]:
    """Return (tracks, rank_source).

    Preferred: /artists/{id}/top-tracks, which is Spotify's own popularity ranking
    (the 'Popular' list on the artist page). Extended Quota Mode apps get this.
    Development Mode apps lost this endpoint in Feb 2026, so fall back to a track
    search scoped to the artist: Spotify's search relevance for an artist-scoped
    query tracks streaming popularity closely, so the first two distinct results
    are a good proxy for 'most listened' + 'other top song'.
    """
    aid = artist["id"]
    try:
        j = sp.get(f"/artists/{aid}/top-tracks", market=market)
        tracks = _dedupe_take(j.get("tracks", []), TRACKS_PER_ARTIST)
        if tracks:
            return tracks, "top_tracks"
    except requests.HTTPError as e:
        if e.response is None or e.response.status_code not in (403, 404, 410):
            raise
    j = sp.get("/search", q=f'artist:"{artist["name"]}"', type="track", limit=10, market=market)
    items = [t for t in j.get("tracks", {}).get("items", [])
             if any(a["id"] == aid for a in t.get("artists", []))]
    return _dedupe_take(items, TRACKS_PER_ARTIST), "search"


def lookup_artist(sp: Spotify, name: str, market: str, cache: dict) -> dict:
    key = norm(name)
    hit = cache.get(key)
    if hit and hit.get("fetched_at"):
        age = datetime.now(timezone.utc) - datetime.fromisoformat(hit["fetched_at"])
        if age < timedelta(days=CACHE_TTL_DAYS):
            return hit
    res = sp.get("/search", q=f'artist:"{name}"', type="artist", limit=5, market=market)
    cands = res.get("artists", {}).get("items", [])
    if not cands:
        res = sp.get("/search", q=name, type="artist", limit=5, market=market)
        cands = res.get("artists", {}).get("items", [])
    a = pick_artist(name, cands)
    entry = {"query": name, "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if a:
        tracks, rank_source = top_tracks(sp, a, market)
        entry.update({
            "spotify_id": a["id"],
            "spotify_name": a["name"],
            "url": a["external_urls"]["spotify"],
            "genres": a.get("genres", []),
            "popularity": a.get("popularity"),
            "followers": (a.get("followers") or {}).get("total"),
            "image": (a.get("images") or [{}])[-1].get("url"),
            "tracks": tracks,
            "rank_source": rank_source,
        })
    else:
        entry["spotify_id"] = None
    cache[key] = entry
    return entry


# --- Build -------------------------------------------------------------------
def enrich_city(sp: Spotify, city: dict, cache: dict) -> dict:
    raw_path = RAW_DIR / f"{city['slug']}.json"
    raw = json.loads(raw_path.read_text())
    market = city.get("market", "US")
    events_out, unmatched = [], []
    for e in raw["events"]:
        artists = []
        for p in e["performers"]:
            a = lookup_artist(sp, p["name"], market, cache)
            if a.get("spotify_id") and a.get("tracks"):
                artists.append({
                    "name": p["name"],
                    "spotify_name": a["spotify_name"],
                    "spotify_id": a["spotify_id"],
                    "url": a["url"],
                    "genres": a["genres"],
                    "songkick_genres": p.get("songkick_genres", []),
                    "popularity": a["popularity"],
                    "followers": a["followers"],
                    "image": a.get("image"),
                    "tracks": a["tracks"],
                    "rank_source": a.get("rank_source"),
                })
            else:
                unmatched.append({"artist": p["name"], "event": e["name"], "date": e["start"][:10]})
        if artists:
            events_out.append({
                "id": e["id"],
                "name": e["name"],
                "date": e["start"][:10],
                "start": e["start"],
                "venue": e["venue"],
                "locality": e["locality"],
                "url": e["url"],
                "headliner": artists[0]["name"],
                "artists": artists,
            })
    return {
        "city": city["slug"],
        "city_name": city["name"],
        "market": market,
        "timezone": city.get("timezone"),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scraped_at": raw["scraped_at"],
        "horizon_days": raw["horizon_days"],
        "source": raw["source"],
        "events": events_out,
        "unmatched": unmatched,
        "skipped": [{"name": s["name"], "date": s["start"][:10], "venue": s["venue"], "reason": s["skip_reason"]}
                    for s in raw.get("skipped", [])],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city")
    args = ap.parse_args()

    cid, sec = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET")
    sp = Spotify(cid, sec)

    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    cache = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}

    index = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "cities": []}
    for city in CONFIG["cities"]:
        if args.city and city["slug"] != args.city:
            continue
        if not (RAW_DIR / f"{city['slug']}.json").exists():
            print(f"{city['slug']}: no raw file, run scrape.py first", file=sys.stderr)
            continue
        try:
            data = enrich_city(sp, city, cache)
        finally:
            CACHE_FILE.write_text(json.dumps(cache, indent=0, ensure_ascii=False))
        (DATA_DIR / f"{city['slug']}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False))
        n_art = sum(len(e["artists"]) for e in data["events"])
        index["cities"].append({
            "slug": city["slug"], "name": city["name"], "timezone": city.get("timezone"),
            "events": len(data["events"]), "artists": n_art, "generated_at": data["generated_at"],
        })
        print(f"{city['slug']}: {len(data['events'])} events, {n_art} artists matched, "
              f"{len(data['unmatched'])} unmatched, {sp.calls} API calls")

    # Preserve cities not processed this run.
    idx_path = DATA_DIR / "index.json"
    if idx_path.exists() and args.city:
        old = json.loads(idx_path.read_text())
        done = {c["slug"] for c in index["cities"]}
        index["cities"] += [c for c in old.get("cities", []) if c["slug"] not in done]
    idx_path.write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
