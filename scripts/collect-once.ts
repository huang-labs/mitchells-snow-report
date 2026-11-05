/**
 * Runs one collection against the real upstream sources in Node, using an
 * in-memory KV, and prints per-source status plus the normalized API output.
 *   npm run collect:once            # summary
 *   npm run collect:once -- --json  # full /api/report-shaped JSON
 */
import { runCollection } from "../src/lib/collect";
import { buildReport } from "../src/lib/report";
import { MemoryKV, readSnapshot } from "../src/lib/store";
import { formatDenver } from "../src/lib/time";

const kv = new MemoryKV();
const summary = await runCollection({
  SNOW_KV: kv,
  COLLECTOR_CONTACT: process.env.COLLECTOR_CONTACT,
});
const report = buildReport(await readSnapshot(kv));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const r of summary.results) {
    const s = report.sources[r.id];
    console.log(
      `${r.ok ? "OK  " : "FAIL"} ${r.id.padEnd(12)} ${String(r.ms).padStart(5)}ms  freshness=${s.freshness.padEnd(12)} sourceUpdated=${formatDenver(s.sourceUpdatedAt)}${r.error ? `  error=${r.error}` : ""}`,
    );
  }
  console.log(`requiredMissing: ${JSON.stringify(report.requiredMissing)}  total ${summary.durationMs}ms`);
}
