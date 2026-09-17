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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
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
  [...document.querySelectorAll("#forYou .rail")].map((r) => r.querySelectorAll(".rec").length));
ok(railCounts.every((n) => n === 2), "every rail shows exactly two shows", railCounts.join(", "));
ok(railTitles.some((t) => /something a little different/i.test(t)), "a 'Something a little different' rail");
ok(await page.locator("#forYou .railMore[data-more]").count() > 0, "at least one rail offers more");
const beforeMore = await page.locator('[data-rail="emerging"] .rec').count();
await page.locator('[data-rail="emerging"] .railMore[data-more]').first().click();
await page.waitForTimeout(120);
const afterMore = await page.locator('[data-rail="emerging"] .rec').count();
ok(afterMore > beforeMore, "the more link expands that rail in place", `${beforeMore} -> ${afterMore}`);
await page.locator('[data-rail="emerging"] .railMore[data-more]').first().click();
await page.waitForTimeout(120);
ok(await page.locator('[data-rail="emerging"] .rec').count() === beforeMore, "and collapses again");
const stretch = await page.evaluate(() =>
  [...document.querySelectorAll('[data-rail="stretch"] .recWhy')].map((e) => e.textContent.trim()));
ok(stretch.length > 0 && stretch.every((w) => /this one is|further from your usual/i.test(w)),
  "the stretch rail says what is different about each pick", stretch[0] || "(none)");
// Seed artists exist to measure taste; they must never be offered as a gig.
const seedOnly = await page.evaluate(async () => {
  const j = await (await fetch("seed-artists.json")).json();
  const playing = new Set();
  for (const e of window.__gigamp.state.data.events) for (const a of e.artists) playing.add(a.name);
  return j.artists.map((a) => a.name).filter((n) => !playing.has(n));
});
const railNames = await page.evaluate(() =>
  [...document.querySelectorAll("#forYou .recName")].map((e) => e.childNodes[0].textContent.trim()));
ok(seedOnly.length > 10, "the fixture has seed artists with no local gig", `${seedOnly.length}`);
ok(!railNames.some((n) => seedOnly.includes(n)), "no act without a local gig is ever recommended");
const usedSeedOnly = await page.evaluate((names) => {
  const s = new Set(); for (const c of window.__gigamp.taste.explicit.comparisons) { s.add(c.a.name); s.add(c.b.name); }
  return names.filter((n) => s.has(n));
}, seedOnly);
ok(usedSeedOnly.length > 0, "but the game does use acts with no local gig", usedSeedOnly.join(", "));
const whys = await page.locator("#forYou .recWhy").allTextContents();
ok(whys.length > 0 && whys.every((w) => w.trim().length > 0), "every recommendation carries a reason", `${whys.length} cards`);
ok(!whys.some((w) => /^recommended for you$/i.test(w.trim())), "no bare 'Recommended for you'");
const cards = await page.evaluate(() => [...document.querySelectorAll("#forYou .rec")].map((c) => ({
  artist: c.querySelector(".recName").childNodes[0].textContent.trim(),
  why: c.querySelector(".recWhy").textContent.trim(),
  rail: c.closest(".rail").dataset.rail })));
const names = cards.map((c) => c.artist);
ok(new Set(names).size === names.length, "no artist appears twice anywhere in For You",
  `${names.length} cards, ${new Set(names).size} distinct acts`);
ok(!cards.some((c) => new RegExp(`You liked ${c.artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`).test(c.why)),
  "no card explains itself with its own artist");
const obShown = await page.evaluate(() => {
  const s = new Set(); for (const c of window.__gigamp.taste.explicit.comparisons) { s.add(c.a.name); s.add(c.b.name); } return [...s];
});
ok(!cards.filter((c) => c.rail === "emerging").some((c) => obShown.includes(c.artist)),
  "Before they blow up never offers an act the visitor already saw in the game");
const emergingTiers = await page.evaluate(() =>
  [...document.querySelectorAll('[data-rail="emerging"] .recName .pill')].map((e) => e.textContent));
ok(emergingTiers.length > 0 && emergingTiers.every((t) => /underground|emerging/.test(t)),
  "Before they blow up only contains smaller acts", emergingTiers.join(", "));
await page.screenshot({ path: path.join(SHOTS, "03-foryou.png"), fullPage: false });

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
ok(/days|listed/i.test(await page.locator('.knob:has([data-knob="window"]) .knobValue').textContent()),
  "the dial reads out its current value");
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
const sizeKnob = page.locator('[data-knob="size"]');
const box = await sizeKnob.boundingBox();
const clickPos = async (i, n) => {
  const deg = -135 + (270 * i) / (n - 1), rad = (deg - 90) * Math.PI / 180;
  const r = box.width * 0.42;
  await page.mouse.click(box.x + box.width / 2 + r * Math.cos(rad), box.y + box.height / 2 + r * Math.sin(rad));
  await page.waitForTimeout(140);
};
await clickPos(4, 5);
let reach = await page.evaluate(() => window.__gigamp.state.reach);
ok(reach[0] === 3 && reach[1] === 4, "clicking a dial where you want it points it there", JSON.stringify(reach));
ok((await page.evaluate(() => location.hash)).includes("r=3-4"), "and the change is in the share link");
await clickPos(1, 5);
reach = await page.evaluate(() => window.__gigamp.state.reach);
ok(reach[0] === 0 && reach[1] === 1, "and again for a different position", JSON.stringify(reach));
const fine = await page.evaluate(() => [+document.querySelector("#reachMin").value, +document.querySelector("#reachMax").value]);
ok(fine[0] === 0 && fine[1] === 1, "the finer slider inside Filters stays in step with the dial", JSON.stringify(fine));
await clickPos(0, 5);
await page.waitForTimeout(100);
await page.screenshot({ path: path.join(SHOTS, "08-faceplate.png"), fullPage: false });

console.log("\n7b. Modules collapse");
ok(await page.locator("#filterModule").evaluate((e) => !e.open), "the filters module starts collapsed");
ok(await page.locator("#venues").isHidden(), "so the venue list is not on screen");
await page.locator("#filterModule > summary").click();
await page.waitForTimeout(120);
ok(await page.locator("#venues").isVisible(), "opening it reveals the venue list");
ok(await page.locator("#forYouModule").evaluate((e) => e.open), "For You starts open");
await page.locator("#forYouModule > summary").click();
await page.waitForTimeout(120);
ok(await page.locator("#forYou").isHidden(), "and collapses when asked");

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
    const rows = new Set([...document.querySelectorAll(".knob")].map((k) => Math.round(k.getBoundingClientRect().top)));
    return { lastCardBottom: Math.round(cards[cards.length - 1].bottom), vh: window.innerHeight,
      knobRows: rows.size, overflowX: document.documentElement.scrollWidth > window.innerWidth,
      faceH: Math.round(document.querySelector(".faceplate").getBoundingClientRect().height) };
  });
  ok(m.knobRows === 1, "the faceplate stays one row of dials", `${m.knobRows} row(s), ${m.faceH}px tall`);
  ok(!m.overflowX, "no sideways scrolling");
  ok(m.lastCardBottom <= m.vh, "both acts fit on one screen, buttons included",
    `cards end at ${m.lastCardBottom} of ${m.vh}`);
  await pm.close(); await mob.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (errors.length) { console.log("page errors:\n  " + errors.join("\n  ")); failures += errors.length; }
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
