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

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly appTitle: string,
  ) {}

  async translateEmail(request: TranslationRequest): Promise<TranslationResult> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Title": this.appTitle,
      },
      body: JSON.stringify({
        model: this.model,
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

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
    }

    const payload = completionSchema.parse(await response.json());
    const rawContent = payload.choices[0]?.message.content?.trim();

    if (!rawContent) {
      throw new Error("OpenRouter returned an empty completion");
    }

    const parsedJson = parseJsonObject(rawContent);
    const translated = translationPayloadSchema.parse(parsedJson);

    if (translated.translatedHtmlSegments.length !== request.htmlSegments.length) {
      throw new Error(
        `Translated HTML segment count mismatch: expected ${request.htmlSegments.length}, received ${translated.translatedHtmlSegments.length}`,
      );
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
  }
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
