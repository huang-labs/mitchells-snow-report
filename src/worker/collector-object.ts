import { DurableObject } from "cloudflare:workers";
import { Collector, type CollectorRequest } from "../lib/collector";
import type { WorkerEnv } from "./env";

/**
 * Owns the source snapshot: every collection run in the deployed Worker goes
 * through the one instance named COLLECTOR_NAME, which queues runs and keeps
 * the authoritative snapshot in SQLite-backed storage (src/lib/collector.ts).
 */
export class CollectorObject extends DurableObject<WorkerEnv> {
  private readonly collector = new Collector(this.ctx.storage, this.env);

  collect(request: CollectorRequest) {
    return this.collector.collect(request);
  }
}
