#!/usr/bin/env python3
"""
Seed pool for GigAmp's taste comparison game.

The game asks "which would you rather see live?" and needs acts the visitor is
likely to recognise. Those acts do NOT have to be playing locally: they are a
measuring instrument, not a recommendation. Only the For You rails are limited
to gigs actually happening in the city.

So this walks the controlled genre vocabulary, asks Last.fm for the most-listened
artists carrying each genre's tag, resolves each one to a Spotify artist and a
playable track through the same cache and matcher enrich.py uses, and writes
docs/seed-artists.json.

Quota behaviour mirrors enrich.py: Spotify Development Mode has a daily request
quota, so this stops cleanly when it trips, writes whatever it has, and exits 0.
The artist cache is shared with enrich.py, so a second run is nearly free and any
act already resolved for a local gig costs nothing here.

Env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, LASTFM_API_KEY

Usage:
  python scraper/seed_artists.py                     # refresh the whole pool
  python scraper/seed_artists.py --per-genre 8       # smaller pool, fewer calls
  python scraper/seed_artists.py --max-new 60        # cap new Spotify lookups this run

Output: docs/seed-artists.json
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import canonical_genres  # noqa: E402
import enrich  # noqa: E402
import lastfm as lastfm_mod  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "docs" / "seed-artists.json"

# Last.fm tag to query for each canonical genre id. Kept here rather than in
# genres.json because it is a lookup detail of this script: genres.json is the
# shared vocabulary and both the pipeline and the site parse it.
SEED_TAGS = {
    "post-punk": "post-punk", "hardcore": "hardcore", "emo": "emo", "punk": "punk",
    "metal": "metal", "grunge": "grunge", "shoegaze": "shoegaze", "dream-pop": "dream pop",
    "psychedelic": "psychedelic rock", "garage": "garage rock", "noise": "noise rock",
    "post-rock": "post-rock", "prog": "progressive rock", "indie": "indie",
    "alternative": "alternative rock", "indie-pop": "indie pop", "synth-pop": "synthpop",
    "rock": "rock", "pop": "pop", "house": "house", "techno": "techno",
    "bass": "drum and bass", "trance": "trance", "ambient": "ambient",
    "industrial": "industrial", "experimental": "experimental", "electronic": "electronic",
    "hip-hop": "hip-hop", "rnb": "rnb", "soul": "soul", "funk": "funk", "disco": "disco",
    "jazz": "jazz", "blues": "blues", "americana": "americana", "country": "country",
    "folk": "folk", "singer-songwriter": "singer-songwriter", "latin": "latin",
    "reggae": "reggae", "world": "world music", "classical": "classical",
    # "spoken" (comedy) is filtered out of GigAmp everywhere else; no seeds for it.
}

# Kept after resolution, per genre, ranked by Last.fm listeners. The game only ever
# shows a handful, but a wider pool means the later, harder rounds have somewhere to go.
KEEP_PER_GENRE = 8
MARKET = "CA"


def slim(entry: dict, name: str) -> dict | None:
    """The fields the browser needs, and nothing else — this file is fetched on every visit."""
    if not entry or not entry.get("spotify_id") or not entry.get("tracks"):
        return None
    genres = canonical_genres(entry)
    if not genres:
        return None                      # no genre means no taste vector, so it is useless here
    reach = entry.get("reach") or {}
    return {
        "name": entry.get("spotify_name") or name,
        "spotify_id": entry["spotify_id"],
        "url": entry.get("url"),
        "image": entry.get("image"),
        "genres_canon": genres,
        "reach": {"listeners": reach.get("listeners") or 0, "tier": reach.get("tier") or 0},
        "tracks": [{"id": t["id"], "uri": t["uri"], "name": t["name"]} for t in entry["tracks"][:1]],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-genre", type=int, default=14, help="artists requested from Last.fm per genre")
    ap.add_argument("--keep-per-genre", type=int, default=KEEP_PER_GENRE)
    ap.add_argument("--max-new", type=int, default=0, help="stop after this many uncached Spotify lookups (0 = no cap)")
    args = ap.parse_args()

    lfm = lastfm_mod.from_env()
    if not lfm.enabled:
        sys.exit("LASTFM_API_KEY is required: the seed pool is built from Last.fm tag charts")
    cid, sec = enrich.os.environ.get("SPOTIFY_CLIENT_ID"), enrich.os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET")
    sp = enrich.Spotify(cid, sec)

    enrich.CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    cache = json.loads(enrich.CACHE_FILE.read_text()) if enrich.CACHE_FILE.exists() else {}
    before = set(cache)

    by_id: dict[str, dict] = {}
    per_genre_counts: dict[str, int] = {}
    stopped = None

    try:
        for gid, tag in SEED_TAGS.items():
            chart = lfm.tag_top_artists(tag, limit=args.per_genre)
            if not chart:
                print(f"  {gid}: no Last.fm chart for tag '{tag}'", file=sys.stderr)
                continue
            kept = 0
            for row in chart:
                if kept >= args.keep_per_genre:
                    break
                name = row["name"]
                if args.max_new and len(set(cache) - before) >= args.max_new:
                    stopped = "max_new reached"
                    raise StopIteration
                entry = enrich.lookup_artist(sp, name, MARKET, cache, strict=False, lfm=lfm)
                s = slim(entry, name)
                if not s:
                    continue
                kept += 1
                prev = by_id.get(s["spotify_id"])
                if prev:
                    # Already seeded from another genre: keep it once, union the genres.
                    for g in s["genres_canon"]:
                        if g not in prev["genres_canon"]:
                            prev["genres_canon"].append(g)
                    continue
                by_id[s["spotify_id"]] = s
            per_genre_counts[gid] = kept
    except StopIteration:
        pass
    except enrich.QuotaExceeded:
        stopped = "spotify_quota"
    finally:
        enrich.CACHE_FILE.write_text(json.dumps(cache, indent=0, ensure_ascii=False))

    artists = sorted(by_id.values(), key=lambda a: -(a["reach"]["listeners"] or 0))
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "market": MARKET,
        "count": len(artists),
        "stopped_reason": stopped,
        "artists": artists,
    }
    if stopped and OUT_FILE.exists():
        # A partial run must never shrink a good pool: merge over what is already there.
        old = json.loads(OUT_FILE.read_text())
        merged = {a["spotify_id"]: a for a in old.get("artists", [])}
        merged.update({a["spotify_id"]: a for a in artists})
        out["artists"] = sorted(merged.values(), key=lambda a: -(a["reach"]["listeners"] or 0))
        out["count"] = len(out["artists"])

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=0, ensure_ascii=False))
    thin = [g for g, n in per_genre_counts.items() if n < 3]
    print(f"seed pool: {out['count']} artists across {len(per_genre_counts)} genres, "
          f"{sp.calls} Spotify calls, {lfm.calls} Last.fm calls -> {OUT_FILE.relative_to(ROOT)}")
    if thin:
        print(f"  thin genres (under 3 acts): {', '.join(thin)}", file=sys.stderr)
    if stopped:
        print(f"::warning::seed pool run stopped early ({stopped}); existing entries were kept "
              f"and the next run fills in the rest.")


if __name__ == "__main__":
    main()
