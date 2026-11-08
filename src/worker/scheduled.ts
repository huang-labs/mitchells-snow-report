import { collectAndPublish } from "./collection";
import type { WorkerEnv } from "./env";
export async function scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
  ctx.waitUntil(
    collectAndPublish(env, { now: new Date(controller.scheduledTime), scheduled: true }).then((summary) => {
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
    }).catch((err) => {
      // Collection runs in CollectorObject; a failed RPC or storage commit lands here.
      console.error(JSON.stringify({ event: "collection_failed", cron: controller.cron, error: err instanceof Error ? err.message : String(err) }));
    }),
  );
}
