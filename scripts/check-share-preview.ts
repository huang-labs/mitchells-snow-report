import assert from "node:assert/strict";
import { decode } from "fast-png";
import { REGIONS } from "../src/lib/catalog";
import { SECTIONS, sectionHref } from "../src/lib/sections";

// The optional expected origin lets a local Worker validate a preview-targeted build.
const base = new URL(process.argv[2]);
const expectedOrigin = new URL(process.argv[3] ?? base).origin;
const headers = { "User-Agent": "facebookexternalhit/1.1" };

const paths=[...SECTIONS.map(s=>sectionHref(s.id)),...REGIONS.flatMap(r=>["/daily-snow/"+r.id,"/weather/"+r.id,"/plumes/"+r.id])];
for (const path of paths) {
  const url = new URL(path, base);
  // Avoid a stale page when a preview alias has just been updated.
  url.searchParams.set("verify", process.env.GITHUB_SHA ?? Date.now().toString());
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200, `${url}: page status`);
  const html = await response.text();
  const tags = new Map<string, string>();
  for (const match of html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)"/g)) {
    tags.set(match[1], match[2]);
  }
  for (const key of ["og:url", "og:image", "twitter:image"]) {
    assert.ok(tags.has(key), `${url}: missing ${key}`);
    assert.equal(new URL(tags.get(key)!).origin, expectedOrigin, `${url}: ${key} points outside this deployment`);
  }
  const expectedPath = path.startsWith("/daily-snow") ? path+"/opengraph-image" : "/share-brand-v2.png";
  for (const key of ["og:image", "twitter:image"]) {
    const image = new URL(tags.get(key)!);
    assert.equal(image.pathname, expectedPath);
    const imageResponse = await fetch(new URL(image.pathname + image.search, base), { headers });
    assert.equal(imageResponse.status, 200, `${key}: image status`);
    assert.match(imageResponse.headers.get("content-type") ?? "", /^image\/png/);
    const png = decode(new Uint8Array(await imageResponse.arrayBuffer()));
    assert.deepEqual([png.width, png.height], [1200, 630]);
  }
  console.log(`${path}: share URLs and images OK`);
}
