import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  PreviewStorage,
  SEED_KEY,
} from "../scripts/preview/storage";
import {
  assertPullRequest,
  collectionUrl,
  deploymentUrls,
  previewConfig,
  readinessComment,
  revokedResponse,
  selectedChannels,
  withRunner,
  type PreviewStatus,
  type RunnerHooks,
} from "../scripts/preview/workflow";
import { emptyDailySnowState } from "@/lib/dailysnow";
import type { ReportResponse } from "@/lib/types";
import type { CollectSummary } from "@/lib/collect";
import { buildReport } from "@/lib/report";

const id = "a".repeat(32);
const namespace = { id, title: namespaceTitle(12) };
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).buffer;
const decode = (value: ArrayBuffer) =>
  JSON.parse(new TextDecoder().decode(value));

describe("preview deletion propagation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a deleted temporary runner to disappear from the control plane", async () => {
    const methods: string[] = [];
    let reads = 0;
    const cf = new Cloudflare("account", "test-token", (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "DELETE") return Response.json({ success: true });
      return ++reads <= 2
        ? Response.json({ success: true, result: { id: "seed-pr-18" } })
        : new Response(null, { status: 404 });
    }) as typeof fetch);
    await Promise.all([
      expect(deletePreview(cf, "seed-pr-18")).resolves.toBeUndefined(),
      vi.runAllTimersAsync(),
    ]);
    expect(methods).toEqual(["DELETE", "GET", "GET", "GET"]);
  });

  it("fails after bounded checks when deletion never becomes visible", async () => {
    const mock = vi.fn(async () => Response.json({ success: true }));
    const cf = new Cloudflare("account", "test-token", mock);
    await Promise.all([
      expect(deletePreview(cf, "seed-pr-18")).rejects.toThrow(/still exists after deletion/),
      vi.runAllTimersAsync(),
    ]);
    expect(mock).toHaveBeenCalledTimes(13); // One DELETE, twelve GETs.
  });

  it("accepts an already absent preview without polling", async () => {
    const mock = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(deletePreview(new Cloudflare("account", "test-token", mock), "seed-pr-18")).resolves.toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 500])("propagates HTTP %i without retrying or claiming cleanup succeeded", async (status) => {
    const mock = vi.fn(async (_input, init?: RequestInit) => init?.method === "DELETE"
      ? Response.json({ success: true })
      : Response.json({ errors: [{ code: 1, message: "API failure" }] }, { status }));
    const cf = new Cloudflare("account", "test-token", mock);
    await expect(deletePreview(cf, "seed-pr-18")).rejects.toThrow(`HTTP ${status}`);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
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
  it("copies binary stills with their expiry, resumes existing preview values, paginates, and seeds only once", async () => {
    const values = new Map<string, ArrayBuffer>([
      ["snapshot:v1", encode({ previewEdit: true })],
    ]);
    const writes: Array<{ key: string; expiration: string | null }> = [];
    const now = Date.now();
    const expiration = Math.floor(now / 1000) + 600;
    const image = new Uint8Array([137, 80, 78, 71, 255]).buffer;
    const mock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const production = url.pathname.includes(PRODUCTION_KV);
        if (production && init?.method && init.method !== "GET")
          throw new Error("Production write attempted");
        if (url.pathname.endsWith("/keys"))
          return Response.json({
            success: true,
            result: url.searchParams.get("cursor")
              ? [
                  { name: "ADMIN_TOKEN" },
                  { name: "plume-panel:expired", expiration: expiration - 600 },
                ]
              : [
                  { name: "snapshot:v1" },
                  { name: "plume-panel:live", expiration },
                ],
            result_info: {
              cursor: url.searchParams.get("cursor") ? "" : "next",
            },
          });
        const key = decodeURIComponent(url.pathname.split("/values/")[1]);
        if (production)
          return new Response(
            key === "snapshot:v1" ? encode({ production: true }) : image,
          );
        if (init?.method === "PUT") {
          const body = init.body;
          values.set(
            key,
            typeof body === "string"
              ? new TextEncoder().encode(body).buffer
              : (body as ArrayBuffer),
          );
          writes.push({ key, expiration: url.searchParams.get("expiration") });
          return Response.json({ success: true });
        }
        return values.has(key)
          ? new Response(values.get(key))
          : new Response("missing", { status: 404 });
      },
    );
    const storage = new PreviewStorage(
      new Cloudflare("account", "credential", mock as typeof fetch),
      namespace,
      12,
    );
    expect(await storage.seed(now)).toBe(1);
    expect(decode(values.get("snapshot:v1")!)).toEqual({ previewEdit: true });
    expect(new Uint8Array(values.get("plume-panel:live")!)).toEqual(
      new Uint8Array(image),
    );
    expect(writes).toEqual([
      { key: "plume-panel:live", expiration: String(expiration) },
      { key: SEED_KEY, expiration: null },
    ]);
    expect(await storage.seed(now)).toBe(0);
  });
  it("does not commit a seed marker after a failed copy", async () => {
    const paths: string[] = [];
    const cf = new Cloudflare("account", "credential", (async (input, init) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("/keys?"))
        return Response.json({
          success: true,
          result: [{ name: "snapshot:v1" }],
          result_info: {},
        });
      if (url.includes(PRODUCTION_KV))
        return new Response("unavailable", { status: 503 });
      if (!init?.method) return new Response("missing", { status: 404 });
      return Response.json({ success: true });
    }) as typeof fetch);
    await expect(new PreviewStorage(cf, namespace, 12).seed()).rejects.toThrow(
      /503/,
    );
    expect(
      paths.filter((p) => decodeURIComponent(p).includes(SEED_KEY)),
    ).toHaveLength(1); // only initial GET
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

describe("temporary runner orchestration", () => {
  const summary: CollectSummary = {
    startedAt: "2026-11-05T15:00:00Z",
    durationMs: 1,
    results: [{ id: "nws", ok: true, ms: 1 }],
    skipped: [],
  };
  const status = (): PreviewStatus => ({ sourceFailures: [], editions: {} });
  function hooks(): RunnerHooks {
    return {
      deploy: vi.fn(async () => [
        "https://alias.example",
        "https://immutable.example",
      ]),
      remove: vi.fn(async () => {}),
      collect: vi.fn(async () => summary),
      report: vi.fn(async () => buildReport(null)),
      revoked: vi.fn(async () => {}),
    };
  }
  it("refreshes without any forced channel, then revokes every returned runner URL", async () => {
    const h = hooks(),
      s = status();
    await withRunner(h, [], s, "head");
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.collect).mock.calls[0][2]).toBeUndefined();
    expect(s.refreshedSha).toBe("head");
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.revoked).toHaveBeenCalledTimes(2);
  });
  it("removes the runner after collection failure or partial deployment", async () => {
    for (const failure of ["collect", "deploy"] as const) {
      const h = hooks();
      vi.mocked(h[failure]).mockRejectedValueOnce(new Error("timeout"));
      await expect(withRunner(h, [], status(), "head")).rejects.toThrow(
        /timeout/,
      );
      expect(h.remove).toHaveBeenCalledOnce();
    }
  });
  it("reports caps/skips without retrying or resetting channel state", async () => {
    const h = hooks(),
      s = status();
    vi.mocked(h.collect).mockResolvedValue({
      ...summary,
      publications: [{ channel: "utah", skipped: "channel daily cap" }],
    });
    expect(await withRunner(h, ["utah"], s, "head", false)).toEqual([
      "utah: channel daily cap",
    ]);
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(s.editions).toEqual({});
    expect(h.remove).toHaveBeenCalledOnce();
  });
  it("records commit provenance only after seeing a newly published edition", async () => {
    const h = hooks(),
      s = status();
    vi.mocked(h.collect).mockResolvedValue({
      ...summary,
      publications: [{ channel: "utah", published: "2026-11-05" }],
    });
    vi.mocked(h.report).mockResolvedValue({
      ...buildReport(null),
      dailySnows: { utah: { generatedAt: summary.startedAt } },
    } as ReportResponse);
    await withRunner(h, ["utah"], s, "head", false);
    expect(s.editions.utah).toEqual({
      sha: "head",
      generatedAt: summary.startedAt,
    });
  });
  it("propagates cleanup failures rather than claiming that temporary access is closed", async () => {
    const h = hooks();
    vi.mocked(h.remove).mockRejectedValue(new Error("delete forbidden"));
    await expect(withRunner(h, [], status(), "head")).rejects.toThrow(
      /delete forbidden/,
    );
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

it("uses an explicit source list for refresh and forces only the chosen generation channel", () => {
  const refresh = collectionUrl("https://preview.example");
  expect(refresh.searchParams.getAll("source")).toContain("nws");
  expect(refresh.searchParams.has("dailysnow")).toBe(false);
  const generate = collectionUrl("https://preview.example", "western-us");
  expect(generate.searchParams.get("channel")).toBe("western-us");
  expect(generate.searchParams.get("dailysnow")).toBe("force");
  expect(selectedChannels("all").at(-1)).toBe("western-us");
  expect(selectedChannels("all")).toHaveLength(9);
  expect(() => selectedChannels("bogus")).toThrow();
});

it("never carries production bindings, routes, secrets or crons into generated preview config", () => {
  const base = unstable_readConfig({ config: "wrangler.jsonc" });
  const config = previewConfig(base, id, false);
  expect(config.routes).toEqual([]);
  expect(config.triggers.crons).toEqual([]);
  expect(config.vars.AI_ENABLED).toBe("false");
  expect(config.previews).not.toHaveProperty("ai");
  expect(JSON.stringify(config)).not.toContain(PRODUCTION_KV);
  expect(JSON.stringify(config)).not.toContain(LEGACY_PREVIEW_KV);
  expect(JSON.stringify(config)).not.toContain("ADMIN_TOKEN");
  expect(previewConfig(base, id, true).previews.ai).toEqual({ binding: "AI" });
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
});

it("recognizes deleted Preview responses without accepting an arbitrary server error as revocation", async () => {
  expect(await revokedResponse(new Response(null, { status: 404 }))).toBe(true);
  expect(
    await revokedResponse(
      new Response('<span class="cf-error-code">1101</span>', {
        status: 500,
        headers: { "x-preview-user-error": "true" },
      }),
    ),
  ).toBe(true);
  expect(
    await revokedResponse(
      new Response("Database unavailable", { status: 500 }),
    ),
  ).toBe(false);
  expect(
    await revokedResponse(new Response("Method not allowed", { status: 405 })),
  ).toBe(false);
});

it("waits for the deployed runner's report before sending any write request", async () => {
  let ready!: (report: ReportResponse) => void;
  const report = new Promise<ReportResponse>((resolve) => {
    ready = resolve;
  });
  const collect = vi.fn(async () => ({
    startedAt: "now",
    durationMs: 0,
    results: [],
    skipped: [],
  }));
  const operation = withRunner(
    {
      deploy: async () => ["https://immutable.example"],
      remove: async () => {},
      revoked: async () => {},
      report: async () => report,
      collect,
    },
    [],
    { sourceFailures: [], editions: {} },
    "head",
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(collect).not.toHaveBeenCalled();
  ready(buildReport(null));
  await operation;
  expect(collect).toHaveBeenCalledOnce();
});

it("prefers the immutable deployment URL for writes and tracks both URL types for cleanup", () => {
  const alias = "https://seed-pr-12-report.huang-inc.workers.dev";
  const immutable = "https://revision-seed-pr-12-report.huang-inc.workers.dev";
  expect(
    deploymentUrls(
      JSON.stringify({
        type: "preview",
        preview_urls: [alias],
        deployment_urls: [immutable, alias],
      }),
    ),
  ).toEqual([immutable, alias]);
  expect(() =>
    deploymentUrls(
      JSON.stringify({
        type: "preview",
        preview_urls: ["https://unrelated.example"],
      }),
    ),
  ).toThrow(/unexpected/);
  expect(() => deploymentUrls(JSON.stringify({ type: "other" }))).toThrow(
    /Missing/,
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
