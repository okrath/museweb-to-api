# museweb-to-api — initial build

Status: implemented and calibrated against the live muse.ai web app (2026-09-21); mode picker not available on the web UI.

## Outcome

Expose a signed-in muse.ai web session as OpenAI- and Anthropic-compatible HTTP APIs, reusing
the same Muse conversation across follow-up requests (so Muse's prompt cache hits) and serving
identical requests from a local response cache.

## Constraints

- No MCP / tool calling.
- Browser automation over the web UI (Muse has no composer length limit); no credential handling.
- Patterns borrowed from `cli-to-api` (protocol layer, fingerprinted session reuse, cache,
  API key auth) and from `codex-chatgpt-web` (DOM-driven turn with stable-text completion,
  Markdown conversion, explicit failure on UI drift).
- KISS: one package, JSON stores, no database or admin console.

## Non-goals

- Images, files, tools, token usage accounting.
- Multiple Muse accounts, load balancing, cooldown rotation.

## Acceptance criteria

- [x] `POST /v1/chat/completions` and `POST /v1/messages`, streaming and non-streaming, behind one API key.
- [x] Follow-up request with matching history continues the same Muse chat and sends only the newest user message (`x-mta-session-reused: 1`).
- [x] Identical request within `CACHE_TTL_SEC` is served from cache without a browser turn.
- [x] Requests with tools fail with `400 tools_unsupported`; unknown models `404`; signed-out profile `502 upstream_auth`; usage limit `429`; busy tabs `503`; hung page `504`.
- [x] `pnpm muse:login` and `pnpm muse:probe` exist for sign-in and selector calibration.
- [x] `pnpm lint`, `pnpm test`, `pnpm build` green.
- [x] Live turn verified against muse.ai: `pnpm muse:probe --send` returns the reply and a `/thread/<uuid>` conversation id.
- [ ] Mode selection (`muse-spark-*` models): the web UI exposed no picker; fails explicitly until one exists.

## Phases

1. Scaffold + protocol layer + stores + router — done.
2. Browser driver (browser, page scripts, reader, driver, login, probe) — done.
3. Tests + docs — done.
4. Live calibration — done 2026-09-21. Findings recorded in `docs/muse-driver.md`: side chats via
   `/thread/new`, draft page never renders the reply, `[data-message-item]` markup, VM delivery
   failures when the main chat exceeds the 4 MB subscription limit.

## Risks

- Muse DOM changes → driver fails explicitly; fix in `src/muse/selectors.ts` with `pnpm muse:probe`.
- Muse VM instability (oversized main chat, "Delivery not confirmed") → slow or timed-out turns;
  Muse-side fix.
- Side chats accumulate one per API conversation in the user's panel.
