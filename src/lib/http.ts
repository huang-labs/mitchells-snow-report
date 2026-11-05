import type { KVLike } from "./store";
export interface UpstreamCall {
  url: string;
  status: number | null;
  ms: number;
}

export interface FetchContext {
  now: Date;
  env: CollectorSecrets;
  calls: UpstreamCall[];
  fetchText(url: string, init?: FetchOptions): Promise<string>;
  fetchJson<T = unknown>(url: string, init?: FetchOptions): Promise<T>;
  /** GET a binary body, checking its content type prefix (e.g. "image/"). */
  fetchBytes(url: string, init?: FetchOptions & { contentType?: string }): Promise<Uint8Array>;
  /** Blob storage for derived artifacts (cropped plume panels); absent in unit tests of pure parsers. */
  kv?: KVLike;
  /** Payload from the last successful collection of this source, if any. */
  previous: unknown;
  /** HEAD (falling back to ranged GET) — returns status + headers without reading the body. */
  probe(url: string, init?: FetchOptions): Promise<{ status: number; headers: Headers }>;
}

export interface CollectorSecrets {
  COLLECTOR_CONTACT?: string;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Maximum decoded response body size; defaults to 8 MB for every body type. */
  maxBytes?: number;
  /** Use browser-like headers (some resort CDNs reject generic clients). */
  browserLike?: boolean;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Redact credentials from URLs before they are stored in diagnostics. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:key|bearer_token|token|api_key)=)[^&]+/gi, "$1[redacted]");
}

export function createFetchContext(
  env: CollectorSecrets,
  now: Date,
  fetchImpl: typeof fetch = fetch,
  extra: { kv?: KVLike; previous?: unknown } = {},
): FetchContext {
  const calls: UpstreamCall[] = [];
  const ua = `mitchells-snow-report/0.1${env.COLLECTOR_CONTACT ? ` (${env.COLLECTOR_CONTACT})` : ""}`;

  // Cancellation is best effort: a broken producer must not keep our promise pending.
  const cancel = (body: ReadableStream<Uint8Array> | null) => {
    if (body && !body.locked) void body.cancel().catch(() => undefined);
  };

  async function readBytes(res: Response, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) throw new Error(`body too large (${declared} bytes)`);
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const stop = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", stop, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error(`body too large (${size} bytes)`);
        chunks.push(value);
      }
      finished = true;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      signal.removeEventListener("abort", stop);
      if (!finished) stop();
      reader.releaseLock();
    }
  }

  async function raw<T>(
    url: string, method: string, init: FetchOptions,
    consume: (res: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const controller = new AbortController();
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const headers: Record<string, string> = init.browserLike
      ? { ...BROWSER_HEADERS, ...init.headers }
      : { "User-Agent": ua, Accept: "application/json, text/html;q=0.9, */*;q=0.5", ...init.headers };
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("timeout"));
        controller.abort();
      }, init.timeoutMs ?? 15_000);
    });
    try {
      return await Promise.race([
        (async () => {
          response = await fetchImpl(url, { method, headers, signal: controller.signal, redirect: "follow" });
          if (controller.signal.aborted) {
            cancel(response.body);
            throw new Error("timeout");
          }
          return consume(response, controller.signal);
        })(),
        deadline,
      ]);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      const msg = controller.signal.aborted ? "timeout" : err instanceof Error ? err.message : String(err);
      throw new UpstreamError(`${method} ${redactUrl(url)} failed: ${msg}`, redactUrl(url), response?.status ?? null);
    } finally {
      clearTimeout(timer);
      cancel(response?.body ?? null);
      calls.push({ url: redactUrl(url), status: response?.status ?? null, ms: Date.now() - started });
    }
  }

  function get<T>(url: string, init: FetchOptions = {}, consume: (bytes: Uint8Array, res: Response) => T): Promise<T> {
    return raw(url, "GET", init, async (res, signal) => {
      if (!res.ok) throw new UpstreamError(`GET ${redactUrl(url)} returned HTTP ${res.status}`, redactUrl(url), res.status);
      const type = res.headers.get("content-type") ?? "";
      const prefix = (init as FetchOptions & { contentType?: string }).contentType;
      if (prefix && !type.startsWith(prefix)) {
        throw new UpstreamError(`GET ${redactUrl(url)} returned ${type || "no content type"}`, redactUrl(url), res.status);
      }
      return consume(await readBytes(res, signal, init.maxBytes ?? 8_000_000), res);
    });
  }

  return {
    now, env, calls, kv: extra.kv, previous: extra.previous ?? null,
    fetchBytes: (url, init) => get(url, init, (bytes) => bytes),
    fetchText: (url, init) => get(url, init, (bytes) => new TextDecoder().decode(bytes)),
    fetchJson<T>(url: string, init?: FetchOptions) {
      return get(url, init, (bytes, res) => {
        try {
          return JSON.parse(new TextDecoder().decode(bytes)) as T;
        } catch {
          throw new UpstreamError(`GET ${redactUrl(url)} returned non-JSON body`, redactUrl(url), res.status);
        }
      });
    },
    async probe(url, init = {}) {
      const consume = async (res: Response) => ({ status: res.status, headers: res.headers });
      let res = await raw(url, "HEAD", init, consume);
      if (res.status >= 400) {
        res = await raw(url, "GET", { ...init, headers: { Range: "bytes=0-0", ...init.headers } }, consume);
      }
      return res;
    },
  };
}
