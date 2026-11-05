import {
  reservePublication,
  type ReservationState,
  type ReservationRequest,
  type CoordinatorClient,
} from "@/lib/dailysnow/reservations";
import type { ChannelId } from "@/lib/catalog";
export class MemoryCoordinator implements CoordinatorClient {
  state: ReservationState = { calls: [], channels: {} };
  async reserve(req: Omit<ReservationRequest, "token">) {
    const token = crypto.randomUUID();
    const result = reservePublication(this.state, { ...req, token });
    this.state = result.state;
    return { ok: result.ok, token: result.ok ? token : undefined, reason: result.reason };
  }
  async valid(channel: ChannelId, token: string) {
    const lease = this.state.channels[channel];
    return !!lease?.running && lease.token === token;
  }
  async finish(channel: ChannelId, token: string) {
    const lease = this.state.channels[channel];
    if (!lease?.running || lease.token !== token) return false;
    lease.running = false;
    return true;
  }
}
export const coordinatorBinding = (coordinator = new MemoryCoordinator()) => ({ getByName: () => coordinator });
