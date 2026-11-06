export interface CloudflareApiIssue {
  code: number;
  message: string;
}

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly issues: CloudflareApiIssue[],
    message: string,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

/** Cloudflare control-plane access for preview tooling. Never exposed by the app. */
export class Cloudflare {
  constructor(
    readonly account: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async response(
    path: string,
    init: RequestInit = {},
    missingOk = false,
  ): Promise<Response> {
    const response = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${this.account}${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${this.token}`,
        },
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (missingOk && response.status === 404) return response;
    if (!response.ok) {
      // Report the actual status and API error, without printing request headers or credentials.
      const body = (await response.json().catch(() => ({}))) as {
        errors?: CloudflareApiIssue[];
      };
      throw new CloudflareApiError(
        response.status,
        body.errors ?? [],
        `Cloudflare ${init.method ?? "GET"} ${path}: HTTP ${response.status} ${JSON.stringify(body.errors ?? [])}`,
      );
    }
    return response;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.response(path, init);
    const body = (await response.json()) as {
      success: boolean;
      result: T;
      errors?: unknown;
    };
    if (!body.success)
      throw new Error(`Cloudflare ${path}: ${JSON.stringify(body.errors)}`);
    return body.result;
  }

  async pages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; ; page++) {
      const response = await this.response(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const body = (await response.json()) as {
        success: boolean;
        result: T[];
        result_info?: { total_pages?: number };
      };
      if (!body.success) throw new Error(`Cloudflare listing failed: ${path}`);
      results.push(...body.result);
      if (
        body.result.length === 0 ||
        page >=
          (body.result_info?.total_pages ??
            (body.result.length < 100 ? page : Infinity))
      )
        return results;
    }
  }
}

export const PRODUCTION_KV = "5fb1857843374e8ea427c2117b5f3955";
export const LEGACY_PREVIEW_KV = "f9e542e8a1d0405f8624beade1bba09b";
export const PREVIEW_WORKER = "mitchells-snow-report-preview";
export const PREVIEW_GATEWAY = "mitchells-snow-report-preview";
export const REPOSITORY = "huang-labs/mitchells-snow-report";
export const namespaceTitle = (pr: number) => `mitchells-snow-report-pr-${pr}`;
export const previewName = (pr: number) => `pr-${pr}`;
export const runnerName = (pr: number) => `seed-pr-${pr}`;
export const previewOrigin = (pr: number) =>
  `https://pr-${pr}-mitchells-snow-report-preview.huang-inc.workers.dev`;

export function parsePr(value: string | undefined): number {
  if (
    !value ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Expected a positive --pr number");
  return Number(value);
}

export function assertPreviewNamespace(
  namespace: { id: string; title: string },
  pr: number,
) {
  if (
    namespace.title !== namespaceTitle(pr) ||
    !/^[a-f0-9]{32}$/.test(namespace.id) ||
    [PRODUCTION_KV, LEGACY_PREVIEW_KV].includes(namespace.id)
  )
    throw new Error(
      "Refusing to mutate a namespace that is not owned by this PR",
    );
}

export async function findNamespace(
  cf: Cloudflare,
  pr: number,
  create: boolean,
) {
  const namespaces = await cf.pages<{ id: string; title: string }>(
    "/storage/kv/namespaces",
  );
  let found = namespaces.find((n) => n.title === namespaceTitle(pr));
  if (!found && create)
    found = await cf.json("/storage/kv/namespaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: namespaceTitle(pr) }),
    });
  if (found) assertPreviewNamespace(found, pr);
  return found;
}

export const previewPath = (name: string) =>
  `/workers/workers/${PREVIEW_WORKER}/previews/${name}`;
export async function deletePreview(cf: Cloudflare, name: string) {
  // Never accept the parent worker or a free-form production name.
  if (!/^(?:pr|seed-pr)-[1-9]\d*$/.test(name))
    throw new Error("Invalid preview name");
  const response = await cf.response(
    previewPath(name),
    { method: "DELETE" },
    true,
  );
  if (response.status === 404) return;
  // A successful DELETE can remain visible to GET briefly. Confirm removal
  // before reusing the runner name; do not mask API/authentication failures.
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await cf.response(previewPath(name), {}, true)).status === 404) return;
    if (attempt < 11) await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Preview ${name} still exists after deletion (12 checks)`);
}

export async function ensureGateway(cf: Cloudflare) {
  const path = `/ai-gateway/gateways/${PREVIEW_GATEWAY}`;
  if ((await cf.response(path, {}, true)).status === 404) {
    try {
      await cf.json("/ai-gateway/gateways", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: PREVIEW_GATEWAY,
          cache_invalidate_on_update: true,
          cache_ttl: 0,
          collect_logs: true,
          rate_limiting_interval: 86400,
          rate_limiting_limit: 1000,
          rate_limiting_technique: "sliding",
        }),
      });
    } catch (error) {
      // Different PRs can provision the shared preview-only Gateway concurrently.
      if ((await cf.response(path, {}, true)).status === 404) throw error;
    }
  }
  const gateway = await cf.json<{
    rate_limiting_limit: number;
    rate_limiting_interval: number;
    rate_limiting_technique: string;
  }>(path);
  if (
    gateway.rate_limiting_limit !== 1000 ||
    gateway.rate_limiting_interval !== 86400 ||
    gateway.rate_limiting_technique !== "sliding"
  )
    throw new Error(
      "Preview AI Gateway must enforce 1,000 requests per sliding day before generation",
    );
}
