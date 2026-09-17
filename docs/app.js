/* GigAmp front end. Static: reads data/*.json produced by the weekly GitHub Action.
   No sign-in of any kind. Taste is learned anonymously in this browser from the
   artist comparison game and from what you play, and powers the For You layer.
   For You RANKS the event list; it never removes anything from All Gigs. */
(() => {
  const CFG = window.GIGAMP_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  // Guard against an index.html that predates this script (missing optional elements):
  // create inert stand-ins so one missing id never takes the whole page down.
  (function ensureElements() {
    const need = {
      dock: () => { const d = document.createElement("div"); d.id = "dock"; d.hidden = true;
        d.innerHTML = `<div class="dockwrap"><div id="dockTitle"></div><div id="dockPlayer"></div><button id="dockClose" aria-label="Close player">×</button></div>`;
        document.body.appendChild(d); },
      savedBtn: () => { const b = document.createElement("button"); b.id = "savedBtn"; b.className = "btn ghost saved-toggle"; b.textContent = "★ My shows";
        ($("#share") || document.body).insertAdjacentElement("beforebegin", b); },
      reachRange: () => { const wrap = document.createElement("div"); wrap.hidden = true; wrap.innerHTML =
        `<div class="range" id="reachRange"><div class="track"></div><div class="fill" id="reachFill"></div><input type="range" id="reachMin" min="0" max="4" value="0"><input type="range" id="reachMax" min="0" max="4" value="4"></div><div id="reachLabel"></div>`;
        document.body.appendChild(wrap); },
      onboard: () => { const s = document.createElement("section"); s.id = "onboard"; s.hidden = true;
        ($("#results") || document.body).insertAdjacentElement("beforebegin", s); },
      forYou: () => { const s = document.createElement("section"); s.id = "forYou"; s.hidden = true;
        ($("#results") || document.body).insertAdjacentElement("beforebegin", s); },
      plName: () => { const i = document.createElement("input"); i.type = "text"; i.id = "plName"; i.hidden = true; document.body.appendChild(i); },
    };
    for (const [id, make] of Object.entries(need)) if (!document.getElementById(id)) { try { make(); } catch {} }
    for (const id of ["status", "results", "unmatched", "dataAge", "subJson", "nShows", "nArtists", "nTracks", "allGigsHead", "tuneBtn", "copyList"])
      if (!document.getElementById(id)) { const el = document.createElement("div"); el.id = id; el.hidden = true; document.body.appendChild(el); }
  })();

  const ARENA_RE = /\b(arena|stadium|coliseum|place|amphitheatre|amphitheater|pne|forum|arch|centre for the performing arts)\b/i;
  // Community tags that aren't genres (mirrors TAG_JUNK_RE in scraper/lastfm.py for older cache entries)
  const TAG_JUNK = /^(seen live|video|all|favou?rites?|awesome|love|beautiful|amazing|good|great|my \w+|new|local|canada|canadian|vancouver|british columbia|usa|american|british|uk|england|english|scottish|irish|ireland|italian|italy|german|germany|french|france|swedish|sweden|norwegian|norway|finnish|finland|danish|denmark|japanese|japan|korean|korea|australian|australia|spanish|spain|mexican|mexico|brazilian|brazil|dutch|netherlands|belgian|polish|russian|chinese|turkish|turkey|portuguese|portugal|icelandic|iceland|austrian|swiss|greek|african|european|toronto|montreal|seattle|portland|bc|ontario|quebec|nyc|new york|los angeles|california|texas|chicago|\d{2,4}s?)$/i;

  const SONGKICK_GENRE_LABELS = {
    indie_alternative: "indie / alternative", rock: "rock", pop: "pop", metal: "metal", punk: "punk",
    hip_hop_rap: "hip hop / rap", rnb: "r&b", electronic: "electronic", dance: "dance",
    folk_blues: "folk / blues", country: "country", jazz: "jazz", classical: "classical",
    reggae: "reggae", latin: "latin", world: "world", soul_funk: "soul / funk",
  };

  /* ===================================================================== */
  /* Taste model                                                            */
  /* ===================================================================== */
  /* Seven axes. Six come from genre, the seventh from the Last.fm reach tier.
     Every value is -1..+1. This is a fixed table, not a model: the whole V1
     recommender is arithmetic over these numbers, so it is reproducible and
     debuggable. Change a row here and every profile recomputes from raw
     interactions on the next boot (derived state is never the source of truth). */
  const AXES = ["guitar", "energy", "pop", "urban", "roots", "dance", "reach"];
  const AXIS_LABEL = {
    guitar: "guitars vs machines", energy: "loud vs gentle", pop: "pop vs leftfield",
    urban: "hip hop / r&b", roots: "roots & acoustic", dance: "dancefloor vs listening",
    reach: "big names vs underground",
  };
  const AXIS_W = { guitar: 1.15, energy: 1.0, pop: 1.05, urban: 1.1, roots: 0.85, dance: 0.95, reach: 0.7 };

  //                       guitar energy   pop  urban  roots  dance
  const GENRE_AXES = {
    "post-punk":         [ 0.90,  0.40, -0.40, -0.80, -0.30,  0.00],
    "hardcore":          [ 1.00,  1.00, -0.80, -0.80, -0.40, -0.30],
    "emo":               [ 0.90,  0.50, -0.10, -0.80, -0.20, -0.40],
    "punk":              [ 1.00,  0.90, -0.40, -0.80, -0.20, -0.20],
    "metal":             [ 1.00,  1.00, -0.60, -0.90, -0.30, -0.40],
    "grunge":            [ 1.00,  0.70, -0.20, -0.90, -0.10, -0.40],
    "shoegaze":          [ 0.80,  0.10, -0.40, -0.90, -0.30, -0.50],
    "dream-pop":         [ 0.40, -0.50,  0.10, -0.70, -0.20, -0.40],
    "psychedelic":       [ 0.70,  0.00, -0.40, -0.80,  0.00, -0.30],
    "garage":            [ 1.00,  0.70, -0.20, -0.80,  0.10, -0.10],
    "noise":             [ 0.60,  0.90, -1.00, -0.80, -0.30, -0.50],
    "post-rock":         [ 0.80,  0.00, -0.70, -0.90, -0.10, -0.60],
    "prog":              [ 0.80,  0.20, -0.60, -0.90, -0.10, -0.50],
    "indie":             [ 0.80,  0.00,  0.00, -0.80,  0.00, -0.30],
    "alternative":       [ 0.80,  0.30,  0.10, -0.70, -0.10, -0.20],
    "indie-pop":         [ 0.50, -0.10,  0.40, -0.70,  0.00, -0.10],
    "synth-pop":         [-0.40,  0.10,  0.60, -0.50, -0.50,  0.40],
    "rock":              [ 1.00,  0.50,  0.20, -0.80,  0.00, -0.20],
    "pop":               [-0.10,  0.10,  1.00, -0.10, -0.20,  0.30],
    "house":             [-0.90,  0.30,  0.10,  0.10, -0.70,  1.00],
    "techno":            [-1.00,  0.60, -0.50, -0.20, -0.80,  0.90],
    "bass":              [-0.90,  0.70, -0.20,  0.20, -0.80,  0.90],
    "trance":            [-1.00,  0.40,  0.20, -0.30, -0.80,  0.90],
    "ambient":           [-0.60, -1.00, -0.60, -0.50, -0.30, -0.90],
    "industrial":        [-0.20,  0.90, -0.70, -0.60, -0.60,  0.20],
    "experimental":      [-0.10,  0.10, -1.00, -0.40, -0.20, -0.60],
    "electronic":        [-0.90,  0.20,  0.10, -0.10, -0.70,  0.60],
    "hip-hop":           [-0.60,  0.40,  0.30,  1.00, -0.40,  0.40],
    "rnb":               [-0.40, -0.30,  0.50,  0.90, -0.20,  0.20],
    "soul":              [ 0.10, -0.10,  0.40,  0.80,  0.30,  0.20],
    "funk":              [ 0.20,  0.40,  0.20,  0.80,  0.20,  0.70],
    "disco":             [-0.20,  0.30,  0.60,  0.50, -0.10,  1.00],
    "jazz":              [ 0.20, -0.20, -0.40,  0.40,  0.50, -0.20],
    "blues":             [ 0.80,  0.00, -0.10,  0.40,  0.80, -0.10],
    "americana":         [ 0.80, -0.20,  0.00, -0.30,  1.00, -0.30],
    "country":           [ 0.70,  0.00,  0.40, -0.40,  0.90, -0.10],
    "folk":              [ 0.60, -0.70, -0.10, -0.40,  1.00, -0.60],
    "singer-songwriter": [ 0.50, -0.80,  0.20, -0.30,  0.80, -0.70],
    "latin":             [ 0.10,  0.40,  0.40,  0.30,  0.50,  0.80],
    "reggae":            [ 0.20,  0.00,  0.20,  0.60,  0.40,  0.50],
    "world":             [ 0.10,  0.00, -0.10,  0.10,  0.80,  0.20],
    "classical":         [ 0.00, -0.60, -0.40, -0.60,  0.60, -0.90],
    "spoken":            [ 0.00, -0.50,  0.00,  0.00,  0.00, -0.90],
  };
  // Canonical genres reach the browser as labels; the axis table is keyed by id.
  const LABEL_TO_ID = {
    "dream pop": "dream-pop", "garage rock": "garage", "indie pop": "indie-pop",
    "bass / dnb": "bass", "hip hop": "hip-hop", "r&b": "rnb", "reggae / dub": "reggae",
    "comedy / spoken": "spoken",
  };
  for (const id of Object.keys(GENRE_AXES)) if (!(id in LABEL_TO_ID)) LABEL_TO_ID[id] = id;
  // Tier 0 unknown, 1 underground, 2 emerging, 3 established, 4 big.
  const TIER_REACH = [0, -1, -0.4, 0.5, 1];

  const genreId = (label) => LABEL_TO_ID[String(label || "").toLowerCase()] || null;

  /** Seven-axis vector for one artist: mean of its genres, plus the reach axis. */
  function artistVector(a) {
    const acc = [0, 0, 0, 0, 0, 0]; let n = 0;
    for (const label of artistGenres(a)) {
      const row = GENRE_AXES[genreId(label)];
      if (!row) continue;
      for (let i = 0; i < 6; i++) acc[i] += row[i];
      n++;
    }
    if (n) for (let i = 0; i < 6; i++) acc[i] /= n;
    acc.push(TIER_REACH[tierOf(a)] ?? 0);
    return { v: acc, known: n > 0 };
  }

  /* ---- persisted taste: explicit / behaviour / derived, kept apart ------- */
  const TASTE_KEY = "gigamp:taste";
  const blankTaste = () => ({
    v: 1,
    // What the user told us.
    explicit: { comparisons: [], savedArtists: [] },
    // What they did.
    behaviour: { plays: {}, ticketClicks: {}, dismissed: [] },
    // What we calculated. Always rebuildable from the two above.
    derived: { axes: {}, artistAffinity: {}, genreAffinity: {}, updatedAt: null },
    onboarding: { done: false, rounds: 0, startedAt: null, completedAt: null, skipped: false },
  });
  let taste = blankTaste();
  const saveTaste = () => store.set(TASTE_KEY, taste);

  function anonId() {
    let id = store.get("gigamp:anon", null);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
        ("xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        }));
      store.set("gigamp:anon", id);
    }
    return id;
  }

  /** Recompute every derived number from the raw explicit + behaviour records.
      Called on boot and after each answer, so a change to the scoring here
      upgrades existing profiles without ever re-asking the user anything. */
  function recomputeDerived() {
    const axes = {};
    for (const k of AXES) axes[k] = { num: 0, den: 0, value: 0, conf: 0 };
    const artistAffinity = {}, genreAffinity = {};
    const bump = (obj, k, by) => { if (k) obj[k] = (obj[k] || 0) + by; };

    for (const c of taste.explicit.comparisons) {
      if (!c.chose) continue;
      const win = c.chose === c.a.key ? c.a : c.b;
      const lose = c.chose === c.a.key ? c.b : c.a;
      if (!win?.v || !lose?.v) continue;

      // Playback nudges the weight of the round. The explicit choice is always
      // the strong signal: these multipliers stay inside 0.8..1.25 on purpose.
      const pw = c.plays?.[win.key] || 0, pl = c.plays?.[lose.key] || 0;
      let w = 1;
      if (pw && pl) w = 1.25;                   // heard both, then chose: a considered answer
      else if (!pw && pl) w = 0.8;              // only played the one they rejected: curiosity, not preference
      else if (pw && !pl) w = 1.1;

      for (let i = 0; i < AXES.length; i++) {
        const k = AXES[i];
        const d = win.v[i] - lose.v[i], m = Math.abs(d);
        if (m < 0.15) continue;                 // they agree on this axis: it teaches nothing
        axes[k].num += w * m * Math.sign(d);
        axes[k].den += w * m;
      }
      bump(artistAffinity, win.key, 1);
      bump(artistAffinity, lose.key, -0.35);
      for (const g of win.genres || []) bump(genreAffinity, g, 1 / Math.max(1, (win.genres || []).length));
      for (const g of lose.genres || []) bump(genreAffinity, g, -0.35 / Math.max(1, (lose.genres || []).length));
    }
    for (const k of AXES) {
      axes[k].value = axes[k].den ? axes[k].num / axes[k].den : 0;
      // Confidence is evidence *times consistency*: answering both ways on an axis
      // keeps it uncertain, which is what makes a muddled visitor get a couple of
      // extra comparisons while a decisive one is finished at five.
      const evidence = 1 - Math.exp(-axes[k].den / 2.4);
      axes[k].conf = evidence * (0.35 + 0.65 * Math.abs(axes[k].value));
    }
    // Behaviour: real but weaker than a stated choice.
    for (const [key, n] of Object.entries(taste.behaviour.plays || {})) bump(artistAffinity, key, Math.min(0.4, 0.2 * n));
    for (const [key, n] of Object.entries(taste.behaviour.ticketClicks || {})) bump(artistAffinity, key, Math.min(0.6, 0.3 * n));
    for (const key of taste.explicit.savedArtists || []) bump(artistAffinity, key, 0.8);

    taste.derived = { axes, artistAffinity, genreAffinity, updatedAt: Date.now() };
  }

  const beliefOf = (k) => taste.derived.axes[k]?.value || 0;
  const confOf = (k) => taste.derived.axes[k]?.conf || 0;
  // How many dimensions we now hold a definite view on. This, not a mean, is the
  // stop rule: someone whose taste sits on two axes is understood as soon as those
  // two are settled, while someone answering inconsistently never settles any.
  const settledAxes = () => AXES.filter((k) => confOf(k) >= OB.settledConf).length;
  const hasTaste = () => AXES.some((k) => confOf(k) > 0.2);

  /** Confidence-weighted agreement between an artist vector and the user, -1..1. */
  function tasteSim(v) {
    let num = 0, den = 0;
    for (let i = 0; i < AXES.length; i++) {
      const k = AXES[i], c = confOf(k), b = beliefOf(k);
      num += c * b * v[i];
      den += c * Math.abs(b);
    }
    return den > 0.001 ? num / den : 0;
  }
  /** Plain similarity between two artists, used for "because you liked X". */
  function vecSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < AXES.length; i++) { const w = AXIS_W[AXES[i]]; dot += a[i] * b[i] * w; na += a[i] * a[i] * w; nb += b[i] * b[i] * w; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  // ---------- state ----------
  const state = {
    city: null, days: 30, venues: null /* null = all */, genres: [], headliners: false,
    sources: ["songkick", "do604"],
    reach: [0, 4],    // inclusive tier range: 0 unknown, 1 underground, 2 emerging, 3 established, 4 big
    savedOnly: false,
    index: null, data: null,
    pool: [],         // artist pool for comparisons and recommendations
    poolByKey: new Map(),
    round: null,      // the comparison on screen: { n, a, b, plays:{} }
    onboarding: false,
  };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const saved = new Set(store.get("gigamp:saved", []));
  const showKey = (e) => e.id || `${e.date}|${e.venue}|${e.headliner}`;
  const artistKey = (a) => a.spotify_id || norm(a.name);
  let playing = null;   // { key, trackId }

  function readHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (h.get("city")) state.city = h.get("city");
    if (h.get("days")) state.days = +h.get("days");
    if (h.has("v")) state.venues = h.get("v") ? h.get("v").split("|") : [];
    if (h.get("g")) state.genres = h.get("g").split("|");
    if (h.get("h")) state.headliners = h.get("h") === "1";
    if (h.get("s")) state.sources = h.get("s").split("|");
    if (h.get("r")) { const [a, b] = h.get("r").split("-").map(Number); if (a >= 0 && b <= 4 && a <= b) state.reach = [a, b]; }
  }
  function writeHash() {
    const h = new URLSearchParams();
    h.set("city", state.city); h.set("days", state.days);
    if (state.venues) h.set("v", state.venues.join("|"));
    if (state.genres.length) h.set("g", state.genres.join("|"));
    if (state.headliners) h.set("h", "1");
    if (state.sources.length !== 2) h.set("s", state.sources.join("|"));
    if (state.reach[0] !== 0 || state.reach[1] !== 4) h.set("r", state.reach.join("-"));
    history.replaceState(null, "", "#" + h.toString());
    try { localStorage.setItem("gigamp:sel", "#" + h.toString()); } catch {}
  }

  // ---------- selection (mirrors scraper/common.py) ----------
  // Controlled genre vocabulary (docs/genres.json), mirrors scraper/common.py. Loaded at boot;
  // until then (or if it fails) fall back to the precomputed genres_canon on each artist.
  let VOCAB = null;
  async function loadVocab() {
    try {
      const v = await (await fetch("genres.json", { cache: "no-cache" })).json();
      VOCAB = { max: v.max_per_artist || 3, junk: (v.junk || []).map((p) => new RegExp(p, "i")),
        genres: v.genres.map((g) => ({ id: g.id, label: g.label, pats: g.match.map((p) => new RegExp(p, "i")) })) };
      for (const g of VOCAB.genres) LABEL_TO_ID[g.label.toLowerCase()] = g.id;
    } catch { VOCAB = null; }
  }
  function mapTag(tag) {
    if (!VOCAB) return null;
    let t = String(tag || "").trim().toLowerCase();
    if (!t || VOCAB.junk.some((p) => p.test(t))) return null;
    t = t.replace(/_/g, " ");
    for (const g of VOCAB.genres) if (g.pats.some((p) => p.test(t))) return g.label;
    return null;
  }
  const artistGenres = (a) => {
    if (a.genres_canon) return a.genres_canon.map((g) => g.toLowerCase());
    if (!VOCAB) return [];
    const raw = [...(a.genres || []), ...(a.reach?.tags || []), ...(a.songkick_genres || [])];
    const out = [];
    for (const tag of raw) { const g = mapTag(tag); if (g && !out.includes(g)) out.push(g); if (out.length >= VOCAB.max) break; }
    return out;
  };
  const TIER_NAMES = ["unknown", "underground", "emerging", "established", "big"];
  const tierOf = (a) => Number(a.reach?.tier || 0);
  const reachOk = (a) => tierOf(a) >= state.reach[0] && tierOf(a) <= state.reach[1];
  const fmtListeners = (n) => !n ? "" : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
  const genreMatch = (a) => !state.genres.length ||
    artistGenres(a).some((g) => state.genres.some((w) => g.includes(w.toLowerCase())));

  const srcOk = (e) => state.sources.includes(e.source || "songkick");
  // Same Spotify artist billed twice on one show ("Sasha & John Digweed" + "John Digweed") = one act.
  function collapseSameSpotify(arts) {
    const seen = new Map(), out = [];
    for (const a of arts) {
      const k = a.spotify_id || a.name;
      const prev = seen.get(k);
      if (!prev) { const c = { ...a, also_billed: [...(a.also_billed || [])] }; seen.set(k, c); out.push(c); continue; }
      const exactNew = norm(a.name) === norm(a.spotify_name || ""), exactOld = norm(prev.name) === norm(prev.spotify_name || "");
      if (exactNew && !exactOld) { const loserName = prev.name; Object.assign(prev, a, { also_billed: [loserName, ...(prev.also_billed || [])] }); }
      else if (a.name !== prev.name && !prev.also_billed.includes(a.name)) prev.also_billed.push(a.name);
    }
    return out;
  }
  function windowBounds(days) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = new Date(today); end.setDate(end.getDate() + (days ?? state.days));
    const iso = (d) => d.toISOString().slice(0, 10);
    return [iso(today), iso(end)];
  }
  function select() {
    const [t0, t1] = windowBounds();
    const venues = state.venues && new Set(state.venues.map((v) => v.toLowerCase()));
    const shows = [], uris = [], seen = new Set(); let nArtists = 0;
    for (const e of [...state.data.events].sort((a, b) => a.start.localeCompare(b.start))) {
      if (e.date < t0 || e.date > t1) continue;
      if (!srcOk(e)) continue;
      if (state.savedOnly && !saved.has(showKey(e))) continue;
      if (venues && !venues.has((e.venue || "").toLowerCase())) continue;
      let arts = collapseSameSpotify(state.headliners ? e.artists.slice(0, 1) : e.artists);
      arts = arts.filter(genreMatch).filter(reachOk);
      if (!arts.length) continue;
      nArtists += arts.length;
      for (const a of arts) for (const t of a.tracks) if (!seen.has(t.uri)) { seen.add(t.uri); uris.push(t.uri); }
      shows.push({ ...e, artists: arts });
    }
    return { shows, uris, nArtists, t0, t1 };
  }

  /* ===================================================================== */
  /* Artist pool                                                            */
  /* ===================================================================== */
  /* Built from the whole city file, never from the user's filters, so the
     comparison game and For You can see acts the sidebar is currently hiding. */
  function buildPool() {
    const by = new Map();
    for (const e of state.data.events) {
      const inWindow = true;
      for (const a of collapseSameSpotify(e.artists)) {
        if (!a.tracks || !a.tracks.length) continue;         // needs a track so Play works
        const key = artistKey(a);
        let p = by.get(key);
        if (!p) {
          const { v, known } = artistVector(a);
          p = { key, name: a.name, image: a.image, url: a.url, tracks: a.tracks,
            tier: tierOf(a), listeners: a.reach?.listeners || 0, genres: artistGenres(a),
            v, known, events: [], nextDate: null };
          by.set(key, p);
        }
        p.events.push(e);
        if (!p.nextDate || e.date < p.nextDate) p.nextDate = e.date;
        void inWindow;
      }
    }
    state.pool = [...by.values()].filter((p) => p.known);
    state.poolByKey = by;
  }
  // How likely someone is to recognise the name at all. Early rounds need this;
  // later rounds deliberately stop caring. Calibrated so ~50k listeners is still
  // obscure (0.3) and only millions read as a household name.
  const familiarity = (p) => Math.max(
    p.tier / 4,
    p.listeners > 1000 ? Math.max(0, Math.min(1, (Math.log10(p.listeners) - 3.5) / 3.2)) : 0
  );

  /* ===================================================================== */
  /* Adaptive comparison selection                                          */
  /* ===================================================================== */
  const OB = Object.assign({ minRounds: 5, maxRounds: 8, settledAxes: 4, settledConf: 0.5 }, CFG.onboarding || {});
  const SEP_MAX = 2.2, SEP_MIN = 0.55;

  const shownKeys = () => {
    const s = new Set();
    for (const c of taste.explicit.comparisons) { s.add(c.a.key); s.add(c.b.key); }
    if (state.round) { s.add(state.round.a.key); s.add(state.round.b.key); }
    return s;
  };

  /** Pick the next pair. Round number is 0-indexed.
      Early: maximum contrast between recognisable acts, on the axes we know least about.
      Late:  a close call between two acts that both sit near the emerging profile. */
  function nextPair(round) {
    const used = shownKeys();
    const progress = Math.min(1, round / Math.max(1, OB.maxRounds - 2));
    const targetSep = SEP_MAX + (SEP_MIN - SEP_MAX) * progress;
    const alignW = round < 2 ? 0 : Math.min(1.8, 0.6 * (round - 1));
    const famW = Math.max(0, 1.2 - 0.32 * round);
    const emergingRound = round >= 4;

    let cands = state.pool.filter((p) => !used.has(p.key));
    if (cands.length < 2) return null;

    // The first rounds are only useful if the visitor recognises both names, so
    // they are drawn from the well-known end of the pool outright rather than
    // left to a soft weight. From round 3 the whole pool is back in play.
    if (round < 3) {
      const known = cands.filter((p) => familiarity(p) >= 0.55);
      if (known.length >= 12) cands = known;
    }

    // Keep the pairwise pass small and relevant.
    const rank = round < 2
      ? (p) => familiarity(p)
      : (p) => 0.55 * tasteSim(p.v) + 0.45 * familiarity(p) * Math.max(0, 1 - 0.25 * round);
    cands = cands.sort((x, y) => rank(y) - rank(x)).slice(0, 130);

    let best = null, bestScore = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i], b = cands[j];
        let info = 0, sep2 = 0;
        for (let k = 0; k < AXES.length; k++) {
          const d = a.v[k] - b.v[k], m = Math.abs(d);
          sep2 += d * d;
          info += m * (1 - confOf(AXES[k])) * AXIS_W[AXES[k]];
        }
        const sep = Math.sqrt(sep2);
        let score = info - 1.4 * Math.abs(sep - targetSep);
        score += famW * (familiarity(a) + familiarity(b)) / 2;
        if (alignW) score += alignW * (tasteSim(a.v) + tasteSim(b.v)) / 2;
        // Late on, a rising local act opposite something known is the interesting question.
        if (emergingRound) {
          const lo = (p) => p.tier > 0 && p.tier <= 2;
          if (lo(a) !== lo(b)) score += 0.45;
          if (lo(a) && lo(b)) score += 0.2;
        }
        // Two acts with identical genre vectors teach nothing.
        if (sep < 0.12) score -= 3;
        if (score > bestScore) { bestScore = score; best = [a, b]; }
      }
    }
    if (!best) return null;
    // Put the more familiar act on the left about half the time, deterministically
    // by round, so there is no positional bias to learn from.
    return round % 2 ? [best[1], best[0]] : best;
  }

  function onboardingComplete() {
    const n = taste.explicit.comparisons.filter((c) => c.chose).length;
    if (n >= OB.maxRounds) return true;
    if (n >= OB.minRounds && settledAxes() >= OB.settledAxes) return true;
    return false;
  }

  function startOnboarding(force) {
    if (!state.pool.length) return;
    if (force) { taste.onboarding.done = false; taste.onboarding.skipped = false; }
    if (!taste.onboarding.startedAt) taste.onboarding.startedAt = Date.now();
    state.onboarding = true;
    nextRound();
  }
  function nextRound() {
    const n = taste.explicit.comparisons.filter((c) => c.chose).length;
    if (onboardingComplete()) return finishOnboarding();
    const pair = nextPair(n);
    if (!pair) return finishOnboarding();
    state.round = { n, a: pair[0], b: pair[1], shownAt: Date.now(), plays: {} };
    renderOnboard();
  }
  function answerRound(key) {
    const r = state.round; if (!r) return;
    const snap = (p) => ({ key: p.key, name: p.name, v: p.v, genres: p.genres, tier: p.tier });
    taste.explicit.comparisons.push({
      round: r.n, a: snap(r.a), b: snap(r.b), chose: key,
      shownAt: r.shownAt, answeredAt: Date.now(), plays: { ...r.plays },
    });
    taste.onboarding.rounds = taste.explicit.comparisons.filter((c) => c.chose).length;
    state.round = null;
    recomputeDerived(); saveTaste();
    nextRound();
    renderForYou();
  }
  function finishOnboarding(skipped) {
    state.onboarding = false; state.round = null;
    taste.onboarding.done = true;
    taste.onboarding.skipped = !!skipped;
    taste.onboarding.completedAt = Date.now();
    recomputeDerived(); saveTaste();
    renderOnboard(); renderForYou();
    $("#tuneBtn").hidden = false;
    if (!skipped && hasTaste()) {
      const fy = $("#forYou");
      if (fy && !fy.hidden) fy.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /* ===================================================================== */
  /* Recommendations. A ranking over the existing events, never a filter.    */
  /* ===================================================================== */
  function artistScore(p) {
    const sim = tasteSim(p.v);
    const ga = (p.genres || []).reduce((s, g) => s + (taste.derived.genreAffinity[g] || 0), 0) / Math.max(1, (p.genres || []).length);
    const aff = taste.derived.artistAffinity[p.key] || 0;
    let s = 0.78 * sim + 0.22 * Math.max(-1, Math.min(1, ga));
    if (aff > 0) s += Math.min(0.35, 0.18 * aff);
    if (aff < 0) s += Math.max(-0.4, 0.3 * aff);          // rejected acts sink, they are not banned
    return s;
  }

  /** Candidate events for the personalised rails: same city, window and sources
      as All Gigs, but deliberately ignoring the genre / venue / audience-size
      filters, because For You is a layer over the database and not a view of it. */
  function recommendCandidates() {
    const [t0, t1] = windowBounds(Math.max(state.days, 14));
    const out = [];
    for (const e of state.data.events) {
      if (e.date < t0 || e.date > t1) continue;
      if (!srcOk(e)) continue;
      const arts = collapseSameSpotify(e.artists).filter((a) => a.tracks?.length);
      if (!arts.length) continue;
      let best = null, bestScore = -Infinity;
      for (const a of arts) {
        const p = state.poolByKey.get(artistKey(a));
        if (!p || !p.known) continue;
        const s = artistScore(p);
        if (s > bestScore) { bestScore = s; best = p; }
      }
      if (!best) continue;
      out.push({ e, artists: arts, lead: best, score: bestScore });
    }
    out.sort((x, y) => y.score - x.score || x.e.start.localeCompare(y.e.start));
    return out;
  }

  /* Rails. Two dedupe rules run across the whole For You block:
     an event appears at most once, and so does an ARTIST. Three nights of the
     same band is a calendar, not discovery. */
  function railBecause(cands, ctx) {
    // Seed on artists they actually chose. Later rounds are the more refined
    // answers, so a late pick outranks an early one at the same affinity.
    const roundOf = new Map();
    taste.explicit.comparisons.forEach((c, i) => { if (c.chose) roundOf.set(c.chose, i); });
    const picks = Object.entries(taste.derived.artistAffinity)
      .filter(([, s]) => s > 0.5)
      .sort((a, b) => (b[1] - a[1]) || ((roundOf.get(b[0]) ?? -1) - (roundOf.get(a[0]) ?? -1)))
      .map(([k]) => state.poolByKey.get(k)).filter(Boolean);
    const seeds = [];
    for (const p of picks) {
      // One "because you liked" rail unless a second pick sits somewhere genuinely
      // different in taste space — two rails about the same corner is just padding.
      if (seeds.length && seeds.every((s) => vecSim(s.v, p.v) > 0.5)) continue;
      seeds.push(p);
      if (seeds.length === 2) break;
    }
    const rails = [];
    for (const seed of seeds) {
      const pool = cands.filter((c) => free(c, ctx)).map((c) => ({ ...c, rel: vecSim(seed.v, c.lead.v) }));
      // The seed's own next show can lead the rail, but only once and only one of them.
      const own = pool.filter((c) => c.lead.key === seed.key).sort((a, b) => a.e.start.localeCompare(b.e.start))[0];
      const others = pool.filter((c) => c.lead.key !== seed.key && c.rel > 0.55)
        .sort((a, b) => (b.rel * 0.6 + b.score * 0.4) - (a.rel * 0.6 + a.score * 0.4));
      const items = dedupeByArtist([...(own ? [own] : []), ...others], ctx, 4);
      if (items.length < 2) continue;
      for (const it of items) {
        claim(it, ctx);
        it.reason = it.lead.key === seed.key ? `You picked ${seed.name} — they're playing` : `Because you liked ${seed.name}`;
      }
      rails.push({ id: "because", title: `Because you liked ${seed.name}`, items });
    }
    return rails;
  }
  function railEmerging(cands, ctx) {
    // Only acts the visitor has given no sign of already knowing: anything they
    // were shown in the game, picked, played or saved is not a discovery.
    const known = shownKeys();
    for (const k of Object.keys(taste.behaviour.plays || {})) known.add(k);
    for (const k of taste.explicit.savedArtists || []) known.add(k);
    const items = dedupeByArtist(
      cands.filter((c) => free(c, ctx))
        .filter((c) => c.lead.tier > 0 && c.lead.tier <= 2 && c.score > 0.18 && !known.has(c.lead.key))
        .sort((a, b) => b.score - a.score), ctx, 4);
    if (!items.length) return null;
    // The act of theirs this one most resembles, never the act itself.
    const nearest = (p) => {
      let bk = null, bs = 0;
      for (const [k, s] of Object.entries(taste.derived.artistAffinity)) {
        if (s <= 0.5 || k === p.key) continue;
        const q = state.poolByKey.get(k); if (!q) continue;
        const sim = vecSim(p.v, q.v);
        if (sim > bs) { bs = sim; bk = q; }
      }
      return bk;
    };
    for (const it of items) {
      claim(it, ctx);
      const seed = nearest(it.lead);
      it.reason = seed ? `You liked ${seed.name}. Catch ${it.lead.name} first.`
        : `${TIER_NAMES[it.lead.tier]} act that fits your picks`;
    }
    return { id: "emerging", title: "Before they blow up", items, blurb: "Smaller acts that match your picks, playing here soon." };
  }
  function railMore(cands, ctx) {
    const items = dedupeByArtist(cands.filter((c) => free(c, ctx) && c.score > 0.05), ctx, 6);
    if (!items.length) return null;
    for (const it of items) {
      claim(it, ctx);
      const g = (it.lead.genres || [])[0];
      it.reason = g ? `${g} · matches your picks` : "Matches your picks";
    }
    return { id: "more", title: "You might like this", items };
  }
  // Shared dedupe bookkeeping for the rails above.
  const free = (c, ctx) => !ctx.events.has(showKey(c.e)) && !ctx.artists.has(c.lead.key);
  const claim = (c, ctx) => { ctx.events.add(showKey(c.e)); ctx.artists.add(c.lead.key); };
  function dedupeByArtist(list, ctx, n) {
    const out = [], seen = new Set();
    for (const c of list) {
      if (seen.has(c.lead.key) || ctx.artists.has(c.lead.key)) continue;
      seen.add(c.lead.key); out.push(c);
      if (out.length === n) break;
    }
    return out;
  }

  function tasteLine() {
    const parts = [];
    const strong = AXES.map((k) => ({ k, b: beliefOf(k), c: confOf(k) }))
      .filter((x) => x.c > 0.35 && Math.abs(x.b) > 0.25)
      .sort((x, y) => Math.abs(y.b) * y.c - Math.abs(x.b) * x.c);
    const words = {
      guitar: ["machines and production", "guitars and bands"],
      energy: ["slower and gentler", "loud and fast"],
      pop: ["left of the dial", "big hooks"],
      urban: ["", "hip hop and r&b"],
      roots: ["", "roots and acoustic"],
      dance: ["made for listening", "made for dancing"],
      reach: ["small rooms and rising acts", "the big names"],
    };
    for (const x of strong.slice(0, 3)) {
      const w = words[x.k][x.b > 0 ? 1 : 0];
      if (w) parts.push(w);
    }
    return parts.length ? parts.join(", ") + "." : "Still forming a picture — a couple more picks will sharpen it.";
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
    for (const e of state.data.events.filter(srcOk)) {
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
    for (const e of state.data.events.filter(srcOk)) for (const a of e.artists) for (const g of new Set(artistGenres(a))) counts.set(g, (counts.get(g) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 48);
    const on = new Set(state.genres.map((g) => g.toLowerCase()));
    $("#genres").innerHTML = top.map(([g, n]) =>
      `<button class="chip" data-g="${esc(g)}" aria-pressed="${on.has(g)}">${esc(g)}<span class="n">${n}</span></button>`).join("")
      || `<span style="color:var(--muted);font-size:13px">No genre data for this city yet.</span>`;
    $("#headliners").checked = state.headliners;
  }

  /* ---- the comparison game ---- */
  function artistCard(p, side) {
    const t = p.tracks[0];
    const on = playing && t && playing.trackId === t.id;
    return `<div class="vsCard" data-side="${side}">
      <div class="vsArt">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ""}</div>
      <div class="vsName">${esc(p.name)}</div>
      <div class="vsMeta">${(p.genres || []).slice(0, 2).map((g) => `<span class="pill">${esc(g)}</span>`).join(" ")}${p.listeners ? `<span class="reach">${fmtListeners(p.listeners)} listeners</span>` : ""}</div>
      ${t ? `<button class="btn ghost vsPlay${on ? " on" : ""}" data-play="${esc(t.id)}" data-key="onboard:${esc(p.key)}" data-artist="${esc(p.name)}" data-track="${esc(t.name)}" data-pool="${esc(p.key)}">${on ? "◼ Playing" : "▶ Play top track"}</button>` : `<span class="vsNoTrack">No track</span>`}
      <button class="btn primary vsChoose" data-choose="${esc(p.key)}">Choose</button>
    </div>`;
  }
  function renderOnboard() {
    const el = $("#onboard");
    if (!state.onboarding || !state.round) {
      // Done, skipped, or never started.
      if (taste.onboarding.done && hasTaste()) { el.hidden = true; el.innerHTML = ""; return; }
      if (taste.onboarding.done) {
        el.hidden = false;
        el.innerHTML = `<div class="obDone"><b>No problem.</b> Everything below is every gig in town. <button class="btn ghost" id="obRestart">Try the taste game</button></div>`;
        $("#obRestart").onclick = () => startOnboarding(true);
        return;
      }
      el.hidden = true; el.innerHTML = ""; return;
    }
    const r = state.round;
    const total = Math.max(OB.minRounds, Math.min(OB.maxRounds, r.n + (onboardingComplete() ? 0 : 2)));
    const dots = Array.from({ length: OB.maxRounds }, (_, i) =>
      `<span class="obDot${i < r.n ? " done" : i === r.n ? " now" : ""}"></span>`).join("");
    el.hidden = false;
    el.innerHTML = `
      <div class="obHead">
        <div>
          <div class="obKicker">${r.n === 0 ? "Let's figure out what you might want to see live" : r.n >= 4 ? "Getting harder" : "Which would you rather see live?"}</div>
          ${r.n === 0 ? `<div class="obSub">Two acts, pick one. Press play if you don't remember how they sound.</div>` : ""}
        </div>
        <div class="obProg">${dots}<button class="btn ghost obSkip" id="obSkip">Skip</button></div>
      </div>
      <div class="vsRow">
        ${artistCard(r.a, "a")}
        <div class="vsOr">vs</div>
        ${artistCard(r.b, "b")}
      </div>`;
    $("#obSkip").onclick = () => finishOnboarding(true);
    void total;
  }

  /* ---- For You ---- */
  function gigCard(item) {
    const e = item.e, k = showKey(e), isSaved = saved.has(k);
    const lead = item.lead, t = lead.tracks[0];
    const on = playing && t && playing.trackId === t.id;
    const srcLabel = e.source === "do604" ? "Details" : "Tickets";
    return `<article class="rec${isSaved ? " saved" : ""}" data-key="${esc(k)}">
      <div class="recWhy">${esc(item.reason || "")}</div>
      <div class="recBody">
        ${lead.image ? `<img class="recImg" src="${esc(lead.image)}" alt="" loading="lazy">` : ""}
        <div class="recInfo">
          <div class="recName">${esc(lead.name)}${lead.tier ? `<span class="pill">${TIER_NAMES[lead.tier]}</span>` : ""}</div>
          <div class="recWhen">${fmtDate(e.date)} · ${esc(e.venue || "Venue TBA")}${e.source === "do604" ? ` <span class="pill">local</span>` : ""}</div>
          <div class="recActs">
            ${t ? `<button class="play${on ? " on" : ""}" data-play="${esc(t.id)}" data-key="${esc(k)}" data-artist="${esc(lead.name)}" data-track="${esc(t.name)}" data-pool="${esc(lead.key)}" title="Play">${on ? "◼" : "▶"}</button><span class="recTrack">${esc(t.name)}</span>` : ""}
            <button class="star${isSaved ? " on" : ""}" data-save="${esc(k)}" aria-pressed="${isSaved}" title="${isSaved ? "Remove from my shows" : "Save to my shows"}">${isSaved ? "★" : "☆"}</button>
            <a class="lnk" href="${esc(e.url)}" target="_blank" rel="noopener" data-ticket="${esc(lead.key)}">${srcLabel} ↗</a>
          </div>
        </div>
      </div>
    </article>`;
  }
  function renderForYou() {
    const el = $("#forYou");
    if (!state.data || !hasTaste()) { el.hidden = true; el.innerHTML = ""; $("#allGigsHead").hidden = true; return; }
    const cands = recommendCandidates();
    const ctx = { events: new Set(), artists: new Set() };
    const rails = [...railBecause(cands, ctx)];
    const em = railEmerging(cands, ctx); if (em) rails.push(em);
    const more = railMore(cands, ctx); if (more) rails.push(more);
    if (!rails.length) { el.hidden = true; el.innerHTML = ""; $("#allGigsHead").hidden = true; return; }
    el.hidden = false;
    const done = taste.onboarding.done && !state.onboarding;
    el.innerHTML = `
      <div class="fyHead">
        <div>
          <h2 class="fyTitle">${done ? "We've got your vibe" : "Shaping up"}</h2>
          <div class="fySub">${esc(tasteLine())}</div>
        </div>
        <button class="btn ghost" id="fyTune">${done ? "Tune this" : "Keep going"}</button>
      </div>
      ${rails.map((r) => `
        <div class="rail" data-rail="${r.id}">
          <div class="railHead"><h3>${esc(r.title)}</h3>${r.blurb ? `<span class="railBlurb">${esc(r.blurb)}</span>` : ""}</div>
          <div class="railItems">${r.items.map(gigCard).join("")}</div>
        </div>`).join("")}`;
    $("#fyTune").onclick = () => { startOnboarding(true); $("#onboard").scrollIntoView({ behavior: "smooth", block: "start" }); };
    $("#allGigsHead").hidden = false;
  }

  function renderResults() {
    const r = select();
    $("#nShows").textContent = r.shows.length;
    $("#nArtists").textContent = r.nArtists;
    $("#nTracks").textContent = r.uris.length;
    $("#copyList").disabled = !r.uris.length;
    if (!r.shows.length) {
      $("#results").innerHTML = `<div class="empty">Nothing matches. Widen the window or tick more venues.</div>`;
    } else {
      let html = "", day = "";
      for (const e of r.shows) {
        if (e.date !== day) { day = e.date; html += `<div class="day">${fmtDate(e.date)}</div>`; }
        const k = showKey(e), isSaved = saved.has(k);
        const srcLabel = e.source === "do604" ? "Details on Do604" : "Tickets & info";
        html += `<article class="show${isSaved ? " saved" : ""}" data-key="${esc(k)}">
          <div class="showhead">
            <div class="venue"><span class="vname">${esc(e.venue || "Venue TBA")}</span>${e.source === "do604" ? ` <span class="pill">local</span>` : ""}${e.locality && !e.venue?.includes(e.locality) ? ` · ${esc(e.locality)}` : ""}${timeOf(e.start) ? `<span class="time">${timeOf(e.start).replace(" · ", "")}</span>` : ""}</div>
            <div class="showactions">
              <a class="lnk" href="${esc(e.url)}" target="_blank" rel="noopener" data-ticket="${esc(artistKey(e.artists[0] || {}))}">${srcLabel} ↗</a>${(e.also_listed || []).filter((x) => x.url).map((x) => `<a class="lnk" href="${esc(x.url)}" target="_blank" rel="noopener">${x.source === "do604" ? "Do604" : "Songkick"} ↗</a>`).join("")}
              <button class="star${isSaved ? " on" : ""}" data-save="${esc(k)}" title="${isSaved ? "Remove from my shows" : "Save to my shows"}" aria-pressed="${isSaved}">${isSaved ? "★" : "☆"}</button>
            </div>
          </div>
          ${e.artists.map((a) => `
            <div class="artist" data-artist-id="${esc(artistKey(a))}">
              ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy">` : ""}
              <div class="ainfo">
                <div class="who"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>${a.spotify_name && norm(a.spotify_name) !== norm(a.name) ? `<small>as “${esc(a.spotify_name)}” on Spotify</small>` : ""}${a.also_billed?.length ? `<small>also billed as ${a.also_billed.map((n) => `“${esc(n)}”`).join(", ")}</small>` : ""}${a.reach?.listeners ? `<span class="reach" title="Last.fm listeners">${fmtListeners(a.reach.listeners)} listeners</span>` : `<span class="reach">not on Last.fm</span>`}${artistGenres(a).slice(0, 3).map((g) => `<small class="pill">${esc(g)}</small>`).join(" ")}</div>
                <div class="tracks">${a.tracks.map((t) => `<button class="play${playing && playing.trackId === t.id ? " on" : ""}" data-play="${t.id}" data-key="${esc(k)}" data-artist="${esc(a.name)}" data-track="${esc(t.name)}" data-pool="${esc(artistKey(a))}" title="Play in page">${playing && playing.trackId === t.id ? "◼" : "▶"}</button><a href="https://open.spotify.com/track/${t.id}" target="_blank" rel="noopener">${esc(t.name)}</a>`).join(`<span class="sep">·</span>`)}</div>
              </div>
            </div>`).join("")}
        </article>`;
      }
      $("#results").innerHTML = html;
    }
    $("#savedBtn").textContent = `★ My shows${saved.size ? ` (${saved.size})` : ""}`;
    $("#savedBtn").setAttribute("aria-pressed", state.savedOnly);
    if (!r.shows.length && state.savedOnly) $("#results").innerHTML = `<div class="empty">No saved shows in this window. Tap ☆ on a show to save it.</div>`;
    const cityName = state.data.city_name.split(",")[0];
    if (!$("#plName").value) $("#plName").value = `${CFG.playlistPrefix || "GigAmp"} · ${cityName}`;
    $("#subJson").textContent = JSON.stringify({
      id: "me", city: state.city, playlist_name: $("#plName").value, days: state.days,
      venues: state.venues || [], exclude_venues: [], genres: state.genres, sources: state.sources, reach: state.reach,
      headliners_only: state.headliners, public: false, token_secret: "SPOTIFY_REFRESH_TOKEN_ME",
    }, null, 2);
    const um = state.data.unmatched?.length || 0;
    $("#unmatched").textContent = um ? ` ${um} billed act${um === 1 ? "" : "s"} had no Spotify match and ${um === 1 ? "was" : "were"} left out.` : "";
    const gen = new Date(state.data.generated_at);
    const pend = state.data.pending?.length || 0;
    $("#dataAge").textContent = `Listings updated ${gen.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${state.data.events.length} shows over ${state.data.horizon_days} days` + (pend ? ` · ${pend} acts still being matched` : "");
  }
  function renderReach() {
    const [lo, hi] = state.reach;
    $("#reachMin").value = lo; $("#reachMax").value = hi;
    const pct = (v) => 9 + (v / 4) * (($("#reachRange").clientWidth || 300) - 18);
    $("#reachFill").style.left = pct(lo) + "px"; $("#reachFill").style.width = Math.max(0, pct(hi) - pct(lo)) + "px";
    const counts = [0, 0, 0, 0, 0];
    for (const e of state.data.events.filter(srcOk)) for (const a of e.artists) counts[tierOf(a)]++;
    const inRange = counts.slice(lo, hi + 1).reduce((x, y) => x + y, 0);
    $("#reachLabel").innerHTML = lo === 0 && hi === 4 ? `All sizes · <b>${inRange}</b> acts`
      : `<b>${TIER_NAMES[lo]}</b>${lo !== hi ? ` to <b>${TIER_NAMES[hi]}</b>` : ""} · <b>${inRange}</b> of ${counts.reduce((x, y) => x + y, 0)} acts`;
  }
  function onReachInput() {
    let lo = +$("#reachMin").value, hi = +$("#reachMax").value;
    if (lo > hi) { if (this && this.id === "reachMin") hi = lo; else lo = hi; }
    state.reach = [lo, hi]; renderReach(); renderResults(); writeHash();
  }
  $("#reachMin").addEventListener("input", onReachInput); $("#reachMax").addEventListener("input", onReachInput);
  window.addEventListener("resize", () => state.data && renderReach());
  function renderSources() { for (const b of document.querySelectorAll("[data-src]")) b.checked = state.sources.includes(b.dataset.src); }
  function renderAll() { renderSources(); renderDays(); renderVenues(); renderGenres(); renderReach(); renderOnboard(); renderForYou(); renderResults(); writeHash(); }
  for (const b of document.querySelectorAll("[data-src]")) b.addEventListener("change", () => {
    state.sources = [...document.querySelectorAll("[data-src]")].filter((x) => x.checked).map((x) => x.dataset.src);
    renderVenues(); renderGenres(); renderReach(); renderForYou(); renderResults(); writeHash();
  });

  // ---------- docked player (lives outside #results so re-renders never interrupt playback) ----------
  const dock = { api: null, controller: null, ready: false, pendingUri: null };
  window.onSpotifyIframeApiReady = (IFrameAPI) => { dock.api = IFrameAPI; if (dock.pendingUri) dockPlay(dock.pendingUri); };
  (function loadIframeApi() {
    const sc = document.createElement("script"); sc.src = "https://open.spotify.com/embed/iframe-api/v1"; sc.async = true;
    sc.onerror = () => { dock.api = "failed"; if (dock.pendingUri) dockPlay(dock.pendingUri); };
    document.head.appendChild(sc);
  })();
  function dockPlay(uri) {
    const host = $("#dockPlayer");
    if (!dock.api) { dock.pendingUri = uri; return; }             // API still loading: play once it lands
    dock.pendingUri = null;
    if (dock.api === "failed") {                                 // fallback: plain embed (user presses play inside)
      host.innerHTML = `<iframe src="https://open.spotify.com/embed/track/${uri.split(":").pop()}?utm_source=generator&theme=0" width="100%" height="80" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="Spotify player"></iframe>`;
      return;
    }
    if (dock.controller) { dock.controller.loadUri(uri); dock.controller.play(); return; }
    host.innerHTML = `<div id="dockEmbed"></div>`;
    dock.api.createController($("#dockEmbed"), { uri, width: "100%", height: 80, theme: "dark" }, (controller) => {
      dock.controller = controller;
      controller.addListener("ready", () => controller.play());
      controller.addListener("playback_update", (ev) => {
        // Reflect real player state on the ▶ buttons (paused inside the widget, track ended...)
        const isPaused = ev?.data?.isPaused, pos = ev?.data?.position, dur = ev?.data?.duration;
        if (isPaused && pos && dur && pos >= dur - 500) { playing = null; syncPlayButtons(); }
      });
    });
  }
  function syncPlayButtons() {
    for (const b of document.querySelectorAll("[data-play]")) {
      const on = !!playing && b.dataset.play === playing.trackId;
      b.classList.toggle("on", on);
      if (b.classList.contains("vsPlay")) b.textContent = on ? "◼ Playing" : "▶ Play top track";
      else b.textContent = on ? "◼" : "▶";
    }
  }
  function showDock(artist, track) {
    $("#dock").hidden = false; document.body.classList.add("has-dock");
    $("#dockTitle").innerHTML = `<b>${esc(artist)}</b> <span>${esc(track)}</span>`;
  }
  function closeDock() {
    playing = null; syncPlayButtons();
    try { dock.controller?.pause(); } catch {}
    $("#dock").hidden = true; document.body.classList.remove("has-dock");
  }
  $("#dockClose").onclick = closeDock;

  /** One play path for the whole site: gig cards, For You cards and the
      comparison game all go through this, so there is a single audio system. */
  function handlePlayClick(pb) {
    const id = pb.dataset.play;
    const poolKey = pb.dataset.pool;
    if (playing && playing.trackId === id) {                    // same track: pause/stop
      try { dock.controller?.pause(); } catch {}
      playing = null; syncPlayButtons(); return;
    }
    playing = { key: pb.dataset.key, trackId: id };
    showDock(pb.dataset.artist, pb.dataset.track);
    dockPlay(`spotify:track:${id}`);
    syncPlayButtons();
    if (poolKey) {
      taste.behaviour.plays[poolKey] = (taste.behaviour.plays[poolKey] || 0) + 1;
      if (state.round && (poolKey === state.round.a.key || poolKey === state.round.b.key))
        state.round.plays[poolKey] = (state.round.plays[poolKey] || 0) + 1;
      recomputeDerived(); saveTaste();
    }
  }
  function handleSaveClick(sb) {
    // Toggle in place: no re-render, so nothing playing is interrupted.
    const k = sb.dataset.save;
    const on = !saved.has(k);
    if (on) saved.add(k); else saved.delete(k);
    store.set("gigamp:saved", [...saved]);
    for (const b of document.querySelectorAll(`[data-save="${CSS.escape(k)}"]`)) {
      b.classList.toggle("on", on); b.textContent = on ? "★" : "☆"; b.setAttribute("aria-pressed", on);
      b.title = on ? "Remove from my shows" : "Save to my shows";
      b.closest(".show,.rec")?.classList.toggle("saved", on);
    }
    $("#savedBtn").textContent = `★ My shows${saved.size ? ` (${saved.size})` : ""}`;
  }
  function delegate(root) {
    root.addEventListener("click", (e) => {
      const pb = e.target.closest("[data-play]"); if (pb) return handlePlayClick(pb);
      const sb = e.target.closest("[data-save]");
      if (sb) { handleSaveClick(sb); if (state.savedOnly) renderResults(); return; }
      const ch = e.target.closest("[data-choose]"); if (ch) return answerRound(ch.dataset.choose);
      const tk = e.target.closest("[data-ticket]");
      if (tk) { const k = tk.dataset.ticket; if (k) { taste.behaviour.ticketClicks[k] = (taste.behaviour.ticketClicks[k] || 0) + 1; recomputeDerived(); saveTaste(); } }
    });
  }
  delegate($("#results")); delegate($("#onboard")); delegate($("#forYou"));
  $("#savedBtn").onclick = () => { state.savedOnly = !state.savedOnly; renderResults(); };
  $("#tuneBtn").onclick = () => { startOnboarding(true); $("#onboard").scrollIntoView({ behavior: "smooth", block: "start" }); };

  // ---------- events ----------
  $("#city").addEventListener("change", async (e) => { state.city = e.target.value; state.venues = null; state.genres = []; await loadCity(); buildPool(); renderAll(); });
  $("#days").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.days = +b.dataset.days; renderDays(); renderForYou(); renderResults(); writeHash(); });
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
  $("#share").onclick = async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); status("Link copied. Anyone opening it sees this exact selection."); }
    catch { status(`Share this link: ${location.href}`); }
  };
  // Playlist handoff without any sign-in: the track list goes to the clipboard,
  // ready to paste into a Spotify (or anything else) search / import box.
  $("#copyList").onclick = async () => {
    const r = select(); if (!r.shows.length) return;
    const lines = [], seen = new Set();
    for (const s of r.shows) for (const a of s.artists) for (const t of a.tracks) {
      const line = `${a.name} - ${t.name}`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
    const text = lines.join("\n");
    try { await navigator.clipboard.writeText(text); status(`${lines.length} tracks copied. Paste them into a Spotify playlist, or any importer.`); }
    catch { status("Copy failed — your browser blocked clipboard access."); }
  };

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

  // ---------- utils ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeOf = (start) => { const m = /T(\d{2}):(\d{2})/.exec(start || ""); if (!m) return ""; const h = +m[1]; return ` · ${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "am" : "pm"}`; };
  function status(msg, err) { const el = $("#status"); el.innerHTML = msg; el.className = "status" + (err ? " err" : ""); }

  // ---------- boot ----------
  (async () => {
    try {
      // Old Spotify callback links may still carry ?code= / ?error=; drop them.
      if (/[?&](code|error)=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
      anonId();
      taste = Object.assign(blankTaste(), store.get(TASTE_KEY, null) || {});
      taste.explicit = Object.assign({ comparisons: [], savedArtists: [] }, taste.explicit);
      taste.behaviour = Object.assign({ plays: {}, ticketClicks: {}, dismissed: [] }, taste.behaviour);
      taste.onboarding = Object.assign({ done: false, rounds: 0, startedAt: null, completedAt: null, skipped: false }, taste.onboarding);
      recomputeDerived();                       // derived state is always rebuilt, never trusted from storage

      if (!location.hash) { try { const s = localStorage.getItem("gigamp:sel"); if (s) history.replaceState(null, "", s); } catch {} }
      const firstVisit = !location.hash;
      readHash();
      await Promise.all([loadIndex(), loadVocab()]); renderCity(); await loadCity();
      if (firstVisit && state.venues === null) {
        const small = [...new Set(state.data.events.map((e) => e.venue))].filter((v) => v && !ARENA_RE.test(v));
        if (small.length < new Set(state.data.events.map((e) => e.venue)).size) state.venues = small;
      }
      buildPool();
      $("#tuneBtn").hidden = !(taste.onboarding.done || hasTaste());
      if (!taste.onboarding.done && CFG.onboardingEnabled !== false && state.pool.length >= 8) startOnboarding(false);
      renderAll();
    } catch (e) { status(esc(e.message), true); console.error("GigAmp failed to start:", e); }
  })();
  window.addEventListener("error", (ev) => { const el = $("#status"); if (el && !el.textContent) { el.textContent = "Something broke on this page: " + (ev.message || "unknown error") + ". Try a hard refresh (Cmd+Shift+R)."; el.className = "status err"; } });

  // Exposed for the node test harness in tests/. No behaviour depends on it.
  window.__gigamp = { AXES, GENRE_AXES, LABEL_TO_ID, TIER_REACH, state, get taste() { return taste; }, nextPair, recomputeDerived, tasteSim, artistScore };
})();
