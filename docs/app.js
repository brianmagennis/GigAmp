/* GigAmp front end. Static: reads data/*.json produced by the weekly GitHub Action,
   logs the user into Spotify with PKCE (no secret), and writes the playlist. */
(() => {
  const CFG = window.GIGAMP_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const API = "https://api.spotify.com/v1";
  const SCOPES = "playlist-modify-public playlist-modify-private playlist-read-private";
  const ARENA_RE = /\b(arena|stadium|coliseum|place|amphitheatre|amphitheater|pne|forum)\b/i;

  const SONGKICK_GENRE_LABELS = {
    indie_alternative: "indie / alternative", rock: "rock", pop: "pop", metal: "metal", punk: "punk",
    hip_hop_rap: "hip hop / rap", rnb: "r&b", electronic: "electronic", dance: "dance",
    folk_blues: "folk / blues", country: "country", jazz: "jazz", classical: "classical",
    reggae: "reggae", latin: "latin", world: "world", soul_funk: "soul / funk",
  };

  // ---------- state ----------
  const state = {
    city: null, days: 30, venues: null /* null = all */, genres: [], headliners: false,
    index: null, data: null,
  };

  function readHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (h.get("city")) state.city = h.get("city");
    if (h.get("days")) state.days = +h.get("days");
    if (h.has("v")) state.venues = h.get("v") ? h.get("v").split("|") : [];
    if (h.get("g")) state.genres = h.get("g").split("|");
    if (h.get("h")) state.headliners = h.get("h") === "1";
  }
  function writeHash() {
    const h = new URLSearchParams();
    h.set("city", state.city); h.set("days", state.days);
    if (state.venues) h.set("v", state.venues.join("|"));
    if (state.genres.length) h.set("g", state.genres.join("|"));
    if (state.headliners) h.set("h", "1");
    history.replaceState(null, "", "#" + h.toString());
    try { localStorage.setItem("gigamp:sel", "#" + h.toString()); } catch {}
  }

  // ---------- selection (mirrors scraper/common.py) ----------
  const artistGenres = (a) => (a.genres && a.genres.length)
    ? a.genres.map((g) => g.toLowerCase())
    : (a.songkick_genres || []).map((g) => SONGKICK_GENRE_LABELS[g] || g.replace(/_/g, " "));
  const genreMatch = (a) => !state.genres.length ||
    artistGenres(a).some((g) => state.genres.some((w) => g.includes(w.toLowerCase())));

  function select() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today); end.setDate(end.getDate() + state.days);
    const iso = (d) => d.toISOString().slice(0, 10);
    const t0 = iso(today), t1 = iso(end);
    const venues = state.venues && new Set(state.venues.map((v) => v.toLowerCase()));
    const shows = [], uris = [], seen = new Set(); let nArtists = 0;
    for (const e of [...state.data.events].sort((a, b) => a.start.localeCompare(b.start))) {
      if (e.date < t0 || e.date > t1) continue;
      if (venues && !venues.has((e.venue || "").toLowerCase())) continue;
      let arts = state.headliners ? e.artists.slice(0, 1) : e.artists;
      arts = arts.filter(genreMatch);
      if (!arts.length) continue;
      nArtists += arts.length;
      for (const a of arts) for (const t of a.tracks) if (!seen.has(t.uri)) { seen.add(t.uri); uris.push(t.uri); }
      shows.push({ ...e, artists: arts });
    }
    return { shows, uris, nArtists, t0, t1 };
  }

  // ---------- rendering ----------
  function renderCity() {
    const sel = $("#city");
    sel.innerHTML = state.index.cities.map((c) => `<option value="${c.slug}">${c.name}</option>`).join("");
    sel.value = state.city;
  }
  function renderDays() {
    for (const b of $("#days").children) b.setAttribute("aria-pressed", +b.dataset.days === state.days);
  }
  function renderVenues() {
    const counts = new Map(), locs = new Map();
    for (const e of state.data.events) {
      counts.set(e.venue, (counts.get(e.venue) || 0) + 1);
      if (e.locality && e.locality !== state.data.city_name.split(",")[0]) locs.set(e.venue, e.locality);
    }
    const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const on = state.venues ? new Set(state.venues) : null;
    $("#venues").innerHTML = all.map(([v, n]) => `
      <label><input type="checkbox" data-v="${esc(v)}" ${!on || on.has(v) ? "checked" : ""}>
        <span>${esc(v)}${locs.has(v) ? ` <span class="loc">· ${esc(locs.get(v))}</span>` : ""}</span><span class="n">${n}</span></label>`).join("");
  }
  function renderGenres() {
    const counts = new Map();
    for (const e of state.data.events) for (const a of e.artists) for (const g of new Set(artistGenres(a))) counts.set(g, (counts.get(g) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 48);
    const on = new Set(state.genres.map((g) => g.toLowerCase()));
    $("#genres").innerHTML = top.map(([g, n]) =>
      `<button class="chip" data-g="${esc(g)}" aria-pressed="${on.has(g)}">${esc(g)}<span class="n">${n}</span></button>`).join("")
      || `<span style="color:var(--muted);font-size:13px">No genre data for this city yet.</span>`;
    $("#headliners").checked = state.headliners;
  }
  function renderResults() {
    const r = select();
    $("#nShows").textContent = r.shows.length;
    $("#nArtists").textContent = r.nArtists;
    $("#nTracks").textContent = r.uris.length;
    $("#create").disabled = !r.uris.length;
    if (!r.shows.length) {
      $("#results").innerHTML = `<div class="empty">Nothing matches. Widen the window or tick more venues.</div>`;
    } else {
      let html = "", day = "";
      for (const e of r.shows) {
        if (e.date !== day) { day = e.date; html += `<div class="day">${fmtDate(e.date)}</div>`; }
        html += `<article class="show">
          <div>
            <div class="venue"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.venue || "Venue TBA")}</a>${e.locality && !e.venue?.includes(e.locality) ? ` · ${esc(e.locality)}` : ""}${timeOf(e.start)}</div>
            ${e.artists.map((a) => `
              <div class="artist">
                ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy">` : `<div style="width:38px;height:38px;border-radius:50%;background:#26262e;flex:none"></div>`}
                <div>
                  <div class="who"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>${a.spotify_name && norm(a.spotify_name) !== norm(a.name) ? `<small>as “${esc(a.spotify_name)}” on Spotify</small>` : ""}${artistGenres(a).slice(0, 3).map((g) => `<small class="pill">${esc(g)}</small>`).join(" ")}</div>
                  <div class="tracks">${a.tracks.map((t) => `<a href="https://open.spotify.com/track/${t.id}" target="_blank" rel="noopener">${esc(t.name)}</a>`).join(`<span class="sep">·</span>`)}</div>
                </div>
              </div>`).join("")}
          </div>
        </article>`;
      }
      $("#results").innerHTML = html;
    }
    const cityName = state.data.city_name.split(",")[0];
    if (!$("#plName").value || $("#plName").dataset.auto === "1") {
      $("#plName").value = `${CFG.playlistPrefix || "GigAmp"} · ${cityName}`;
      $("#plName").dataset.auto = "1";
    }
    $("#subJson").textContent = JSON.stringify({
      id: "me", city: state.city, playlist_name: $("#plName").value, days: state.days,
      venues: state.venues || [], exclude_venues: [], genres: state.genres,
      headliners_only: state.headliners, public: false, token_secret: "SPOTIFY_REFRESH_TOKEN_ME",
    }, null, 2);
    const um = state.data.unmatched?.length || 0;
    $("#unmatched").textContent = um ? ` ${um} billed act${um === 1 ? "" : "s"} had no Spotify match and ${um === 1 ? "was" : "were"} left out.` : "";
    const gen = new Date(state.data.generated_at);
    const pend = state.data.pending?.length || 0;
    $("#dataAge").textContent = `Listings updated ${gen.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${state.data.events.length} shows over ${state.data.horizon_days} days` + (pend ? ` · ${pend} acts still being matched` : "");
  }
  function renderAll() { renderDays(); renderVenues(); renderGenres(); renderResults(); writeHash(); }

  // ---------- events ----------
  $("#city").addEventListener("change", async (e) => { state.city = e.target.value; state.venues = null; state.genres = []; await loadCity(); renderAll(); });
  $("#days").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.days = +b.dataset.days; renderDays(); renderResults(); writeHash(); });
  $("#venues").addEventListener("change", () => {
    const boxes = [...$("#venues").querySelectorAll("input")];
    const on = boxes.filter((b) => b.checked).map((b) => b.dataset.v);
    state.venues = on.length === boxes.length ? null : on;
    renderResults(); writeHash();
  });
  $("#vAll").onclick = () => { state.venues = null; renderVenues(); renderResults(); writeHash(); };
  $("#vNone").onclick = () => { state.venues = []; renderVenues(); renderResults(); writeHash(); };
  $("#vSmall").onclick = () => { state.venues = [...new Set(state.data.events.map((e) => e.venue))].filter((v) => v && !ARENA_RE.test(v)); renderVenues(); renderResults(); writeHash(); };
  $("#genres").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const g = b.dataset.g; const i = state.genres.indexOf(g);
    if (i >= 0) state.genres.splice(i, 1); else state.genres.push(g);
    renderGenres(); renderResults(); writeHash();
  });
  $("#gClear").onclick = () => { state.genres = []; renderGenres(); renderResults(); writeHash(); };
  $("#headliners").addEventListener("change", (e) => { state.headliners = e.target.checked; renderResults(); writeHash(); });
  $("#plName").addEventListener("input", (e) => { e.target.dataset.auto = "0"; renderResults(); });
  $("#share").onclick = async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); status("Link copied. Anyone opening it sees this exact selection."); }
    catch { status(`Share this link: ${location.href}`); }
  };
  $("#create").onclick = createPlaylist;

  // ---------- data ----------
  async function loadIndex() {
    const r = await fetch("data/index.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("No data yet. Run the refresh workflow once.");
    state.index = await r.json();
    if (!state.city || !state.index.cities.some((c) => c.slug === state.city)) state.city = CFG.defaultCity || state.index.cities[0]?.slug;
  }
  async function loadCity() {
    const r = await fetch(`data/${state.city}.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`No data for ${state.city}`);
    state.data = await r.json();
  }

  // ---------- Spotify auth (PKCE) ----------
  const redirectUri = () => CFG.redirectUri || (location.origin + location.pathname);
  const tokenStore = {
    get() { try { return JSON.parse(localStorage.getItem("gigamp:tok") || "null"); } catch { return null; } },
    set(t) { try { localStorage.setItem("gigamp:tok", JSON.stringify(t)); } catch {} },
    clear() { try { localStorage.removeItem("gigamp:tok"); } catch {} },
  };
  function b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  async function login() {
    if (!CFG.spotifyClientId) { status("Spotify client ID missing in config.js — see the README.", true); return; }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    sessionStorage.setItem("gigamp:pkce", verifier);
    sessionStorage.setItem("gigamp:return", location.hash);
    const p = new URLSearchParams({ client_id: CFG.spotifyClientId, response_type: "code", redirect_uri: redirectUri(),
      scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge });
    location.href = "https://accounts.spotify.com/authorize?" + p;
  }
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.get("code") && !q.get("error")) return;
    const ret = sessionStorage.getItem("gigamp:return") || "";
    history.replaceState(null, "", location.pathname + ret);
    if (q.get("error")) { status(`Spotify login failed: ${q.get("error")}`, true); return; }
    const verifier = sessionStorage.getItem("gigamp:pkce");
    const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CFG.spotifyClientId, grant_type: "authorization_code", code: q.get("code"),
        redirect_uri: redirectUri(), code_verifier: verifier }) });
    const j = await r.json();
    if (!r.ok) { status(`Token exchange failed: ${j.error_description || j.error}`, true); return; }
    tokenStore.set({ access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  }
  async function accessToken() {
    const t = tokenStore.get(); if (!t) return null;
    if (Date.now() < t.exp) return t.access;
    const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CFG.spotifyClientId, grant_type: "refresh_token", refresh_token: t.refresh }) });
    if (!r.ok) { tokenStore.clear(); return null; }
    const j = await r.json();
    tokenStore.set({ access: j.access_token, refresh: j.refresh_token || t.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 });
    return j.access_token;
  }
  async function api(method, path, body) {
    const tok = await accessToken(); if (!tok) throw new Error("Not logged in");
    for (let i = 0; i < 4; i++) {
      const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 429) { await sleep((+r.headers.get("Retry-After") || 3) * 1000); continue; }
      if (r.status === 204 || r.headers.get("content-length") === "0") return {};
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const err = new Error(j.error?.message || `${method} ${path} → ${r.status}`); err.status = r.status; throw err; }
      return j;
    }
    throw new Error("Spotify rate limit, try again in a minute");
  }
  let me = null;
  async function renderAuth() {
    const el = $("#auth");
    if (!(await accessToken())) { el.innerHTML = `<button class="btn spotify" id="login">Log in with Spotify</button>`; $("#login").onclick = login; return; }
    try { me = me || await api("GET", "/me"); } catch (e) { tokenStore.clear(); return renderAuth(); }
    el.innerHTML = `<span>${esc(me.display_name || me.id)}</span><button class="btn ghost" id="logout">Log out</button>`;
    $("#logout").onclick = () => { tokenStore.clear(); me = null; renderAuth(); };
  }

  // ---------- playlist ----------
  async function findOrCreatePlaylist(name) {
    for (let offset = 0; ; offset += 50) {
      const page = await api("GET", `/me/playlists?limit=50&offset=${offset}`);
      const hit = (page.items || []).find((p) => p && p.name === name && p.owner?.id === me.id);
      if (hit) return hit.id;
      if (!page.next) break;
    }
    const p = await api("POST", `/users/${me.id}/playlists`, { name, public: false, description: "Built by GigAmp" });
    return p.id;
  }
  async function createPlaylist() {
    if (!(await accessToken())) return login();
    const r = select(); if (!r.uris.length) return;
    const name = $("#plName").value.trim() || "GigAmp";
    const btn = $("#create"); btn.disabled = true;
    try {
      status("Finding your playlist…");
      if (!me) me = await api("GET", "/me");
      const pid = await findOrCreatePlaylist(name);
      status(`Writing ${r.uris.length} tracks…`);
      let path = `/playlists/${pid}/items`;
      try { await api("PUT", path, { uris: r.uris.slice(0, 100) }); }
      catch (e) { if (e.status !== 404) throw e; path = `/playlists/${pid}/tracks`; await api("PUT", path, { uris: r.uris.slice(0, 100) }); }
      for (let i = 100; i < r.uris.length; i += 100) await api("POST", path, { uris: r.uris.slice(i, i + 100) });
      const desc = `${state.data.city_name} shows ${r.t0} to ${r.t1} · ${r.shows.length} shows, ${r.uris.length} tracks · updated ${new Date().toISOString().slice(0, 10)} by GigAmp`;
      await api("PUT", `/playlists/${pid}`, { description: desc.slice(0, 300) }).catch(() => {});
      status(`Done: <a href="https://open.spotify.com/playlist/${pid}" target="_blank" rel="noopener">open “${esc(name)}” in Spotify</a> · ${r.uris.length} tracks from ${r.shows.length} shows.`);
      btn.textContent = "Update playlist";
    } catch (e) {
      status(`Spotify error: ${esc(e.message)}${e.status === 403 ? " — in Development Mode your Spotify account must be added to the app's user list." : ""}`, true);
    } finally { btn.disabled = false; }
  }

  // ---------- utils ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeOf = (start) => { const m = /T(\d{2}):(\d{2})/.exec(start || ""); if (!m) return ""; const h = +m[1]; return ` · ${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "am" : "pm"}`; };
  function status(msg, err) { const el = $("#status"); el.innerHTML = msg; el.className = "status" + (err ? " err" : ""); }

  // ---------- boot ----------
  (async () => {
    try {
      await handleCallback();
      if (!location.hash) { try { const s = localStorage.getItem("gigamp:sel"); if (s) history.replaceState(null, "", s); } catch {} }
      readHash();
      await loadIndex(); renderCity(); await loadCity(); renderAll();
      await renderAuth();
    } catch (e) { status(esc(e.message), true); }
  })();
})();
