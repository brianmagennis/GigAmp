# GigAmp — working folder

This folder is where Claude writes the latest GigAmp code. Upload from here.

## Current release: v0.14 (19 Sep 2026)

- **Copy for Spotify actually works now.** It was copying "Artist - Track" lines, which
  Spotify has no way to import - a straight bug against mechanism 1 in
  `claude/multi-platform-playlist-export.md`. It now copies
  `https://open.spotify.com/track/<id>` one per line, which the Spotify desktop app and
  web player accept when pasted into a playlist, and the status line says where to
  paste. A "plain list" link beside it still gives the Artist - Track text for Soundiiz
  and TuneMyMusic. On a phone it says so rather than pretending.
- **Phone faceplate**: normally a one-line readout ("Vancouver · Everything · Any size ·
  30 days"), 43px tall. Tap it and the dials open at full 92px, two across, every
  position written out and tappable. Four 58px rotaries in a row were a bad touch
  target; collapsed this is shorter than that row was, so the survey gains room.
  Desktop is unchanged and never collapses.
- **For You is about half as tall**: a rail card shows the act it is about plus
  "+N more on the bill", instead of the whole lineup. Section is now ~1 screen.

## Previous: v0.13 (17 Sep 2026)

- Audience size is back on the faceplate as a fourth dial, but as a **ceiling**, not a
  range: Underground only / Up to emerging / Up to established / Any size. A ceiling is
  genuinely one value, so the single pointer is honest rather than a lossy stand-in for
  two. It behaves like a volume knob - turned down for the underground, up for anything.
- The two-ended slider in Advanced search is unchanged and is still the way to set a
  floor. Dial and slider stay in step; if you set a floor the dial reads "custom"
  rather than pointing somewhere wrong.

## Previous: v0.12 (17 Sep 2026)

- The "acts left out" panel is gone again.
- Audience size is no longer a dial; it is the slider at the top of Advanced search.
  Three dials remain: City, Sources, Window.
- Venues and Genres both have **select all** and **clear**, so "everything except
  these two" is a couple of clicks.
- The collapsed Advanced search summary no longer reads "unknown-emerging"; it names
  the preset ("rising") or spells the range out.
- **Because you liked** is one rail, not two. It rotates to a different act on every
  page load, and starring a show makes that act a seed - a fresh star leads within a
  few refreshes. Cards inside it no longer repeat the heading.
- No rail repeats its opening clause across its cards, and a card's reason always
  names the act at the top of that card's bill.

## Previous: v0.11 (17 Sep 2026)

- The whole personalised block (survey + For You) is one module you can collapse to
  drop straight to the show list, and that choice is remembered.
- Venue and genre filters moved into **Advanced search**, directly under the dials.
- Each dial lists all its positions and highlights the selected one; the words are
  clickable too.
- **Advanced search now lists the billed acts left out of the listings**, grouped by
  why (never scrobbled / no Spotify match / matched but no playable track) with the
  near-miss names Spotify offered. That data was always in `docs/data/<city>.json`
  under `unmatched` — the site just never showed it.

## Previous: v0.10 (17 Sep 2026)

- Taste survey artists now come from a Last.fm seed pool and no longer need a local
  gig. Local and emerging acts still appear in the later rounds.
- Amp faceplate: City, Sources, Audience, Window as click-to-step dials, always visible.
- Single column of collapsible modules: faceplate, For You, Filters, then the show list.
- For You is three rails of two shows each, with a "more" link.
- "Tune For You" asks three further questions instead of silently doing nothing.
- Every round has a "Neither — skip this pair" so a guess never pollutes the profile.

## What to upload to GitHub

1. Drag the whole `docs` folder in. `index.html`, `app.js` and `config.js` must always
   go up together — the page and the script are versioned as a pair.
2. Drag the whole `scraper` folder in. `seed_artists.py` is new; `lastfm.py` has a new
   `tag_top_artists` method that the new script needs. `enrich.py`, `scrape.py`,
   `do604.py`, `venues.py`, `common.py` and `cities.json` are unchanged, so they are
   not in here — only upload what is here and leave the rest alone.
3. `tests` is optional developer tooling. Nothing in `docs` depends on it.

## One workflow change you need to make by hand

`.github/workflows/refresh.yml` is not in this folder (it is not in the release zips),
so add this step yourself, after the `enrich.py` step and before the commit step:

    - name: Refresh taste-survey seed pool
      run: python scraper/seed_artists.py
      env:
        SPOTIFY_CLIENT_ID: ${{ secrets.SPOTIFY_CLIENT_ID }}
        SPOTIFY_CLIENT_SECRET: ${{ secrets.SPOTIFY_CLIENT_SECRET }}
        LASTFM_API_KEY: ${{ secrets.LASTFM_API_KEY }}

Make sure the commit step also picks up `docs/seed-artists.json`.

The first run resolves roughly 300 new artists on Spotify, which is the largest single
demand this project has made on the Dev Mode daily quota. If it trips, the script writes
what it got and exits 0, and the next run fills in the rest. To be gentle the first time:

    python scraper/seed_artists.py --max-new 80

The site works without the file — it falls back to surveying acts that have local gigs,
which is how v0.9 behaved — so uploading `docs` before the pipeline has run is safe.

## What is deliberately NOT in here

- `docs/data/` — listings JSON, generated weekly by the Action.
- `docs/seed-artists.json` — the seed pool, generated by `scraper/seed_artists.py`.

Both are produced by the pipeline. If either appears in this folder it is synthetic test
data written by `tests/make_fixture.py`; do not upload it or it will overwrite the real
thing.

## Files

    docs/index.html    page shell, all styles, the faceplate markup
    docs/app.js        listings, comparison game, taste model, For You, the dials
    docs/config.js     city default, survey tuning, rail sizes
    docs/genres.json   the 43-genre controlled vocabulary (shared with scraper/common.py)

    scraper/seed_artists.py  builds docs/seed-artists.json from Last.fm tag charts
    scraper/lastfm.py        adds tag_top_artists()

    tests/make_fixture.py     synthetic docs/data + docs/seed-artists.json, no scraper needed
    tests/browser_test.mjs    74 end-to-end checks in headless Chromium, desktop and phone
    tests/selector_test.mjs   39 checks driving six simulated listeners through the survey

Running the tests needs Node and Playwright:

    python3 tests/make_fixture.py
    node tests/browser_test.mjs
    node tests/selector_test.mjs

## Also in this folder

`Code Sept 10/` is an older snapshot of the scraper from before v0.8. Left untouched.
