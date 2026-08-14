import { afterEach, describe, expect, test } from "bun:test";

import { describeTranslationFailure, OpenRouterClient, OpenRouterError } from "./openrouter";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("translation failure descriptions", () => {
  test("identifies exhausted credits without exposing provider details", () => {
    const failure = describeTranslationFailure(new OpenRouterError("credits", 402));

    expect(failure).toEqual({
      kind: "credits",
      retryable: false,
      status: 402,
      userMessage: "The translation service is currently out of credits.",
    });
  });

  test("treats provider outages as retryable", () => {
    const failure = describeTranslationFailure(new OpenRouterError("unavailable", 503));

    expect(failure.kind).toBe("unavailable");
    expect(failure.retryable).toBe(true);
  });

  test("does not include an upstream error body in the thrown error", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"secret upstream diagnostic"}}', { status: 402 })) as unknown as typeof fetch;
    const client = new OpenRouterClient("test-key", "test-model", ["test-provider"], "test-app");

    const promise = client.translateEmail({
      subject: "Hello",
      text: "World",
      htmlSegments: [],
      targetLanguage: "Croatian",
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(String(error)).toContain("category=credits status=402");
    expect(String(error)).not.toContain("secret upstream diagnostic");
  });
});
