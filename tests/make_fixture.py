#!/usr/bin/env python3
"""Build a synthetic docs/data/vancouver.json so the front end can be exercised
locally (and in CI) without running the scraper. Not used in production."""
import json, random, sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
random.seed(7)

# name, canonical genres (labels from docs/genres.json), reach tier, listeners
ACTS = [
    ("IDLES", ["punk", "post-punk", "rock"], 4, 1_900_000),
    ("Fontaines D.C.", ["post-punk", "indie", "alternative"], 4, 1_600_000),
    ("Sabrina Carpenter", ["pop"], 4, 4_100_000),
    ("Dua Lipa", ["pop", "disco"], 4, 6_000_000),
    ("Charli XCX", ["pop", "synth-pop", "electronic"], 4, 3_200_000),
    ("Fred again..", ["house", "electronic", "dance" if False else "techno"], 4, 2_400_000),
    ("Zach Bryan", ["country", "americana", "folk"], 4, 2_800_000),
    ("Arctic Monkeys", ["indie", "rock", "alternative"], 4, 7_500_000),
    ("The Strokes", ["indie", "garage rock", "rock"], 4, 5_100_000),
    ("Wet Leg", ["indie", "post-punk", "indie pop"], 3, 900_000),
    ("Kendrick Lamar", ["hip hop", "r&b"], 4, 6_800_000),
    ("Tyler, The Creator", ["hip hop", "r&b", "soul"], 4, 4_400_000),
    ("SZA", ["r&b", "soul", "pop"], 4, 3_900_000),
    ("Bonobo", ["electronic", "ambient", "house"], 4, 2_100_000),
    ("Four Tet", ["electronic", "techno", "ambient"], 4, 1_500_000),
    ("Peggy Gou", ["house", "techno"], 3, 700_000),
    ("Sleep Token", ["metal", "prog", "alternative"], 4, 1_800_000),
    ("Turnstile", ["hardcore", "punk", "alternative"], 3, 800_000),
    ("Knocked Loose", ["hardcore", "metal"], 3, 420_000),
    ("Slowdive", ["shoegaze", "dream pop"], 3, 950_000),
    ("Beach House", ["dream pop", "indie", "shoegaze"], 4, 2_200_000),
    ("Khruangbin", ["psychedelic", "funk", "soul"], 4, 2_000_000),
    ("Vampire Weekend", ["indie", "indie pop", "rock"], 4, 3_100_000),
    ("Phoebe Bridgers", ["singer-songwriter", "indie", "folk"], 4, 2_600_000),
    ("Big Thief", ["folk", "indie", "singer-songwriter"], 3, 980_000),
    ("Jamie xx", ["electronic", "house", "techno"], 4, 1_700_000),
    ("Overmono", ["electronic", "bass / dnb", "techno"], 3, 480_000),
    ("Sampha", ["r&b", "soul", "electronic"], 3, 900_000),
    ("Little Simz", ["hip hop", "soul"], 3, 850_000),
    ("Black Midi", ["experimental", "prog", "noise"], 2, 340_000),
    ("Squid", ["post-punk", "experimental"], 2, 260_000),
    ("Alvvays", ["indie pop", "dream pop", "indie"], 3, 780_000),
    ("Japanese Breakfast", ["indie pop", "dream pop"], 3, 720_000),
    ("Michael Kiwanuka", ["soul", "folk", "blues"], 3, 1_100_000),
    ("Leon Bridges", ["soul", "r&b", "blues"], 3, 1_400_000),
    ("Sturgill Simpson", ["country", "americana"], 3, 900_000),
    ("Sierra Ferrell", ["americana", "folk", "country"], 2, 310_000),
    ("Chet Faker", ["electronic", "r&b", "soul"], 3, 1_200_000),
    ("Caribou", ["electronic", "house", "psychedelic"], 3, 990_000),
    ("Kaytranada", ["house", "hip hop", "funk"], 4, 1_900_000),
    ("Denzel Curry", ["hip hop"], 3, 1_300_000),
    ("JPEGMAFIA", ["hip hop", "experimental", "noise"], 3, 620_000),
    ("Godspeed You! Black Emperor", ["post-rock", "experimental"], 2, 420_000),
    ("Explosions in the Sky", ["post-rock", "ambient"], 3, 700_000),
    ("Chelsea Wolfe", ["metal", "experimental", "shoegaze"], 2, 380_000),
    ("Boygenius", ["indie", "singer-songwriter"], 4, 1_600_000),
    ("Amyl and the Sniffers", ["punk", "garage rock"], 3, 520_000),
    ("Viagra Boys", ["post-punk", "punk"], 3, 600_000),
    ("Shygirl", ["electronic", "hip hop", "bass / dnb"], 2, 290_000),
    ("Yaeji", ["house", "electronic"], 2, 350_000),
    # ---- Vancouver / emerging tier ----
    ("Dumb", ["post-punk", "punk", "garage rock"], 1, 4_200),
    ("Necking", ["punk", "garage rock"], 1, 3_100),
    ("Crack Cloud", ["post-punk", "experimental"], 2, 88_000),
    ("Peach Pit", ["indie", "indie pop"], 3, 640_000),
    ("Sleepy Gonzales", ["dream pop", "shoegaze"], 1, 9_500),
    ("Wine Lips", ["garage rock", "psychedelic", "punk"], 1, 14_000),
    ("Bratboy", ["punk", "garage rock"], 1, 2_800),
    ("Sightlines", ["post-rock", "ambient"], 1, 1_900),
    ("Yu Su", ["house", "electronic", "ambient"], 1, 22_000),
    ("Khari Wendell McClelland", ["soul", "folk", "blues"], 1, 1_200),
    ("Ishome", ["techno", "house"], 1, 6_400),
    ("Kimmortal", ["hip hop", "r&b"], 1, 3_600),
    ("So Loki", ["hip hop"], 1, 5_100),
    ("Haley Blais", ["indie pop", "singer-songwriter"], 2, 74_000),
    ("Devours", ["synth-pop", "electronic"], 1, 4_400),
    ("Mother Sun", ["psychedelic", "indie"], 1, 11_000),
    ("Sunglaciers", ["post-punk", "shoegaze"], 1, 7_700),
    ("Kite Tails", ["emo", "indie"], 1, 2_100),
    ("Pale Red", ["grunge", "alternative"], 1, 3_300),
    ("Bison", ["metal", "hardcore"], 1, 12_000),
    ("Jo Passed", ["noise", "psychedelic"], 1, 9_100),
    ("Sister Ray", ["americana", "singer-songwriter"], 1, 5_600),
    ("Blessed", ["post-punk", "experimental"], 1, 16_000),
    ("Pastel Cowboy", ["country", "americana"], 1, 1_400),
    ("Moon Shot", ["trance", "electronic"], 1, 2_600),
    ("Basement Revolver", ["shoegaze", "indie"], 2, 52_000),
    ("Tough Age", ["punk", "indie"], 1, 8_300),
    ("Sunshine Yard", ["reggae / dub", "soul"], 1, 2_200),
    ("Gilded", ["disco", "funk", "house"], 1, 3_900),
    ("Latin Quarter Collective", ["latin", "jazz"], 1, 1_700),
]

# Well-known acts that are NOT playing locally. The taste game must be able to use
# these; the For You rails must never show them, because they have no gig.
SEED_ONLY = [
    ("Radiohead", ["alternative", "experimental", "rock"], 4, 6_900_000),
    ("Taylor Swift", ["pop", "country"], 4, 8_200_000),
    ("Nine Inch Nails", ["industrial", "metal", "electronic"], 4, 3_300_000),
    ("Aphex Twin", ["electronic", "ambient", "experimental"], 4, 2_500_000),
    ("Burial", ["bass / dnb", "electronic", "ambient"], 3, 1_100_000),
    ("Joy Division", ["post-punk"], 4, 3_800_000),
    ("My Bloody Valentine", ["shoegaze", "noise"], 4, 1_900_000),
    ("Nas", ["hip hop"], 4, 2_700_000),
    ("Erykah Badu", ["r&b", "soul", "jazz"], 4, 2_000_000),
    ("Daft Punk", ["house", "electronic", "disco"], 4, 5_400_000),
    ("Johnny Cash", ["country", "americana", "folk"], 4, 3_100_000),
    ("Miles Davis", ["jazz"], 4, 2_300_000),
    ("Black Sabbath", ["metal", "rock"], 4, 3_600_000),
    ("Bad Brains", ["hardcore", "punk", "reggae / dub"], 3, 700_000),
    ("Cocteau Twins", ["dream pop", "shoegaze"], 3, 1_500_000),
    ("Bicep", ["house", "techno", "electronic"], 3, 900_000),
    ("Kraftwerk", ["electronic", "synth-pop", "experimental"], 4, 2_200_000),
    ("Bob Marley", ["reggae / dub", "soul"], 4, 4_100_000),
    ("Sufjan Stevens", ["folk", "indie", "singer-songwriter"], 4, 2_400_000),
    ("Mount Kimbie", ["electronic", "post-punk", "ambient"], 3, 600_000),
    ("Buena Vista Social Club", ["latin", "world", "jazz"], 3, 800_000),
    ("Slint", ["post-rock", "experimental"], 2, 400_000),
    ("Grimes", ["synth-pop", "electronic", "pop"], 4, 2_100_000),
    ("Anderson .Paak", ["r&b", "funk", "hip hop"], 4, 2_000_000),
    ("Bruce Springsteen", ["rock", "americana"], 4, 3_900_000),
]

VENUES = [
    ("commodore-ballroom", "Commodore Ballroom", "songkick"),
    ("orpheum", "Orpheum Theatre", "songkick"),
    ("rogers-arena", "Rogers Arena", "songkick"),
    ("pne-forum", "PNE Forum", "songkick"),
    ("rickshaw", "Rickshaw Theatre", "do604"),
    ("fox-cabaret", "Fox Cabaret", "do604"),
    ("wise-hall", "WISE Hall", "do604"),
    ("green-auto", "Green Auto", "do604"),
    ("hollywood", "Hollywood Theatre", "do604"),
    ("pearl", "The Pearl", "songkick"),
    ("cobalt", "The Cobalt", "do604"),
    ("red-room", "Red Room", "do604"),
]

def track(seed, i, artist):
    return {"id": f"{abs(hash((artist, i))) % 10**22:022d}"[:22],
            "uri": f"spotify:track:{abs(hash((artist, i))) % 10**22:022d}"[:37],
            "name": f"{artist.split()[0]} Song {i + 1}"}

def main():
    today = date.today()
    events = []
    for n, (name, genres, tier, listeners) in enumerate(ACTS):
        for rep in range(2 if tier >= 3 else 1):
            vid, vname, source = VENUES[(n + rep * 5) % len(VENUES)]
            d = today + timedelta(days=(n * 3 + rep * 11) % 40)
            support = []
            if random.random() < 0.55:
                s = ACTS[(n + 7 + rep) % len(ACTS)]
                support = [s]
            arts = []
            for j, (an, ag, at, al) in enumerate([(name, genres, tier, listeners)] + support):
                arts.append({
                    "name": an,
                    "spotify_name": an,
                    "spotify_id": f"sp{abs(hash(an)) % 10**20:020d}"[:22],
                    "url": f"https://open.spotify.com/artist/{abs(hash(an)) % 10**20:020d}",
                    "genres": ag, "songkick_genres": [], "image": "",
                    "tracks": [track(n, k, an) for k in range(2)],
                    "rank_source": "lastfm", "mbid": None,
                    "reach": {"listeners": al, "tier": at, "tags": ag, "lastfm_url": "", "mbid": None},
                    "genres_canon": ag, "also_billed": [],
                })
            events.append({
                "id": f"ev{n}-{rep}", "name": f"{name} at {vname}", "source": source,
                "date": d.isoformat(), "start": d.isoformat() + f"T{19 + (n % 3):02d}:30:00",
                "venue": vname, "venue_id": vid, "locality": "Vancouver",
                "url": f"https://example.invalid/{vid}/{n}-{rep}", "also_listed": [],
                "lat": 49.28, "lng": -123.12, "headliner": name, "artists": arts,
            })
    data = {
        "city": "vancouver", "city_name": "Vancouver, BC", "market": "CA",
        "timezone": "America/Vancouver",
        "generated_at": f"{today.isoformat()}T09:00:00Z", "scraped_at": f"{today.isoformat()}T09:00:00Z",
        "horizon_days": 45,
        "venues": {vid: {"name": vname, "lat": 49.28, "lng": -123.12, "aliases": []} for vid, vname, _ in VENUES},
        "events": events, "unmatched": [], "pending": [],
    }
    out = ROOT / "docs" / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "vancouver.json").write_text(json.dumps(data))
    (out / "index.json").write_text(json.dumps({"cities": [
        {"slug": "vancouver", "name": "Vancouver, BC"},
        {"slug": "victoria", "name": "Victoria, BC"},
    ]}))

    # The taste-game seed pool: every reasonably known local act plus acts with no
    # local gig at all, which is the whole point of seed-artists.json.
    seeds = []
    for name, genres, tier, listeners in [a for a in ACTS if a[2] >= 3] + SEED_ONLY:
        seeds.append({
            "name": name,
            "spotify_id": f"sp{abs(hash(name)) % 10**20:020d}"[:22],
            "url": f"https://open.spotify.com/artist/{abs(hash(name)) % 10**20:020d}",
            "image": "",
            "genres_canon": genres,
            "reach": {"listeners": listeners, "tier": tier},
            "tracks": [track(0, 0, name)],
        })
    (ROOT / "docs" / "seed-artists.json").write_text(json.dumps({
        "generated_at": f"{today.isoformat()}T09:00:00Z", "market": "CA",
        "count": len(seeds), "stopped_reason": None, "artists": seeds}))
    print(f"wrote {len(events)} events, {len(ACTS)} acts, {len(seeds)} seed artists "
          f"({len(SEED_ONLY)} with no local gig) -> {out}", file=sys.stderr)

if __name__ == "__main__":
    main()
