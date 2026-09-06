"""
GigAmp enrichment: matches scraped performers to Spotify artists (client-credentials
flow, no user login needed), pulls genres and the two top tracks per artist, and
writes the per-city dataset the site consumes.

Quota-aware: Spotify Development Mode has an unpublished daily request quota (a
QUOTA_EXCEEDED 429 with a ~24 h Retry-After). So this script
  * spends one request per artist where it can (combined artist+track search),
  * works nearest-show-first so the next few weeks are always covered,
  * stops cleanly when the quota trips, writes whatever it has, and exits 0,
  * keeps a cache (docs/data/cache/artists.json) so the next daily run resumes.

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
CACHE_TTL_DAYS = 30          # re-check an artist's tracks roughly monthly
MISS_TTL_DAYS = 14           # re-try artists we couldn't match after two weeks
TRACKS_PER_ARTIST = 2
MAX_CALLS_PER_RUN = int(os.environ.get("GIGAMP_MAX_CALLS", "0")) or None  # optional hard cap

API = "https://api.spotify.com/v1"


class QuotaExceeded(RuntimeError):
    pass


# --- Spotify client ----------------------------------------------------------
class Spotify:
    def __init__(self, client_id: str, client_secret: str):
        self.client_id, self.client_secret = client_id, client_secret
        self.token, self.token_expiry = None, 0
        self.s = requests.Session()
        self.calls = 0
        self.top_tracks_available = True   # flipped off on the first 403/404 from that endpoint

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
        if MAX_CALLS_PER_RUN and self.calls >= MAX_CALLS_PER_RUN:
            raise QuotaExceeded(f"Hit GIGAMP_MAX_CALLS={MAX_CALLS_PER_RUN}")
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
                    raise QuotaExceeded(f"Spotify daily quota exceeded after {self.calls} calls "
                                        f"(Retry-After {wait}s ≈ {wait // 3600}h)")
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


def artist_entry(a: dict, tracks: list[dict], rank_source: str) -> dict:
    return {
        "spotify_id": a["id"],
        "spotify_name": a["name"],
        "url": a["external_urls"]["spotify"],
        "genres": a.get("genres", []),
        "popularity": a.get("popularity"),
        "followers": (a.get("followers") or {}).get("total"),
        "image": (a.get("images") or [{}])[-1].get("url"),
        "tracks": tracks,
        "rank_source": rank_source,
    }


def lookup_artist(sp: Spotify, name: str, market: str, cache: dict) -> dict:
    """Resolve one billed act to a Spotify artist + two tracks, cheaply.

    1. One combined search (type=artist,track, artist-scoped query) usually yields
       both the artist and their top-ranked tracks: 1 request.
    2. If the app still has /artists/{id}/top-tracks (Extended Quota Mode), use it
       for Spotify's own popularity ranking: +1 request, tried once per run.
    3. If the scoped query found no artist, retry with a plain query: +1 request.
    """
    key = norm(name)
    hit = cache.get(key)
    if hit and hit.get("fetched_at"):
        age = datetime.now(timezone.utc) - datetime.fromisoformat(hit["fetched_at"])
        ttl = CACHE_TTL_DAYS if hit.get("spotify_id") else MISS_TTL_DAYS
        if age < timedelta(days=ttl):
            return hit

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    res = sp.get("/search", q=f'artist:"{name}"', type="artist,track", limit=10, market=market)
    cands = res.get("artists", {}).get("items", [])
    a = pick_artist(name, cands)
    tracks_pool = res.get("tracks", {}).get("items", [])
    if not a:
        res = sp.get("/search", q=name, type="artist", limit=5, market=market)
        a = pick_artist(name, res.get("artists", {}).get("items", []))
        tracks_pool = []
    if not a:
        cache[key] = {"query": name, "fetched_at": now, "spotify_id": None}
        return cache[key]

    tracks, rank_source = [], "search"
    if sp.top_tracks_available:
        try:
            j = sp.get(f"/artists/{a['id']}/top-tracks", market=market)
            tracks = _dedupe_take(j.get("tracks", []), TRACKS_PER_ARTIST)
            rank_source = "top_tracks"
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code in (403, 404, 410):
                sp.top_tracks_available = False    # Development Mode: don't waste calls retrying
            else:
                raise
    if not tracks:
        own = [t for t in tracks_pool if any(x["id"] == a["id"] for x in t.get("artists", []))]
        if not own and not tracks_pool:
            j = sp.get("/search", q=f'artist:"{a["name"]}"', type="track", limit=10, market=market)
            own = [t for t in j.get("tracks", {}).get("items", []) if any(x["id"] == a["id"] for x in t.get("artists", []))]
        tracks = _dedupe_take(own, TRACKS_PER_ARTIST)
        rank_source = "search"

    entry = {"query": name, "fetched_at": now}
    entry.update(artist_entry(a, tracks, rank_source))
    cache[key] = entry
    return entry


# --- Build -------------------------------------------------------------------
def build_city(city: dict, raw: dict, cache: dict, pending: list[str], stopped_reason: str | None) -> dict:
    """Assemble the site dataset from the raw events and whatever the cache holds."""
    events_out, unmatched = [], []
    for e in raw["events"]:
        artists = []
        for p in e["performers"]:
            a = cache.get(norm(p["name"]))
            if a and a.get("spotify_id") and a.get("tracks"):
                artists.append({
                    "name": p["name"],
                    "spotify_name": a["spotify_name"],
                    "spotify_id": a["spotify_id"],
                    "url": a["url"],
                    "genres": a["genres"],
                    "songkick_genres": p.get("songkick_genres", []),
                    "popularity": a.get("popularity"),
                    "followers": a.get("followers"),
                    "image": a.get("image"),
                    "tracks": a["tracks"],
                    "rank_source": a.get("rank_source"),
                })
            elif a:   # looked up, no usable match
                unmatched.append({"artist": p["name"], "event": e["name"], "date": e["start"][:10]})
        if artists:
            events_out.append({
                "id": e["id"], "name": e["name"], "date": e["start"][:10], "start": e["start"],
                "venue": e["venue"], "locality": e["locality"], "url": e["url"],
                "headliner": artists[0]["name"], "artists": artists,
            })
    return {
        "city": city["slug"],
        "city_name": city["name"],
        "market": city.get("market", "US"),
        "timezone": city.get("timezone"),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scraped_at": raw["scraped_at"],
        "horizon_days": raw["horizon_days"],
        "source": raw["source"],
        "events": events_out,
        "unmatched": unmatched,
        "pending": pending,                     # acts not yet looked up (quota); next run continues
        "stopped_reason": stopped_reason,
        "skipped": [{"name": s["name"], "date": s["start"][:10], "venue": s["venue"], "reason": s["skip_reason"]}
                    for s in raw.get("skipped", [])],
    }


def enrich_city(sp: Spotify, city: dict, cache: dict) -> dict:
    raw = json.loads((RAW_DIR / f"{city['slug']}.json").read_text())
    market = city.get("market", "US")
    # Nearest shows first, headliners before support, each act once.
    queue, seen = [], set()
    for e in sorted(raw["events"], key=lambda e: e["start"]):
        for p in e["performers"]:
            k = norm(p["name"])
            if k and k not in seen:
                seen.add(k)
                queue.append(p["name"])
    stopped, pending = None, []
    for i, name in enumerate(queue):
        try:
            lookup_artist(sp, name, market, cache)
        except QuotaExceeded as e:
            stopped = str(e)
            pending = queue[i:]
            break
    return build_city(city, raw, cache, pending, stopped)


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
    quota_hit = False
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
            "events": len(data["events"]), "artists": n_art, "pending": len(data["pending"]),
            "generated_at": data["generated_at"],
        })
        print(f"{city['slug']}: {len(data['events'])} events, {n_art} artists matched, "
              f"{len(data['unmatched'])} unmatched, {len(data['pending'])} pending, "
              f"{sp.calls} API calls, top-tracks endpoint {'available' if sp.top_tracks_available else 'unavailable (Dev Mode)'}")
        if data["stopped_reason"]:
            quota_hit = True
            print(f"  stopped early: {data['stopped_reason']} - the next run picks up the remaining acts.")

    idx_path = DATA_DIR / "index.json"
    if idx_path.exists() and args.city:
        old = json.loads(idx_path.read_text())
        done = {c["slug"] for c in index["cities"]}
        index["cities"] += [c for c in old.get("cities", []) if c["slug"] not in done]
    idx_path.write_text(json.dumps(index, indent=1))
    if quota_hit:
        print("::warning::Spotify daily quota reached; dataset is partial and will fill in on the next run.")


if __name__ == "__main__":
    main()
