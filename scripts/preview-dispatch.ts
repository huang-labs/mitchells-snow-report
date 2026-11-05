/** Dispatch on main, where the Action validates and checks out the requested PR's current head. */
import { execFileSync } from "node:child_process";
import { parsePr, REPOSITORY } from "./preview/cloudflare";
import { selectedChannels } from "./preview/workflow";

const args = process.argv.slice(2);
const mode = args.shift();
const option = (key: string) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const pr = parsePr(option("--pr"));
if (mode !== "refresh" && mode !== "dailysnow")
  throw new Error("Expected refresh or dailysnow");
if (args.includes("--all") && option("--channel"))
  throw new Error("Choose --all or --channel, not both");
const channel =
  mode === "refresh"
    ? "none"
    : args.includes("--all")
      ? "all"
      : option("--channel");
if (!channel || (mode === "dailysnow" && channel === "none"))
  throw new Error("Daily Snow requires --channel <id> or --all");
if (mode === "refresh" && (args.includes("--all") || option("--channel")))
  throw new Error("Use preview:dailysnow for AI generation");
selectedChannels(channel);
execFileSync(
  "gh",
  [
    "workflow",
    "run",
    "preview-data.yml",
    "--repo",
    REPOSITORY,
    "--ref",
    "main",
    "-f",
    `pr=${pr}`,
    "-f",
    `channel=${channel}`,
  ],
  { stdio: "inherit" },
);
console.log(
  `Queued PR ${pr}: ${channel === "none" ? "source refresh without AI" : `source refresh and Daily Snow (${channel})`}.`,
);
console.log(
  `Run status: https://github.com/${REPOSITORY}/actions/workflows/preview-data.yml`,
);
console.log(
  "The Action updates the PR's existing Preview comment with readiness and generation results.",
);
