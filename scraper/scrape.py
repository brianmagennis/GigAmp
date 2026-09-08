"""
GigAmp scraper: pulls upcoming concerts for each configured city from Songkick's
metro-area listing pages (JSON-LD MusicEvent blocks) and writes a raw events file.

Usage:
  python scraper/scrape.py                 # all cities in cities.json
  python scraper/scrape.py --city vancouver
  python scraper/scrape.py --fixture tests/fixtures/songkick_page.html --city vancouver

Output: docs/data/raw/<city>.json
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent))
from do604 import scrape_do604, norm_venue  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "scraper" / "cities.json").read_text())
RAW_DIR = ROOT / "docs" / "data" / "raw"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36 GigAmp/0.1 (+https://github.com)")

# --- Filters -----------------------------------------------------------------
# Tribute / cover acts: excluded per Brian's spec.
TRIBUTE_RE = re.compile(
    r"\b(tribute|a tribute to|covers? band|cover show|the music of|plays the music of|"
    r"performs the (?:album|music|songs) of|celebrat(?:ing|ion of) the music of|"
    r"the .{2,40} experience|revisited|reimagined|symphonic .{2,40} concert)\b",
    re.I,
)
# Club nights / themed party events: excluded, unless a real headline act is billed.
CLUB_NIGHT_RE = re.compile(
    r"\b(emo night|disco night|dance party|club night|silent disco|karaoke|"
    r"gimme gimme disco|frosh|throwback|theme(?:d)? party|rave|after ?party|"
    r"drag brunch|bingo|trivia|open mic|jam night|showcase night|dj night|"
    r"night out|singalong|sing-along)\b",
    re.I,
)
# Things that are not gigs at all.
NON_MUSIC_RE = re.compile(
    r"\b(comedy|comedian|stand[- ]?up|podcast|lecture|film|screening|orchestra|"
    r"symphony|ballet|opera|musical theatre|circus|magic show)\b",
    re.I,
)


def classify(event_name: str, performers: list[str]) -> str | None:
    """Return a skip reason, or None if the event should be kept."""
    text = " | ".join([event_name] + performers)
    if TRIBUTE_RE.search(text):
        return "tribute"
    if NON_MUSIC_RE.search(text):
        return "non_music"
    if CLUB_NIGHT_RE.search(text):
        return "club_night"
    if not performers:
        return "no_performers"
    return None


# --- Parsing -----------------------------------------------------------------
def parse_page(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    events = []
    for tag in soup.select('script[type="application/ld+json"]'):
        try:
            data = json.loads(tag.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        for item in data if isinstance(data, list) else [data]:
            if item.get("@type") != "MusicEvent":
                continue
            loc = item.get("location") or {}
            addr = loc.get("address") or {}
            geo = loc.get("geo") or {}
            performers = []
            for p in item.get("performer") or []:
                name = (p.get("name") or "").strip()
                if name:
                    performers.append({
                        "name": name,
                        "songkick_genres": p.get("genre") or [],
                        "songkick_url": p.get("sameAs"),
                    })
            url = (item.get("url") or "").split("?")[0]
            events.append({
                "source": "songkick",
                "id": re.sub(r"\D", "", url.rsplit("/", 1)[-1])[:12] or None,
                "name": item.get("name"),
                "start": item.get("startDate"),
                "status": (item.get("eventStatus") or "").rsplit("/", 1)[-1],
                "venue": loc.get("name"),
                "venue_url": loc.get("sameAs"),
                "locality": addr.get("addressLocality"),
                "lat": geo.get("latitude"),
                "lng": geo.get("longitude"),
                "url": url,
                "performers": performers,
            })
    return events


def next_page_exists(html: str, page: int) -> bool:
    return f"page={page + 1}" in html


# --- Fetching ----------------------------------------------------------------
def fetch(url: str, session: requests.Session, retries: int = 4) -> str:
    for attempt in range(retries):
        r = session.get(url, headers={"User-Agent": UA}, timeout=30)
        if r.status_code == 200:
            return r.text
        if r.status_code in (429, 503):
            time.sleep(int(r.headers.get("Retry-After", 0) or 15 * (attempt + 1)))
            continue
        r.raise_for_status()
    raise RuntimeError(f"Failed to fetch {url}")


def scrape_city(city: dict, horizon_days: int, max_pages: int, fixture: Path | None = None) -> dict:
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(days=horizon_days)
    base = f"https://www.songkick.com/metro-areas/{city['songkick_metro_id']}"
    session = requests.Session()
    all_events, page = [], 1
    while page <= max_pages:
        if fixture:
            html = fixture.read_text()
        else:
            url = base if page == 1 else f"{base}?page={page}"
            html = fetch(url, session)
            time.sleep(1.5)  # be polite
        events = parse_page(html)
        all_events.extend(events)
        past_horizon = [e for e in events if e["start"] and e["start"][:10] > horizon.strftime("%Y-%m-%d")]
        if fixture or not events or past_horizon or not next_page_exists(html, page):
            break
        page += 1

    # Second source: Do604 for the small rooms Songkick misses. Songkick wins on overlap
    # (same date + venue) because its artist data is structured.
    do604_added = 0
    if (city.get("do604") or {}).get("enabled") and not fixture:
        try:
            sk_keys = {(e["start"][:10], norm_venue(e["venue"] or "")) for e in all_events if e["start"]}
            for e in scrape_do604(city, horizon_days):
                if (e["start"][:10], norm_venue(e["venue"] or "")) in sk_keys:
                    continue
                all_events.append(e)
                do604_added += 1
        except Exception as ex:  # a Do604 outage must not sink the Songkick data
            print(f"do604: failed, continuing with Songkick only ({ex})", file=sys.stderr)

    kept, skipped, seen = [], [], set()
    for e in all_events:
        if not e["start"] or e["start"][:10] > horizon.strftime("%Y-%m-%d"):
            continue
        if e["start"][:10] < now.strftime("%Y-%m-%d"):
            continue
        if e["status"] in ("EventCancelled", "EventPostponed"):
            continue
        key = (e["start"][:10], (e["venue"] or "").lower(), tuple(p["name"].lower() for p in e["performers"]))
        if key in seen:
            continue
        seen.add(key)
        reason = classify(e["name"] or "", [p["name"] for p in e["performers"]])
        if reason:
            e["skip_reason"] = reason
            skipped.append(e)
        else:
            kept.append(e)

    return {
        "city": city["slug"],
        "city_name": city["name"],
        "source": base,
        "scraped_at": now.isoformat(timespec="seconds"),
        "horizon_days": horizon_days,
        "pages_fetched": page,
        "do604_events": do604_added,
        "events": kept,
        "skipped": skipped,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city")
    ap.add_argument("--fixture", type=Path)
    args = ap.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cities = [c for c in CONFIG["cities"] if not args.city or c["slug"] == args.city]
    if not cities:
        sys.exit(f"No city matching {args.city!r} in cities.json")
    failures = 0
    for city in cities:
        out = RAW_DIR / f"{city['slug']}.json"
        try:
            result = scrape_city(city, CONFIG["horizon_days"], CONFIG["max_pages"], args.fixture)
        except Exception as ex:
            # Keep yesterday's listings rather than failing the whole run (Songkick 429s, timeouts...).
            failures += 1
            if out.exists():
                print(f"::warning::{city['slug']}: scrape failed ({ex}); keeping previous raw data", file=sys.stderr)
                continue
            print(f"::error::{city['slug']}: scrape failed and no previous data ({ex})", file=sys.stderr)
            continue
        out.write_text(json.dumps(result, indent=1, ensure_ascii=False))
        print(f"{city['slug']}: {len(result['events'])} events kept "
              f"({result['do604_events']} from Do604), {len(result['skipped'])} skipped, "
              f"{result['pages_fetched']} Songkick page(s) -> {out.relative_to(ROOT)}")
    if failures and not any((RAW_DIR / f"{c['slug']}.json").exists() for c in cities):
        sys.exit(1)


if __name__ == "__main__":
    main()
