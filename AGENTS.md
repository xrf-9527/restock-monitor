# AGENTS.md

This repository follows the open **AGENTS.md** guidance format: https://agents.md

## Project

Cloudflare Worker restock monitor (Cron + KV + optional HTTP endpoints).

- Entry: `src/index.ts` (`fetch`, `scheduled`)
- Monitoring/state machine: `src/monitor.ts`
- Notifications: `src/notifiers.ts`
- Shared types: `src/types.ts`
- Architecture notes: `docs/architecture.md`

## Runtime constraints (Cloudflare Workers)

- Do not introduce Node.js-only APIs or dependencies.
- Prefer Web Platform APIs available in Workers (`fetch`, `URL`, `AbortController`, `crypto.subtle`, `TextEncoder`).

## Common commands

- Install: `npm install`
- Dev server: `npm run dev`
- Typecheck: `npx tsc --noEmit`
- Deploy: `npm run deploy`

## Configuration & secrets

- Non-sensitive defaults live in `wrangler.toml` under `[vars]` (values are strings).
- Secrets must be configured via `wrangler secret put` (never commit secrets).
- Local dev: copy `.dev.vars.example` to `.dev.vars` (kept out of git by `.gitignore`).
- KV binding `STOCK_STATE` is required for persistence.

## Code conventions

- Keep changes small and focused; follow existing formatting (4-space indent, semicolons).
- Maintain the anti-false-positive checks (sanity check + confirm delay + streak thresholds) unless explicitly changing alert semantics.
- Notification sending must be best-effort: one channel failure must not block other channels.
- If you add/rename endpoints, config vars, or alert logic, update `README.md` and `docs/architecture.md`.

