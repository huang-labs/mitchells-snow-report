import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "fast-png";
import { REGIONS, RESORTS } from "../src/lib/catalog";
import type { ReportResponse } from "../src/lib/types";

// Exercise the bundled Worker and real asset routing in workerd, without
// credentials, upstream collection, remote AI, or the developer's local KV.
const state = await mkdtemp(join(tmpdir(), "snow-worker-smoke-"));
const child = spawn(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--port", "0",
  "--inspector-port", "0", "--persist-to", state, "--show-interactive-dev-session=false",
], { stdio: ["ignore", "pipe", "pipe"] });
const exited = once(child, "exit");
let output = "";
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker startup timed out\n${output}`)), 30_000);
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(url!);
    };
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
      const ready = /Ready on (http:\/\/(?:localhost|127\.0\.0\.1):\d+)/.exec(output);
      if (ready) finish(undefined, ready[1]);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Worker exited (${code})\n${output}`)));
  });
  const get = (path: string, method = "GET") => fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(15_000) });
  for (const path of ["/", "/daily-snow", "/weather", "/plumes", ...RESORTS.map(r=>"/"+r.id), ...REGIONS.flatMap(r=>["/daily-snow/"+r.id,"/weather/"+r.id,"/plumes/"+r.id])]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /role="status">Loading /, `accessible loading status for ${path}`);
    assert.match(html, /aria-busy="true"/, `initial skeleton for ${path}`);
    const expectedImage = path.startsWith("/daily-snow") ? path+"/opengraph-image" : "/share-brand-v2.png";
    assert.ok(html.includes(`${expectedImage}\"`), `share image for ${path}`);
    const script = /src="([^\"]*\/_next\/static\/[^\"]+\.js)"/.exec(html)?.[1];
    assert.ok(script, `static script for ${path}`);
    const js = await get(script);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("cache-control")!, /immutable/);
    await js.arrayBuffer();
  }
  const brand = await get("/share-brand-v2.png");
  assert.equal(brand.status, 200);
  assert.match(brand.headers.get("content-type")!, /^image\/png/);
  const brandedPng = decode(new Uint8Array(await brand.arrayBuffer()));
  assert.deepEqual([brandedPng.width, brandedPng.height], [1200, 630]);
  // Next static export uses .txt payloads for client-side navigation.
  const navigation = await get("/weather.txt");
  assert.equal(navigation.status, 200);
  assert.match(await navigation.text(), /weather/);
  const retiredPreview = await get("/opengraph-image");
  assert.equal(retiredPreview.status, 404);
  await retiredPreview.arrayBuffer();
  const missing = await get("/not-a-section");
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  const report = await get("/api/report");
  assert.equal(report.status, 200);
  assert.equal(report.headers.get("cache-control"), "no-store");
  assert.equal(((await report.json()) as ReportResponse).sources.alta.freshness, "unavailable");
  for (const path of ["/traffic", "/api/unknown", "/api/plume/CLN/2026110100/snow"]) {
    const res = await get(path);
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  }
  const method = await get("/api/report", "POST");
  assert.equal(method.status, 405);
  await method.arrayBuffer();
  for (const path of ["/daily-snow/opengraph-image", "/daily-snow/tahoe/opengraph-image"]) {
    const image = await get(path);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "public, max-age=60");
    const png = decode(new Uint8Array(await image.arrayBuffer()));
    assert.deepEqual([png.width, png.height], [1200, 630]);
    let dark = 0;
    for (let i = 0; i < png.data.length; i += png.channels) {
      if (png.data[i] < 60 && png.data[i + 1] < 80 && png.data[i + 2] < 100) dark++;
    }
    assert.ok(dark > 1200 * 630 * 0.7, "share image has a dark background");
    const head = await get(path, "HEAD");
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const archive = await get("/api/daily-snow?date=2026-11-01");
  assert.equal(archive.status, 404);
  assert.match(await archive.text(), /No Daily Snow/);
  const figure = await get("/api/daily-snow/figure/2026-11-01/stake-alta");
  assert.equal(figure.status, 404);
  await figure.arrayBuffer();
  const shareCheck = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-share-preview.ts", base, process.env.SITE_URL || "https://mitchells-snow-report.huang.mx"], { stdio: "inherit" });
  const [code] = await once(shareCheck, "exit");
  assert.equal(code, 0, "share metadata matches each section and deployment");
  console.log("Worker smoke passed: 42 static pages, navigation payload, immutable JS, 404s, API methods, KV, static and Daily Snow PNGs, share metadata and HEAD.");
} finally {
  child.kill("SIGTERM");
  await exited;
  await rm(state, { recursive: true, force: true });
}
