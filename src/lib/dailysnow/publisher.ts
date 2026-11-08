import { channelById, type ChannelId, type RegionId } from "../catalog";
import { localDate } from "../time";
import type { DailySnowPost, DailySnowState, Snapshot } from "../types";
import { emptyDailySnowState, planDailySnow, type DailySnowEnv } from ".";
import { channelKV, channelStateKey, regionalSnapshot } from "./regions";
import { attemptsToday, DAILY_CALL_CAP, inFlight, MAX_ATTEMPTS, shouldRunDailySnow } from "./schedule";
import { writeWestern } from "./western";

/**
 * One channel's publication state machine, shared by the ChannelObject Durable
 * Object (src/worker/channel-object.ts) and Node tooling (runChannels).
 *
 * A publication has two steps. `request` decides and reserves an attempt; it
 * does no network I/O between reading state and writing the reservation, so
 * inside a Durable Object two requests cannot both reserve. `runPending` then
 * runs the model and publishes; the Durable Object calls it from an alarm with
 * its own time budget, Node calls it inline.
 *
 * This object is the only writer of the channel's state. It keeps the
 * authoritative copy in `storage` and rewrites `daily-state:v2:<channel>` in KV,
 * the read copy behind /api/report, after every change.
 */

export interface ChannelStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface PublisherEnv extends DailySnowEnv {
  /** "false" leaves only forced runs (PR previews). */
  DAILY_SNOW_AUTOMATIC?: string;
}

export interface PublisherDeps {
  /** The latest committed source snapshot, read when the attempt runs. */
  snapshot(): Promise<Snapshot | null>;
  /** Today's regional editions, for the Western overview. */
  editions(now: Date): Promise<Partial<Record<RegionId, DailySnowPost>>>;
  fetchImpl?: typeof fetch;
}

export interface PublicationRequest {
  /** ISO time of the collection run; also the attempt's time and the edition's local date. */
  now: string;
  force?: boolean;
  /** Regional channels: whether the region has anything to report (dailySnowActivity). */
  worthPosting?: boolean;
}

export interface PublicationOutcome {
  channel: ChannelId;
  /** An attempt was reserved at this time and will run. */
  scheduled?: string;
  published?: string;
  error?: string;
  skipped?: string;
}

/** A reserved attempt. `base` is the state before reservation, so a skipped run can refund it. */
export interface PendingAttempt {
  attemptAt: string;
  force: boolean;
  base: DailySnowState;
  /** Set before the model is called: a retried alarm must not call it twice. */
  started?: boolean;
}

const STATE = "state";
const PENDING = "pending";

export const INTERRUPTED = "Attempt was interrupted before it finished";

/** Today's editions for each region, from that region's state. */
export function currentEditions(
  states: Partial<Record<ChannelId, DailySnowState | undefined>>,
  regions: ReadonlyArray<{ id: RegionId; timeZone: string }>,
  now: Date,
): Partial<Record<RegionId, DailySnowPost>> {
  return Object.fromEntries(
    regions.flatMap((r) => {
      const p = states[r.id]?.current;
      return p && p.date === localDate(now, r.timeZone) ? [[r.id, p]] : [];
    }),
  );
}

export class ChannelPublisher {
  private current: DailySnowState = emptyDailySnowState();
  private pending: PendingAttempt | null = null;
  private loading?: Promise<void>;
  private kvStale = false;

  constructor(
    readonly channel: ChannelId,
    private readonly storage: ChannelStorage,
    private readonly env: PublisherEnv,
    private readonly deps: PublisherDeps,
  ) {}

  /** Loaded once; concurrent first calls share the load, so none decides on a partial state. */
  private load(): Promise<void> {
    return (this.loading ??= (async () => {
      const stored = await this.storage.get<DailySnowState>(STATE);
      if (stored) this.current = stored;
      else {
        // First start (production cutover): the KV state the previous writer left.
        const raw = await this.env.SNOW_KV.get(channelStateKey(this.channel), "text");
        if (raw) this.current = JSON.parse(raw) as DailySnowState;
      }
      this.pending = (await this.storage.get<PendingAttempt>(PENDING)) ?? null;
    })().catch((err) => {
      this.loading = undefined;
      throw err;
    }));
  }

  /**
   * Apply `state` in memory first, synchronously, so any request deciding from
   * here on sees it; then persist it (reverting memory if storage fails), then
   * rewrite the KV read copy.
   */
  private async save(state: DailySnowState, pending: PendingAttempt | null) {
    const previous = { state: this.current, pending: this.pending };
    this.current = state;
    this.pending = pending;
    try {
      await this.storage.put(pending ? { [STATE]: state, [PENDING]: pending } : { [STATE]: state });
      if (!pending) await this.storage.delete(PENDING);
    } catch (err) {
      if (this.current === state) Object.assign(this, { current: previous.state, pending: previous.pending });
      throw err;
    }
    await this.writeKv();
  }

  private async writeKv() {
    try {
      await this.env.SNOW_KV.put(channelStateKey(this.channel), JSON.stringify(this.current));
      this.kvStale = false;
    } catch (err) {
      // The authoritative copy is saved; the next request rewrites the read copy.
      this.kvStale = true;
      console.error(`dailysnow: ${this.channel} KV read copy not updated`, err);
    }
  }

  async state(): Promise<DailySnowState> {
    await this.load();
    return structuredClone(this.current);
  }

  /** Whether an attempt is reserved and not yet finished. */
  async hasPending(): Promise<boolean> {
    await this.load();
    return this.pending !== null;
  }

  /** Initialize an empty store from `state` (PR previews); an initialized store is left alone. */
  async seed(state: DailySnowState): Promise<boolean> {
    await this.load();
    if (await this.storage.get(STATE)) return false;
    await this.save(state, null);
    return true;
  }

  /** Decide and, when due, reserve an attempt. Returns null when a scheduled run is simply not due. */
  async request(req: PublicationRequest): Promise<PublicationOutcome | null> {
    const channel = this.channel;
    if (!this.env.AI || this.env.AI_ENABLED === "false") return null;
    if (!req.force && this.env.DAILY_SNOW_AUTOMATIC === "false") return null;
    await this.load();
    if (this.kvStale) await this.writeKv();
    const now = new Date(req.now);
    const western = channel === "western-us";

    let skip = this.decide(now, req);
    if (skip !== undefined) return skip;
    let editions: Partial<Record<RegionId, DailySnowPost>> = {};
    if (western) {
      // Network I/O: re-decide afterwards, since another request may have reserved meanwhile.
      editions = await this.deps.editions(now);
      if (!Object.keys(editions).length) return { channel, skipped: "No current regional editions" };
      skip = this.decide(now, req);
      if (skip !== undefined) return skip;
    }
    const base = this.current;
    const used = attemptsToday(base, now, channel);
    const reserved: DailySnowState = {
      ...base,
      lastAttemptAt: now.toISOString(),
      attempts: { date: localDate(now, channelById(channel)!.timeZone), count: used.count + 1, calls: used.calls + 2 },
    };
    await this.save(reserved, { attemptAt: reserved.lastAttemptAt!, force: !!req.force, base });
    return { channel, scheduled: reserved.lastAttemptAt! };
  }

  /** undefined: reserve. null: not due. Otherwise the skip to report. */
  private decide(now: Date, req: PublicationRequest): PublicationOutcome | null | undefined {
    const channel = this.channel;
    const base = this.current;
    if (this.pending || inFlight(base, now)) return req.force ? { channel, skipped: "in-flight" } : null;
    if (req.force) {
      const used = attemptsToday(base, now, channel);
      if (used.count >= MAX_ATTEMPTS || used.calls + 2 > DAILY_CALL_CAP) return { channel, skipped: "channel daily cap" };
      return undefined;
    }
    if (!shouldRunDailySnow(base, now, channel)) return null;
    if (channel !== "western-us" && !req.worthPosting) return { channel, skipped: "off-season or inputs unavailable" };
    return undefined;
  }

  /** Run the reserved attempt, if any. Never throws. */
  async runPending(): Promise<PublicationOutcome | null> {
    await this.load();
    const p = this.pending;
    if (!p) return null;
    const channel = this.channel;
    const reserved = this.current;
    if (reserved.lastAttemptAt !== p.attemptAt) {
      await this.save(reserved, null);
      return null;
    }
    if (p.started) {
      // A retried alarm after an eviction mid-run: the attempt and its model calls are spent.
      const failed = this.failed(p, INTERRUPTED);
      await this.save(failed, null);
      return { channel, error: INTERRUPTED };
    }
    await this.save(reserved, { ...p, started: true });

    const now = new Date(p.attemptAt);
    const superseded = () => this.current.lastAttemptAt !== p.attemptAt;
    const env: PublisherEnv = {
      ...this.env,
      SNOW_KV: channelKV(this.env.SNOW_KV, channel),
      DAILY_SNOW_CHANNEL: channel,
      beforePublish: async () => {
        if (superseded()) throw new Error("Publication attempt superseded");
      },
    };
    let state: DailySnowState;
    let skipped: string | undefined;
    try {
      const snapshot = await this.deps.snapshot();
      if (!snapshot) throw new Error("No source snapshot");
      if (channel === "western-us") {
        state = await writeWestern(reserved, snapshot, await this.deps.editions(now), env, now);
      } else {
        const plan = planDailySnow(p.base, regionalSnapshot(snapshot, channel), env, now, { force: p.force, fetchImpl: this.deps.fetchImpl });
        if (plan?.run) state = await plan.run();
        else {
          // Nothing to write after all (inputs changed since the request): refund the attempt.
          state = p.base;
          skipped = plan?.skipped ?? "not due";
        }
      }
    } catch (e) {
      state = this.failed(p, e instanceof Error ? e.message : String(e));
    }
    if (superseded()) return { channel, error: "Publication attempt superseded" };
    await this.save(state, null);
    if (skipped) return { channel, skipped };
    return state.lastError ? { channel, error: state.lastError } : { channel, published: state.current?.date };
  }

  private failed(p: PendingAttempt, message: string): DailySnowState {
    return {
      ...this.current,
      lastError: message.slice(0, 500),
      lastFinishedAt: new Date().toISOString(),
      consecutiveFailures: p.base.consecutiveFailures + 1,
    };
  }
}

/** In-memory ChannelStorage for Node tooling and tests. Values are cloned, as Durable Object storage serializes them. */
export class MemoryChannelStorage implements ChannelStorage {
  readonly rows = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.rows.has(key) ? (structuredClone(this.rows.get(key)) as T) : undefined;
  }
  async put<T>(entries: Record<string, T>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.rows.set(k, structuredClone(v));
  }
  async delete(key: string): Promise<boolean> {
    return this.rows.delete(key);
  }
}
