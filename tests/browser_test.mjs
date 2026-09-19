/* End-to-end check of the real docs/ page in headless Chromium against the
   synthetic city fixture. Verifies: no Spotify sign-in anywhere, the comparison
   game runs broad-to-narrow without repeating an artist, Play works from the
   comparison cards, For You appears with explained rails, and All Gigs still
   shows the complete event list afterwards. Run: node tests/browser_test.mjs */
import { chromium, devices } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const SHOTS = path.join(ROOT, "tests", "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const p = path.join(DOCS, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(DOCS) || !fs.existsSync(p)) { res.writeHead(404); return res.end("nope"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});

let failures = 0, checks = 0;
const ok = (cond, label, extra = "") => {
  checks++;
  if (cond) console.log(`  PASS  ${label}${extra ? " — " + extra : ""}`);
  else { failures++; console.log(`  FAIL  ${label}${extra ? " — " + extra : ""}`); }
};

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"] });
// The page loads the Spotify embed API from the network; block it so the test is
// offline-deterministic. app.js already has an onerror fallback for exactly this.
await ctx.route("**open.spotify.com/**", (r) => r.abort());
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/open\.spotify|net::ERR/.test(m.text())) errors.push(m.text()); });

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("#results .show").length > 0, null, { timeout: 15000 });

console.log("\n1. Spotify sign-in is gone");
const html = await page.content();
const src = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
ok(!/Log in with Spotify|Connect Spotify/i.test(html), "no sign-in button in the DOM");
ok(!/accounts\.spotify\.com/.test(src), "no accounts.spotify.com in app.js");
ok(!/code_challenge|code_verifier|refresh_token/.test(src), "PKCE code is gone");
ok(!/gigamp:tok/.test(src), "token storage is gone");
ok(/open\.spotify\.com\/embed\/iframe-api/.test(src), "embed player kept (it never needed auth)");
ok(await page.locator("#copyList").isVisible(), "Copy for Spotify replaces Create playlist");

console.log("\n2. The comparison game");
await page.waitForSelector("#onboard .vsCard", { timeout: 10000 });
ok(await page.locator("#forYou").isHidden() && await page.locator("#allGigsHead").isHidden(),
  "before any answer there is no For You section and no All Gigs divider");
await page.screenshot({ path: path.join(SHOTS, "01-round1.png"), fullPage: false });

const seen = [];
const seps = [];
let round = 0;
while (await page.locator("#onboard .vsCard").count() === 2 && round < 12) {
  const names = await page.locator("#onboard .vsName").allTextContents();
  const sep = await page.evaluate(() => {
    const r = window.__gigamp.state.round;
    if (!r) return null;
    let s = 0; for (let i = 0; i < r.a.v.length; i++) { const d = r.a.v[i] - r.b.v[i]; s += d * d; }
    return Math.sqrt(s);
  });
  seps.push(sep);
  seen.push(names);
  console.log(`  round ${round + 1}: ${names[0]} vs ${names[1]}  (separation ${sep.toFixed(2)})`);

  if (round === 0) {
    // Play both sides from inside the game, using the shared dock player.
    await page.locator("#onboard .vsPlay").first().click();
    await page.waitForTimeout(150);
    ok(await page.locator("#dock").isVisible(), "Play in the game opens the shared dock player");
    ok(/◼ Playing/.test(await page.locator("#onboard .vsPlay").first().textContent()), "the game's Play button reflects playback state");
    await page.locator("#onboard .vsPlay").nth(1).click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, "02-playing.png") });
  }

  // Always choose the more "guitar/alternative" side, to simulate a coherent taste.
  const pick = await page.evaluate(() => {
    const r = window.__gigamp.state.round;
    return (r.a.v[0] + r.a.v[1] * 0.4) >= (r.b.v[0] + r.b.v[1] * 0.4) ? r.a.key : r.b.key;
  });
  await page.evaluate((k) => document.querySelector(`#onboard [data-choose="${k.replace(/"/g, '\\"')}"]`).click(), pick);
  await page.waitForTimeout(120);
  round++;
}
console.log(`  finished after ${round} rounds`);

const flat = seen.flat();
ok(new Set(flat).size === flat.length, "no artist is ever shown twice", `${flat.length} slots, ${new Set(flat).size} distinct`);
ok(round >= 5 && round <= 8, "round count inside 5-8, not hard-coded to 7", `${round} rounds`);
const firstThree = seps.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
const lastTwo = seps.slice(-2).reduce((a, b) => a + b, 0) / 2;
ok(firstThree > lastTwo, "comparisons narrow: early pairs are further apart than late ones",
  `early ${firstThree.toFixed(2)} vs late ${lastTwo.toFixed(2)}`);
const maxTimesSameArtist = Math.max(...Object.values(flat.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {})));
ok(maxTimesSameArtist === 1, "no single artist is used as a repeated yardstick");
const emergingLate = await page.evaluate(() => {
  const cs = window.__gigamp.taste.explicit.comparisons;
  return cs.slice(3).some((c) => [c.a, c.b].some((x) => x.tier > 0 && x.tier <= 2));
});
ok(emergingLate, "an emerging / local act appears in the later rounds");

console.log("\n3. For You");
await page.waitForSelector("#forYou .rail", { timeout: 10000 });
const railTitles = await page.locator("#forYou .railHead h3").allTextContents();
console.log("  rails:", railTitles.join(" | "));
ok(railTitles.some((t) => /because you liked/i.test(t)), "a 'Because you liked X' rail");
ok(railTitles.some((t) => /before they blow up/i.test(t)), "a 'Before they blow up' rail");
ok(/We've got your vibe/.test(await page.locator("#fyTitle").textContent()), "no 'profile complete' congratulation");
const railCounts = await page.evaluate(() =>
  [...document.querySelectorAll("#forYou .rail")].map((r) => r.querySelectorAll(".show").length));
// The rails must use the same card as All Gigs, stacked the same way.
const sameCard = await page.evaluate(() => {
  const rail = document.querySelector("#forYou .show"), all = document.querySelector("#results .show");
  if (!rail || !all) return { ok: false, why: "missing card" };
  const parts = (el) => [...el.querySelectorAll("*")].map((n) => n.className).filter((c) => typeof c === "string" && c);
  const railParts = new Set(parts(rail)), allParts = new Set(parts(all));
  const missing = [...allParts].filter((c) => !railParts.has(c) && c !== "sep");
  return { ok: missing.length === 0, why: missing.join(", "),
    stacked: getComputedStyle(document.querySelector("#forYou .railItems")).display };
});
ok(sameCard.ok, "a rail card is built from the same parts as an All Gigs card", sameCard.why || "identical");
ok(sameCard.stacked === "block", "rail cards stack one per row like the main list", sameCard.stacked);
// Full bills ran the section to six screens; a rail card is the act it is about.
const perCard = await page.evaluate(() =>
  [...document.querySelectorAll("#forYou .show")].map((c) => c.querySelectorAll(".artist").length));
ok(perCard.every((n) => n === 1), "a rail card shows one act, not the whole bill", perCard.join(","));
const alsoOn = await page.evaluate(() =>
  [...document.querySelectorAll("#forYou .show")].map((c) => c.querySelector(".alsoOn")?.textContent || ""));
ok(alsoOn.some((t) => /\+\d+ more on the bill/.test(t)), "and says how many others are on it",
  alsoOn.filter(Boolean)[0] || "(none had support acts)");
const fyHeight = await page.evaluate(() => Math.round(document.querySelector("#forYou").getBoundingClientRect().height));
ok(fyHeight < 1600, "the whole section is under two desktop screens", `${fyHeight}px`);
ok(railCounts.every((n) => n === 2), "every rail shows exactly two shows", railCounts.join(", "));
ok(railTitles.some((t) => /something a little different/i.test(t)), "a 'Something a little different' rail");
ok(await page.locator("#forYou .railMore[data-more]").count() > 0, "at least one rail offers more");
const beforeMore = await page.locator('[data-rail="emerging"] .show').count();
await page.locator('[data-rail="emerging"] .railMore[data-more]').first().click();
await page.waitForTimeout(120);
const afterMore = await page.locator('[data-rail="emerging"] .show').count();
ok(afterMore > beforeMore, "the more link expands that rail in place", `${beforeMore} -> ${afterMore}`);
await page.locator('[data-rail="emerging"] .railMore[data-more]').first().click();
await page.waitForTimeout(120);
ok(await page.locator('[data-rail="emerging"] .show').count() === beforeMore, "and collapses again");
const stretch = await page.evaluate(() =>
  [...document.querySelectorAll('[data-rail="stretch"] .show .why')].map((e) => e.textContent.trim()));
ok(stretch.length > 0 && stretch.every((w) => / is .+|further from your usual/i.test(w)),
  "the stretch rail says what is different about each pick", stretch.join(" | "));
ok(new Set(stretch).size === stretch.length, "and does not repeat the same sentence on every card");
// Seed artists exist to measure taste; they must never be offered as a gig.
const seedOnly = await page.evaluate(async () => {
  const j = await (await fetch("seed-artists.json")).json();
  const playing = new Set();
  for (const e of window.__gigamp.state.data.events) for (const a of e.artists) playing.add(a.name);
  return j.artists.map((a) => a.name).filter((n) => !playing.has(n));
});
const railNames = await page.evaluate(() =>
  [...document.querySelectorAll("#forYou .artist .who a")].map((e) => e.textContent.trim()));
ok(seedOnly.length > 10, "the fixture has seed artists with no local gig", `${seedOnly.length}`);
ok(!railNames.some((n) => seedOnly.includes(n)), "no act without a local gig is ever recommended");
const usedSeedOnly = await page.evaluate((names) => {
  const s = new Set(); for (const c of window.__gigamp.taste.explicit.comparisons) { s.add(c.a.name); s.add(c.b.name); }
  return names.filter((n) => s.has(n));
}, seedOnly);
ok(usedSeedOnly.length > 0, "but the game does use acts with no local gig", usedSeedOnly.join(", "));
const whys = await page.locator("#forYou .show .why").allTextContents();
ok(whys.length > 0 && whys.every((w) => w.trim().length > 0), "every recommendation carries a reason", `${whys.length} cards`);
ok(!whys.some((w) => /^recommended for you$/i.test(w.trim())), "no bare 'Recommended for you'");
// A rail that says the same thing on every card reads as filler.
const repeats = await page.evaluate(() => {
  const bad = [];
  for (const rail of document.querySelectorAll("#forYou .rail")) {
    const first = [...rail.querySelectorAll(".show .why")].map((e) => e.textContent.trim().split(/[.·]/)[0].trim());
    if (new Set(first).size !== first.length) bad.push(rail.dataset.rail + ": " + first.join(" / "));
  }
  return bad;
});
ok(repeats.length === 0, "no rail repeats the same opening clause across its cards", repeats.join("; ") || "all distinct");
// The act a card is about has to be the act at the top of that card's bill.
const leadFirst = await page.evaluate(() =>
  [...document.querySelectorAll("#forYou .show")].every((c) => {
    const why = c.querySelector(".why").textContent;
    const first = c.querySelector(".artist .who a").textContent.trim();
    const named = [...c.querySelectorAll(".artist .who a")].map((a) => a.textContent.trim())
      .filter((n) => why.includes(n));
    return named.length === 0 || named.includes(first);
  }));
ok(leadFirst, "a card's reason names the act at the top of its bill, not one further down");
const cards = await page.evaluate(() => [...document.querySelectorAll("#forYou .show")].map((c) => ({
  artist: c.querySelector(".artist .who a").textContent.trim(),
  all: [...c.querySelectorAll(".artist .who a")].map((a) => a.textContent.trim()),
  why: c.querySelector(".why").textContent.trim(),
  rail: c.closest(".rail").dataset.rail })));
const names = cards.flatMap((c) => c.all);
ok(new Set(names).size === names.length, "no act is recommended twice anywhere in For You",
  `${names.length} cards, ${new Set(names).size} distinct acts`);
ok(!cards.some((c) => new RegExp(`You liked ${c.artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`).test(c.why)),
  "no card explains itself with its own artist");
const obShown = await page.evaluate(() => {
  const s = new Set(); for (const c of window.__gigamp.taste.explicit.comparisons) { s.add(c.a.name); s.add(c.b.name); } return [...s];
});
ok(!cards.filter((c) => c.rail === "emerging").some((c) => obShown.includes(c.artist)),
  "Before they blow up never offers an act the visitor already saw in the game");
const emergingTiers = await page.evaluate(() =>
  [...document.querySelectorAll('[data-rail="emerging"] .show')].map((c) => {
    const key = c.querySelector(".artist").dataset.artistId;
    return window.__gigamp.state.poolByKey.get(key)?.tier;
  }));
ok(emergingTiers.length > 0 && emergingTiers.every((t) => t > 0 && t <= 2),
  "Before they blow up only leads with smaller acts", emergingTiers.join(", "));
await page.screenshot({ path: path.join(SHOTS, "03-foryou.png"), fullPage: false });

console.log("\n3b. Copy for Spotify");
// Spotify has no paste-a-tracklist import, so a list of "Artist - Track" does nothing
// there. What its desktop app and web player DO accept is a paste of track URLs.
await page.locator("#copyList").click();
await page.waitForTimeout(200);
const clip = await page.evaluate(() => navigator.clipboard.readText());
const clipLines = clip.split("\n").filter(Boolean);
ok(clipLines.length > 0 && clipLines.every((l) => /^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+$/.test(l)),
  "it copies Spotify track links, which is what Spotify actually accepts",
  `${clipLines.length} lines, e.g. ${clipLines[0]}`);
ok(new Set(clipLines).size === clipLines.length, "no duplicate tracks");
const howTo = await page.locator("#status").textContent();
ok(/paste/i.test(howTo) && /desktop|web player/i.test(howTo),
  "and says where the paste actually works", howTo.slice(0, 90));
// The plain list is still there for the transfer services, one click away.
await page.locator('#status [data-copy="text"]').click();
await page.waitForTimeout(200);
const clip2 = (await page.evaluate(() => navigator.clipboard.readText())).split("\n").filter(Boolean);
ok(clip2.every((l) => / - /.test(l) && !/^https/.test(l)),
  "and a plain Artist - Track list is one click away for Soundiiz", clip2[0] || "(empty)");

console.log("\n4. For You is a layer, not a filter");
const totals = await page.evaluate(() => {
  const s = window.__gigamp.state;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const t1 = new Date(t0); t1.setDate(t1.getDate() + s.days);
  const iso = (d) => d.toISOString().slice(0, 10);
  const inWindow = s.data.events.filter((e) => e.date >= iso(t0) && e.date <= iso(t1));
  return { inWindow: inWindow.length, rendered: document.querySelectorAll("#results .show").length,
    shown: +document.querySelector("#nShows").textContent };
});
console.log("  events in window:", totals.inWindow, "| rendered in All Gigs:", totals.rendered);
ok(totals.rendered === totals.shown, "All Gigs renders every show the counter claims");
// With venues/genres/reach untouched apart from the first-visit arena default,
// All Gigs must still be a big list containing genres the profile scores badly.
const allGenres = await page.evaluate(() =>
  [...document.querySelectorAll("#results .artist .pill")].map((e) => e.textContent));
ok(allGenres.includes("pop"), "pop is still in All Gigs after an alternative-leaning profile");
ok(allGenres.includes("hip hop") || allGenres.includes("r&b"), "hip hop / r&b still in All Gigs");
ok(totals.rendered > 40, "All Gigs is still the full database", `${totals.rendered} shows`);

console.log("\n5. Persistence and no accounts");
ok(await page.evaluate(() => !!localStorage.getItem("gigamp:anon")), "an anonymous id exists");
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("gigamp:taste")));
ok(Array.isArray(stored.explicit.comparisons) && stored.explicit.comparisons.length === round,
  "explicit comparisons stored", `${stored.explicit.comparisons.length}`);
ok(Object.keys(stored.behaviour.plays).length >= 2, "playback captured as behaviour, separately from the choices");
ok(stored.explicit.comparisons.some((c) => Object.keys(c.plays || {}).length),
  "per-round play counts stored alongside the choice");
ok(!!stored.derived.axes && Object.keys(stored.derived.axes).length === 7, "derived axes stored apart from the raw signals");
ok(!/gigamp:tok|access_token/.test(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))), "nothing auth-shaped in storage");

const beliefs = await page.evaluate(() => {
  const a = window.__gigamp.taste.derived.axes;
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, [+v.value.toFixed(2), +v.conf.toFixed(2)]]));
});
console.log("  learned axes (value, confidence):", JSON.stringify(beliefs));
ok(beliefs.guitar[0] > 0.3, "a guitar-leaning tester ends up guitar-leaning", `guitar=${beliefs.guitar[0]}`);

console.log("\n6. Reload keeps the profile and skips the game");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("#results .show").length > 0, null, { timeout: 15000 });
ok(await page.locator("#onboard").isHidden(), "the comparison game does not run again");
await page.waitForSelector("#forYou .rail", { timeout: 10000 });
ok(await page.locator("#forYou .rail").count() > 0, "For You survives a reload");
ok(await page.locator("#tuneBtn").isVisible(), "a 'Tune For You' entry point is offered");
await page.screenshot({ path: path.join(SHOTS, "04-reload.png"), fullPage: false });

console.log("\n6b. Tune this actually asks more questions");
const before = await page.evaluate(() => window.__gigamp.taste.explicit.comparisons.filter((c) => c.chose).length);
await page.locator("#tuneBtn").click();
await page.waitForTimeout(200);
ok(await page.locator("#onboard .vsCard").count() === 2, "pressing Tune puts a comparison on screen");
let tuneRounds = 0;
while (await page.locator("#onboard .vsCard").count() === 2 && tuneRounds < 8) {
  await page.evaluate(() => document.querySelector("#onboard [data-choose]").click());
  await page.waitForTimeout(90); tuneRounds++;
}
const after = await page.evaluate(() => window.__gigamp.taste.explicit.comparisons.filter((c) => c.chose).length);
ok(tuneRounds === 3, "it asks exactly the three configured extra questions", `${tuneRounds}`);
ok(after === before + 3, "and keeps everything already learned", `${before} -> ${after}`);
ok(await page.locator("#forYou .rail").count() > 0, "For You is back afterwards");

console.log("\n6c. Skipping a single pair");
{
  // Fresh browser, so the profile the sections below rely on is left alone.
  const pp = await browser.newPage();
  await pp.route("**open.spotify.com/**", (r) => r.abort());
  await pp.goto(base, { waitUntil: "domcontentloaded" });
  await pp.waitForSelector("#onboard .vsCard", { timeout: 15000 });
  const firstPair = await pp.locator("#onboard .vsName").allTextContents();
  ok(await pp.locator("#obPass").isVisible(), "each round offers a skip for the pair itself");
  await pp.locator("#obPass").click();
  await pp.waitForTimeout(150);
  const secondPair = await pp.locator("#onboard .vsName").allTextContents();
  ok(secondPair.length === 2 && !secondPair.some((n) => firstPair.includes(n)),
    "skipping replaces both acts rather than reusing them", secondPair.join(" vs "));
  const afterPass = await pp.evaluate(() => {
    const t = window.__gigamp.taste;
    return { stored: t.explicit.comparisons.length, answered: t.explicit.comparisons.filter((c) => c.chose).length,
      conf: Math.max(...Object.values(t.derived.axes).map((a) => a.conf)) };
  });
  ok(afterPass.stored === 1 && afterPass.answered === 0, "the skipped pair is recorded but not answered");
  ok(afterPass.conf === 0, "a skipped pair moves the taste profile not at all", `max confidence ${afterPass.conf}`);
  // Passing forever must still end.
  let passes = 1;
  while (await pp.locator("#obPass").count() && passes < 30) { await pp.locator("#obPass").click(); await pp.waitForTimeout(60); passes++; }
  ok(passes < 30, "passing on everything terminates rather than looping the pool", `${passes} pairs`);
  await pp.close();
}

console.log("\n7. The faceplate");
const knobLabels = await page.locator(".knob .knobLabel").allTextContents();
ok(knobLabels.join(",").toLowerCase() === "city,sources,audience,window", "four dials: city, sources, audience, window", knobLabels.join(", "));
const windowKnob = page.locator('[data-knob="window"]');
const daysBefore = await page.evaluate(() => window.__gigamp.state.days);
await windowKnob.focus();
await windowKnob.press("ArrowLeft");
await page.waitForTimeout(120);
const daysAfter = await page.evaluate(() => window.__gigamp.state.days);
ok(daysAfter < daysBefore, "arrow keys turn a dial", `${daysBefore} -> ${daysAfter} days`);
const windowOpts = await page.locator('.knob:has([data-knob="window"]) .knobOpt').allTextContents();
ok(windowOpts.join(",") === "7 days,14 days,30 days,All listed", "every dial position is written out", windowOpts.join(" · "));
const litUp = await page.locator('.knob:has([data-knob="window"]) .knobOpt.on').allTextContents();
ok(litUp.length === 1 && /14 days/.test(litUp[0]), "and only the chosen one is highlighted", litUp.join(","));
// The words are controls in their own right.
await page.locator('.knob:has([data-knob="window"]) .knobOpt', { hasText: "30 days" }).click();
await page.waitForTimeout(140);
ok(await page.evaluate(() => window.__gigamp.state.days) === 30, "clicking a position word selects it");
ok(/30 days/.test((await page.locator('.knob:has([data-knob="window"]) .knobOpt.on').allTextContents())[0]),
  "and the highlight follows");
// Chrome maps the SVG transform attribute onto CSS transform, so a stray CSS
// transform-origin silently throws the pointer clean off its dial.
const strays = await page.evaluate(() => {
  const bad = [];
  for (const d of document.querySelectorAll(".knobDial")) {
    const db = d.getBoundingClientRect();
    for (const el of d.querySelectorAll("line,circle")) {
      const r = el.getBoundingClientRect();
      if (r.left < db.left - 2 || r.right > db.right + 2 || r.top < db.top - 2 || r.bottom > db.bottom + 2)
        bad.push(`${el.getAttribute("class")} on ${d.dataset.knob}`);
    }
  }
  return bad;
});
ok(strays.length === 0, "every dial's pointer and ticks stay inside the dial", strays.join("; ") || "none stray");
// The dial sweeps 270 degrees with the gap at the bottom, like an amp. Clicking at a
// position's own angle must select that position - that is the whole interaction.
const srcKnob = page.locator('[data-knob="source"]');
const box = await srcKnob.boundingBox();
const clickPos = async (i, n) => {
  const deg = -135 + (270 * i) / (n - 1), rad = (deg - 90) * Math.PI / 180;
  const r = box.width * 0.42;
  await page.mouse.click(box.x + box.width / 2 + r * Math.cos(rad), box.y + box.height / 2 + r * Math.sin(rad));
  await page.waitForTimeout(140);
};
await clickPos(2, 3);
ok((await page.evaluate(() => window.__gigamp.state.sources)).join() === "do604",
  "clicking a dial where you want it points it there");
ok((await page.evaluate(() => location.hash)).includes("s=do604"), "and the change is in the share link");
await clickPos(0, 3);
ok((await page.evaluate(() => window.__gigamp.state.sources)).length === 2, "and again for a different position");

// The Audience dial is a ceiling: one pointer, and it only ever sets the upper end.
const sizeOpts = await page.locator('.knob:has([data-knob="size"]) .knobOpt').allTextContents();
ok(sizeOpts.join(",") === "Underground only,Up to emerging,Up to established,Any size",
  "the audience dial reads as a ceiling, smallest to largest", sizeOpts.join(" · "));
await page.locator('.knob:has([data-knob="size"]) .knobOpt', { hasText: "Up to emerging" }).click();
await page.waitForTimeout(140);
let reach = await page.evaluate(() => window.__gigamp.state.reach);
ok(reach[0] === 0 && reach[1] === 2, "turning it down sets the ceiling and leaves the floor alone", JSON.stringify(reach));
ok((await page.evaluate(() => location.hash)).includes("r=0-2"), "and the change is in the share link");

// The slider in Advanced search is still the full two-ended control, and the two stay in step.
await page.locator("#advancedModule").evaluate((e) => { e.open = true; });
await page.waitForTimeout(80);
ok(await page.locator("#reachRange").isVisible(), "the two-ended slider is still in Advanced search");
const fine = await page.evaluate(() => [+document.querySelector("#reachMin").value, +document.querySelector("#reachMax").value]);
ok(fine[0] === 0 && fine[1] === 2, "the slider followed the dial", JSON.stringify(fine));
const summary = await page.locator("#filterSummary").textContent();
ok(!/unknown/i.test(summary), "the collapsed summary never says 'unknown-emerging'", summary);
ok(/up to emerging/i.test(summary), "it names the ceiling instead", summary);

// Setting a floor is something a ceiling dial cannot express, so it must not pretend.
await page.evaluate(() => {
  const el = document.querySelector("#reachMin");
  el.value = "3"; el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(140);
const lit = await page.locator('.knob:has([data-knob="size"]) .knobOpt.on').allTextContents();
ok(lit.length === 1 && /custom/i.test(lit[0]), "a floor set on the slider shows the dial as custom, not a wrong position", lit.join(","));
ok(!/unknown/i.test(await page.locator("#filterSummary").textContent()), "and the summary still reads properly",
  await page.locator("#filterSummary").textContent());
await page.locator('.knob:has([data-knob="size"]) .knobOpt', { hasText: "Any size" }).click();
await page.waitForTimeout(140);
reach = await page.evaluate(() => window.__gigamp.state.reach);
ok(reach[0] === 0 && reach[1] === 4, "and the dial clears the floor when you turn it back up", JSON.stringify(reach));
await page.locator("#advancedModule").evaluate((e) => { e.open = false; });   // leave it as we found it
await page.waitForTimeout(80);

await page.screenshot({ path: path.join(SHOTS, "08-faceplate.png"), fullPage: false });

console.log("\n7b. Advanced search sits under the dials");
const order = await page.evaluate(() => [...document.querySelectorAll("main > *")].map((e) => e.id || e.className.split(" ")[0]));
ok(order.indexOf("advancedModule") === order.indexOf("facePanel") + 1,
  "Advanced search is the first thing under the faceplate", order.join(" → "));
ok(/advanced search/i.test(await page.locator("#advancedModule > summary h2").textContent()), "and is called Advanced search");
ok(await page.locator("#advancedModule").evaluate((e) => !e.open), "it starts collapsed");
ok(await page.locator("#venues").isHidden() && await page.locator("#genres").isHidden(), "so venues and genres are out of the way");
await page.locator("#advancedModule > summary").click();
await page.waitForTimeout(120);
ok(await page.locator("#venues").isVisible() && await page.locator("#genres").isVisible(),
  "opening it brings back both the venue and genre filters");
ok(await page.locator("#genres .chip").count() > 0, "the genre chips are populated");

// Both lists can be filled and emptied, which is what makes "everything except these" possible.
const nChips = await page.locator("#genres .chip").count();
await page.locator("#gAll").click(); await page.waitForTimeout(120);
ok(await page.locator('#genres .chip[aria-pressed="true"]').count() === nChips, "select all ticks every genre");
await page.locator('#genres .chip[aria-pressed="true"]').first().click(); await page.waitForTimeout(120);
ok(await page.evaluate(() => window.__gigamp.state.genres.length) === nChips - 1,
  "so you can then drop the one genre you do not want");
await page.locator("#gClear").click(); await page.waitForTimeout(120);
ok(await page.evaluate(() => window.__gigamp.state.genres.length) === 0, "clear empties them again");
await page.locator("#vNone").click(); await page.waitForTimeout(120);
ok(await page.evaluate(() => window.__gigamp.state.venues?.length) === 0, "clear empties the venues");
await page.locator("#vAll").click(); await page.waitForTimeout(120);
ok(await page.evaluate(() => window.__gigamp.state.venues) === null, "select all restores every venue");
ok((await page.locator("#vAll").textContent()).trim() === "select all" &&
   (await page.locator("#gAll").textContent()).trim() === "select all", "both lists say the same thing");
await page.screenshot({ path: path.join(SHOTS, "09-advanced.png"), fullPage: false });

console.log("\n7c. The whole feature collapses");
ok(await page.locator("#personalModule").evaluate((e) => e.open), "For you starts open");
await page.locator("#personalModule > summary").click();
await page.waitForTimeout(140);
ok(await page.locator("#forYou").isHidden(), "collapsing it hides the rails");
ok(await page.locator("#onboard").isHidden(), "and the survey with them");
ok(await page.locator("#results .show").first().isVisible(), "the full show list is right there");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("#results .show").length > 0, null, { timeout: 15000 });
ok(await page.locator("#personalModule").evaluate((e) => !e.open), "and it is still collapsed on the next visit");
await page.locator("#personalModule > summary").click();
await page.waitForTimeout(120);

console.log("\n7e. Because you liked — rotation and starred gigs");
const titles = [];
for (let i = 0; i < 5; i++) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#forYou .rail", { timeout: 15000 });
  titles.push((await page.locator('[data-rail="because"] .railHead h3').textContent()).trim());
}
console.log("  across five loads:", [...new Set(titles)].join(" | "));
ok(new Set(titles).size > 1, "the rail leads with a different act between refreshes",
  `${new Set(titles).size} distinct over 5 loads`);
ok(await page.locator('[data-rail="because"]').count() === 1, "only one Because you liked rail");
const becauseWhys = await page.locator('[data-rail="because"] .show .why').allTextContents();
ok(!becauseWhys.some((w) => /because you liked/i.test(w)),
  "the cards inside it never repeat the heading", becauseWhys.join(" | "));
ok(becauseWhys.every((w) => w.trim().length > 0), "but each still says what the link is");

// Starring a show is a stronger statement than any survey answer, so it feeds the same seed list.
const starred = await page.evaluate(() => {
  const g = window.__gigamp;
  // a show whose lead act the survey never touched
  const seen = new Set();
  for (const c of g.taste.explicit.comparisons) { seen.add(c.a.key); seen.add(c.b.key); }
  for (const e of g.state.data.events) {
    const arts = e.artists.filter((a) => a.tracks?.length);
    if (!arts.length) continue;
    const key = arts[0].spotify_id;
    if (seen.has(key) || (g.taste.derived.artistAffinity[key] || 0) > 0.5) continue;
    const btn = document.querySelector(`[data-save="${(e.id || "").replace(/"/g, '\\"')}"]`);
    if (!btn) continue;
    btn.click();
    return { name: arts[0].name, key };
  }
  return null;
});
if (!starred) {
  ok(false, "could not find an unstarred show to test with");
} else {
  const aff = await page.evaluate((k) => window.__gigamp.taste.derived.artistAffinity[k] || 0, starred.key);
  ok(aff > 0.5, `starring a show makes its act a taste signal (${starred.name})`, `affinity ${aff.toFixed(2)}`);
  const seeds = [];
  for (let i = 0; i < 8 && !seeds.includes(starred.name); i++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#forYou .rail", { timeout: 15000 });
    seeds.push((await page.locator('[data-rail="because"] .railHead h3').textContent()).replace(/^Because you liked /, "").trim());
  }
  ok(seeds.includes(starred.name), "and the rail leads with it within a few refreshes",
    seeds.join(" → "));
}

console.log("\n8. Fresh visitor can browse and skip");
const p2 = await ctx.newPage();
await p2.goto(base + "#city=vancouver&days=30", { waitUntil: "domcontentloaded" });
await p2.waitForFunction(() => document.querySelectorAll("#results .show").length > 0, null, { timeout: 15000 });
ok(await p2.locator("#results .show").count() > 0, "a shared link still lands straight on the listings");
await p2.close();

const p3 = await browser.newPage();
await p3.goto(base, { waitUntil: "domcontentloaded" });
await p3.waitForSelector("#onboard .vsCard", { timeout: 15000 });
await p3.locator("#obSkip").click();
await p3.waitForTimeout(150);
ok(await p3.locator("#results .show").count() > 0, "skipping the game leaves the full listings");
ok(await p3.locator("#forYouModule").isHidden(), "no For You section without any taste signal");
await p3.close();

console.log("\n9. On a phone");
{
  const mob = await browser.newContext({ ...devices["iPhone 13"] });
  await mob.route("**open.spotify.com/**", (r) => r.abort());
  const pm = await mob.newPage();
  await pm.goto(base, { waitUntil: "domcontentloaded" });
  await pm.waitForSelector("#onboard .vsCard", { timeout: 15000 });
  const m = await pm.evaluate(() => {
    const cards = [...document.querySelectorAll("#onboard .vsCard")].map((c) => c.getBoundingClientRect());
    return { lastCardBottom: Math.round(cards[cards.length - 1].bottom), vh: window.innerHeight,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      faceOpen: document.querySelector("#facePanel").open,
      faceH: Math.round(document.querySelector("#facePanel").getBoundingClientRect().height),
      readout: document.querySelector("#faceNow").textContent };
  });
  ok(!m.faceOpen, "the faceplate starts as a one-line readout on a phone", `${m.faceH}px`);
  ok(/·/.test(m.readout), "which shows every dial's current position", m.readout);
  ok(!m.overflowX, "no sideways scrolling");
  ok(m.lastCardBottom <= m.vh, "both acts fit on one screen, buttons included",
    `cards end at ${m.lastCardBottom} of ${m.vh}`);

  // Tapping it opens dials at full size rather than the old 58px squeeze.
  await pm.locator("#facePanel > summary").click();
  await pm.waitForTimeout(160);
  const open = await pm.evaluate(() => {
    const d = [...document.querySelectorAll(".knobDial")].map((k) => k.getBoundingClientRect());
    const rows = new Set(d.map((r) => Math.round(r.top)));
    const opts = [...document.querySelectorAll('.knob:has([data-knob="window"]) .knobOpt')]
      .filter((o) => o.getBoundingClientRect().height > 0).length;
    return { size: Math.round(d[0].width), rows: rows.size, visibleOpts: opts,
      overflowX: document.documentElement.scrollWidth > window.innerWidth };
  });
  ok(open.size >= 80, "the dials open at full size", `${open.size}px`);
  ok(open.rows === 2, "two across rather than four squeezed into one row", `${open.rows} rows`);
  ok(open.visibleOpts === 4, "and every position is readable, not just the selected one", `${open.visibleOpts} shown`);
  ok(!open.overflowX, "still no sideways scrolling when open");
  // The choice sticks.
  await pm.reload({ waitUntil: "domcontentloaded" });
  await pm.waitForSelector("#onboard .vsCard", { timeout: 15000 });
  ok(await pm.locator("#facePanel").evaluate((e) => e.open), "and it is still open on the next visit");

  await pm.close(); await mob.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (errors.length) { console.log("page errors:\n  " + errors.join("\n  ")); failures += errors.length; }
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
