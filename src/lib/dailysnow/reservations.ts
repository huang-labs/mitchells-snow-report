import type { ChannelId } from "../catalog";

const DAY = 86400000;
export const GLOBAL_CALL_CAP = 64;
export const LEASE_MS = 12 * 60000;
export interface ReservationState {
  calls: Array<{ at: number; count: number }>;
  channels: Partial<
    Record<ChannelId, { date: string; attempts: number; started: number; token: string; running: boolean }>
  >;
}
export interface ReservationRequest {
  channel: ChannelId;
  date: string;
  now: number;
  token: string;
}
export function reservePublication(
  state: ReservationState,
  req: ReservationRequest,
): { state: ReservationState; ok: boolean; reason?: string } {
  const next = structuredClone(state);
  next.calls = next.calls.filter((c) => c.at > req.now - DAY);
  const previous = next.channels[req.channel];
  if (previous?.running && req.now - previous.started < LEASE_MS)
    return { state: next, ok: false, reason: "in-flight" };
  if (Object.values(next.channels).filter((c) => c?.running && req.now - c.started < LEASE_MS).length >= 4)
    return { state: next, ok: false, reason: "generation concurrency limit" };
  const count = previous?.date === req.date ? previous.attempts : 0;
  if (count >= 3) return { state: next, ok: false, reason: "channel daily cap" };
  if (next.calls.reduce((sum, c) => sum + c.count, 0) + 2 > GLOBAL_CALL_CAP)
    return { state: next, ok: false, reason: "global rolling daily cap" };
  next.calls.push({ at: req.now, count: 2 });
  next.channels[req.channel] = {
    date: req.date,
    attempts: count + 1,
    started: req.now,
    token: req.token,
    running: true,
  };
  return { state: next, ok: true };
}
export interface CoordinatorClient {
  reserve(req: Omit<ReservationRequest, "token">): Promise<{ ok: boolean; token?: string; reason?: string }>;
  finish(channel: ChannelId, token: string): Promise<boolean>;
  valid(channel: ChannelId, token: string): Promise<boolean>;
}
