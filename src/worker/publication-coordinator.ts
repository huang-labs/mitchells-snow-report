import { DurableObject } from "cloudflare:workers";
import { reservePublication, type ReservationRequest, type ReservationState } from "../lib/dailysnow/reservations";
import { channelById, type ChannelId } from "../lib/catalog";

/** Only short storage operations are serialized; model inference stays in the cron. */
export class PublicationCoordinator extends DurableObject {
  async reserve(req: Omit<ReservationRequest, "token">) {
    if (!channelById(req.channel) || !/^\d{4}-\d{2}-\d{2}$/.test(req.date) || !Number.isFinite(req.now))
      throw new Error("Invalid publication reservation");
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = (await this.ctx.storage.get<ReservationState>("reservations")) ?? { calls: [], channels: {} };
      const token = crypto.randomUUID();
      const result = reservePublication(state, { ...req, token });
      await this.ctx.storage.put("reservations", result.state);
      return { ok: result.ok, ...(result.ok ? { token } : { reason: result.reason }) };
    });
  }
  async valid(channel: ChannelId, token: string) {
    const state = await this.ctx.storage.get<ReservationState>("reservations");
    const lease = state?.channels[channel];
    return !!lease?.running && lease.token === token;
  }
  async finish(channel: ChannelId, token: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.ctx.storage.get<ReservationState>("reservations");
      const lease = state?.channels[channel];
      if (!state || !lease?.running || lease.token !== token) return false;
      lease.running = false;
      await this.ctx.storage.put("reservations", state);
      return true;
    });
  }
}
