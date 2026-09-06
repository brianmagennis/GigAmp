# GigAmp

Hear who's playing near you, before they play. GigAmp turns a city's upcoming gig
listings into a Spotify playlist: pick your city, tick the venues you actually go to,
filter by genre, and get two tracks per act (their most-listened song plus their next
top song, which is usually the current single). A weekly GitHub Action keeps the
listings fresh and can re-sync your playlist every Friday without you touching it.

Runs entirely on GitHub: Pages hosts the site, Actions does the scraping. No server.

```
scraper/scrape.py      Songkick metro listings  ->  docs/data/raw/<city>.json
scraper/enrich.py      Spotify artist match + top tracks  ->  docs/data/<city>.json
scraper/common.py      Selection rules shared with the site (window, venues, genres)
docs/                  Static site (GitHub Pages) with in-browser Spotify login (PKCE)
sync/sync_playlists.py Weekly unattended playlist refresh for subscribers
sync/authorize.py      One-time helper to mint a refresh token for auto-sync
.github/workflows/     Friday cron: scrape -> enrich -> commit -> sync
```

## Setup (about 15 minutes)

### 1. Create the GitHub repo

Push this folder to a new repository on your GitHub account (public or private both
work; Pages on a private repo needs GitHub Pro). Then:

- Settings -> Pages -> Source: "Deploy from a branch", branch `main`, folder `/docs`.
  Note the URL it gives you, e.g. `https://<you>.github.io/gigamp/`.
- Settings -> Actions -> General -> Workflow permissions: "Read and write permissions".

### 2. Create the Spotify app

At https://developer.spotify.com/dashboard, Create app:

- Name: GigAmp. Redirect URIs, add both:
  - your Pages URL exactly, with trailing slash: `https://<you>.github.io/gigamp/`
  - `http://127.0.0.1:8888/callback` (for the auto-sync helper)
- API used: Web API. Save.
- Settings -> User Management: add the Spotify account email of everyone who will log
  in (Development Mode allows 5, each must have Premium; the owner must too).
- Copy the Client ID into `docs/config.js` (`spotifyClientId`). Commit and push.
- Copy Client ID and Client Secret into the repo's Actions secrets
  (Settings -> Secrets and variables -> Actions): `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`.

### 3. First data run

Actions -> "Weekly refresh" -> Run workflow. Two to three minutes later `docs/data/`
has the Vancouver dataset and the site is live. Open it, log in with Spotify, pick
venues and genres, Create playlist.

### 4. Optional: weekly auto-sync of your playlist

The site's "Weekly auto-refresh for this selection" panel prints a JSON block for your
current selection. Paste it into `sync/subscribers.json`, then on your Mac:

```
pip install requests
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... python sync/authorize.py
```

It opens a Spotify login and prints a refresh token. Save it as an Actions secret with
the name you used in `token_secret` (the default entry uses `SPOTIFY_REFRESH_TOKEN_BRIAN`),
and add a matching line under the "Sync subscriber playlists" step in
`.github/workflows/refresh.yml` if you add more subscribers. From then on the Friday
run rebuilds the playlist for the rolling window. Past shows fall off, new bookings appear.

## Adding a city

Add an entry to `scraper/cities.json`. The `songkick_metro_id` is the slug in a Songkick
metro URL, e.g. `https://www.songkick.com/metro-areas/17835-uk-london` -> `17835-uk-london`.
`market` is the Spotify market code used for track availability. Run the workflow.

## Filters

- Tribute and cover acts are dropped (`TRIBUTE_RE` in `scraper/scrape.py`).
- Themed club nights (emo night, disco parties, frosh, etc.) are dropped, but headline
  DJs and producers are ordinary billed acts and stay in (`CLUB_NIGHT_RE`).
- Comedy, film, orchestral and other non-gig listings are dropped (`NON_MUSIC_RE`).
- Cancelled and postponed shows are dropped; duplicates are merged.
- Acts with no Spotify match are listed as `unmatched` in the city JSON for review.

## Spotify API notes (September 2026)

Spotify's Development Mode (what a personal app gets) is capped at 5 users, requires
Premium, and since February 2026 no longer serves `/artists/{id}/top-tracks` or
`popularity` fields. GigAmp handles this automatically: it tries top-tracks first (works
for Extended Quota Mode apps and gives Spotify's own "Popular" ranking), and otherwise
falls back to an artist-scoped track search, whose relevance order tracks streaming
popularity closely. The `rank_source` field on each artist records which was used.
If you get access to an Extended Quota Mode app, just swap the Client ID and secret.

Playlist writes use the renamed `/playlists/{id}/items` endpoint with a fallback to
the legacy `/tracks` path.

## Local development

```
pip install -r requirements.txt
python scraper/scrape.py --city vancouver
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... python scraper/enrich.py --city vancouver
cd docs && python -m http.server 8000     # then open http://localhost:8000
python -m pytest tests/
```

Songkick's pages are fetched politely (one request every 1.5 s, a handful of pages a
week). If they change their markup, `parse_page` in `scrape.py` is the only place to fix.
