import type { ChannelId } from "../lib/catalog";
import type { CollectorEnv } from "../lib/collect";
import type { CollectorRequest, CollectorResult } from "../lib/collector";
import type { PublicationOutcome, PublicationRequest } from "../lib/dailysnow/publisher";
import type { DailySnowState, Snapshot } from "../lib/types";

/** The RPC surface of CollectorObject that the Worker calls. */
export interface CollectorNamespace {
  getByName(name: string): {
    collect(request: CollectorRequest): Promise<CollectorResult>;
    latest(): Promise<Snapshot | null>;
    seed(snapshot: Snapshot): Promise<boolean>;
  };
}

/** The RPC surface of ChannelObject; one instance per channel id. */
export interface ChannelNamespace {
  getByName(name: string): {
    request(channel: ChannelId, request: PublicationRequest): Promise<PublicationOutcome | null>;
    state(channel: ChannelId): Promise<DailySnowState>;
    status(channel: ChannelId): Promise<{ state: DailySnowState; pending: boolean }>;
    seed(channel: ChannelId, state: DailySnowState): Promise<boolean>;
  };
}

/** The Worker receives bindings directly; the static frontend never sees them. */
export interface WorkerEnv extends CollectorEnv {
  ASSETS: Pick<Fetcher, "fetch">;
  ADMIN_TOKEN?: string;
  /** CollectorObject: the single writer of the source snapshot. */
  COLLECTOR?: CollectorNamespace;
  /** ChannelObject: the single writer of each Daily Snow channel. */
  CHANNEL?: ChannelNamespace;
}
