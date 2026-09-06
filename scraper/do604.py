"""
Do604 source: locally curated Vancouver listings, strong on small and DIY rooms that
Songkick misses (Green Auto, Red Gate, Lana Lou's...). Pages are per day:
https://do604.com/events/music/YYYY/MM/DD[?page=N], each listing carrying schema.org
microdata (name, location, startDate). Titles are free text, so artist names are
extracted heuristically and later validated against Spotify (strict name match).

Configure per city in cities.json:
  "do604": {"enabled": true, "venues": ["Green Auto", "Red Gate", ...]}
An empty venues list means "all venues" (noisy: Do604's music category includes
pub nights, comedy and festivals). The curated list is the recommended mode.
"""
import re
import time
from datetime import date, timedelta

import requests
from bs4 import BeautifulSoup

BASE = "https://do604.com/events/music/{d:%Y/%m/%d}"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36 GigAmp/0.2")

# Whole-listing rejects (Do604's "music" category is loose).
JUNK_RE = re.compile(
    r"\b(karaoke|trivia|bingo|comedy|comedian|improv|open mic|jam night|jam session|"
    r"happy hour|brunch|wings?|ribs|tacos?|burger|pint|(?:daily|drink|food|lunch|dinner) specials?|drag|burlesque|is funny|"
    r"festival|fest\b|fair\b|fringe|market|closed|patio|workshop|class|lesson|"
    r"screening|film|theatre|theater|musical|ballet|opera|symphony|orchestra|choir|"
    r"dance party|disco|night out|singalong|sing-along|tribute|the music of|"
    r"vinyl night|dj night|industry night|showcase night|every (mon|tue|wed|thu|fri|sat|sun)|"
    r"(?:mon|tues|wednes|thurs|fri|satur|sun)days?\s+(?:at|night|live)\b|"
    r"\$\d)\b",
    re.I,
)
# Prefix noise: "Early Show:", "MODO-LIVE presents", "MRG Live x Timbre present" ...
PREFIX_RE = re.compile(
    r"^(?:(?:early|late|matinee|second|2nd|first|1st)\s+show\s*[:\-]\s*|"
    r"(?:[\w'&.\- ]{2,40}\s+(?:presents?|present:|x)\s+)+|"
    r"do604\s+presents?\s+|sold out[:\- ]+)",
    re.I,
)
# Suffix noise: " - The Deadbeat Tour", " Tour 2026", " (Album Release)", " | 19+", " Tickets"
SUFFIX_RE = re.compile(
    r"(\s*[\-–—|:]\s*(?:the\s+)?[\w' .&!]*(?:tour|release|anniversary|years? of|live in|"
    r"in concert|residency|edition|night|party|show|celebration|farewell|reunion)\b.*$)|"
    r"(\s*\((?:[^)]*(?:tour|release|guests?|19\+|all ages|matinee|sold out)[^)]*)\)\s*$)|"
    r"(\s+(?:(?:north|south|american?|america|world|european?|europe|canadian|canada|uk|west coast|east coast|"
    r"pacific|fall|spring|summer|winter|autumn|farewell|anniversary|reunion|the|debut|headline|20\d\d)\s+)*tour(?:\s+20\d\d)?\b.*$)|"
    r"(\s+tickets?\s*$)|(\s+live\s*$)",
    re.I,
)
SUPPORT_SPLIT_RE = re.compile(r"\s*(?:,|\bwith\b|\bw/\s*|\bplus\b|\+|\bft\.?\b|\bfeat\.?\b|\bfeaturing\b|\bsupport(?:ed by)?:?\b|\bopeners?\b)\s*", re.I)
RELEASE_RE = re.compile(r"\s*(?:['\u2018\u2019\"\u201c\u201d][^'\u2018\u2019\"\u201c\u201d]{1,60}['\u2018\u2019\"\u201c\u201d]\s*)?(?:record|album|ep|single|vinyl|cassette)\s+release(?:\s+(?:show|party|concert))?", re.I)
DROP_TOKEN_RE = re.compile(
    r"^(?:special guests?|guests?|friends|tba|tbd|more|and more|others|dj set|dj|live|"
    r"support|opening act|album release|record release|band|the band|full band|quintet|trio|duo|"
    r"\d+(?:pm|am)?.*|.*\bsold out\b.*)$",
    re.I,
)


def extract_artists(title: str) -> list[str]:
    """Best-effort artist names from a Do604 listing title. Empty list = give up."""
    t = title.strip()
    t = PREFIX_RE.sub("", t)
    t = RELEASE_RE.sub("", t)
    t = re.sub(r"\s+", " ", t).strip(" -–—|:,")
    if not t or len(t) < 2:
        return []
    parts = [SUFFIX_RE.sub("", p).strip(" -–—|:,'\"") for p in SUPPORT_SPLIT_RE.split(t)]
    out = []
    for p in parts:
        # "Cody Johnson & Friends" -> keep whole; only split on & / and when it's a list.
        if not p or DROP_TOKEN_RE.match(p) or len(p) > 60:
            continue
        p = re.sub(r"\s+&\s+friends$", "", p, flags=re.I)
        if p.lower() not in {x.lower() for x in out}:
            out.append(p)
    return out[:6]


def norm_venue(v: str) -> str:
    v = re.sub(r"\(.*?\)", "", v or "").lower()
    v = re.sub(r"\b(the|at|vancouver|bc)\b", " ", v)
    return re.sub(r"[^a-z0-9]+", " ", v).strip()


def parse_page(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for li in soup.select(".ds-listing"):
        name_el = li.select_one(".ds-listing-event-title-text") or li.select_one('[itemprop="name"]')
        venue_el = li.select_one(".ds-venue-name")
        start_el = li.select_one('[itemprop="startDate"]')
        banner = (li.select_one(".ds-listing-banners") or li.select_one(".ds-listing-series"))
        banner_txt = banner.get_text(" ", strip=True) if banner else ""
        url_el = li.select_one('a[href*="/events/"]')
        if not (name_el and venue_el and start_el):
            continue
        out.append({
            "title": name_el.get_text(" ", strip=True),
            "venue": venue_el.get_text(" ", strip=True),
            "start": start_el.get("content") or start_el.get("datetime") or "",
            "banner": banner_txt,
            "url": (li.get("data-permalink") or (url_el.get("href") if url_el else "") or "").split("?")[0],
        })
    return out


def has_next(html: str) -> bool:
    return "Next Page" in html or 'rel="next"' in html


def fetch_day(d: date, session: requests.Session) -> list[dict]:
    items, page = [], 1
    while page <= 6:
        url = BASE.format(d=d) + (f"?page={page}" if page > 1 else "")
        r = session.get(url, headers={"User-Agent": UA}, timeout=30)
        if r.status_code == 404:
            break
        r.raise_for_status()
        items += parse_page(r.text)
        if not has_next(r.text):
            break
        page += 1
        time.sleep(1.0)
    return items


def scrape_do604(city: dict, horizon_days: int, fixture_html: str | None = None) -> list[dict]:
    """Return events in the same raw shape scrape.py uses, tagged source='do604'."""
    cfg = city.get("do604") or {}
    wanted = {norm_venue(v) for v in cfg.get("venues", [])}
    today = date.today()
    session = requests.Session()
    events, seen = [], set()
    days = [today + timedelta(days=i) for i in range(horizon_days + 1)]
    for d in days:
        items = parse_page(fixture_html) if fixture_html else fetch_day(d, session)
        if not fixture_html:
            time.sleep(1.2)
        for it in items:
            if not it["start"].startswith(d.isoformat()) and not fixture_html:
                continue                                  # multi-day runs repeat on every page
            if wanted and norm_venue(it["venue"]) not in wanted:
                continue
            if re.match(r"^(every|through)\b", it["banner"], re.I):
                continue                                  # weeklies and multi-day runs
            if JUNK_RE.search(it["title"]):
                continue
            artists = extract_artists(it["title"])
            if not artists:
                continue
            key = (it["start"][:10], norm_venue(it["venue"]), tuple(a.lower() for a in artists))
            if key in seen:
                continue
            seen.add(key)
            slug = it["url"].rstrip("/").rsplit("/", 1)[-1]
            events.append({
                "id": f"do604-{it['start'][:10]}-{slug[:40]}" if slug else None,
                "name": it["title"],
                "start": it["start"],
                "status": "EventScheduled",
                "venue": it["venue"],
                "venue_url": None,
                "locality": "Vancouver",
                "url": ("https://do604.com" + it["url"]) if it["url"].startswith("/") else it["url"],
                "performers": [{"name": a, "songkick_genres": [], "strict": True} for a in artists],
                "source": "do604",
            })
        if fixture_html:
            break
    return events
