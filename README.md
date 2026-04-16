# 2026-04-16-email-translate

Terminal-only Bun worker that:

- listens to `INBOX` over IMAP `IDLE`
- detects each incoming email
- translates it with OpenRouter
- sends a translated copy back through SMTP
- preserves reply threading, reply-to routing, and original HTML structure as closely as possible

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

## Notes

- If no `+language` suffix is found in recipient addressing, translation defaults to English.
- Example: `translate+croatian@example.com`
- The service uses IMAP `IDLE` instead of 1-second polling.
- Original inbound emails are marked `\Seen` after a successful translated send to avoid duplicate retranslations on restart.
