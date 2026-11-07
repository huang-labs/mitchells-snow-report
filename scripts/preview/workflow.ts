import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { CHANNELS, type ChannelId } from "../../src/lib/catalog";
import { SOURCES } from "../../src/lib/sources";
import { runCollection, type CollectorEnv } from "../../src/lib/collect";
import { readChannelStates } from "../../src/lib/dailysnow/channels";
import type { ReportResponse } from "../../src/lib/types";
import { report } from "../../src/worker/report";
import { gatewayAi } from "./ai";
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

/** Only carry known build settings; production routes, KV, triggers, vars, AI and secrets never spread into this config. */
export function previewConfig(
  base: ReturnType<typeof unstable_readConfig>,
  namespace: string,
) {
  const bindings = {
    define: base.define,
    kv_namespaces: [{ binding: "SNOW_KV", id: namespace }],
    vars: {
      AI_ENABLED: "false",
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
    observability: base.observability,
    ...bindings,
    previews: bindings,
  };
}

/** Upload the built site and Worker as the PR's stable `pr-<number>` Preview. */
export function deployPreview(pr: number, sha: string, namespace: string) {
  const temp = mkdtempSync(join(tmpdir(), "snow-preview-"));
  try {
    const config = join(temp, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify(
        previewConfig(unstable_readConfig({ config: "wrangler.jsonc" }), namespace),
      ),
    );
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

export interface PreviewRun {
  kv: PreviewKV;
  sha: string;
  channels: ChannelId[];
  /** Workers AI for explicit generation; required when `channels` is non-empty. */
  ai?: CollectorEnv["AI"];
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/**
 * Refresh every source, then force each requested channel in order, all
 * through the branch's real collection code against the in-memory KV.
 * Returns the status to store and any generation failures or skips.
 */
export async function collectPreview(run: PreviewRun) {
  const now = run.now ?? (() => new Date());
  const status = (await run.kv.json<PreviewStatus>(STATUS_KEY)) ?? {
    sourceFailures: [],
    editions: {},
  };
  const env: CollectorEnv = {
    SNOW_KV: run.kv,
    COLLECTOR_CONTACT: "https://mitchells-snow-report.huang.mx",
    AI_ENABLED: "false",
  };
  // Explicit sources bypass cadence, so every branch-defined source is fetched.
  const refresh = await runCollection(env, {
    now: now(),
    only: SOURCES.map((s) => s.id),
    fetchImpl: run.fetchImpl,
  });
  status.refreshedAt = refresh.startedAt;
  status.refreshedSha = run.sha;
  status.sourceFailures = refresh.results
    .filter((r) => !r.ok)
    .map((r) => `${r.id}: ${r.error ?? "failed"}`);

  const failures: string[] = [];
  if (run.channels.length && !run.ai)
    throw new Error("Generation requires Workers AI");
  const generate: CollectorEnv = {
    ...env,
    AI: run.ai,
    AI_ENABLED: "true",
    AI_GATEWAY_ID: PREVIEW_GATEWAY,
  };
  for (const channel of run.channels) {
    const result = await runCollection(generate, {
      now: now(),
      channel,
      forceDailySnow: true,
      fetchImpl: run.fetchImpl,
    });
    const outcome = result.publications?.find((p) => p.channel === channel);
    const post = (await readChannelStates(run.kv))[channel]?.current;
    if (!outcome?.published || outcome.error || !post) {
      failures.push(
        `${channel}: ${outcome?.error ?? outcome?.skipped ?? "not published"}`,
      );
      continue;
    }
    status.editions[channel] = { sha: run.sha, generatedAt: post.generatedAt };
  }
  return { status, failures };
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
 * Prepare a PR preview: collect into memory, store the result once over REST,
 * then deploy the public preview (no admin token, no AI). The PR comment is
 * built from the stored state, so it doesn't wait for edge propagation.
 */
export async function runPreview(
  cf: Cloudflare,
  storage: PreviewStorage,
  pr: number,
  sha: string,
  channels: ChannelId[],
) {
  // Model calls use a token scoped to Workers AI and Gateway runs, never the deploy token.
  const aiToken = process.env.WORKERS_AI_TOKEN;
  if (channels.length && !aiToken)
    throw new Error("WORKERS_AI_TOKEN is required to generate Daily Snow");
  if (channels.length) await ensureGateway(cf);
  const kv = await PreviewKV.open(storage);
  if (kv.copied !== null)
    console.log(`Seeding from ${kv.copied} production values (production reads only)`);
  const { status, failures } = await collectPreview({
    kv,
    sha,
    channels,
    ai: channels.length
      ? gatewayAi(cf.account, aiToken!, PREVIEW_GATEWAY)
      : undefined,
  });
  const current = (await (
    await report({ SNOW_KV: kv })
  ).json()) as ReportResponse;
  // Pushes and dispatches for one PR are serialized; a newer head supersedes this run.
  assertPullRequest(await github<PullRequest>(`/pulls/${pr}`), sha);
  console.log(`Stored ${await kv.flush(status)} changed values`);
  deployPreview(pr, sha, storage.namespace.id);
  // No propagation wait: nothing reads this KV back before writing, the comment
  // comes from `current`, and the share-preview check needs no KV data (pages are
  // static assets; share cards render without an article).
  await comment(pr, readinessComment(pr, sha, status, current, failures));
  if (failures.length || current.requiredMissing.length)
    throw new ReportedPreviewError(
      "Preview deployed with data failures; see the PR readiness comment",
    );
  return previewOrigin(pr);
}
