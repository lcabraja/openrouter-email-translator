import { z } from "zod";

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().default(0),
      completion_tokens: z.number().int().nonnegative().default(0),
      total_tokens: z.number().int().nonnegative().default(0),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

const errorResponseSchema = z.object({
  error: z.object({
    code: z.number().int(),
    metadata: z
      .object({
        error_type: z.string().optional(),
      })
      .optional(),
  }),
});

const translationPayloadSchema = z.object({
  detectedLanguage: z.string().trim().min(1),
  targetLanguage: z.string().trim().min(1),
  translatedSubject: z.string().nullable(),
  translatedText: z.string().nullable(),
  translatedHtmlSegments: z.array(z.string()),
});

export type TranslationRequest = {
  subject: string | null;
  text: string | null;
  htmlSegments: string[];
  targetLanguage: string;
};

export type TranslationUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
};

export type TranslationResult = z.infer<typeof translationPayloadSchema> & {
  usage: TranslationUsage;
};

export type TranslationFailureKind =
  | "credits"
  | "authentication"
  | "rate-limit"
  | "unavailable"
  | "invalid-response"
  | "request-rejected"
  | "processing";

export type TranslationFailure = {
  kind: TranslationFailureKind;
  retryable: boolean;
  status?: number;
  userMessage: string;
};

export class OpenRouterError extends Error {
  constructor(
    readonly kind: Exclude<TranslationFailureKind, "processing">,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    const statusLabel = status === undefined ? "none" : String(status);
    super(`OpenRouter request failed category=${kind} status=${statusLabel}`, options);
    this.name = "OpenRouterError";
  }
}

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly providers: string[],
    private readonly appTitle: string,
  ) {}

  async translateEmail(request: TranslationRequest): Promise<TranslationResult> {
    let response: Response;

    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": this.appTitle,
        },
        body: JSON.stringify({
          model: this.model,
          provider: {
            order: this.providers,
            allow_fallbacks: true,
            sort: "throughput",
          },
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: [
                "You translate emails while preserving tone and intent.",
                "Return JSON only. No markdown, no commentary, no extra keys.",
                "Detect the source language.",
                "Translate into the requested target language.",
                "The htmlSegments array must be returned with the exact same length and order.",
                "Do not omit empty-but-present fields. Use null for missing subject/text.",
                "Preserve URLs, email addresses, product codes, and tracking numbers unless they are natural language.",
              ].join("\n"),
            },
            {
              role: "user",
              content: JSON.stringify({
                instruction: "Translate this email payload.",
                targetLanguage: request.targetLanguage,
                email: {
                  subject: request.subject,
                  text: request.text,
                  htmlSegments: request.htmlSegments,
                },
                outputShape: {
                  detectedLanguage: "string",
                  targetLanguage: "string",
                  translatedSubject: "string | null",
                  translatedText: "string | null",
                  translatedHtmlSegments: ["string"],
                },
              }),
            },
          ],
        }),
      });
    } catch (error) {
      throw new OpenRouterError("unavailable", undefined, { cause: error });
    }

    if (!response.ok) {
      const errorPayload = errorResponseSchema.safeParse(await response.json().catch(() => null));
      const status = errorPayload.success ? errorPayload.data.error.code : response.status;
      const errorType = errorPayload.success ? errorPayload.data.error.metadata?.error_type : undefined;
      throw new OpenRouterError(classifyProviderFailure(status, errorType), status);
    }

    try {
      const responsePayload: unknown = await response.json();
      const errorPayload = errorResponseSchema.safeParse(responsePayload);

      if (errorPayload.success) {
        const status = errorPayload.data.error.code;
        throw new OpenRouterError(
          classifyProviderFailure(status, errorPayload.data.error.metadata?.error_type),
          status,
        );
      }

      const payload = completionSchema.parse(responsePayload);
      const rawContent = payload.choices[0]?.message.content?.trim();

      if (!rawContent) {
        throw new Error("OpenRouter returned an empty completion");
      }

      const parsedJson = parseJsonObject(rawContent);
      const translated = translationPayloadSchema.parse(parsedJson);

      if (translated.translatedHtmlSegments.length !== request.htmlSegments.length) {
        throw new Error("Translated HTML segment count mismatch");
      }

      return {
        ...translated,
        usage: {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          totalTokens: payload.usage?.total_tokens ?? 0,
          cost: payload.usage?.cost ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof OpenRouterError) {
        throw error;
      }

      throw new OpenRouterError("invalid-response", response.status, { cause: error });
    }
  }
}

export function describeTranslationFailure(error: unknown): TranslationFailure {
  const kind = error instanceof OpenRouterError ? error.kind : "processing";
  const status = error instanceof OpenRouterError ? error.status : undefined;

  switch (kind) {
    case "credits":
      return {
        kind,
        retryable: false,
        status,
        userMessage: "The translation service is currently out of credits.",
      };
    case "authentication":
      return {
        kind,
        retryable: false,
        status,
        userMessage: "The translation service is temporarily unavailable because of a configuration issue.",
      };
    case "rate-limit":
      return {
        kind,
        retryable: true,
        status,
        userMessage: "The translation service is temporarily busy.",
      };
    case "unavailable":
      return {
        kind,
        retryable: true,
        status,
        userMessage: "The translation provider is temporarily unavailable.",
      };
    case "invalid-response":
      return {
        kind,
        retryable: true,
        status,
        userMessage: "The translation provider returned a response that could not be processed.",
      };
    case "request-rejected":
      return {
        kind,
        retryable: false,
        status,
        userMessage: "The translation provider could not accept this translation request.",
      };
    case "processing":
      return {
        kind,
        retryable: true,
        userMessage: "An unexpected processing error prevented the translation.",
      };
  }
}

function classifyProviderFailure(
  status: number,
  errorType?: string,
): Exclude<TranslationFailureKind, "processing"> {
  if (status === 402 || errorType === "payment_required") {
    return "credits";
  }

  if (status === 401 || errorType === "authentication") {
    return "authentication";
  }

  if (status === 429 || errorType === "rate_limit_exceeded") {
    return "rate-limit";
  }

  if (
    status === 408 ||
    status >= 500 ||
    errorType === "provider_overloaded" ||
    errorType === "provider_unavailable" ||
    errorType === "server" ||
    errorType === "timeout" ||
    errorType === "unmapped"
  ) {
    return "unavailable";
  }

  return "request-rejected";
}

function parseJsonObject(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    const start = input.indexOf("{");
    const end = input.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model response did not contain a JSON object");
    }

    return JSON.parse(input.slice(start, end + 1));
  }
}
