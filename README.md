# 2026-04-16-email-translate

A terminal-only Bun worker that:

- watches `INBOX` over IMAP
- translates it with OpenRouter
- replies through SMTP
- preserves threading headers, reply routing, attachments, and the original HTML structure as closely as possible

## Install

```bash
bun install
```

## Environment

Copy `.env.example` and fill in your values.

## Run

```bash
bun run start
```

## Behavior

- If no `+language` suffix is found in recipient addressing, translation defaults to English.
- Example: `translate+croatian@example.com`
- New mail is picked up via IMAP `IDLE` with a short fallback sync loop.
- Replies are sent to the original `Reply-To`, or `From` if `Reply-To` is missing.
- Original inbound emails are marked `\Seen` only after a successful translate-and-send flow.

## Output

Normal terminal output is intentionally minimal:

- `unread on startup: N`
- `processed from Name <email@example.com>, tokens=123`

Failures are printed as errors.
