"""Shared selection logic (mirrors docs/app.js — keep the two in step)."""
from datetime import date, timedelta

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
    g = [x.lower() for x in artist.get("genres") or []]
    if g:
        return g
    return [SONGKICK_GENRE_LABELS.get(x, x.replace("_", " ")) for x in artist.get("songkick_genres") or []]


def genre_matches(artist: dict, wanted: list[str]) -> bool:
    if not wanted:
        return True
    mine = artist_genres(artist)
    return any(w.lower() in g for w in wanted for g in mine)


def select_tracks(data: dict, days: int = 30, venues: list[str] | None = None,
                  exclude_venues: list[str] | None = None, genres: list[str] | None = None,
                  headliners_only: bool = False, today: date | None = None) -> dict:
    today = today or date.today()
    end = today + timedelta(days=days)
    venues_l = {v.lower() for v in (venues or [])}
    excl_l = {v.lower() for v in (exclude_venues or [])}
    uris, seen, shows = [], set(), []
    for e in sorted(data["events"], key=lambda e: e["start"]):
        d = date.fromisoformat(e["date"])
        if d < today or d > end:
            continue
        v = (e.get("venue") or "").lower()
        if venues_l and v not in venues_l:
            continue
        if v in excl_l:
            continue
        arts = e["artists"][:1] if headliners_only else e["artists"]
        arts = [a for a in arts if genre_matches(a, genres or [])]
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
