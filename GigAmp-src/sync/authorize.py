"""
One-time helper: get a Spotify refresh token for weekly auto-sync.

Run this on your own machine (it opens your browser and listens on 127.0.0.1:8888):

  SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... python sync/authorize.py

Prerequisite: add  http://127.0.0.1:8888/callback  as a Redirect URI on your app at
developer.spotify.com. The refresh token it prints goes into a GitHub Actions secret
(e.g. SPOTIFY_REFRESH_TOKEN_BRIAN) and is referenced from sync/subscribers.json.
It is never written to disk by this script.
"""
import base64
import os
import secrets
import sys
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

REDIRECT = "http://127.0.0.1:8888/callback"
SCOPES = "playlist-modify-public playlist-modify-private playlist-read-private"


def main():
    cid, sec = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the environment first.")
    state = secrets.token_urlsafe(16)
    url = "https://accounts.spotify.com/authorize?" + urllib.parse.urlencode({
        "client_id": cid, "response_type": "code", "redirect_uri": REDIRECT,
        "scope": SCOPES, "state": state, "show_dialog": "true"})
    result = {}

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [None])[0] != state:
                self.send_response(400); self.end_headers(); self.wfile.write(b"State mismatch"); return
            result["code"] = q.get("code", [None])[0]
            self.send_response(200); self.end_headers()
            self.wfile.write(b"GigAmp authorised. You can close this tab and return to the terminal.")

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 8888), H)
    print("Opening Spotify login in your browser...")
    webbrowser.open(url)
    while "code" not in result:
        srv.handle_request()
    basic = base64.b64encode(f"{cid}:{sec}".encode()).decode()
    r = requests.post("https://accounts.spotify.com/api/token",
                      data={"grant_type": "authorization_code", "code": result["code"], "redirect_uri": REDIRECT},
                      headers={"Authorization": f"Basic {basic}"}, timeout=30)
    r.raise_for_status()
    print("\nRefresh token (add as a GitHub Actions secret, do not commit it):\n")
    print(r.json()["refresh_token"])


if __name__ == "__main__":
    main()
