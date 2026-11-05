/** Internal CI entry point. Human/agent commands dispatch the serialized GitHub Action instead. */
import { buildReport } from "../src/lib/report";
import { previewOrigin } from "./preview/cloudflare";
import type { ReportResponse } from "../src/lib/types";
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  Cloudflare,
  parsePr,
  findNamespace,
  deletePreview,
  previewName,
  runnerName,
} from "./preview/cloudflare";
import { PreviewStorage, STATUS_KEY } from "./preview/storage";
import {
  assertPullRequest,
  comment,
  github,
  readinessComment,
  ReportedPreviewError,
  runPreview,
  selectedChannels,
  type PreviewStatus,
  type PullRequest,
} from "./preview/workflow";

const args = process.argv.slice(2);
const operation = args.shift();
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const pr = parsePr(option("--pr"));
if (!["deploy", "data", "cleanup", "cleanup-runner"].includes(operation ?? ""))
  throw new Error("Expected deploy, data, cleanup or cleanup-runner");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token)
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
  );
const cf = new Cloudflare(account, token);
const pull = await github<PullRequest>(`/pulls/${pr}`);
assertPullRequest(pull);
if (operation === "cleanup-runner") {
  await deletePreview(cf, runnerName(pr));
} else if (operation === "cleanup") {
  if (pull.state !== "closed")
    throw new Error("Refusing to delete an open PR's data");
  await deletePreview(cf, runnerName(pr));
  await deletePreview(cf, previewName(pr));
  const namespace = await findNamespace(cf, pr, false);
  if (namespace)
    await cf.response(`/storage/kv/namespaces/${namespace.id}`, {
      method: "DELETE",
    });
  console.log(`Removed PR ${pr} previews and its KV namespace`);
} else {
  const channels = selectedChannels(option("--channel") ?? "none");
  if (operation === "deploy" && channels.length)
    throw new Error("Automatic deployment cannot generate AI editions");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assertPullRequest(pull, sha);
  const namespace = (await findNamespace(cf, pr, true))!;
  const storage = new PreviewStorage(cf, namespace, pr);
  console.log(
    `Preparing PR ${pr} at ${sha.slice(0, 7)} with dedicated KV ${namespace.id}`,
  );
  let url: string;
  try {
    console.log(
      `Copied ${await storage.seed()} production baseline values (production reads only)`,
    );
    url = await runPreview(cf, storage, pr, sha, channels);
  } catch (error) {
    // Preserve diagnostic visibility even when refresh/inference/deletion fails before deployment.
    if (
      !(error instanceof ReportedPreviewError) &&
      (await github<PullRequest>(`/pulls/${pr}`)).head.sha === sha
    ) {
      const status = (await storage.json<PreviewStatus>(STATUS_KEY)) ?? {
        sourceFailures: [],
        editions: {},
      };
      let report = buildReport(null);
      const response = await fetch(new URL("/api/report", previewOrigin(pr)), {
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (response?.ok) report = (await response.json()) as ReportResponse;
      await comment(
        pr,
        readinessComment(pr, sha, status, report, [
          `Operation failed: ${error instanceof Error ? error.message : String(error)}`,
        ]),
      );
    }
    throw error;
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
  console.log(`Preview ready: ${url}`);
}
