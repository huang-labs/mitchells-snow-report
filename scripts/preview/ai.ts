import type { AiLike } from "../../src/lib/ai/model";

/**
 * The Workers AI binding's `run`, over REST through an AI Gateway, for
 * collection running in Node. Returns the same `result` the binding returns.
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
        `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/workers-ai/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
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
