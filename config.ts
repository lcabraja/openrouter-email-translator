import { z } from "zod";

const requiredString = z.string().trim().min(1);

const envSchema = z.object({
  IMAP_USERNAME: requiredString,
  IMAP_PASSWORD: requiredString,
  IMAP_SERVER: requiredString,
  IMAP_PORT: requiredString,
  SMTP_USERNAME: requiredString,
  SMTP_PASSWORD: requiredString,
  SMTP_SERVER: requiredString,
  SMTP_PORT: requiredString,
  OPENROUTER_API_KEY: requiredString,
  OPENROUTER_MODEL_IDENTIFIER: requiredString,
});

function parsePort(value: string, label: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }

  return parsed;
}

export type AppConfig = {
  imap: {
    user: string;
    pass: string;
    host: string;
    port: number;
    secure: boolean;
  };
  smtp: {
    user: string;
    pass: string;
    host: string;
    port: number;
    secure: boolean;
  };
  openRouter: {
    apiKey: string;
    model: string;
  };
  inboxPath: string;
  reconnectDelayMs: number;
  maxIdleTimeMs: number;
  appTitle: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse(env);

  const imapPort = parsePort(parsedEnv.IMAP_PORT, "IMAP_PORT");
  const smtpPort = parsePort(parsedEnv.SMTP_PORT, "SMTP_PORT");

  return {
    imap: {
      user: parsedEnv.IMAP_USERNAME,
      pass: parsedEnv.IMAP_PASSWORD,
      host: parsedEnv.IMAP_SERVER,
      port: imapPort,
      secure: imapPort === 993,
    },
    smtp: {
      user: parsedEnv.SMTP_USERNAME,
      pass: parsedEnv.SMTP_PASSWORD,
      host: parsedEnv.SMTP_SERVER,
      port: smtpPort,
      secure: smtpPort === 465,
    },
    openRouter: {
      apiKey: parsedEnv.OPENROUTER_API_KEY,
      model: parsedEnv.OPENROUTER_MODEL_IDENTIFIER,
    },
    inboxPath: "INBOX",
    reconnectDelayMs: 60_000,
    maxIdleTimeMs: 29 * 60_000,
    appTitle: "email-translate",
  };
}
