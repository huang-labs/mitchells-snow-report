import { runCollection } from "../lib/collect";
import type { WorkerEnv } from "./env";
export async function scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
  ctx.waitUntil(
    runCollection(env, { now: new Date(controller.scheduledTime) }).then((summary) => {
      const failed = summary.results.filter((r) => !r.ok);
      console.log(
        JSON.stringify({
          event: "collection",
          cron: controller.cron,
          durationMs: summary.durationMs,
          ok: summary.results.length - failed.length,
          skipped: summary.skipped,
          publications: summary.publications,
          failed: failed.map((f) => ({ id: f.id, error: f.error })),
        }),
      );
    }),
  );
}
