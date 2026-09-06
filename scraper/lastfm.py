"""
Last.fm lookups: free, generous, and the only open source of artist audience size that
covers tiny acts. artist.getInfo gives total listeners + playcount + community tags.

We use it for two things:
  * "reach" (audience-size tiers on a log scale) for the site's slider
  * a cheap pre-filter: an act Last.fm has never seen is almost never on Spotify either,
    so we skip the (quota-limited) Spotify request for heuristic names.

Env: LASTFM_API_KEY  (free key: https://www.last.fm/api/account/create)
"""
import os
import re
import time

import requests

API = "https://ws.audioscrobbler.com/2.0/"
UA = "GigAmp/0.4 (+https://github.com/brianmagennis/GigAmp)"

# Tag noise Last.fm users add that isn't a genre.
TAG_JUNK_RE = re.compile(
    r"^(seen live|all|favorites?|favourites?|awesome|love|beautiful|amazing|good|great|"
    r"under \d+ listeners|\d{2,4}s?|canada|canadian|vancouver|british columbia|usa|american|"
    r"british|uk|female vocalists?|male vocalists?|singer-songwriter|songwriter|"
    r"my music|check out|new|local|indie\s*$)$", re.I)

# Audience tiers on Last.fm total listeners (log-ish). Index doubles as slider position.
TIERS = [
    ("unknown", 0, 0),                     # not on Last.fm at all
    ("underground", 1, 5_000),
    ("emerging", 5_000, 50_000),
    ("established", 50_000, 500_000),
    ("big", 500_000, float("inf")),
]


def tier_for(listeners) -> int:
    if not listeners:
        return 0
    for i, (_, lo, hi) in enumerate(TIERS[1:], start=1):
        if lo <= listeners < hi:
            return i
    return len(TIERS) - 1


class LastFM:
    def __init__(self, api_key: str | None):
        self.key = api_key
        self.s = requests.Session()
        self.calls = 0

    @property
    def enabled(self) -> bool:
        return bool(self.key)

    def artist_info(self, name: str) -> dict | None:
        """Return {'name','listeners','playcount','tags','url'} or None if unknown."""
        if not self.key:
            return None
        for attempt in range(3):
            r = self.s.get(API, params={"method": "artist.getInfo", "artist": name, "autocorrect": 0,
                                        "api_key": self.key, "format": "json"},
                           headers={"User-Agent": UA}, timeout=20)
            self.calls += 1
            if r.status_code == 429 or (r.status_code >= 500):
                time.sleep(2 * (attempt + 1))
                continue
            j = r.json()
            a = j.get("artist")
            if not a or j.get("error"):
                return None
            stats = a.get("stats") or {}
            tags = [t["name"].lower() for t in (a.get("tags") or {}).get("tag", []) if isinstance(t, dict)]
            tags = [t for t in tags if not TAG_JUNK_RE.match(t)][:4]
            listeners = int(stats.get("listeners") or 0)
            # Last.fm auto-creates empty pages for anything ever scrobbled once; treat ~0 as unknown.
            if listeners < 2:
                return None
            return {"name": a.get("name"), "listeners": listeners, "playcount": int(stats.get("playcount") or 0),
                    "tags": tags, "url": a.get("url")}
        return None


def from_env() -> LastFM:
    return LastFM(os.environ.get("LASTFM_API_KEY"))
