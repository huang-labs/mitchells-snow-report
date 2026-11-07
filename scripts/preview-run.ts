/** Internal CI entry point. Human/agent commands dispatch the serialized GitHub Action instead. */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  Cloudflare,
  parsePr,
  findNamespace,
  deletePreview,
} from "./preview/cloudflare";
import { PreviewStorage } from "./preview/storage";
import {
  assertPullRequest,
  comment,
  failureComment,
  github,
  ReportedPreviewError,
  runPreview,
  selectedChannels,
  type PullRequest,
} from "./preview/workflow";

const args = process.argv.slice(2);
const operation = args.shift();
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const pr = parsePr(option("--pr"));
if (!["deploy", "data", "cleanup"].includes(operation ?? ""))
  throw new Error("Expected deploy, data or cleanup");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token)
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
  );
const cf = new Cloudflare(account, token);
const pull = await github<PullRequest>(`/pulls/${pr}`);
assertPullRequest(pull);
if (operation === "cleanup") {
  if (pull.state !== "closed")
    throw new Error("Refusing to delete an open PR's data");
  await deletePreview(cf, pr);
  const namespace = await findNamespace(cf, pr, false);
  if (namespace)
    await cf.response(`/storage/kv/namespaces/${namespace.id}`, {
      method: "DELETE",
    });
  console.log(`Removed PR ${pr} preview and its KV namespace`);
} else {
  const channels = selectedChannels(option("--channel") ?? "none");
  if (operation === "deploy" && channels.length)
    throw new Error("Automatic deployment cannot generate AI editions");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assertPullRequest(pull, sha);
  const namespace = (await findNamespace(cf, pr, true))!;
  console.log(
    `Preparing PR ${pr} at ${sha.slice(0, 7)} with dedicated KV ${namespace.id}`,
  );
  let url: string;
  try {
    url = await runPreview(
      cf,
      new PreviewStorage(cf, namespace, pr),
      pr,
      sha,
      channels,
    );
  } catch (error) {
    if (
      !(error instanceof ReportedPreviewError) &&
      (await github<PullRequest>(`/pulls/${pr}`)).head.sha === sha
    )
      await comment(pr, failureComment(pr, sha, error));
    throw error;
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
  console.log(`Preview ready: ${url}`);
}
