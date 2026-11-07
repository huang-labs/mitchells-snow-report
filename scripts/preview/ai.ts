import type { AiLike } from "../../src/lib/ai/model";

/**
 * The Workers AI binding's `run`, over the Workers AI REST API routed through
 * an AI Gateway, for collection running in Node. Returns the same `result`
 * the binding returns. The token needs Account > Workers AI > Read; a token
 * without it gets HTTP 401, code 10000.
 */
export function gatewayAi(
  account: string,
  token: string,
  gateway: string,
  fetchImpl: typeof fetch = fetch,
): AiLike {
  return {
    async run(model, input) {
      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "cf-aig-gateway-id": gateway,
            "cf-aig-skip-cache": "true",
          },
          body: JSON.stringify(input),
          // askWithFallback times each attempt; this only stops an abandoned request.
          signal: AbortSignal.timeout(11 * 60_000),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        result?: unknown;
        errors?: unknown;
      };
      if (!response.ok || !body.success)
        throw new Error(
          `Workers AI HTTP ${response.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`,
        );
      return body.result;
    },
  };
}
