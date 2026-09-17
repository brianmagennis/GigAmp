/* Drives the real comparison engine through several simulated listeners and
   checks the properties the design depends on: broad first, recognisable names
   first, different axes probed early, no artist reused, no fixation on one act,
   narrowing separation, and a length that actually adapts to how decisive the
   answers are. Run: node tests/selector_test.mjs */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const p = path.join(DOCS, rel === "/" ? "index.html" : rel);
  if (!p.startsWith(DOCS) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

let failures = 0, checks = 0;
const ok = (c, label, extra = "") => { checks++; console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`); if (!c) failures++; };

const AXES = ["guitar", "energy", "pop", "urban", "roots", "dance", "reach"];
// Each persona is a weight vector over the axes; it always picks the artist
// whose vector scores highest against it. "coin" is the deliberately muddled one.
const PERSONAS = {
  "alt / guitar":   [1, 0.4, -0.3, 0, 0, 0, 0],
  "pop & dancing":  [-0.2, 0, 1, 0, 0, 0.8, 0.3],
  "hip hop / r&b":  [0, 0, 0.2, 1, 0, 0.3, 0],
  "roots / folk":   [0.2, -0.5, 0, 0, 1, -0.4, 0],
  "underground":    [0, 0, -0.4, 0, 0, 0, -1],
  "contrarian":     null,
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route("**open.spotify.com/**", (r) => r.abort());

const results = {};
for (const [name, w] of Object.entries(PERSONAS)) {
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#onboard .vsCard", { timeout: 15000 });

  const rows = [];
  let n = 0;
  while (await page.locator("#onboard .vsCard").count() === 2 && n < 12) {
    const row = await page.evaluate((weights) => {
      const g = window.__gigamp, r = g.state.round;
      const score = (v) => weights ? v.reduce((s, x, i) => s + x * weights[i], 0) : 0;
      // No weights = the contrarian: always picks whichever act agrees LESS with
      // the profile built so far, so nothing ever settles.
      const pick = weights
        ? (score(r.a.v) >= score(r.b.v) ? r.a : r.b)
        : (g.tasteSim(r.a.v) <= g.tasteSim(r.b.v) ? r.a : r.b);
      let sep = 0, topAxis = 0, topDiff = 0;
      for (let i = 0; i < r.a.v.length; i++) {
        const d = r.a.v[i] - r.b.v[i]; sep += d * d;
        if (Math.abs(d) > topDiff) { topDiff = Math.abs(d); topAxis = i; }
      }
      const fam = (p) => Math.max(p.tier / 4, p.listeners > 1000 ? Math.max(0, Math.min(1, (Math.log10(p.listeners) - 3.5) / 3.2)) : 0);
      const poolA = g.state.poolByKey.get(r.a.key), poolB = g.state.poolByKey.get(r.b.key);
      return { a: r.a.name, b: r.b.name, chose: pick.name, key: pick.key,
        sep: Math.sqrt(sep), topAxis, fam: [fam(poolA), fam(poolB)] };
    }, w);
    await page.evaluate((k) => document.querySelector(`#onboard [data-choose="${k.replace(/"/g, '\\"')}"]`).click(),
      await page.evaluate((weights) => {
        const r = window.__gigamp.state.round;
        const score = (v) => weights ? v.reduce((s, x, i) => s + x * weights[i], 0) : 0;
        const g = window.__gigamp;
        return weights ? (score(r.a.v) >= score(r.b.v) ? r.a.key : r.b.key)
                       : (g.tasteSim(r.a.v) <= g.tasteSim(r.b.v) ? r.a.key : r.b.key);
      }, w));
    row.conf = await page.evaluate(() => {
      const core = ["guitar", "energy", "pop", "urban", "dance"];
      const a = window.__gigamp.taste.derived.axes;
      return Object.values(a).filter((x) => x.conf >= 0.5).length + "/7 settled";
    });
    rows.push(row); n++;
    await page.waitForTimeout(40);
  }
  const axesOut = await page.evaluate(() => Object.fromEntries(
    Object.entries(window.__gigamp.taste.derived.axes).map(([k, v]) => [k, +v.value.toFixed(2)])));
  results[name] = { rows, rounds: n, axes: axesOut };
  await page.close();
}

for (const [name, r] of Object.entries(results)) {
  console.log(`\n${name}  (${r.rounds} rounds)`);
  r.rows.forEach((x, i) => console.log(`  ${i + 1}. ${x.a} vs ${x.b}  -> ${x.chose}   sep ${x.sep.toFixed(2)}  key axis ${AXES[x.topAxis]}  conf ${x.conf}`));
  console.log("  axes:", JSON.stringify(r.axes));
}

console.log("\nProperties");
for (const [name, r] of Object.entries(results)) {
  const shown = r.rows.flatMap((x) => [x.a, x.b]);
  ok(new Set(shown).size === shown.length, `${name}: no artist shown twice`);
  ok(r.rounds >= 5 && r.rounds <= 8, `${name}: length between 5 and 8`, `${r.rounds}`);
  ok(r.rows.slice(0, 2).every((x) => Math.min(...x.fam) >= 0.55),
    `${name}: both acts in the opening rounds are recognisable`,
    r.rows.slice(0, 2).map((x) => x.fam.map((f) => f.toFixed(2)).join("/")).join(" "));
  const early = r.rows.slice(0, 3).reduce((s, x) => s + x.sep, 0) / 3;
  const late = r.rows.slice(-2).reduce((s, x) => s + x.sep, 0) / 2;
  ok(early > late, `${name}: pairs get closer together`, `${early.toFixed(2)} -> ${late.toFixed(2)}`);
  const firstAxes = new Set(r.rows.slice(0, 3).map((x) => x.topAxis));
  ok(firstAxes.size >= 2, `${name}: the first three rounds probe more than one dimension`,
    [...firstAxes].map((i) => AXES[i]).join(", "));
}

console.log("");
ok(results["alt / guitar"].axes.guitar > 0.4, "guitar listener reads as guitar", `${results["alt / guitar"].axes.guitar}`);
ok(results["pop & dancing"].axes.pop > 0.3 && results["pop & dancing"].axes.dance > 0.2, "pop/dance listener reads as pop and dance",
  `pop ${results["pop & dancing"].axes.pop}, dance ${results["pop & dancing"].axes.dance}`);
ok(results["hip hop / r&b"].axes.urban > 0.4, "hip hop listener reads on the urban axis", `${results["hip hop / r&b"].axes.urban}`);
ok(results["roots / folk"].axes.roots > 0.3, "roots listener reads on the roots axis", `${results["roots / folk"].axes.roots}`);
ok(results["underground"].axes.reach < -0.2, "underground listener reads as underground", `${results["underground"].axes.reach}`);
const decisive = ["alt / guitar", "pop & dancing", "hip hop / r&b", "roots / folk", "underground"].map((k) => results[k].rounds);
ok(results["contrarian"].rounds > Math.min(...decisive),
  "an answerer who never settles gets asked more questions than a decisive one",
  `${results["contrarian"].rounds} vs ${Math.min(...decisive)}`);
ok(Math.min(...decisive) < 8, "a decisive listener finishes before the ceiling", `shortest ${Math.min(...decisive)}`);

// Distinct personas must end up with distinct profiles, or the model is not learning.
const dist = (a, b) => Math.sqrt(AXES.reduce((s, k) => s + (a[k] - b[k]) ** 2, 0));
ok(dist(results["alt / guitar"].axes, results["pop & dancing"].axes) > 1.5,
  "alt and pop listeners end up in clearly different places",
  dist(results["alt / guitar"].axes, results["pop & dancing"].axes).toFixed(2));
ok(dist(results["hip hop / r&b"].axes, results["roots / folk"].axes) > 1.5,
  "hip hop and roots listeners end up in clearly different places",
  dist(results["hip hop / r&b"].axes, results["roots / folk"].axes).toFixed(2));

console.log(`\n${checks - failures}/${checks} checks passed`);
await browser.close(); server.close();
process.exit(failures ? 1 : 0);
