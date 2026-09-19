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
      city: () => { const sel = document.createElement("select"); sel.id = "city"; sel.hidden = true; document.body.appendChild(sel); },
      personalModule: () => { const d = document.createElement("details"); d.id = "personalModule"; d.className = "module"; d.hidden = true;
        d.innerHTML = `<summary><h2 id="fyTitle">For you</h2><span class="modSub" id="fySub"></span></summary><div class="modBody"><section id="onboard"></section><div id="forYou"></div></div>`;
        ($("#results") || document.body).insertAdjacentElement("beforebegin", d); },
      advancedModule: () => { const d = document.createElement("details"); d.id = "advancedModule"; d.className = "module"; document.body.appendChild(d); },
      facePanel: () => { const d = document.createElement("details"); d.id = "facePanel"; d.className = "faceplate"; d.open = true;
        d.innerHTML = `<summary class="faceSummary"><span class="faceLabel">Search</span><span id="faceNow"></span></summary>`;
        ($("#knobs") || document.body).insertAdjacentElement("beforebegin", d); },
    };
    for (const [id, make] of Object.entries(need)) if (!document.getElementById(id)) { try { make(); } catch {} }
    for (const id of ["status", "results", "unmatched", "dataAge", "nShows", "nArtists", "nTracks", "allGigsHead",
      "tuneBtn", "copyList", "knobs", "fySub", "fyTitle", "filterSummary", "faceCount", "citySelectWrap", "forYou", "faceNow"])
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
  const UI_KEY = "gigamp:ui";          // which modules the visitor left open
  const ROT_KEY = "gigamp:rot";        // rotates the "because you liked" seed per visit
  const blankTaste = () => ({
    v: 1,
    // What the user told us.
    explicit: { comparisons: [], savedArtists: [] },
    // What they did.
    behaviour: { plays: {}, ticketClicks: {}, dismissed: [] },
    // What we calculated. Always rebuildable from the two above.
    derived: { axes: {}, artistAffinity: {}, genreAffinity: {}, updatedAt: null },
    onboarding: { done: false, rounds: 0, startedAt: null, completedAt: null, skipped: false, targetRounds: 0 },
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
    for (const [key, w] of savedArtistWeights()) bump(artistAffinity, key, w);

    taste.derived = { axes, artistAffinity, genreAffinity, updatedAt: Date.now() };
  }

  /** Artists on the shows the visitor starred. Starring is a stronger statement of
      intent than anything the survey can ask, so it feeds the same affinity score. */
  function savedArtistWeights() {
    const out = new Map();
    if (!state.data) return out;
    for (const e of state.data.events) {
      if (!saved.has(showKey(e))) continue;
      const arts = collapseSameSpotify(e.artists);
      arts.forEach((a, i) => {
        // The act on the poster is why the show was starred; the rest of the bill
        // counts, but not enough on its own to become a "because you liked" seed.
        const w = i === 0 ? 0.9 : 0.45;
        const k = artistKey(a);
        out.set(k, Math.max(out.get(k) || 0, w));
      });
    }
    return out;
  }
  const savedArtistKeys = () => new Set([...savedArtistWeights()].filter(([, w]) => w >= 0.9).map(([k]) => k));

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
    seeds: [],        // well-known acts from docs/seed-artists.json, no local gig required
    pool: [],         // comparison pool: seeds plus local acts
    poolByKey: new Map(),
    round: null,      // the comparison on screen: { n, a, b, plays:{} }
    onboarding: false,
    railOpen: new Set(),
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
    // Local acts first: anything with a gig in this city, whatever its size.
    for (const e of state.data.events) {
      for (const a of collapseSameSpotify(e.artists)) {
        if (!a.tracks || !a.tracks.length) continue;         // needs a track so Play works
        const key = artistKey(a);
        let p = by.get(key);
        if (!p) {
          const { v, known } = artistVector(a);
          p = { key, name: a.name, image: a.image, url: a.url, tracks: a.tracks,
            tier: tierOf(a), listeners: a.reach?.listeners || 0, genres: artistGenres(a),
            v, known, local: true, events: [], nextDate: null };
          by.set(key, p);
        }
        p.local = true;
        p.events.push(e);
        if (!p.nextDate || e.date < p.nextDate) p.nextDate = e.date;
      }
    }
    // Then the seed pool. These are the measuring instrument for the taste game and
    // are deliberately NOT required to be playing here; they never enter the rails,
    // which only ever rank real gigs.
    for (const a of state.seeds) {
      if (!a.tracks || !a.tracks.length) continue;
      const key = artistKey(a);
      if (by.has(key)) continue;                             // already here with a real gig
      const { v, known } = artistVector(a);
      by.set(key, { key, name: a.name, image: a.image, url: a.url, tracks: a.tracks,
        tier: tierOf(a), listeners: a.reach?.listeners || 0, genres: artistGenres(a),
        v, known, local: false, events: [], nextDate: null });
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
  const OB = Object.assign({ minRounds: 5, maxRounds: 8, settledAxes: 4, settledConf: 0.5,
    tuneRounds: 3, maxPasses: 6 }, CFG.onboarding || {});
  const RAIL = Object.assign({ size: 2, expanded: 6, seedPool: 6 }, CFG.rails || {});
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
    if (cands.length < 2) {
      // Someone who keeps tuning eventually sees every act in the pool. Rather than
      // stopping dead, let the ones they saw longest ago come round again.
      const lastSeen = new Map();
      taste.explicit.comparisons.forEach((c, i) => { lastSeen.set(c.a.key, i); lastSeen.set(c.b.key, i); });
      cands = [...state.pool]
        .filter((p) => !state.round || (p.key !== state.round.a.key && p.key !== state.round.b.key))
        .sort((a, b) => (lastSeen.get(a.key) ?? -1) - (lastSeen.get(b.key) ?? -1))
        .slice(0, 80);
    }
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
        // Late on, a rising local act opposite something known is the interesting
        // question, and it is the one place the game itself can surface a discovery.
        if (emergingRound) {
          const lo = (p) => p.tier > 0 && p.tier <= 2;
          if (lo(a) !== lo(b)) score += 0.45;
          if (lo(a) && lo(b)) score += 0.2;
          if (a.local !== b.local) score += 0.35;
          if ((a.local && a.tier <= 2) || (b.local && b.tier <= 2)) score += 0.3;
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

  const answeredCount = () => taste.explicit.comparisons.filter((c) => c.chose).length;
  const shownCount = () => taste.explicit.comparisons.length;

  function onboardingComplete() {
    const n = answeredCount();
    // A "tune" run sets a target a few rounds above where the profile already is.
    // Without this the stop rule is satisfied the moment the run starts and the
    // whole thing finishes before a single question is drawn.
    // A tune run asks for a fixed number more, counted from where it started, and
    // NOTHING else applies while it is running. The old fallback to a lifetime
    // ceiling meant that once someone had answered maxRounds + tuneRounds across
    // all their visits, every later tune finished before drawing a question -
    // which looked exactly like the button doing nothing.
    if (taste.onboarding.targetRounds) return n >= taste.onboarding.targetRounds;
    if (n >= OB.maxRounds) return true;
    if (n >= OB.minRounds && settledAxes() >= OB.settledAxes) return true;
    return false;
  }

  /** mode: undefined = first run, "tune" = a few more questions on what is least certain. */
  function startOnboarding(mode) {
    if (!state.pool.length) return;
    if (mode === "tune") {
      taste.onboarding.done = false;
      taste.onboarding.skipped = false;
      taste.onboarding.targetRounds = answeredCount() + OB.tuneRounds;
    }
    if (!taste.onboarding.startedAt) taste.onboarding.startedAt = Date.now();
    state.onboarding = true;
    state.runShown = 0;              // pass guard counts this run, not a lifetime
    nextRound();
  }
  function nextRound() {
    const n = answeredCount();
    if (onboardingComplete()) return finishOnboarding();
    // Somebody who passes on everything would otherwise loop forever through the pool.
    // Counted per run: a lifetime count would strand a returning visitor.
    const cap = (taste.onboarding.targetRounds ? OB.tuneRounds : OB.maxRounds) + OB.maxPasses;
    if ((state.runShown || 0) >= cap) return finishOnboarding();
    const pair = nextPair(n);
    if (!pair) return finishOnboarding();
    state.runShown = (state.runShown || 0) + 1;
    state.round = { n, a: pair[0], b: pair[1], shownAt: Date.now(), plays: {} };
    $("#personalModule").hidden = false;
    applyUiState();
    renderOnboard();
    syncPersonalHeader();
  }
  /** Neither act means anything to them. Record it so the pair never returns, but
      write no preference: a guessed answer is worse than no answer. */
  function passRound() {
    const r = state.round; if (!r) return;
    const snap = (p) => ({ key: p.key, name: p.name, v: p.v, genres: p.genres, tier: p.tier });
    taste.explicit.comparisons.push({
      round: r.n, a: snap(r.a), b: snap(r.b), chose: null, passed: true,
      shownAt: r.shownAt, answeredAt: Date.now(), plays: { ...r.plays },
    });
    state.round = null;
    saveTaste();
    nextRound();
  }
  function answerRound(key) {
    const r = state.round; if (!r) return;
    const snap = (p) => ({ key: p.key, name: p.name, v: p.v, genres: p.genres, tier: p.tier });
    taste.explicit.comparisons.push({
      round: r.n, a: snap(r.a), b: snap(r.b), chose: key,
      shownAt: r.shownAt, answeredAt: Date.now(), plays: { ...r.plays },
    });
    taste.onboarding.rounds = answeredCount();
    state.round = null;
    recomputeDerived(); saveTaste();
    nextRound();
    renderForYou();
  }
  function finishOnboarding(skipped) {
    state.onboarding = false; state.round = null;
    taste.onboarding.done = true;
    taste.onboarding.skipped = !!skipped;
    taste.onboarding.targetRounds = 0;
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

  /* Rails. Two dedupe rules run across the whole For You block: an event appears
     at most once, and so does an ARTIST. Three nights of the same band is a
     calendar, not discovery. Each rail shows RAIL.size cards with a link to open
     the rest, so the section stays short without throwing away good matches. */
  /** Which act this visit's rail is built around. Every act they picked in the
      survey or starred a show for is a candidate; the rail rotates through them
      one per page load, so the section is not the same two gigs every time. */
  function becauseSeeds() {
    // Two sources, both newest first: acts they starred a show for, and acts they
    // picked in the survey. They are interleaved rather than ranked, because a star
    // from this morning should not queue behind eight survey answers, and eight
    // stars should not bury the survey either.
    const stars = [];
    const headliner = new Map();
    if (state.data) {
      for (const e of state.data.events) {
        const arts = collapseSameSpotify(e.artists).filter((a) => a.tracks?.length);
        if (arts.length) headliner.set(showKey(e), artistKey(arts[0]));
      }
    }
    for (const k of [...saved].reverse()) {
      const a = headliner.get(k);
      if (a && !stars.includes(a)) stars.push(a);
    }
    const picks = [];
    for (let i = taste.explicit.comparisons.length - 1; i >= 0; i--) {
      const c = taste.explicit.comparisons[i];
      if (c.chose && !picks.includes(c.chose)) picks.push(c.chose);
    }
    const out = [], seen = new Set();
    for (let i = 0; i < Math.max(stars.length, picks.length) && out.length < RAIL.seedPool; i++) {
      for (const k of [stars[i], picks[i]]) {
        if (!k || seen.has(k) || out.length >= RAIL.seedPool) continue;
        const p = state.poolByKey.get(k);
        if (!p) continue;
        seen.add(k); out.push(p);
      }
    }
    return out;
  }
  function railBecause(cands, ctx) {
    const seeds = becauseSeeds();
    if (!seeds.length) return [];
    // Rotate on every load, and skip a seed that cannot fill a rail this time.
    const spin = store.get(ROT_KEY, 0);
    for (let n = 0; n < seeds.length; n++) {
      const seed = seeds[(spin + n) % seeds.length];
      const pool = cands.filter((c) => free(c, ctx)).map((c) => ({ ...c, rel: vecSim(seed.v, c.lead.v) }));
      const own = pool.filter((c) => c.lead.key === seed.key).sort((a, b) => a.e.start.localeCompare(b.e.start))[0];
      const others = pool.filter((c) => c.lead.key !== seed.key && c.rel > 0.55)
        .sort((a, b) => (b.rel * 0.6 + b.score * 0.4) - (a.rel * 0.6 + a.score * 0.4));
      const items = dedupeByArtist([...(own ? [own] : []), ...others], ctx, RAIL.expanded);
      if (items.length < RAIL.size) continue;
      for (const it of items) {
        claim(it, ctx);
        // The rail heading already says "Because you liked X". Repeating it on every
        // card just reads as noise, so a card says what the link actually is.
        if (it.lead.key === seed.key) { it.reason = "The act you picked — playing here"; continue; }
        const shared = (it.lead.genres || []).filter((g) => (seed.genres || []).includes(g));
        it.reason = shared.length ? `Also ${shared.slice(0, 2).join(" and ")}`
          : it.rel > 0.8 ? "Very close to that" : "In the same corner";
      }
      return [{ id: "because", title: `Because you liked ${seed.name}`, items, seedKey: seed.key }];
    }
    return [];
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
        .sort((a, b) => b.score - a.score), ctx, RAIL.expanded);
    if (!items.length) return null;
    // The act of theirs this one most resembles, never the act itself.
    const nearest = (p) => {
      let bk = null, bs = 0;
      for (const [k, sc] of Object.entries(taste.derived.artistAffinity)) {
        if (sc <= 0.5 || k === p.key) continue;
        const q = state.poolByKey.get(k); if (!q) continue;
        const sim = vecSim(p.v, q.v);
        if (sim > bs) { bs = sim; bk = q; }
      }
      return bk;
    };
    // Only the first card makes the full argument; repeating "You liked X" on every
    // card in the rail just drones.
    items.forEach((it, i) => {
      claim(it, ctx);
      const seed = nearest(it.lead);
      if (i === 0) {
        it.reason = seed ? `You liked ${seed.name}. Catch ${it.lead.name} first.`
          : `${TIER_NAMES[it.lead.tier]} act that fits your picks`;
        return;
      }
      const shared = seed ? (it.lead.genres || []).filter((g) => (seed.genres || []).includes(g)) : [];
      it.reason = shared.length ? `Also ${shared.slice(0, 2).join(" and ")}, and barely known yet`
        : `${TIER_NAMES[it.lead.tier]} act that fits your picks`;
    });
    return { id: "emerging", title: "Before they blow up", items, blurb: "Smaller acts that match your picks, playing here soon." };
  }

  /* Words for each end of each axis. Two sets, because the sentence needs
     "You lean <from>. This one is <to>." to read like English in both directions.
     An axis with no usable phrase on the side we need is simply not used. */
  const AXIS_POLES = {
    guitar: { from: ["electronic music", "guitars"], to: ["electronic", "guitar music"] },
    energy: { from: ["the gentler stuff", "loud and fast"], to: ["gentler", "louder"] },
    pop:    { from: ["leftfield", "big hooks"], to: ["more leftfield", "poppier"] },
    urban:  { from: ["", "hip hop and r&b"], to: ["", "hip hop"] },
    roots:  { from: ["", "roots and acoustic"], to: ["", "roots music"] },
    dance:  { from: ["music to listen to", "music to dance to"], to: ["for listening", "made for dancing"] },
    reach:  { from: ["smaller rooms", "the big names"], to: ["a much smaller act", "a much bigger name"] },
  };
  /** Something a little different: agrees with the profile on most axes but sits
      a real distance away on exactly one confident axis. Not the leftovers rail —
      if nothing is genuinely a stretch, this shows nothing at all. */
  function railStretch(cands, ctx) {
    const axes = AXES.map((k, i) => ({ k, i, b: beliefOf(k), c: confOf(k) }))
      .filter((x) => x.c >= 0.45 && Math.abs(x.b) >= 0.35);
    if (!axes.length) return null;
    const scored = [];
    for (const c of cands) {
      if (!free(c, ctx)) continue;
      let best = null;
      for (const ax of axes) {
        const poles = AXIS_POLES[ax.k];
        if (!poles.from[ax.b > 0 ? 1 : 0] || !poles.to[c.lead.v[ax.i] > 0 ? 1 : 0]) continue;
        const away = Math.abs(c.lead.v[ax.i] - ax.b);
        if (away < 0.9) continue;                        // not actually a stretch
        if (Math.sign(c.lead.v[ax.i]) === Math.sign(ax.b)) continue;
        // Agreement on everything except the axis we are stretching.
        let num = 0, den = 0;
        for (let j = 0; j < AXES.length; j++) {
          if (j === ax.i) continue;
          const cf = confOf(AXES[j]), bl = beliefOf(AXES[j]);
          num += cf * bl * c.lead.v[j];
          den += cf * Math.abs(bl);
        }
        const rest = den > 0.001 ? num / den : 0;
        if (rest < 0.15) continue;                       // otherwise it is just unrelated
        const s = rest * 0.6 + Math.min(1, away / 2) * 0.4;
        if (!best || s > best.s) best = { s, ax, away, rest };
      }
      if (best) scored.push({ ...c, stretch: best });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.stretch.s - a.stretch.s);
    const items = dedupeByArtist(scored, ctx, RAIL.expanded);
    if (!items.length) return null;
    items.forEach((it, i) => {
      claim(it, ctx);
      const ax = it.stretch.ax, poles = AXIS_POLES[ax.k];
      const toward = poles.to[it.lead.v[ax.i] > 0 ? 1 : 0];
      const from = poles.from[ax.b > 0 ? 1 : 0];
      if (!toward) { it.reason = "Further from your usual"; return; }
      // The first card explains the contrast; the rest just state it.
      it.reason = i === 0 && from ? `You lean ${from}. ${it.lead.name} is ${toward}.`
        : `${it.lead.name} is ${toward}`;
    });
    return { id: "stretch", title: "Something a little different", items,
      blurb: "Close to your taste in every way but one." };
  }
  // Shared dedupe bookkeeping for the rails above.
  // Only the lead act is rendered on a rail card, so that is what must not repeat.
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
  /* ---- the faceplate: four click-to-step dials ----------------------------
     A dial points at the value you click, like a real one: the click angle picks
     the position. Clicking the centre cap steps on by one, and the arrow keys work,
     so nothing here depends on a gesture anyone has to discover. */
  /* Audience size on the faceplate is a ceiling, not a range: "nothing bigger than
     this". That is genuinely one value, so a single-pointer dial is honest rather
     than a lossy stand-in for two, and it behaves like a volume knob - turned down
     for the underground, up for everything. Anyone who wants a floor as well uses
     the two-ended slider in Advanced search, and the dial then reads "custom". */
  const CEILING_PRESETS = [
    { label: "Underground only", sub: "under 5k listeners", max: 1 },
    { label: "Up to emerging", sub: "under 50k listeners", max: 2 },
    { label: "Up to established", sub: "under 500k listeners", max: 3 },
    { label: "Any size", sub: "no limit", max: 4 },
  ];
  const SOURCE_PRESETS = [
    { label: "Everything", value: ["songkick", "do604"] },
    { label: "Touring", sub: "ticketed", value: ["songkick"] },
    { label: "Local", sub: "DIY rooms", value: ["do604"] },
  ];
  const WINDOW_PRESETS = [
    { label: "7 days", value: 7 }, { label: "14 days", value: 14 },
    { label: "30 days", value: 30 }, { label: "All listed", value: 45 },
  ];
  const sameArr = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  /** A phrase for the current audience range. The raw tier names read badly on their
      own ("unknown–emerging"), so a named preset wins and anything else is spelled out. */
  function reachLabel() {
    const [lo, hi] = state.reach;
    if (lo === 0) {
      const hit = CEILING_PRESETS.find((p) => p.max === hi);
      if (hit) return hit.label.toLowerCase();
    }
    if (lo === hi) return `${TIER_NAMES[lo]} acts only`;
    return `${TIER_NAMES[lo]} to ${TIER_NAMES[hi]} acts`;
  }

  const KNOBS = [
    {
      id: "city", label: "City",
      options: () => state.index.cities.map((c) => ({ label: c.name.split(",")[0], sub: (c.name.split(",")[1] || "").trim() })),
      index: () => Math.max(0, state.index.cities.findIndex((c) => c.slug === state.city)),
      set: async (i) => {
        const c = state.index.cities[i]; if (!c || c.slug === state.city) return;
        state.city = c.slug; state.venues = null; state.genres = [];
        await loadCity(); buildPool(); renderAll();
      },
    },
    {
      id: "source", label: "Sources",
      options: () => SOURCE_PRESETS,
      index: () => Math.max(0, SOURCE_PRESETS.findIndex((p) => sameArr(p.value, state.sources))),
      set: (i) => { state.sources = [...SOURCE_PRESETS[i].value]; renderSources(); renderVenues(); renderGenres(); renderReach(); renderKnobs(); renderForYou(); renderResults(); writeHash(); },
    },
    {
      id: "size", label: "Audience",
      options: () => CEILING_PRESETS,
      // A floor set on the slider is not a ceiling, so the dial declines to guess.
      index: () => state.reach[0] !== 0 ? -1 : CEILING_PRESETS.findIndex((p) => p.max === state.reach[1]),
      set: (i) => { state.reach = [0, CEILING_PRESETS[i].max]; renderReach(); renderKnobs(); renderFilterSummary(); renderForYou(); renderResults(); writeHash(); },
    },
    {
      id: "window", label: "Window",
      options: () => WINDOW_PRESETS,
      index: () => Math.max(0, WINDOW_PRESETS.findIndex((p) => p.value === state.days)),
      set: (i) => { state.days = WINDOW_PRESETS[i].value; renderKnobs(); renderForYou(); renderResults(); writeHash(); },
    },
  ];
  const SWEEP = 270;                                    // degrees from first tick to last
  const angleFor = (i, n) => n <= 1 ? 0 : -SWEEP / 2 + (SWEEP * i) / (n - 1);

  function knobSvg(i, n) {
    const ticks = Array.from({ length: n }, (_, k) => {
      const a = (angleFor(k, n) - 90) * Math.PI / 180;
      const x1 = 50 + 39 * Math.cos(a), y1 = 50 + 39 * Math.sin(a);
      const x2 = 50 + 48 * Math.cos(a), y2 = 50 + 48 * Math.sin(a);
      return `<line class="tick${k === i ? " on" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }).join("");
    const rot = i < 0 ? 0 : angleFor(i, n);
    return `<svg viewBox="0 0 100 100" aria-hidden="true">${ticks}
      <circle class="face" cx="50" cy="50" r="32"/>
      <circle class="skirt" cx="50" cy="50" r="26"/>
      <line class="pointer" x1="50" y1="42" x2="50" y2="21" transform="rotate(${rot.toFixed(1)} 50 50)"${i < 0 ? ' opacity="0.25"' : ""}/>
      <circle class="cap" cx="50" cy="50" r="7"/></svg>`;
  }
  const NARROW = () => window.matchMedia("(max-width:560px)").matches;
  /** The panel is only collapsible on a phone. On a wide screen it is forced open,
      whatever a previous phone session stored, or the dials would vanish entirely. */
  function applyFaceState() {
    const el = $("#facePanel");
    state.applyingUi = true;
    el.open = NARROW() ? (store.get(UI_KEY, {}).facePanel ?? false) : true;
    state.applyingUi = false;
  }
  function renderKnobs() {
    if (!state.index || !state.data) return;
    const host = $("#knobs");
    host.innerHTML = KNOBS.map((k) => {
      const opts = k.options(), i = k.index();
      const cur = i >= 0 ? opts[i] : { label: "Custom", sub: reachLabel() };
      // Every position is written out and the chosen one is highlighted, so the dial
      // reads like a faceplate rather than a mystery. The words are buttons too.
      const words = opts.map((o, n) => `<button class="knobOpt${n === i ? " on" : ""}" data-knob-opt="${k.id}:${n}"
        title="${esc(o.label)}${o.sub ? " — " + esc(o.sub) : ""}">${esc(o.label)}</button>`).join("");
      return `<div class="knob">
        <div class="knobLabel">${esc(k.label)}</div>
        <div class="knobDial" data-knob="${k.id}" role="slider" tabindex="0"
             aria-label="${esc(k.label)}" aria-valuemin="0" aria-valuemax="${opts.length - 1}"
             aria-valuenow="${Math.max(0, i)}" aria-valuetext="${esc(cur.label)}">${knobSvg(i, opts.length)}</div>
        <div class="knobOpts">${i < 0 ? `<button class="knobOpt on" disabled>${esc(cur.label)}</button>` : ""}${words}</div>
      </div>`;
    }).join("");
    // Many cities will not fit on a dial; fall back to the select in the filters module.
    const many = state.index.cities.length > 6;
    $("#citySelectWrap").hidden = !many;
    if (many) { const sel = $("#city"); sel.innerHTML = state.index.cities.map((c) => `<option value="${c.slug}">${esc(c.name)}</option>`).join(""); sel.value = state.city; }
    const gen = new Date(state.data.generated_at);
    $("#faceCount").textContent = `updated ${gen.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    // The collapsed phone readout: every dial's current position on one line.
    $("#faceNow").textContent = KNOBS.map((k) => {
      const i = k.index();
      return i >= 0 ? k.options()[i].label : reachLabel();
    }).join(" · ");
    applyFaceState();
  }
  function knobStep(k, i) { const n = k.options().length; return Math.max(0, Math.min(n - 1, i)); }
  function onKnobPoint(el, ev) {
    const k = KNOBS.find((x) => x.id === el.dataset.knob); if (!k) return;
    const n = k.options().length, box = el.getBoundingClientRect();
    const dx = ev.clientX - (box.left + box.width / 2), dy = ev.clientY - (box.top + box.height / 2);
    const r = Math.hypot(dx, dy) / (box.width / 2);
    let i;
    if (r < 0.34) { i = knobStep(k, (Math.max(0, k.index()) + 1) % n); }   // centre cap: step on
    else {
      let deg = Math.atan2(dx, -dy) * 180 / Math.PI;                       // 0 = pointing up
      deg = Math.max(-SWEEP / 2, Math.min(SWEEP / 2, deg));
      i = knobStep(k, Math.round(((deg + SWEEP / 2) / SWEEP) * (n - 1)));
    }
    k.set(i);
  }
  $("#knobs").addEventListener("click", (ev) => {
    const opt = ev.target.closest("[data-knob-opt]");
    if (opt) {
      const [id, n] = opt.dataset.knobOpt.split(":");
      const k = KNOBS.find((x) => x.id === id);
      if (k) k.set(knobStep(k, +n));
      return;
    }
    const el = ev.target.closest("[data-knob]"); if (!el) return;
    onKnobPoint(el, ev);
  });
  $("#knobs").addEventListener("keydown", (ev) => {
    const el = ev.target.closest("[data-knob]"); if (!el) return;
    const k = KNOBS.find((x) => x.id === el.dataset.knob); if (!k) return;
    const n = k.options().length, cur = Math.max(0, k.index());
    let i = null;
    if (ev.key === "ArrowRight" || ev.key === "ArrowUp") i = knobStep(k, cur + 1);
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") i = knobStep(k, cur - 1);
    else if (ev.key === "Home") i = 0;
    else if (ev.key === "End") i = n - 1;
    else if (ev.key === " " || ev.key === "Enter") i = knobStep(k, (cur + 1) % n);
    if (i === null) return;
    ev.preventDefault();
    k.set(i);
  });
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
        $("#obRestart").onclick = () => startOnboarding("tune");
        return;
      }
      el.hidden = true; el.innerHTML = ""; return;
    }
    const r = state.round;
    const tuning = (taste.onboarding.targetRounds || 0) > 0;
    const dots = Array.from({ length: tuning ? OB.tuneRounds : OB.maxRounds }, (_, i) => {
      const base = tuning ? taste.onboarding.targetRounds - OB.tuneRounds : 0;
      const at = r.n - base;
      return `<span class="obDot${i < at ? " done" : i === at ? " now" : ""}"></span>`;
    }).join("");
    el.hidden = false;
    el.innerHTML = `
      <div class="obHead"><div class="obKicker">${tuning ? "A few more to sharpen this" : r.n === 0 ? "Let's figure out what you might want to see live" : r.n >= 4 ? "Getting harder" : "Which would you rather see live?"}</div></div>
      <div class="vsRow">
        ${artistCard(r.a, "a")}
        <div class="vsOr">vs</div>
        ${artistCard(r.b, "b")}
      </div>
      <div class="obFoot">
        <span class="obProg">${dots}</span>
        <button class="btn ghost obPass" id="obPass">Neither</button>
        <button class="btn ghost obSkip" id="obSkip">${tuning ? "Done" : "Skip survey"}</button>
      </div>`;
    $("#obSkip").onclick = () => finishOnboarding(!tuning);
    $("#obPass").onclick = passRound;
  }

  /* ---- For You ---- */
  /** The one show card on the site. All Gigs and every For You rail render this,
      so the two can never drift apart; the rails just pass a reason line and a
      date, which All Gigs gets from its own day heading instead. */
  function showCard(e, artists, opts = {}) {
    const k = showKey(e), isSaved = saved.has(k);
    const srcLabel = e.source === "do604" ? "Details on Do604" : "Tickets & info";
    return `<article class="show${isSaved ? " saved" : ""}" data-key="${esc(k)}">
      ${opts.why ? `<div class="why">${esc(opts.why)}</div>` : ""}
      <div class="showhead">
        <div class="venue">${opts.withDate ? `<span class="vdate">${fmtDate(e.date)}</span> · ` : ""}<span class="vname">${esc(e.venue || "Venue TBA")}</span>${e.source === "do604" ? ` <span class="pill">local</span>` : ""}${e.locality && !e.venue?.includes(e.locality) ? ` · ${esc(e.locality)}` : ""}${timeOf(e.start) ? `<span class="time">${timeOf(e.start).replace(" · ", "")}</span>` : ""}</div>
        <div class="showactions">
          <a class="lnk" href="${esc(e.url)}" target="_blank" rel="noopener" data-ticket="${esc(artistKey(artists[0] || {}))}">${srcLabel} ↗</a>${(e.also_listed || []).filter((x) => x.url).map((x) => `<a class="lnk" href="${esc(x.url)}" target="_blank" rel="noopener">${x.source === "do604" ? "Do604" : "Songkick"} ↗</a>`).join("")}
          <button class="star${isSaved ? " on" : ""}" data-save="${esc(k)}" title="${isSaved ? "Remove from my shows" : "Save to my shows"}" aria-pressed="${isSaved}">${isSaved ? "★" : "☆"}</button>
        </div>
      </div>
      ${artists.map((a) => artistRow(a, k)).join("")}
      ${opts.more ? `<div class="alsoOn">+${opts.more} more on the bill</div>` : ""}
    </article>`;
  }
  function artistRow(a, k) {
    return `<div class="artist" data-artist-id="${esc(artistKey(a))}">
      ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy">` : ""}
      <div class="ainfo">
        <div class="who"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>${a.spotify_name && norm(a.spotify_name) !== norm(a.name) ? `<small>as “${esc(a.spotify_name)}” on Spotify</small>` : ""}${a.also_billed?.length ? `<small>also billed as ${a.also_billed.map((n) => `“${esc(n)}”`).join(", ")}</small>` : ""}${a.reach?.listeners ? `<span class="reach" title="Last.fm listeners">${fmtListeners(a.reach.listeners)} listeners</span>` : `<span class="reach">not on Last.fm</span>`}${artistGenres(a).slice(0, 3).map((g) => `<small class="pill">${esc(g)}</small>`).join(" ")}</div>
        <div class="tracks">${(a.tracks || []).map((t) => `<button class="play${playing && playing.trackId === t.id ? " on" : ""}" data-play="${t.id}" data-key="${esc(k)}" data-artist="${esc(a.name)}" data-track="${esc(t.name)}" data-pool="${esc(artistKey(a))}" title="Play in page">${playing && playing.trackId === t.id ? "◼" : "▶"}</button><a href="https://open.spotify.com/track/${t.id}" target="_blank" rel="noopener">${esc(t.name)}</a>`).join(`<span class="sep">·</span>`)}</div>
      </div>
    </div>`;
  }
  /* A rail card is the same card as All Gigs, but only the act the rail is actually
     about. Three rails of full bills ran to six screens; the rest of the lineup is a
     tap away in the list below, so the card names it and moves on. */
  const gigCard = (item) => {
    const lead = item.artists.find((a) => artistKey(a) === item.lead.key) || item.artists[0];
    return showCard(item.e, [lead],
      { why: item.reason, withDate: true, more: Math.max(0, item.artists.length - 1) });
  };

  /** Open state for the two modules. For you is open until the visitor closes it;
      Advanced search is closed until they open it. Both choices stick. */
  function applyUiState() {
    const ui = store.get(UI_KEY, {});
    state.applyingUi = true;
    $("#personalModule").open = ui.personalModule !== undefined ? ui.personalModule : true;
    $("#advancedModule").open = ui.advancedModule !== undefined ? ui.advancedModule : false;
    state.applyingUi = false;
  }
  function syncPersonalHeader(done) {
    const running = state.onboarding && state.round;
    if (running) {
      $("#fyTitle").textContent = "For you";
      const n = answeredCount() + 1;
      $("#fySub").textContent = `${(taste.onboarding.targetRounds ? "tuning" : "question")} ${n}${taste.onboarding.targetRounds ? "" : ` of about ${OB.minRounds}`} · collapse to skip straight to the listings`;
      return;
    }
    if (done === undefined) done = taste.onboarding.done;
    $("#fyTitle").textContent = hasTaste() && done ? "We've got your vibe" : "For you";
    // The taste line lives in the body; repeating it in the header just doubles it up.
    const t = state.fyCount || 0;
    $("#fySub").textContent = t ? `${t} show${t === 1 ? "" : "s"} picked for you` : "";
  }

  function renderForYou() {
    const mod = $("#personalModule"), el = $("#forYou");
    // The module still has to show while the survey is running, even with no taste yet.
    const hide = () => { el.innerHTML = ""; mod.hidden = !state.onboarding; $("#allGigsHead").hidden = true; syncPersonalHeader(); };
    if (!state.data || !hasTaste()) return hide();
    const cands = recommendCandidates();
    const ctx = { events: new Set(), artists: new Set() };
    const rails = [...railBecause(cands, ctx)];
    const em = railEmerging(cands, ctx); if (em) rails.push(em);
    const st = railStretch(cands, ctx); if (st) rails.push(st);
    if (!rails.length) return hide();

    mod.hidden = false;
    applyUiState();
    const done = taste.onboarding.done && !state.onboarding;
    const total = rails.reduce((n, r) => n + Math.min(r.items.length, RAIL.size), 0);
    state.fyCount = total;
    syncPersonalHeader(done);
    el.innerHTML = `
      <p class="fyLine">${esc(tasteLine())} <button class="railMore" id="fyTune" style="margin-left:6px">${done ? "tune this" : "keep going"}</button></p>
      ${rails.map((r) => {
        const open = state.railOpen.has(r.id + "|" + r.title);
        const shown = open ? r.items : r.items.slice(0, RAIL.size);
        const hidden = r.items.length - shown.length;
        return `<div class="rail" data-rail="${r.id}">
          <div class="railHead">
            <h3>${esc(r.title)}</h3>${r.blurb ? `<span class="railBlurb">${esc(r.blurb)}</span>` : ""}
            ${hidden > 0 || open ? `<button class="railMore" data-more="${esc(r.id + "|" + r.title)}">${open ? "show less" : `${hidden} more`}</button>` : ""}
          </div>
          <div class="railItems">${shown.map(gigCard).join("")}</div>
        </div>`;
      }).join("")}`;
    $("#fyTune").onclick = (ev) => {
      ev.preventDefault();
      startOnboarding("tune");
      $("#onboard").scrollIntoView({ behavior: "smooth", block: "start" });
    };
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
        html += showCard(e, e.artists);
      }
      $("#results").innerHTML = html;
    }
    $("#savedBtn").textContent = `★ My shows${saved.size ? ` (${saved.size})` : ""}`;
    $("#savedBtn").setAttribute("aria-pressed", state.savedOnly);
    if (!r.shows.length && state.savedOnly) $("#results").innerHTML = `<div class="empty">No saved shows in this window. Tap ☆ on a show to save it.</div>`;
    const um = state.data.unmatched?.length || 0;
    $("#unmatched").textContent = um ? ` ${um} billed act${um === 1 ? "" : "s"} had no Spotify match and ${um === 1 ? "was" : "were"} left out.` : "";
    const gen = new Date(state.data.generated_at);
    const pend = state.data.pending?.length || 0;
    $("#dataAge").textContent = `${state.data.events.length} shows over ${state.data.horizon_days} days` + (pend ? ` · ${pend} acts still being matched` : "");
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
    state.reach = [lo, hi]; renderReach(); renderKnobs(); renderFilterSummary(); renderForYou(); renderResults(); writeHash();
  }
  $("#reachMin").addEventListener("input", onReachInput); $("#reachMax").addEventListener("input", onReachInput);
  window.addEventListener("resize", () => state.data && renderReach());
  function renderSources() { for (const b of document.querySelectorAll("[data-src]")) b.checked = state.sources.includes(b.dataset.src); }
  function renderAll() {
    renderSources(); renderKnobs(); renderVenues(); renderGenres(); renderReach();
    renderFilterSummary(); renderOnboard(); renderForYou(); renderResults(); writeHash();
  }
  /** One line on the collapsed filters module, so nothing is silently narrowing the list. */
  function renderFilterSummary() {
    const bits = [];
    if (state.venues) bits.push(`${state.venues.length} venue${state.venues.length === 1 ? "" : "s"}`);
    if (state.genres.length) bits.push(state.genres.slice(0, 3).join(", ") + (state.genres.length > 3 ? "…" : ""));
    if (state.headliners) bits.push("headliners only");
    if (state.reach[0] !== 0 || state.reach[1] !== 4) bits.push(reachLabel());
    $("#filterSummary").textContent = bits.length ? bits.join(" · ") : "all venues, all genres";
  }
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
    // Starring is taste. Fold it in now; the rails pick it up on the next load rather
    // than rearranging themselves under the hand that just tapped one.
    recomputeDerived(); saveTaste();
  }
  function delegate(root) {
    root.addEventListener("click", (e) => {
      const pb = e.target.closest("[data-play]"); if (pb) return handlePlayClick(pb);
      const sb = e.target.closest("[data-save]");
      if (sb) { handleSaveClick(sb); if (state.savedOnly) renderResults(); return; }
      const ch = e.target.closest("[data-choose]"); if (ch) return answerRound(ch.dataset.choose);
      const mb = e.target.closest("[data-more]");
      if (mb) {
        const k = mb.dataset.more;
        if (state.railOpen.has(k)) state.railOpen.delete(k); else state.railOpen.add(k);
        renderForYou(); return;
      }
      const tk = e.target.closest("[data-ticket]");
      if (tk) { const k = tk.dataset.ticket; if (k) { taste.behaviour.ticketClicks[k] = (taste.behaviour.ticketClicks[k] || 0) + 1; recomputeDerived(); saveTaste(); } }
    });
  }
  delegate($("#results")); delegate($("#onboard")); delegate($("#forYou"));
  $("#savedBtn").onclick = () => { state.savedOnly = !state.savedOnly; renderResults(); };
  $("#tuneBtn").onclick = () => { startOnboarding("tune"); $("#onboard").scrollIntoView({ behavior: "smooth", block: "start" }); };
  // Remember a manual collapse of For You so a re-render does not reopen it.
  // Collapsing the whole personalised block is remembered, so someone who only wants
  // the listings gets them straight away on every visit.
  window.matchMedia("(max-width:560px)").addEventListener("change", applyFaceState);
  for (const id of ["personalModule", "advancedModule", "facePanel"]) {
    $("#" + id).addEventListener("toggle", (e) => {
      if (state.applyingUi) return;
      if (id === "facePanel" && !NARROW()) return;      // desktop has no collapsed state to remember
      const ui = store.get(UI_KEY, {});
      ui[id] = e.target.open;
      store.set(UI_KEY, ui);
    });
  }

  // ---------- events ----------
  $("#city").addEventListener("change", async (e) => { state.city = e.target.value; state.venues = null; state.genres = []; await loadCity(); buildPool(); renderAll(); });
  $("#venues").addEventListener("change", () => {
    const boxes = [...$("#venues").querySelectorAll("input")];
    const on = boxes.filter((b) => b.checked).map((b) => b.dataset.v);
    state.venues = on.length === boxes.length ? null : on;
    renderFilterSummary(); renderResults(); writeHash();
  });
  $("#vAll").onclick = () => { state.venues = null; renderVenues(); renderFilterSummary(); renderResults(); writeHash(); };
  $("#vNone").onclick = () => { state.venues = []; renderVenues(); renderFilterSummary(); renderResults(); writeHash(); };
  $("#vSmall").onclick = () => { state.venues = [...new Set(state.data.events.map((e) => e.venue))].filter((v) => v && !ARENA_RE.test(v)); renderVenues(); renderFilterSummary(); renderResults(); writeHash(); };
  $("#genres").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const g = b.dataset.g; const i = state.genres.indexOf(g);
    if (i >= 0) state.genres.splice(i, 1); else state.genres.push(g);
    renderGenres(); renderFilterSummary(); renderResults(); writeHash();
  });
  $("#gClear").onclick = () => { state.genres = []; renderGenres(); renderFilterSummary(); renderResults(); writeHash(); };
  // Ticking every genre is the same result as ticking none, but it is the starting
  // point for "everything except these two", which is what people actually want.
  $("#gAll").onclick = () => {
    state.genres = [...$("#genres").querySelectorAll(".chip")].map((b) => b.dataset.g);
    renderGenres(); renderFilterSummary(); renderResults(); writeHash();
  };
  $("#headliners").addEventListener("change", (e) => { state.headliners = e.target.checked; renderFilterSummary(); renderResults(); writeHash(); });
  $("#share").onclick = async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); status("Link copied. Anyone opening it sees this exact selection."); }
    catch { status(`Share this link: ${location.href}`); }
  };
  // Playlist handoff without any sign-in: the track list goes to the clipboard,
  // ready to paste into a Spotify (or anything else) search / import box.
  /* Spotify has no "paste a tracklist" import, so the old Artist - Track text did
     nothing on the Spotify side. What its desktop app and web player DO accept is a
     paste of track URLs straight into a playlist (mechanism 1 in the export plan),
     and we already hold a Spotify track id for every song. The plain list stays as a
     second option, because that is the format Soundiiz and TuneMyMusic take. */
  function exportTracks() {
    const r = select();
    const urls = [], text = [], seenId = new Set(), seenLine = new Set();
    for (const sh of r.shows) for (const a of sh.artists) for (const t of a.tracks) {
      if (t.id && !seenId.has(t.id)) { seenId.add(t.id); urls.push(`https://open.spotify.com/track/${t.id}`); }
      const line = `${a.name} - ${t.name}`;
      if (!seenLine.has(line)) { seenLine.add(line); text.push(line); }
    }
    return { urls, text };
  }
  async function copyOut(what) {
    const { urls, text } = exportTracks();
    const payload = what === "text" ? text : urls;
    if (!payload.length) return;
    try { await navigator.clipboard.writeText(payload.join("\n")); }
    catch { return status("Copy failed — your browser blocked clipboard access.", true); }
    if (what === "text") {
      status(`${payload.length} tracks copied as a plain list. Paste it into Soundiiz or TuneMyMusic to build the playlist on any service.`);
      return;
    }
    status(NARROW()
      ? `${payload.length} Spotify links copied. The Spotify phone app can't paste a list — open this on a computer, or use <button class="linkish" data-copy="text">the plain list</button> with a transfer service.`
      : `${payload.length} Spotify links copied. In Spotify (desktop app or web player) open a playlist, click the empty space below the tracks, and paste. <button class="linkish" data-copy="text">Need a plain list instead?</button>`);
  }
  $("#copyList").onclick = () => copyOut("spotify");
  $("#status").addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]"); if (b) copyOut(b.dataset.copy);
  });

  // ---------- data ----------
  async function loadIndex() {
    const r = await fetch("data/index.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("No data yet. Run the refresh workflow once.");
    state.index = await r.json();
    if (!state.city || !state.index.cities.some((c) => c.slug === state.city)) state.city = CFG.defaultCity || state.index.cities[0]?.slug;
  }
  /** The taste-game pool. Optional: an older deploy, or a repo whose pipeline has
      not run seed_artists.py yet, has no such file and simply falls back to the
      acts playing in the city, which is how v0.9 behaved. */
  async function loadSeeds() {
    try {
      const r = await fetch("seed-artists.json", { cache: "no-cache" });
      if (!r.ok) return;
      const j = await r.json();
      state.seeds = Array.isArray(j.artists) ? j.artists : [];
    } catch { state.seeds = []; }
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
      taste.onboarding = Object.assign({ done: false, rounds: 0, startedAt: null, completedAt: null, skipped: false, targetRounds: 0 }, taste.onboarding);
      recomputeDerived();                       // derived state is always rebuilt, never trusted from storage

      if (!location.hash) { try { const s = localStorage.getItem("gigamp:sel"); if (s) history.replaceState(null, "", s); } catch {} }
      const firstVisit = !location.hash;
      readHash();
      await Promise.all([loadIndex(), loadVocab(), loadSeeds()]); await loadCity();
      if (firstVisit && state.venues === null) {
        const small = [...new Set(state.data.events.map((e) => e.venue))].filter((v) => v && !ARENA_RE.test(v));
        if (small.length < new Set(state.data.events.map((e) => e.venue)).size) state.venues = small;
      }
      buildPool();
      recomputeDerived();                      // starred shows only resolve once the city data is in
      store.set(ROT_KEY, (store.get(ROT_KEY, 0) + 1) % 997);   // next visit leads with a different act
      $("#tuneBtn").hidden = !(taste.onboarding.done || hasTaste());
      if (!taste.onboarding.done && CFG.onboardingEnabled !== false && state.pool.length >= 8) startOnboarding();
      renderAll();
    } catch (e) { status(esc(e.message), true); console.error("GigAmp failed to start:", e); }
  })();
  window.addEventListener("error", (ev) => { const el = $("#status"); if (el && !el.textContent) { el.textContent = "Something broke on this page: " + (ev.message || "unknown error") + ". Try a hard refresh (Cmd+Shift+R)."; el.className = "status err"; } });

  // Exposed for the node test harness in tests/. No behaviour depends on it.
  window.__gigamp = { AXES, GENRE_AXES, LABEL_TO_ID, TIER_REACH, state, get taste() { return taste; }, nextPair, recomputeDerived, tasteSim, artistScore };
})();
