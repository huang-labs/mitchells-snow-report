import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { CHANNELS, type ChannelId } from "../../src/lib/catalog";
import { SOURCES } from "../../src/lib/sources";
import type { CollectSummary } from "../../src/lib/collect";
import { readChannelStates } from "../../src/lib/dailysnow/channels";
import type { DailySnowState, ReportResponse, Snapshot } from "../../src/lib/types";
import { SNAPSHOT_KEY } from "../../src/lib/store";
import {
  Cloudflare,
  REPOSITORY,
  PREVIEW_WORKER,
  PREVIEW_GATEWAY,
  previewName,
  previewOrigin,
  ensureGateway,
} from "./cloudflare";
import { PreviewKV, PreviewStorage, STATUS_KEY } from "./storage";

export class ReportedPreviewError extends Error {}

export interface PreviewStatus {
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

/**
 * Only carry known build settings; production routes, KV, triggers and secrets
 * never spread into this config. The Preview runs the same Durable Objects as
 * production in its own namespace, with Workers AI routed through the preview
 * gateway and automatic publication off: only an authenticated forced run
 * generates. The admin token is uploaded separately as a secret.
 */
export function previewConfig(
  base: ReturnType<typeof unstable_readConfig>,
  namespace: string,
) {
  const bindings = {
    define: base.define,
    kv_namespaces: [{ binding: "SNOW_KV", id: namespace }],
    durable_objects: {
      bindings: [
        { name: "COLLECTOR", class_name: "CollectorObject" },
        { name: "CHANNEL", class_name: "ChannelObject" },
      ],
    },
    ai: { binding: "AI" },
    vars: {
      AI_GATEWAY_ID: PREVIEW_GATEWAY,
      DAILY_SNOW_AUTOMATIC: "false",
      COLLECTOR_CONTACT: "https://mitchells-snow-report.huang.mx",
    },
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
    migrations: base.migrations,
    observability: base.observability,
    ...bindings,
    previews: bindings,
  };
}

/**
 * The PR preview's admin token, derived rather than stored: HMAC of the PR
 * number keyed with the deployment token, so every run can recompute it, one
 * PR's token opens no other preview, and deleting the Preview deletes it.
 */
export function previewAdminToken(secret: string, pr: number): string {
  return createHmac("sha256", secret).update(`mitchells-snow-report:preview-admin:pr-${pr}`).digest("hex");
}

/** Upload the built site and Worker as the PR's stable `pr-<number>` Preview. */
export function deployPreview(pr: number, sha: string, namespace: string, adminToken: string) {
  const temp = mkdtempSync(join(tmpdir(), "snow-preview-"));
  try {
    const config = join(temp, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify(
        previewConfig(unstable_readConfig({ config: "wrangler.jsonc" }), namespace),
      ),
    );
    const secrets = join(temp, "secrets.json");
    writeFileSync(secrets, JSON.stringify({ ADMIN_TOKEN: adminToken }), { mode: 0o600 });
    execFileSync(
      "npx",
      [
        "wrangler",
        "preview",
        "--config",
        config,
        "--worker-name",
        PREVIEW_WORKER,
        "--name",
        previewName(pr),
        "--ignore-base-config",
        "--tag",
        sha.slice(0, 7),
        "--secrets-file",
        secrets,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
  } catch (error) {
    // execFileSync errors include command output, which is useful for bundling/auth diagnosis.
    if (error && typeof error === "object" && "stderr" in error)
      console.error(String(error.stderr));
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Authenticated calls to one PR preview's admin endpoints (src/worker/admin.ts). */
export class PreviewWorker {
  constructor(
    readonly origin: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    private wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * A just-deployed Preview can answer 404 (or 5xx) briefly; requests that are
   * safe to repeat retry those for about a minute. GETs retry by default; a POST
   * retries only when the caller says repeating it is harmless (`repeatable`),
   * because a lost response may follow work the Worker already did.
   */
  async json<T>(path: string, init: RequestInit = {}, opts: { repeatable?: boolean } = {}): Promise<T> {
    const repeatable = opts.repeatable ?? (init.method ?? "GET") === "GET";
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${this.origin}${path}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (response.ok) return (await response.json()) as T;
      const retryable = response.status === 404 || response.status >= 500;
      const body = (await response.text().catch(() => "")).slice(0, 300);
      if (!retryable || !repeatable || attempt >= 6)
        throw new Error(`Preview ${init.method ?? "GET"} ${path.split("?")[0]}: HTTP ${response.status} ${body}`);
      await this.wait(10_000);
    }
  }
}

export interface PreviewRun {
  kv: PreviewKV;
  worker: PreviewWorker;
  sha: string;
  channels: ChannelId[];
  /** How often and how long to wait for a forced edition (its alarm runs the model). */
  poll?: { everyMs: number; timeoutMs: number; wait?: (ms: number) => Promise<void> };
}

type ChannelStatus = { state: DailySnowState; pending: boolean };

/**
 * Drive the deployed preview's own Durable Objects, which are the PR data's
 * only writers: seed any that are still empty from the PR namespace (a
 * production baseline on a PR's first run), refresh every branch-defined
 * source, then force each requested channel in order and wait for its alarm to
 * finish. Returns the status to store, generation failures or skips, and the
 * report built from the objects themselves.
 */
export async function refreshPreview(run: PreviewRun) {
  const poll = { everyMs: 15_000, timeoutMs: 16 * 60_000, wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), ...run.poll };
  const status = (await run.kv.json<PreviewStatus>(STATUS_KEY)) ?? { sourceFailures: [], editions: {} };
  const post = (path: string, opts: { body?: unknown; repeatable: boolean }) =>
    run.worker.json<unknown>(path, { method: "POST", ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }, { repeatable: opts.repeatable });

  // Only empty objects take the seed: a Preview's objects outlive its deployments.
  // Repeatable: only empty objects take a seed.
  await post("/api/admin/seed", {
    body: { snapshot: (await run.kv.json<Snapshot>(SNAPSHOT_KEY)) ?? undefined, channels: await readChannelStates(run.kv) },
    repeatable: true,
  });

  // Explicit sources bypass cadence, so every branch-defined source is fetched.
  // Repeatable: a second refresh only fetches the sources again.
  const refresh = (await post(`/api/admin/collect?${SOURCES.map((s) => `source=${s.id}`).join("&")}`, { repeatable: true })) as CollectSummary;
  status.refreshedAt = refresh.startedAt;
  status.refreshedSha = run.sha;
  status.sourceFailures = refresh.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.error ?? "failed"}`);

  const failures: string[] = [];
  for (const channel of run.channels) {
    // Sent once: a retry after a lost response would find this channel's own attempt
    // in flight and report a failure while the edition publishes.
    let forced: CollectSummary;
    try {
      forced = (await post(`/api/admin/collect?dailysnow=force&channel=${channel}`, { repeatable: false })) as CollectSummary;
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const outcome = forced.publications?.find((p) => p.channel === channel);
    if (!outcome?.scheduled) {
      failures.push(`${channel}: ${outcome?.error ?? outcome?.skipped ?? "not scheduled"}`);
      continue;
    }
    // The model runs in the channel's alarm; poll rather than hold a connection open.
    let current: ChannelStatus;
    for (let waited = 0; ; waited += poll.everyMs) {
      current = await run.worker.json<ChannelStatus>(`/api/admin/channel?channel=${channel}`);
      if (!current.pending || current.state.lastAttemptAt !== outcome.scheduled) break;
      if (waited >= poll.timeoutMs) break;
      await poll.wait(poll.everyMs);
    }
    const published = current!.state.current?.generatedAt === outcome.scheduled;
    if (published) status.editions[channel] = { sha: run.sha, generatedAt: outcome.scheduled };
    else
      failures.push(
        `${channel}: ${current!.pending ? `still running after ${Math.round(poll.timeoutMs / 60_000)} min` : (current!.state.lastError ?? "not published")}`,
      );
  }
  const report = await run.worker.json<ReportResponse>("/api/admin/report");
  return { status, failures, report };
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
  return `### Preview\n\n${previewOrigin(pr)}\n\nDeployed commit: \`${sha.slice(0, 7)}\`. Each PR has its own KV; no preview cron runs.\n\nSource collection: **${status.refreshedAt ?? "not run"}**, using \`${status.refreshedSha?.slice(0, 7) ?? "unknown"}\`. Upstream report times are preserved.\n\nSnapshot: ${report.snapshotWrittenAt ?? "missing"}. ${freshness.length ? `**Non-current data:** ${freshness.join(", ")}.` : "All sources are current."}\n\n${status.sourceFailures.length ? `**Source refresh failures:**\n${status.sourceFailures.map((s) => `- ${safe(s)}`).join("\n")}` : "All requested source fetches succeeded."}\n\n${report.requiredMissing.length ? `**Missing required data:** ${report.requiredMissing.join(", ")}.\n\n` : ""}| Daily Snow | Edition date | Posted at | Model | Generated with |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n${generationFailures.length ? `**Generation failures/skips:**\n${generationFailures.map((s) => `- ${safe(s)}`).join("\n")}\n\n` : ""}Source refreshes do not regenerate AI articles. Use \`npm run preview:dailysnow -- --pr ${pr} --channel western-us\` (or \`--all\`) for this PR's code.\n`;
}

export function failureComment(pr: number, sha: string, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[`\r\n]/g, " ")
    .slice(0, 500);
  return `### Preview\n\n${previewOrigin(pr)}\n\n**Preview update for \`${sha.slice(0, 7)}\` failed:** ${message}\n\nThe preview may still show an earlier commit or data; see the Action log.\n`;
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

/**
 * Prepare a PR preview: store a first run's production baseline, deploy the
 * Preview with its admin token, then refresh (and optionally generate) through
 * its own Durable Objects. The PR comment is built from those objects' state.
 */
export async function runPreview(
  cf: Cloudflare,
  storage: PreviewStorage,
  pr: number,
  sha: string,
  channels: ChannelId[],
) {
  if (channels.length) await ensureGateway(cf);
  const kv = await PreviewKV.open(storage);
  // Pushes and dispatches for one PR are serialized; a newer head supersedes this run.
  assertPullRequest(await github<PullRequest>(`/pulls/${pr}`), sha);
  if (kv.copied !== null) {
    console.log(`Seeding from ${kv.copied} production values (production reads only)`);
    // Archives, stills and plume panels are read through KV; the objects get their state from the seed call.
    console.log(`Stored ${await kv.writeChanged()} baseline values`);
  }
  const token = previewAdminToken(cf.token, pr);
  deployPreview(pr, sha, storage.namespace.id, token);
  const { status, failures, report } = await refreshPreview({
    kv,
    worker: new PreviewWorker(previewOrigin(pr), token),
    sha,
    channels,
  });
  // The seed marker comes last: an interrupted first run seeds again next time.
  await kv.finish(status);
  await comment(pr, readinessComment(pr, sha, status, report, failures));
  if (failures.length || report.requiredMissing.length)
    throw new ReportedPreviewError(
      "Preview deployed with data failures; see the PR readiness comment",
    );
  return previewOrigin(pr);
}
