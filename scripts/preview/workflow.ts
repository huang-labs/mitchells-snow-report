import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { CHANNELS, type ChannelId } from "../../src/lib/catalog";
import { SOURCES } from "../../src/lib/sources";
import type { CollectSummary } from "../../src/lib/collect";
import type { ReportResponse } from "../../src/lib/types";
import {
  Cloudflare,
  REPOSITORY,
  PREVIEW_WORKER,
  PREVIEW_GATEWAY,
  previewName,
  previewOrigin,
  runnerName,
  deletePreview,
  ensureGateway,
} from "./cloudflare";
import { PreviewStorage, STATUS_KEY } from "./storage";

export class ReportedPreviewError extends Error {}

export interface PreviewStatus {
  deployedSha?: string;
  refreshedSha?: string;
  refreshedAt?: string;
  sourceFailures: string[];
  editions: Partial<Record<ChannelId, { sha: string; generatedAt: string }>>;
}
export interface PullRequest {
  state: string;
  head: { sha: string; repo: { full_name: string } | null };
}

export async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const token =
    process.env.GH_TOKEN ??
    process.env.GITHUB_TOKEN ??
    execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        ...Object.fromEntries(new Headers(init?.headers)),
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export function assertPullRequest(pr: PullRequest, sha?: string) {
  if (pr.head.repo?.full_name !== REPOSITORY)
    throw new Error("Preview operations require a same-repository PR");
  if (sha && (pr.state !== "open" || pr.head.sha !== sha))
    throw new Error(
      "PR is closed or checkout is not its current head; retry against the latest commit",
    );
}

export function selectedChannels(value: string): ChannelId[] {
  if (value === "none") return [];
  if (value === "all")
    return [
      ...CHANNELS.filter((c) => c.id !== "western-us"),
      CHANNELS.find((c) => c.id === "western-us")!,
    ].map((c) => c.id);
  const channel = CHANNELS.find((c) => c.id === value);
  if (!channel) throw new Error(`Unknown Daily Snow channel: ${value}`);
  return [channel.id];
}

/** Only carry known build settings; production routes, KV, triggers, vars and secrets never spread into this config. */
export function previewConfig(
  base: ReturnType<typeof unstable_readConfig>,
  namespace: string,
  ai: boolean,
) {
  const bindings = {
    define: base.define,
    kv_namespaces: [{ binding: "SNOW_KV", id: namespace }],
    vars: {
      AI_ENABLED: ai ? "true" : "false",
      AI_GATEWAY_ID: PREVIEW_GATEWAY,
      COLLECTOR_CONTACT: "https://mitchells-snow-report.huang.mx",
    },
    ...(ai ? { ai: { binding: "AI" } } : {}),
  };
  return {
    name: PREVIEW_WORKER,
    main: resolve("worker.ts"),
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    alias: { harfbuzzjs: resolve("src/worker/harfbuzz.ts") },
    assets: { ...base.assets, directory: resolve("out") },
    workers_dev: false,
    preview_urls: true,
    routes: [],
    triggers: { crons: [] },
    observability: base.observability,
    ...bindings,
    previews: bindings,
  };
}

export function deploymentUrls(output: string): string[] {
  const entries = output
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          preview_urls?: string[];
          deployment_urls?: string[];
        },
    );
  const deployment = entries.findLast((e) => e.type === "preview");
  // Pin writes to this deployment; a recreated stable alias can briefly route to a deleted version.
  const urls = [
    ...new Set([
      ...(deployment?.deployment_urls ?? []),
      ...(deployment?.preview_urls ?? []),
    ]),
  ];
  if (
    !urls?.length ||
    urls.some((url) => {
      const u = new URL(url);
      return (
        u.protocol !== "https:" ||
        !u.hostname.endsWith(".huang-inc.workers.dev")
      );
    })
  )
    throw new Error("Missing or unexpected Wrangler preview URL");
  return urls;
}

export function deployPreview(
  pr: number,
  sha: string,
  namespace: string,
  runner: boolean,
  ai: boolean,
  secret?: string,
): string[] {
  const temp = mkdtempSync(join(tmpdir(), "snow-preview-"));
  try {
    const config = join(temp, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify(
        previewConfig(
          unstable_readConfig({ config: "wrangler.jsonc" }),
          namespace,
          ai,
        ),
      ),
    );
    const output = join(temp, "output.json");
    const args = [
      "wrangler",
      "preview",
      "--config",
      config,
      "--worker-name",
      PREVIEW_WORKER,
      "--name",
      runner ? runnerName(pr) : previewName(pr),
      "--ignore-base-config",
      "--tag",
      sha.slice(0, 7),
    ];
    if (secret) {
      const secrets = join(temp, "secrets.json");
      writeFileSync(secrets, JSON.stringify({ ADMIN_TOKEN: secret }), {
        mode: 0o600,
      });
      args.push("--secrets-file", secrets);
    }
    execFileSync("npx", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      env: {
        ...process.env,
        WRANGLER_OUTPUT_FILE_PATH: output,
        WRANGLER_SEND_METRICS: "false",
      },
    });
    return deploymentUrls(readFileSync(output, "utf8"));
  } catch (error) {
    // execFileSync errors include command output, which is useful for bundling/auth diagnosis.
    if (error && typeof error === "object" && "stderr" in error)
      console.error(String(error.stderr));
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export interface RunnerHooks {
  deploy(secret: string): Promise<string[]>;
  remove(): Promise<void>;
  collect(
    url: string,
    secret: string,
    channel?: ChannelId,
  ): Promise<CollectSummary>;
  report(url: string): Promise<ReportResponse>;
  revoked(url: string, secret: string): Promise<void>;
}

async function waitForReport(
  load: () => Promise<ReportResponse>,
): Promise<ReportResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      if (attempt === 15) throw error;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

/** Cleanup is mandatory even on failed inference, timeouts, verification errors or partial deployment. */
export async function withRunner(
  hooks: RunnerHooks,
  channels: ChannelId[],
  status: PreviewStatus,
  sha: string,
  refreshSources = true,
) {
  const secret = randomBytes(32).toString("hex");
  let urls: string[] = [];
  const failures: string[] = [];
  try {
    urls = await hooks.deploy(secret);
    // Use the immutable deployment URL and wait for routing propagation before any POST.
    await waitForReport(() => hooks.report(urls[0]));
    if (refreshSources) {
      const refresh = await hooks.collect(urls[0], secret);
      status.refreshedAt = refresh.startedAt;
      status.refreshedSha = sha;
      status.sourceFailures = refresh.results
        .filter((r) => !r.ok)
        .map((r) => `${r.id}: ${r.error ?? "failed"}`);
    }
    for (const channel of channels) {
      const result = await hooks.collect(urls[0], secret, channel);
      const outcome = result.publications?.find((p) => p.channel === channel);
      if (!outcome?.published || outcome.error) {
        failures.push(
          `${channel}: ${outcome?.error ?? outcome?.skipped ?? "not published"}`,
        );
        continue;
      }
      let report = await hooks.report(urls[0]);
      for (
        let attempt = 0;
        attempt < 12 &&
        (!report.dailySnows?.[channel] ||
          Date.parse(report.dailySnows[channel]!.generatedAt) <
            Date.parse(result.startedAt));
        attempt++
      ) {
        await new Promise((r) => setTimeout(r, 5_000));
        report = await hooks.report(urls[0]);
      }
      const post = report.dailySnows?.[channel];
      if (!post || Date.parse(post.generatedAt) < Date.parse(result.startedAt))
        throw new Error(`${channel}: publication not visible in report yet`);
      status.editions[channel] = { sha, generatedAt: post.generatedAt };
    }
  } finally {
    await hooks.remove();
    for (const url of urls) await hooks.revoked(url, secret);
  }
  return failures;
}

export function collectionUrl(
  origin: string,
  channel?: ChannelId,
  sourceIds: string[] = SOURCES.map((s) => s.id),
) {
  const url = new URL("/api/admin/collect", origin);
  if (channel) {
    url.searchParams.set("dailysnow", "force");
    url.searchParams.set("channel", channel);
  } else {
    // Explicit source selection bypasses cadence; AI is separately disabled on this request's runner.
    for (const id of sourceIds) url.searchParams.append("source", id);
  }
  return url;
}

export function readinessComment(
  pr: number,
  sha: string,
  status: PreviewStatus,
  report: ReportResponse,
  generationFailures: string[] = [],
) {
  const safe = (s: string) => s.replace(/[|`\r\n]/g, " ");
  const freshness = Object.entries(report.sources)
    .filter(([, source]) => source.freshness !== "current")
    .map(([id, source]) => `${id}: ${source.freshness}`);
  const rows = CHANNELS.map((c) => {
    const post = report.dailySnows?.[c.id];
    const edition = status.editions[c.id];
    const origin =
      edition && edition.generatedAt === post?.generatedAt
        ? `PR commit ${edition.sha.slice(0, 7)}`
        : "Production baseline";
    return `| ${c.name} | ${post?.date ?? "No edition"} | ${post?.generatedAt ?? "—"} | ${safe(post?.model ?? "—")} | ${post ? origin : "Not generated"} |`;
  });
  return `### Preview\n\n${previewOrigin(pr)}\n\nRequested commit: \`${sha.slice(0, 7)}\`. Deployed commit: \`${status.deployedSha?.slice(0, 7) ?? "not deployed"}\`. Each PR has its own KV; no preview cron runs.\n\nSource collection: **${status.refreshedAt ?? "not run"}**, using \`${status.refreshedSha?.slice(0, 7) ?? "unknown"}\`. Upstream report times are preserved.\n\nSnapshot: ${report.snapshotWrittenAt ?? "missing"}. ${freshness.length ? `**Non-current data:** ${freshness.join(", ")}.` : "All sources are current."}\n\n${status.sourceFailures.length ? `**Source refresh failures:**\n${status.sourceFailures.map((s) => `- ${safe(s)}`).join("\n")}` : "All requested source fetches succeeded."}\n\n${report.requiredMissing.length ? `**Missing required data:** ${report.requiredMissing.join(", ")}.\n\n` : ""}| Daily Snow | Edition date | Posted at | Model | Generated with |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n${generationFailures.length ? `**Generation failures/skips:**\n${generationFailures.map((s) => `- ${safe(s)}`).join("\n")}\n\n` : ""}Source refreshes do not regenerate AI articles. Use \`npm run preview:dailysnow -- --pr ${pr} --channel western-us\` (or \`--all\`) for this PR's code.\n`;
}

export async function comment(pr: number, body: string) {
  let existing: { id: number } | undefined;
  for (let page = 1; ; page++) {
    const comments = await github<
      Array<{ id: number; user: { login: string }; body: string }>
    >(`/issues/${pr}/comments?per_page=100&page=${page}`);
    existing = comments.find(
      (c) =>
        c.user.login === "github-actions[bot]" &&
        c.body.startsWith("### Preview\n"),
    );
    if (existing || comments.length < 100) break;
  }
  await github(
    existing ? `/issues/comments/${existing.id}` : `/issues/${pr}/comments`,
    { method: existing ? "PATCH" : "POST", body: JSON.stringify({ body }) },
  );
}

export async function runPreview(
  cf: Cloudflare,
  storage: PreviewStorage,
  pr: number,
  sha: string,
  channels: ChannelId[],
) {
  const status = (await storage.json<PreviewStatus>(STATUS_KEY)) ?? {
    sourceFailures: [],
    editions: {},
  };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report = async (url: string) => {
    const response = await fetch(new URL("/api/report", url), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Preview report HTTP ${response.status}`);
    return response.json() as Promise<ReportResponse>;
  };
  if (channels.length) await ensureGateway(cf);
  await deletePreview(cf, runnerName(pr)); // Remove abandoned runs before creating any secret-bearing version.
  let failures: string[] = [];
  try {
    // Refresh on an AI-disabled runner first; generation uses a separate deployment after fresh sources are stored.
    await withRunner(
      {
        deploy: async (secret) =>
          deployPreview(pr, sha, storage.namespace.id, true, false, secret),
        remove: () => deletePreview(cf, runnerName(pr)),
        report,
        collect: async (url, secret) => {
          const sourceIds = Object.keys((await report(url)).sources);
          const response = await fetch(
            collectionUrl(url, undefined, sourceIds),
            {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}` },
              signal: AbortSignal.timeout(120_000),
            },
          );
          if (!response.ok)
            throw new Error(`Preview collection HTTP ${response.status}`);
          return response.json() as Promise<CollectSummary>;
        },
        revoked: async (url, secret) => verifyRevoked(url, secret),
      },
      [],
      status,
      sha,
    );
    if (channels.length) {
      failures = await withRunner(
        {
          deploy: async (secret) =>
            deployPreview(pr, sha, storage.namespace.id, true, true, secret),
          remove: () => deletePreview(cf, runnerName(pr)),
          report,
          collect: async (url, secret, channel) => {
            if (!channel)
              throw new Error("Generation requires an explicit channel");
            const response = await fetch(collectionUrl(url, channel), {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}` },
              signal: AbortSignal.timeout(11 * 60_000),
            });
            if (!response.ok)
              throw new Error(`Preview generation HTTP ${response.status}`);
            return response.json() as Promise<CollectSummary>;
          },
          revoked: async (url, secret) => verifyRevoked(url, secret),
        },
        channels,
        status,
        sha,
        false,
      );
    }
  } finally {
    await storage.put(STATUS_KEY, JSON.stringify(status));
  }
  assertPullRequest(await github<PullRequest>(`/pulls/${pr}`), sha);
  deployPreview(pr, sha, storage.namespace.id, false, false);
  status.deployedSha = sha;
  await storage.put(STATUS_KEY, JSON.stringify(status));
  let current = await waitForReport(() => report(previewOrigin(pr)));
  // Snapshot and channel states propagate separately; verify newly regenerated editions too.
  const expected = channels.filter(
    (c) =>
      status.editions[c]?.sha === sha &&
      Date.parse(status.editions[c]!.generatedAt) >=
        Date.parse(status.refreshedAt!),
  );
  const pending = () =>
    (status.refreshedAt &&
      (!current.snapshotWrittenAt ||
        Date.parse(current.snapshotWrittenAt) <
          Date.parse(status.refreshedAt))) ||
    expected.some(
      (c) =>
        current.dailySnows?.[c]?.generatedAt !==
        status.editions[c]!.generatedAt,
    );
  for (let attempt = 0; pending(); attempt++) {
    if (attempt === 12)
      throw new Error(
        "Preview snapshot or regenerated editions have not propagated; refresh readiness after KV propagation",
      );
    await delay(5_000);
    current = await report(previewOrigin(pr));
  }
  if (
    (
      await fetch(new URL("/api/admin/collect", previewOrigin(pr)), {
        method: "POST",
      })
    ).status !== 404
  )
    throw new Error("Public PR preview unexpectedly exposes admin access");
  await comment(pr, readinessComment(pr, sha, status, current, failures));
  if (failures.length || current.requiredMissing.length)
    throw new ReportedPreviewError(
      "Preview deployed with data failures; see the PR readiness comment",
    );
  return previewOrigin(pr);
}

export async function revokedResponse(response: Response): Promise<boolean> {
  if (response.status === 404 || response.status === 410) return true;
  // Cloudflare currently serves deleted Preview deployments as 1101 rather than 404.
  // This is accepted only after the control plane has confirmed the entire Preview is absent.
  return (
    response.status === 500 &&
    response.headers.get("x-preview-user-error") === "true" &&
    /<span class="cf-error-code">1101<\/span>/.test(await response.text())
  );
}

async function verifyRevoked(url: string, secret: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(new URL("/api/admin/collect", url), {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (await revokedResponse(response)) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    "Deleted runner URL still responds; verify immutable deployment revocation",
  );
}
