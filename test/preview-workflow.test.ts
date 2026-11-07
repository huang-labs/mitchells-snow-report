import { describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  Cloudflare,
  PRODUCTION_KV,
  LEGACY_PREVIEW_KV,
  assertPreviewNamespace,
  namespaceTitle,
  parsePr,
  findNamespace,
  ensureGateway,
  deletePreview,
} from "../scripts/preview/cloudflare";
import {
  baselineKey,
  baselineValue,
  PreviewKV,
  PreviewStorage,
  SEED_KEY,
  STATUS_KEY,
} from "../scripts/preview/storage";
import {
  assertPullRequest,
  collectPreview,
  failureComment,
  previewConfig,
  readinessComment,
  selectedChannels,
} from "../scripts/preview/workflow";
import { gatewayAi } from "../scripts/preview/ai";
import { emptyDailySnowState } from "@/lib/dailysnow";
import type { ReportResponse } from "@/lib/types";
import { buildReport } from "@/lib/report";

const id = "a".repeat(32);
const namespace = { id, title: namespaceTitle(12) };
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).buffer;
const decode = (value: ArrayBuffer) =>
  JSON.parse(new TextDecoder().decode(value));

/** Cloudflare's KV REST API over two in-memory namespaces; production is read-only. */
function kvApi(production: Record<string, { value: ArrayBuffer; expiration?: number }>) {
  const pr = new Map<string, ArrayBuffer>();
  const writes: Array<{ key: string; expiration: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const isProduction = url.pathname.includes(PRODUCTION_KV);
    if (isProduction && init?.method && init.method !== "GET")
      throw new Error("Production write attempted");
    if (url.pathname.endsWith("/keys"))
      return Response.json({
        success: true,
        result: Object.entries(production).map(([name, { expiration }]) => ({ name, expiration })),
        result_info: {},
      });
    const key = decodeURIComponent(url.pathname.split("/values/")[1]);
    if (init?.method === "PUT") {
      const body = init.body;
      pr.set(key, typeof body === "string" ? (new TextEncoder().encode(body).buffer as ArrayBuffer) : (body as ArrayBuffer));
      writes.push({ key, expiration: url.searchParams.get("expiration") });
      return Response.json({ success: true });
    }
    const value = isProduction ? production[key]?.value : pr.get(key);
    return value ? new Response(value) : new Response("missing", { status: 404 });
  });
  const storage = new PreviewStorage(new Cloudflare("account", "credential", fetchImpl as typeof fetch), namespace, 12);
  return { pr, writes, fetchImpl, storage };
}

describe("preview data built in memory", () => {
  const now = Date.parse("2026-11-07T15:00:00Z");
  const expiration = Math.floor(now / 1000) + 600;
  const image = new Uint8Array([137, 80, 78, 71, 255]).buffer;
  const production = () => ({
    "snapshot:v1": { value: encode({ production: true }) },
    "plume-panel:live": { value: image, expiration },
    "plume-panel:expiring": { value: image, expiration: Math.floor(now / 1000) + 30 },
    ADMIN_TOKEN: { value: encode("secret") },
  });

  it("reads the production baseline before anything is written, then stores it once with the seed marker last", async () => {
    const api = kvApi(production());
    const kv = await PreviewKV.open(api.storage, now);
    expect(api.writes).toEqual([]);
    expect(kv.copied).toBe(2);
    expect(JSON.parse((await kv.get("snapshot:v1", "text"))!)).toEqual({ production: true });
    expect(await kv.get("ADMIN_TOKEN", "text")).toBeNull();
    await kv.put("dailysnow:v1:2026-11-07", "post", { expirationTtl: 3600 });
    await kv.flush({ editions: {} }, now);
    expect(api.writes.map((w) => w.key)).toEqual([
      "snapshot:v1",
      "plume-panel:live",
      "dailysnow:v1:2026-11-07",
      STATUS_KEY,
      SEED_KEY,
    ]);
    expect(api.writes[1].expiration).toBe(String(expiration));
    expect(Number(api.writes[2].expiration)).toBeGreaterThan(Date.now() / 1000 + 3500);
    expect(new Uint8Array(api.pr.get("plume-panel:live")!)).toEqual(new Uint8Array(image));
  });

  it("reuses a seeded namespace and writes only values the run changed", async () => {
    const api = kvApi(production());
    await (await PreviewKV.open(api.storage, now)).flush({}, now);
    api.pr.set("snapshot:v1", encode({ previewEdit: true }));
    api.writes.length = 0;
    const kv = await PreviewKV.open(api.storage, now);
    expect(kv.copied).toBeNull();
    expect(JSON.parse((await kv.get("snapshot:v1", "text"))!)).toEqual({ previewEdit: true });
    await kv.put("snapshot:v1", JSON.stringify({ refreshed: true }));
    await kv.flush({}, now);
    expect(api.writes.map((w) => w.key)).toEqual(["snapshot:v1", STATUS_KEY]);
  });

  it("does not store anything, or mark the namespace seeded, when the production read fails", async () => {
    const api = kvApi(production());
    api.fetchImpl.mockImplementation(async (input) =>
      String(input).includes("/keys")
        ? Response.json({ success: true, result: [{ name: "snapshot:v1" }], result_info: {} })
        : String(input).includes(PRODUCTION_KV)
          ? new Response("unavailable", { status: 503 })
          : new Response("missing", { status: 404 }),
    );
    await expect(PreviewKV.open(api.storage, now)).rejects.toThrow(/503/);
    expect(api.writes).toEqual([]);
  });

  it("keeps production's snow history when a new PR's first refresh fails every source", async () => {
    // PR #27 lost Alta's history: the refresh read an empty snapshot and wrote over the copy.
    const alta = { state: "reported", valueIn: 1, label: "24 Hour", windowEnd: "2026-11-05T08:00:00Z", collectedAt: "2026-11-05T14:00:00Z" };
    const api = kvApi({
      "snapshot:v1": {
        value: encode({ schemaVersion: 1, writtenAt: "2026-11-07T14:00:00Z", sources: {}, snowLog: { resorts: { alta: { "2026-11-05": alta } }, forecasts: {} } }),
      },
    });
    const kv = await PreviewKV.open(api.storage, now);
    const { status } = await collectPreview({
      kv,
      sha: "abcdef123456",
      channels: [],
      now: () => new Date(now),
      fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    await kv.flush(status, now);
    const stored = decode(api.pr.get("snapshot:v1")!);
    expect(stored.snowLog.resorts.alta["2026-11-05"]).toEqual(alta);
    expect(status.sourceFailures.length).toBeGreaterThan(0);
    expect(status.refreshedSha).toBe("abcdef123456");
  });

  it("requires Workers AI before generating a channel", async () => {
    const kv = await PreviewKV.open(kvApi(production()).storage, now);
    await expect(
      collectPreview({ kv, sha: "abc", channels: ["utah"], now: () => new Date(now), fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch }),
    ).rejects.toThrow(/Workers AI/);
  });
});

describe("preview Workers AI over REST", () => {
  it("returns the binding-shaped result through the preview gateway without caching", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ success: true, result: { response: "{}" } }));
    const ai = gatewayAi("account", "credential", "mitchells-snow-report-preview", fetchImpl as typeof fetch);
    expect(await ai.run("@cf/zai-org/glm-5.3-flash", { messages: [] })).toEqual({ response: "{}" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/zai-org/glm-5.3-flash");
    expect(new Headers(init.headers).get("cf-aig-gateway-id")).toBe("mitchells-snow-report-preview");
    expect(new Headers(init.headers).get("cf-aig-skip-cache")).toBe("true");
  });

  it("surfaces the HTTP status and API errors", async () => {
    const ai = gatewayAi("account", "credential", "gateway", (async () =>
      Response.json({ success: false, errors: [{ message: "rate limited" }] }, { status: 429 })) as typeof fetch);
    await expect(ai.run("model", {})).rejects.toThrow(/HTTP 429.*rate limited/);
  });
});

describe("closed-PR preview deletion", () => {
  it("deletes only the PR's own Preview and accepts one that is already gone", async () => {
    const mock = vi.fn(async () => Response.json({ success: true }));
    expect(await deletePreview(new Cloudflare("account", "test-token", mock), 18)).toBe(true);
    expect(String((mock.mock.calls[0] as unknown[])[0])).toMatch(/\/workers\/workers\/mitchells-snow-report-preview\/previews\/pr-18$/);
    const absent = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await deletePreview(new Cloudflare("account", "test-token", absent), 18)).toBe(false);
  });

  it.each([401, 403, 429, 500])("propagates HTTP %i instead of reporting the Preview removed", async (status) => {
    const mock = vi.fn(async () => Response.json({ errors: [{ code: 1, message: "API failure" }] }, { status }));
    await expect(deletePreview(new Cloudflare("account", "test-token", mock), 18)).rejects.toThrow(`HTTP ${status}`);
    expect(mock).toHaveBeenCalledOnce();
  });
});

describe("preview AI quota", () => {
  it("accepts the separate preview gateway's 1,000-request sliding-day limit", async () => {
    const cf = new Cloudflare("account", "test-token", (async () => Response.json({
      success: true,
      result: { rate_limiting_limit: 1000, rate_limiting_interval: 86400, rate_limiting_technique: "sliding" },
    })) as typeof fetch);
    await expect(ensureGateway(cf)).resolves.toBeUndefined();
  });

  it("provisions a missing preview gateway at 1,000 requests without touching production", async () => {
    let created: Record<string, unknown> | undefined;
    const cf = new Cloudflare("account", "test-token", (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") {
        expect(path).toBe("/client/v4/accounts/account/ai-gateway/gateways");
        created = JSON.parse(String(init.body));
        return Response.json({ success: true });
      }
      expect(path).toBe("/client/v4/accounts/account/ai-gateway/gateways/mitchells-snow-report-preview");
      return created ? Response.json({ success: true, result: created }) : new Response(null, { status: 404 });
    }) as typeof fetch);
    await ensureGateway(cf);
    expect(created).toMatchObject({ id: "mitchells-snow-report-preview", rate_limiting_limit: 1000 });
  });
});

describe("preview storage ownership and baseline", () => {
  it("refuses production, shared preview and mismatched PR namespaces", () => {
    for (const n of [
      { ...namespace, id: PRODUCTION_KV },
      { ...namespace, id: LEGACY_PREVIEW_KV },
      { ...namespace, title: namespaceTitle(13) },
    ])
      expect(() => assertPreviewNamespace(n, 12)).toThrow(/Refusing/);
    expect(() => assertPreviewNamespace(namespace, 12)).not.toThrow();
    for (const value of [
      undefined,
      "0",
      "-1",
      "12abc",
      "1/../2",
      "99999999999999999999999",
    ])
      expect(() => parsePr(value)).toThrow();
  });
  it("copies only known application content and resets inherited attempt bookkeeping", () => {
    expect(baselineKey("ADMIN_TOKEN")).toBe(false);
    expect(baselineKey("preview-workflow:status:v1")).toBe(false);
    expect(baselineKey("channel:v1:unknown:dailysnow:v1:2026-11-05")).toBe(
      false,
    );
    expect(
      baselineKey("channel:v1:utah:dailysnow-fig:v2:date:id:revision"),
    ).toBe(true);
    const state = {
      ...emptyDailySnowState(),
      current: { title: "Existing edition" },
      history: [{ date: "2026-11-05" }],
      attempts: { date: "2026-11-05", count: 3, calls: 6 },
      lastAttemptAt: "today",
      lastError: "old failure",
    };
    const copied = decode(baselineValue("daily-state:v2:utah", encode(state)));
    expect(copied.current).toEqual(state.current);
    expect(copied.history).toEqual(state.history);
    expect(copied.attempts).toEqual(emptyDailySnowState().attempts);
    expect(copied.lastError).toBeNull();
    expect(copied.lastAttemptAt).toBeNull();
  });
  it("finds namespaces beyond the first page rather than creating duplicates", async () => {
    const cf = new Cloudflare("account", "credential", (async (input) => {
      const second = new URL(String(input)).searchParams.get("page") === "2";
      return Response.json({
        success: true,
        result: second ? [namespace] : [{ id: "other", title: "other" }],
        result_info: { total_pages: 2 },
      });
    }) as typeof fetch);
    expect(await findNamespace(cf, 12, true)).toEqual(namespace);
  });
});

it("requires an open same-repository PR at the exact checked-out head", () => {
  const pr = {
    state: "open",
    head: {
      sha: "head",
      repo: { full_name: "huang-labs/mitchells-snow-report" },
    },
  };
  expect(() => assertPullRequest(pr, "head")).not.toThrow();
  expect(() => assertPullRequest(pr, "old-head")).toThrow();
  expect(() => assertPullRequest({ ...pr, state: "closed" }, "head")).toThrow();
  expect(() =>
    assertPullRequest({ ...pr, head: { ...pr.head, repo: null } }),
  ).toThrow();
});

it("orders all regions before Western and rejects unknown channels", () => {
  expect(selectedChannels("none")).toEqual([]);
  expect(selectedChannels("all").at(-1)).toBe("western-us");
  expect(selectedChannels("all")).toHaveLength(9);
  expect(() => selectedChannels("bogus")).toThrow();
});

it("never carries production bindings, routes, secrets or crons into generated preview config", () => {
  const base = unstable_readConfig({ config: "wrangler.jsonc" });
  const config = previewConfig(base, id);
  expect(config.routes).toEqual([]);
  expect(config.triggers.crons).toEqual([]);
  expect(config.vars.AI_ENABLED).toBe("false");
  expect(config.previews).not.toHaveProperty("ai");
  expect(JSON.stringify(config)).not.toContain(PRODUCTION_KV);
  expect(JSON.stringify(config)).not.toContain(LEGACY_PREVIEW_KV);
  expect(JSON.stringify(config)).not.toContain("ADMIN_TOKEN");
  expect(config).not.toHaveProperty("ai");
});

it("distinguishes baseline articles from regenerated ones and surfaces source failures in the PR comment", () => {
  const report = {
    ...buildReport(null),
    dailySnows: {
      utah: { generatedAt: "today", date: "2026-11-05", model: "model" },
      tahoe: { generatedAt: "yesterday", date: "2026-11-04", model: "model" },
    },
  } as ReportResponse;
  const body = readinessComment(
    12,
    "abcdef123456",
    {
      sourceFailures: ["nws: HTTP 503"],
      refreshedAt: "now",
      editions: { utah: { sha: "abcdef123456", generatedAt: "today" } },
    },
    report,
  );
  expect(body).toContain("Production baseline");
  expect(body).toContain("PR commit abcdef1");
  expect(body).toContain("nws: HTTP 503");
  expect(body).toContain("No edition");
  expect(failureComment(12, "abcdef123456", new Error("KV `down`\nretry"))).toContain(
    "**Preview update for `abcdef1` failed:** KV  down  retry",
  );
});

it("waits for a newly created namespace to accept the first baseline write", async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts++;
      return attempts < 3
        ? Response.json(
            {
              success: false,
              errors: [
                {
                  code: 10013,
                  message: "get namespace: 'namespace not found'",
                },
              ],
            },
            { status: 404 },
          )
        : Response.json({ success: true });
    });
    const storage = new PreviewStorage(
      new Cloudflare("account", "credential", fetchImpl as typeof fetch),
      namespace,
      12,
    );
    const assertion = expect(
      storage.put(
        "plume-panel:first",
        new Uint8Array([137, 80, 78, 71]).buffer,
      ),
    ).resolves.toBeUndefined();
    await Promise.all([assertion, vi.runAllTimersAsync()]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("stops namespace readiness retries after five delays", async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          success: false,
          errors: [
            { code: 10013, message: "get namespace: 'namespace not found'" },
          ],
        },
        { status: 404 },
      ),
    );
    const storage = new PreviewStorage(
      new Cloudflare("account", "credential", fetchImpl as typeof fetch),
      namespace,
      12,
    );
    const outcome = storage.put("plume-panel:first", "bytes").then(
      () => null,
      (error) => error,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  [403, 10013, "namespace not found"],
  [404, 10009, "key not found"],
  [404, 10013, "a different resource is missing"],
  [429, 10013, "namespace not found"],
])(
  "does not retry unrelated KV failure HTTP %s / code %s",
  async (status, code, message) => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { success: false, errors: [{ code, message }] },
        { status },
      ),
    );
    const storage = new PreviewStorage(
      new Cloudflare("account", "credential", fetchImpl as typeof fetch),
      namespace,
      12,
    );
    await expect(storage.put("plume-panel:first", "bytes")).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  },
);
