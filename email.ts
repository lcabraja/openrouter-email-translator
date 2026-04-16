import { ImapFlow } from "imapflow";
import { type AddressObject, type Attachment, type HeaderValue, type ParsedMail, simpleParser } from "mailparser";
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";

import type { AppConfig } from "./config";
import { OpenRouterClient, type TranslationUsage } from "./openrouter";
import { collectHtmlSegments, prepareHtmlForTranslation, renderTranslatedHtml, textToHtml } from "./translation";

const AUTO_TRANSLATED_HEADER = "x-auto-translated-by";
const AUTO_TRANSLATED_MARKER = "openrouter-email-translator";

export type UsageTotals = TranslationUsage;

export class EmailTranslationService {
  private readonly transporter: Transporter;
  private readonly translator: OpenRouterClient;
  private readonly handledUids = new Set<number>();
  private readonly usageTotals: UsageTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
  private syncInFlight = false;
  private syncQueued = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: AppConfig) {
    this.translator = new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.model,
      config.appTitle,
    );
    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
  }

  async runForever(): Promise<never> {
    while (true) {
      try {
        await this.runSession();
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      await sleep(this.config.reconnectDelayMs);
    }
  }

  private async runSession(): Promise<void> {
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: {
        user: this.config.imap.user,
        pass: this.config.imap.pass,
      },
      maxIdleTime: this.config.maxIdleTimeMs,
      logger: false,
    });

    await this.transporter.verify();
    await client.connect();
    await client.mailboxOpen(this.config.inboxPath);

    client.on("exists", () => {
      this.queueSync(client);
    });

    this.pollTimer = setInterval(() => {
      this.queueSync(client);
    }, this.config.syncIntervalMs);

    const startupUnreadCount = await withMailboxLock(client, this.config.inboxPath, async () => {
      const searchResult = await client.search({ seen: false }, { uid: true });
      return Array.isArray(searchResult) ? searchResult.length : 0;
    });

    console.log(`unread on startup: ${startupUnreadCount}`);
    this.queueSync(client);

    try {
      await waitForClientShutdown(client);
    } finally {
      this.stopPolling();
    }
  }

  private queueSync(client: ImapFlow): void {
    if (this.syncInFlight) {
      this.syncQueued = true;
      return;
    }

    this.syncInFlight = true;

    void (async () => {
      do {
        this.syncQueued = false;
        await this.syncUnreadMessages(client);
      } while (this.syncQueued);

      this.syncInFlight = false;
    })().catch(async (error) => {
      this.syncInFlight = false;
      console.error(error instanceof Error ? error.message : error);

      try {
        this.stopPolling();
        await client.logout();
      } catch {
        // ignore logout failures during reconnect
      }
    });
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async syncUnreadMessages(client: ImapFlow): Promise<void> {
    const unseenUids = await withMailboxLock(client, this.config.inboxPath, async () => {
      const searchResult = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(searchResult) ? searchResult : [];
      return uids.sort((left, right) => left - right);
    });

    for (const uid of unseenUids) {
      if (this.handledUids.has(uid)) {
        continue;
      }

      const didHandle = await this.processMessage(client, uid);

      if (didHandle) {
        this.handledUids.add(uid);
      }
    }
  }

  private async processMessage(client: ImapFlow, uid: number): Promise<boolean> {
    const source = await withMailboxLock(client, this.config.inboxPath, async () => {
      const message = await client.fetchOne(uid, { source: true }, { uid: true });
      return message && "source" in message ? message.source : undefined;
    });

    if (!source) {
      return false;
    }

    const parsed = await simpleParser(source, { skipImageLinks: true });

    if (shouldSkipMessage(parsed, this.config.smtp.user)) {
      await withMailboxLock(client, this.config.inboxPath, async () => {
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      });
      return true;
    }

    const targetLanguage = determineTargetLanguage(parsed);
    const translation = await translateParsedMail(parsed, targetLanguage, this.translator);

    await this.sendTranslatedCopy(parsed, translation);
    await withMailboxLock(client, this.config.inboxPath, async () => {
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    });

    this.usageTotals.promptTokens += translation.usage.promptTokens;
    this.usageTotals.completionTokens += translation.usage.completionTokens;
    this.usageTotals.totalTokens += translation.usage.totalTokens;
    this.usageTotals.cost += translation.usage.cost;

    const fromLabel = originalSenderLabel(parsed);
    console.log(`processed from ${fromLabel}, tokens=${translation.usage.totalTokens}`);

    return true;
  }

  private async sendTranslatedCopy(
    original: ParsedMail,
    translation: Awaited<ReturnType<typeof translateParsedMail>>,
  ): Promise<void> {
    const recipientAddresses = getReplyRecipients(original);

    if (recipientAddresses.length === 0) {
      throw new Error("Could not determine a reply recipient for the message");
    }

    const references = normalizeReferences(original.references, original.messageId);
    const subject = buildThreadSubject(original.subject, translation.translatedSubject);
    const fromDisplayName = original.from?.text ? `Translated: ${original.from.text}` : "Translated email";

    const mailOptions: SendMailOptions = {
      from: {
        name: fromDisplayName,
        address: this.config.smtp.user,
      },
      to: recipientAddresses.join(", "),
      subject,
      text: translation.translatedText ?? original.text ?? "",
      html: translation.translatedHtml,
      attachments: original.attachments.map((attachment) => mapAttachment(attachment)),
      inReplyTo: original.messageId,
      references,
      headers: {
        [AUTO_TRANSLATED_HEADER]: AUTO_TRANSLATED_MARKER,
        "X-Translated-From-Language": translation.detectedLanguage,
        "X-Translated-To-Language": translation.targetLanguage,
        "X-Original-From": original.from?.text ?? "",
        "X-Original-Subject": original.subject ?? "",
        "Auto-Submitted": "auto-generated",
      },
    };

    await this.transporter.sendMail(mailOptions);
  }
}

async function translateParsedMail(
  parsed: ParsedMail,
  targetLanguage: string,
  translator: OpenRouterClient,
): Promise<{
  detectedLanguage: string;
  targetLanguage: string;
  translatedSubject: string | null;
  translatedText: string | null;
  translatedHtml: string;
  usage: TranslationUsage;
}> {
  const preparedHtml = parsed.html ? prepareHtmlForTranslation(parsed.html) : null;
  const translated = await translator.translateEmail({
    subject: parsed.subject ?? null,
    text: parsed.text ?? null,
    htmlSegments: preparedHtml ? collectHtmlSegments(preparedHtml) : [],
    targetLanguage,
  });

  const translatedHtml = preparedHtml
    ? renderTranslatedHtml(
        preparedHtml,
        translated.translatedHtmlSegments,
        translated.detectedLanguage,
        translated.targetLanguage,
      )
    : textToHtml(translated.translatedText ?? parsed.text ?? "");

  return {
    detectedLanguage: translated.detectedLanguage,
    targetLanguage: translated.targetLanguage,
    translatedSubject: translated.translatedSubject,
    translatedText: translated.translatedText,
    translatedHtml,
    usage: translated.usage,
  };
}

function shouldSkipMessage(parsed: ParsedMail, smtpUser: string): boolean {
  if (parsed.headers.has(AUTO_TRANSLATED_HEADER)) {
    return true;
  }

  const autoSubmitted = getHeaderString(parsed.headers.get("auto-submitted"));

  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
    return true;
  }

  const fromAddresses = flattenAddressObject(parsed.from);

  return fromAddresses.some((address) => address.toLowerCase() === smtpUser.toLowerCase());
}

function determineTargetLanguage(parsed: ParsedMail): string {
  const addressCandidates = new Set<string>();

  for (const address of flattenAddressObject(parsed.to)) {
    addressCandidates.add(address);
  }

  for (const address of flattenAddressObject(parsed.cc)) {
    addressCandidates.add(address);
  }

  for (const headerName of ["delivered-to", "x-original-to", "envelope-to", "resent-to", "resent-cc"]) {
    const headerValue = parsed.headers.get(headerName);

    for (const address of extractAddressesFromHeaderValue(headerValue)) {
      addressCandidates.add(address);
    }
  }

  for (const address of addressCandidates) {
    const match = address.match(/^[^+@]+[+](?<language>[^@]+)@/i);
    const language = match?.groups?.language;

    if (language) {
      return decodeLanguageToken(language);
    }
  }

  return "English";
}

function decodeLanguageToken(token: string): string {
  return decodeURIComponent(token).replaceAll(/[._-]+/g, " ").trim() || "English";
}

function flattenAddressObject(value: ParsedMail["to"] | ParsedMail["cc"] | ParsedMail["bcc"] | ParsedMail["from"] | ParsedMail["replyTo"]): string[] {
  if (!value) {
    return [];
  }

  const objects = Array.isArray(value) ? value : [value];
  const addresses: string[] = [];

  for (const object of objects) {
    if (!("value" in object)) {
      continue;
    }

    for (const item of object.value) {
      if (item.address) {
        addresses.push(item.address);
      }
    }
  }

  return addresses;
}

function extractAddressesFromHeaderValue(value: HeaderValue | undefined): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return extractEmailAddresses(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractAddressesFromHeaderValue(item as HeaderValue));
  }

  if (value instanceof Date) {
    return [];
  }

  if ("text" in value) {
    return extractEmailAddresses(value.text);
  }

  if ("value" in value) {
    return [];
  }

  return [];
}

function extractEmailAddresses(input: string): string[] {
  return Array.from(input.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi), (match) => match[0]);
}

function getHeaderString(value: HeaderValue | undefined): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if ("text" in value) {
    return value.text;
  }

  if ("value" in value) {
    return value.value;
  }

  return null;
}

function formatAddressHeader(value: AddressObject | undefined): string | undefined {
  return value?.text || undefined;
}

function originalSenderLabel(parsed: ParsedMail): string {
  const firstAddress = parsed.from?.value[0];

  if (firstAddress?.address) {
    return firstAddress.name ? `${firstAddress.name} <${firstAddress.address}>` : firstAddress.address;
  }

  return parsed.from?.text || "unknown sender";
}

function getReplyRecipients(parsed: ParsedMail): string[] {
  const replyToAddresses = flattenAddressObject(parsed.replyTo);

  if (replyToAddresses.length > 0) {
    return uniqueAddresses(replyToAddresses);
  }

  return uniqueAddresses(flattenAddressObject(parsed.from));
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const address of addresses) {
    const normalized = address.trim().toLowerCase();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(address);
  }

  return unique;
}

function normalizeReferences(
  references: ParsedMail["references"],
  messageId: string | undefined,
): string[] | string | undefined {
  const values = new Set<string>();

  for (const reference of Array.isArray(references) ? references : references ? [references] : []) {
    values.add(reference);
  }

  if (messageId) {
    values.add(messageId);
  }

  if (values.size === 0) {
    return undefined;
  }

  return Array.from(values);
}

function buildThreadSubject(
  originalSubject: string | undefined,
  translatedSubject: string | null,
): string {
  const baseSubject = originalSubject?.trim() || translatedSubject?.trim() || "Translated email";

  if (/^re\s*:/i.test(baseSubject)) {
    return baseSubject;
  }

  return `Re: ${baseSubject}`;
}

function mapAttachment(attachment: Attachment): NonNullable<SendMailOptions["attachments"]>[number] {
  const contentDisposition =
    attachment.contentDisposition === "inline" || attachment.contentDisposition === "attachment"
      ? attachment.contentDisposition
      : undefined;

  return {
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.contentType,
    contentDisposition,
    cid: attachment.cid,
  };
}

async function withMailboxLock<T>(
  client: ImapFlow,
  path: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path);

  try {
    return await callback();
  } finally {
    lock.release();
  }
}

async function waitForClientShutdown(client: ImapFlow): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const closeListener = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error("IMAP connection closed"));
    };
    const errorListener = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      client.off("close", closeListener);
      client.off("error", errorListener);
    };

    client.on("close", closeListener);
    client.on("error", errorListener);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
