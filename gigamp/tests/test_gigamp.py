import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scraper"))

from scrape import classify, parse_page  # noqa: E402
from common import select_tracks  # noqa: E402


def test_classify_filters():
    assert classify("The Musical Box: A Genesis Tribute", ["The Musical Box"]) == "tribute"
    assert classify("Gimme Gimme Disco @ Rickshaw", ["Gimme Gimme Disco"]) == "club_night"
    assert classify("Comedy Night", ["Some Comedian"]) == "non_music"
    assert classify("Empty", []) == "no_performers"
    # Headline DJs / producers are ordinary billed acts and stay in.
    assert classify("BISCITS @ Commodore Ballroom", ["BISCITS", "Matroda"]) is None
    assert classify("Satin Jackets @ Village Studios", ["Satin Jackets"]) is None
    assert classify("Tame Impala @ Rogers Arena", ["Tame Impala", "Dominic Fike"]) is None


def test_parse_fixture():
    html = (ROOT / "tests" / "fixtures" / "songkick_page.html").read_text()
    events = parse_page(html)
    assert len(events) == 11
    e = events[0]
    assert e["venue"] == "Rogers Arena"
    assert [p["name"] for p in e["performers"]] == ["Tame Impala", "Dominic Fike"]
    assert "?" not in e["url"]
    assert e["status"] == "EventScheduled"


def _artist(name, genres, n):
    return {"name": name, "genres": genres, "songkick_genres": [],
            "tracks": [{"uri": f"spotify:track:{n}a", "name": "A"}, {"uri": f"spotify:track:{n}b", "name": "B"}]}


DATA = {"events": [
    {"date": "2026-09-10", "start": "2026-09-10T20:00", "venue": "Vogue Theatre",
     "artists": [_artist("Head", ["indie rock"], 1), _artist("Support", ["shoegaze"], 2)]},
    {"date": "2026-09-20", "start": "2026-09-20T20:00", "venue": "Rogers Arena",
     "artists": [_artist("Big", ["pop"], 3)]},
    {"date": "2026-11-01", "start": "2026-11-01T20:00", "venue": "Vogue Theatre",
     "artists": [_artist("Later", ["indie rock"], 4)]},
]}


def test_select_window_and_filters():
    today = date(2026, 9, 6)
    all_ = select_tracks(DATA, days=30, today=today)
    assert len(all_["uris"]) == 6 and len(all_["shows"]) == 2
    vogue = select_tracks(DATA, days=30, venues=["vogue theatre"], today=today)
    assert [s["venue"] for s in vogue["shows"]] == ["Vogue Theatre"]
    indie = select_tracks(DATA, days=30, genres=["indie"], today=today)
    assert indie["shows"][0]["artists"] == ["Head"]
    heads = select_tracks(DATA, days=30, headliners_only=True, today=today)
    assert len(heads["uris"]) == 4
    short = select_tracks(DATA, days=7, today=today)
    assert len(short["shows"]) == 1
