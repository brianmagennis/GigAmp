"""
GigAmp weekly sync: rebuilds each subscriber's Spotify playlist from the latest
city dataset, unattended (runs in GitHub Actions after the scrape).

Reads sync/subscribers.json. Each subscriber names the env var that holds their
refresh token (a GitHub Actions secret), obtained once with sync/authorize.py.

Env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, plus one <token_secret> per subscriber.
"""
import base64
import json
import os
import sys
import time
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scraper"))
from common import select_tracks  # noqa: E402

API = "https://api.spotify.com/v1"
DATA_DIR = ROOT / "docs" / "data"
SUBS = ROOT / "sync" / "subscribers.json"


def refresh_access_token(client_id, client_secret, refresh_token) -> str:
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    r = requests.post("https://accounts.spotify.com/api/token",
                      data={"grant_type": "refresh_token", "refresh_token": refresh_token},
                      headers={"Authorization": f"Basic {basic}"}, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Token refresh failed: {r.status_code} {r.text[:200]}")
    return r.json()["access_token"]


class Client:
    def __init__(self, token):
        self.h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def call(self, method, path, **kw):
        for _ in range(5):
            r = requests.request(method, f"{API}{path}", headers=self.h, timeout=30, **kw)
            if r.status_code == 429:
                time.sleep(int(r.headers.get("Retry-After", "5")) + 1)
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"{method} {path} -> {r.status_code} {r.text[:300]}")
            return r.json() if r.text else {}
        raise RuntimeError(f"{method} {path} rate limited repeatedly")


def find_or_create_playlist(c: Client, name: str, public: bool) -> str:
    me = c.call("GET", "/me")
    offset = 0
    while True:
        page = c.call("GET", "/me/playlists", params={"limit": 50, "offset": offset})
        for p in page.get("items", []):
            if p and p.get("name") == name and p.get("owner", {}).get("id") == me["id"]:
                return p["id"]
        if not page.get("next"):
            break
        offset += 50
    body = {"name": name, "public": public, "description": "Built by GigAmp"}
    try:                                   # Feb-2026 Dev Mode path
        return c.call("POST", "/me/playlists", json=body)["id"]
    except RuntimeError as e:
        if not any(code in str(e) for code in ("403", "404", "405")):
            raise
    return c.call("POST", f"/users/{me['id']}/playlists", json=body)["id"]


def replace_items(c: Client, playlist_id: str, uris: list[str]):
    """PUT replaces the whole playlist (first 100), POST appends the rest.
    Uses the Feb-2026 '/items' path and falls back to legacy '/tracks'."""
    path = f"/playlists/{playlist_id}/items"
    try:
        c.call("PUT", path, json={"uris": uris[:100]})
    except RuntimeError as e:
        if "404" not in str(e):
            raise
        path = f"/playlists/{playlist_id}/tracks"
        c.call("PUT", path, json={"uris": uris[:100]})
    for i in range(100, len(uris), 100):
        c.call("POST", path, json={"uris": uris[i:i + 100]})


def main():
    cid, sec = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET")
    subs = json.loads(SUBS.read_text()) if SUBS.exists() else []
    if not subs:
        print("No subscribers configured; nothing to sync.")
        return
    failures = 0
    for s in subs:
        tok = os.environ.get(s["token_secret"])
        if not tok:
            print(f"[{s['id']}] secret {s['token_secret']} not set, skipping")
            continue
        data_path = DATA_DIR / f"{s['city']}.json"
        if not data_path.exists():
            print(f"[{s['id']}] no data for city {s['city']}, skipping")
            continue
        data = json.loads(data_path.read_text())
        sel = select_tracks(data, days=s.get("days", 30), venues=s.get("venues"),
                            exclude_venues=s.get("exclude_venues"), genres=s.get("genres"),
                            headliners_only=s.get("headliners_only", False))
        try:
            c = Client(refresh_access_token(cid, sec, tok))
            pid = find_or_create_playlist(c, s["playlist_name"], s.get("public", False))
            replace_items(c, pid, sel["uris"])
            desc = (f"{data['city_name']} shows {sel['start']} to {sel['end']} · "
                    f"{len(sel['shows'])} shows, {len(sel['uris'])} tracks · updated {date.today().isoformat()} by GigAmp")
            c.call("PUT", f"/playlists/{pid}", json={"description": desc[:300]})
            print(f"[{s['id']}] {s['playlist_name']}: {len(sel['uris'])} tracks from {len(sel['shows'])} shows")
        except Exception as e:  # keep going for other subscribers
            failures += 1
            print(f"[{s['id']}] FAILED: {e}")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
