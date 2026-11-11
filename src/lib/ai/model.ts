/**
 * The model call shared by every AI feature: one request body shape, the
 * primary model with one fallback, a timeout per attempt, and output parsing.
 * Features supply the prompts, the JSON schema and a validator.
 */

/** Minimal Workers AI binding surface (Cloudflare `Ai` satisfies it). */
export interface AiLike {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export const PRIMARY_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
/** Different model family, used once if the primary fails or returns invalid output. */
export const FALLBACK_MODEL = "@cf/openai/gpt-oss-120b";
export const MODELS = [PRIMARY_MODEL, FALLBACK_MODEL] as const;

export interface ChatRequest {
  system: string;
  user: string;
  /** Name and strict JSON schema of the structured output. */
  schemaName: string;
  schema: Record<string, unknown>;
  temperature: number;
  /** Output budget, reasoning included. */
  maxTokens: number;
  /**
   * Overrides each model's default level. Reasoning shares `maxTokens` with the
   * answer, so a large prompt can need a lower level to leave room for the JSON.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * Workers AI request body. DeepSeek already defaults to "high"; gpt-oss-120b
 * keeps its "medium" default, which is the better latency/quality trade for a
 * fallback. Both models reason, so neither level disables it. A request's
 * `reasoningEffort` replaces the default for both models.
 */
export function chatInput(model: string, req: ChatRequest): Record<string, unknown> {
  return {
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    reasoning_effort: req.reasoningEffort ?? (model === PRIMARY_MODEL ? "high" : "medium"),
  };
}

interface ChatResult {
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
  response?: unknown;
}

/**
 * Why a result has no answer, from what the response reports: the stop reason,
 * token usage and the size of any reasoning text. A "length" stop with reasoning
 * near the budget means reasoning used up `max_tokens` before the answer began.
 */
function emptyResultDetail(r: ChatResult | undefined): string {
  const choice = r?.choices?.[0];
  const usage = r?.usage;
  const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  const parts = [
    typeof choice?.finish_reason === "string" && `finish_reason ${choice.finish_reason}`,
    typeof usage?.prompt_tokens === "number" && `prompt ${usage.prompt_tokens} tokens`,
    typeof usage?.completion_tokens === "number" && `completion ${usage.completion_tokens} tokens`,
    typeof usage?.completion_tokens_details?.reasoning_tokens === "number" &&
      `reasoning ${usage.completion_tokens_details.reasoning_tokens} tokens`,
    typeof reasoning === "string" && reasoning && `reasoning text ${reasoning.length} chars`,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Extract the JSON object from a chat-completions or Workers AI `response` result. */
export function responseJson(res: unknown): unknown {
  const r = res as ChatResult | undefined;
  const content = r?.choices?.[0]?.message?.content ?? r?.response;
  if (content && typeof content === "object") return content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`Model returned no content${emptyResultDetail(r)}`);
  const text = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Model output is not JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Model timed out after ${ms / 1000} s`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

export interface ModelResult<T> {
  value: T;
  model: string;
  /** Set when the fallback answered: why the primary didn't. */
  fallbackReason?: string;
}

/**
 * Ask the primary model, then the fallback once. A timeout, an upstream error,
 * unparseable JSON or a `validate` throw all count as a failure. Throws with
 * both errors when neither model gives a valid answer.
 */
export async function askWithFallback<T>(opts: {
  ai: AiLike;
  gatewayId: string | undefined;
  /** Request body for one model. */
  input: (model: string) => Record<string, unknown>;
  validate: (raw: unknown) => T;
  timeoutMs: number;
  /** Prefix for warnings in the Worker log. */
  label: string;
}): Promise<ModelResult<T>> {
  const errors: string[] = [];
  const runOptions = opts.gatewayId ? { gateway: { id: opts.gatewayId, skipCache: true } } : {};
  for (const model of MODELS) {
    try {
      const res = await withTimeout(opts.ai.run(model, opts.input(model), runOptions), opts.timeoutMs);
      const value = opts.validate(responseJson(res));
      return errors.length ? { value, model, fallbackReason: errors.join(" | ").slice(0, 500) } : { value, model };
    } catch (e) {
      const message = `${model}: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`${opts.label}: ${message}`);
      errors.push(message);
    }
  }
  throw new Error(errors.join(" | "));
}
