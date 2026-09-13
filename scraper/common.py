"""Shared selection logic (mirrors docs/app.js — keep the two in step)."""
import json
import re
from datetime import date, timedelta
from pathlib import Path

# Controlled genre vocabulary shared with the site (docs/genres.json).
_VOCAB = json.loads((Path(__file__).resolve().parent.parent / "docs" / "genres.json").read_text())
GENRES = [(g["id"], g["label"], [re.compile(p, re.I) for p in g["match"]]) for g in _VOCAB["genres"]]
GENRE_LABEL = {gid: label for gid, label, _ in GENRES}
JUNK = [re.compile(p, re.I) for p in _VOCAB.get("junk", [])]
MAX_GENRES = int(_VOCAB.get("max_per_artist", 3))


def map_tag(tag: str) -> str | None:
    """Map one raw tag to a canonical genre id, or None if it isn't a genre."""
    t = (tag or "").strip().lower()
    if not t or any(p.search(t) for p in JUNK):
        return None
    t = t.replace("_", " ")
    for gid, _, pats in GENRES:
        if any(p.search(t) for p in pats):
            return gid
    return None


def canonical_genres(artist: dict) -> list[str]:
    """Canonical genre labels for an artist: Spotify genres first, then Last.fm tags,
    then Songkick's coarse tags; mapped through the vocabulary, deduped, capped."""
    raw = list(artist.get("genres") or []) + list(((artist.get("reach") or {}).get("tags")) or []) \
        + list(artist.get("songkick_genres") or [])
    out = []
    for tag in raw:
        gid = map_tag(tag)
        if gid and GENRE_LABEL[gid] not in out:
            out.append(GENRE_LABEL[gid])
        if len(out) == MAX_GENRES:
            break
    return out

SONGKICK_GENRE_LABELS = {
    "indie_alternative": "indie / alternative",
    "rock": "rock",
    "pop": "pop",
    "metal": "metal",
    "punk": "punk",
    "hip_hop_rap": "hip hop / rap",
    "rnb": "r&b",
    "electronic": "electronic",
    "dance": "dance",
    "folk_blues": "folk / blues",
    "country": "country",
    "jazz": "jazz",
    "classical": "classical",
    "reggae": "reggae",
    "latin": "latin",
    "world": "world",
    "soul_funk": "soul / funk",
}


def artist_genres(artist: dict) -> list[str]:
    """Canonical genres (precomputed at build time when present)."""
    if artist.get("genres_canon") is not None:
        return [g.lower() for g in artist["genres_canon"]]
    return [g.lower() for g in canonical_genres(artist)]


def reach_tier(artist: dict) -> int:
    return int(((artist.get("reach") or {}).get("tier")) or 0)


def genre_matches(artist: dict, wanted: list[str]) -> bool:
    if not wanted:
        return True
    mine = artist_genres(artist)
    return any(w.lower() in g for w in wanted for g in mine)


def select_tracks(data: dict, days: int = 30, venues: list[str] | None = None,
                  exclude_venues: list[str] | None = None, genres: list[str] | None = None,
                  headliners_only: bool = False, today: date | None = None,
                  sources: list[str] | None = None, reach: tuple[int, int] | None = None) -> dict:
    """reach = (min_tier, max_tier) inclusive, tiers 0..4 (unknown..big)."""
    today = today or date.today()
    end = today + timedelta(days=days)
    venues_l = {v.lower() for v in (venues or [])}
    excl_l = {v.lower() for v in (exclude_venues or [])}
    uris, seen, shows = [], set(), []
    for e in sorted(data["events"], key=lambda e: e["start"]):
        d = date.fromisoformat(e["date"])
        if d < today or d > end:
            continue
        if sources and e.get("source", "songkick") not in sources:
            continue
        v = (e.get("venue") or "").lower()
        if venues_l and v not in venues_l:
            continue
        if v in excl_l:
            continue
        arts = e["artists"][:1] if headliners_only else e["artists"]
        arts = [a for a in arts if genre_matches(a, genres or [])]
        if reach:
            arts = [a for a in arts if reach[0] <= reach_tier(a) <= reach[1]]
        if not arts:
            continue
        picked = []
        for a in arts:
            for t in a["tracks"]:
                if t["uri"] not in seen:
                    seen.add(t["uri"])
                    uris.append(t["uri"])
                    picked.append(t["name"])
        shows.append({"date": e["date"], "venue": e.get("venue"), "artists": [a["name"] for a in arts], "tracks": picked})
    return {"uris": uris, "shows": shows, "start": today.isoformat(), "end": end.isoformat()}
