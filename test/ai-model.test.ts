import { describe, expect, it } from "vitest";
import { chatInput, FALLBACK_MODEL, PRIMARY_MODEL, responseJson, type ChatRequest } from "@/lib/ai/model";

const req: ChatRequest = { system: "s", user: "u", schemaName: "x", schema: {}, temperature: 0.4, maxTokens: 8000 };

describe("chatInput", () => {
  it("uses each model's default reasoning level unless the request sets one", () => {
    expect(chatInput(PRIMARY_MODEL, req).reasoning_effort).toBe("high");
    expect(chatInput(FALLBACK_MODEL, req).reasoning_effort).toBe("medium");
    expect(chatInput(PRIMARY_MODEL, { ...req, reasoningEffort: "medium" }).reasoning_effort).toBe("medium");
    expect(chatInput(FALLBACK_MODEL, { ...req, reasoningEffort: "medium" }).reasoning_effort).toBe("medium");
  });
});

describe("responseJson", () => {
  it("reports the stop reason and token usage when the answer is empty", () => {
    const res = {
      choices: [{ finish_reason: "length", message: { content: null, reasoning_content: "x".repeat(120) } }],
      usage: { prompt_tokens: 21000, completion_tokens: 8000, completion_tokens_details: { reasoning_tokens: 8000 } },
    };
    expect(() => responseJson(res)).toThrow(
      "Model returned no content (finish_reason length, prompt 21000 tokens, completion 8000 tokens, reasoning 8000 tokens, reasoning text 120 chars)",
    );
  });

  it("keeps the plain message when the response reports nothing", () => {
    expect(() => responseJson({ response: "" })).toThrow(/^Model returned no content$/);
  });

  it("still parses a normal answer", () => {
    expect(responseJson({ choices: [{ finish_reason: "stop", message: { content: '{"a":1}' } }] })).toEqual({ a: 1 });
  });
});
