import type { CollectorEnv } from "../lib/collect";
import type { CollectorRequest, CollectorResult } from "../lib/collector";

/** The RPC surface of CollectorObject that the Worker calls. */
export interface CollectorNamespace {
  getByName(name: string): { collect(request: CollectorRequest): Promise<CollectorResult> };
}

/** The Worker receives bindings directly; the static frontend never sees them. */
export interface WorkerEnv extends CollectorEnv {
  ASSETS: Pick<Fetcher, "fetch">;
  ADMIN_TOKEN?: string;
  /** CollectorObject. PR previews don't bind it yet: they have no cron or admin token. */
  COLLECTOR?: CollectorNamespace;
}
