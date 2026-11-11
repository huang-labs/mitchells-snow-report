import { DurableObject } from "cloudflare:workers";
import { REGIONS, type ChannelId } from "../lib/catalog";
import { ChannelPublisher, currentEditions, type PublicationRequest } from "../lib/dailysnow/publisher";
import type { DailySnowState } from "../lib/types";
import { COLLECTOR_NAME } from "./collection";
import type { WorkerEnv } from "./env";

const CHANNEL = "channel";

/**
 * One Daily Snow channel, addressed by its channel id: the only writer of that
 * channel's state, archive and figures (logic in src/lib/dailysnow/publisher.ts).
 * A request reserves an attempt and sets an alarm; the alarm runs the model with
 * its own time budget, so no channel waits on another's generation.
 */
export class ChannelObject extends DurableObject<WorkerEnv> {
  private publisher?: ChannelPublisher;

  /** Every call names its channel; the alarm reads it back from storage. */
  private async channel(channel?: ChannelId): Promise<ChannelPublisher> {
    if (!this.publisher) {
      const stored = await this.ctx.storage.get<ChannelId>(CHANNEL);
      const id = stored ?? channel;
      if (!id) throw new Error("ChannelObject has no channel yet");
      if (!stored) await this.ctx.storage.put(CHANNEL, id);
      this.publisher = new ChannelPublisher(id, this.ctx.storage, this.env, {
        snapshot: () => this.env.COLLECTOR!.getByName(COLLECTOR_NAME).latest(),
        editions: async (now) => currentEditions(await this.regionStates(), REGIONS, now),
        regionStates: () => this.regionStates(),
      });
    }
    if (channel && channel !== this.publisher.channel)
      throw new Error(`ChannelObject for ${this.publisher.channel} asked about ${channel}`);
    return this.publisher;
  }

  private async regionStates() {
    return Object.fromEntries(await Promise.all(REGIONS.map(async (r) => [r.id, await this.env.CHANNEL!.getByName(r.id).state(r.id)] as const)));
  }

  async request(channel: ChannelId, request: PublicationRequest) {
    const outcome = await (await this.channel(channel)).request(request);
    if (outcome?.scheduled) await this.ctx.storage.setAlarm(Date.now());
    return outcome;
  }

  async state(channel: ChannelId) {
    return (await this.channel(channel)).state();
  }

  async status(channel: ChannelId) {
    const publisher = await this.channel(channel);
    return { state: await publisher.state(), pending: await publisher.hasPending() };
  }

  async seed(channel: ChannelId, state: DailySnowState) {
    return (await this.channel(channel)).seed(state);
  }

  /** Never throws (a thrown alarm is retried, and a retry must not call the model again). */
  async alarm() {
    const outcome = await (await this.channel()).runPending();
    if (outcome) console.log(JSON.stringify({ event: "dailysnow", ...outcome }));
  }
}
