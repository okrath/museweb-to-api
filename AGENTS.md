# AGENTS.md — working agreement for AI implementers

## What this repo is

`museweb-to-api`: a local gateway that exposes a signed-in muse.ai browser session as
OpenAI- and Anthropic-compatible HTTP APIs. One Node process, one persistent Chromium
profile, a few tabs. No MCP, no tool calling, no admin console.

Design references: `docs/architecture.md` (request flow) and `docs/muse-driver.md`
(how the browser driver reads the page and how to recalibrate it).

## Non-negotiables

- Contracts in `src/core/types.ts` (`ChatRequest`, `TurnEvent`, `MuseDriver`) are the seam
  between HTTP and browser. Change them deliberately and update the fake driver in
  `tests/helpers/fake-driver.ts`.
- Every DOM assumption lives in `src/muse/selectors.ts`. Do not scatter selectors or text
  patterns through the driver.
- Pure logic stays pure: `turn-reader.ts`, `render-transcript.ts`, stores and protocol modules
  take plain values and are unit-tested without Playwright.
- Fail explicitly. A missing selector, an unselectable mode or a signed-out profile is an error
  with a hint, never a silent fallback to a different mode or transport.
- Do not retry, rotate or otherwise work around Muse usage limits.
- KISS: plain functions and small modules, no `*Manager`/`*Engine`, no base classes with one
  subclass. Files stay under ~300 lines.
- Real behaviour only: no mocks or fake data in `src/`. Tests use the scripted fake driver.
- Never commit `.env`, `data/`, the browser profile or an API key.

## Layout

```
src/
  index.ts  config.ts  server.ts
  core/types.ts        shared contracts
  auth/                single client API key
  protocol/            normalize-*, serialize-*, models, errors, sse
  router/              route-request, slots, event-channel
  sessions/  cache/    JSON-backed stores
  store/json-store.ts  atomic debounced JSON map
  prompt/              transcript rendering
  muse/                browser, page-driver, page-scripts, turn-reader, selectors, markdown, login, probe
tests/                 vitest: protocol, stores, reader logic, HTTP e2e with the fake driver
docs/                  architecture, driver calibration
```

## Commands

```
pnpm install && pnpm browser:install
pnpm muse:login                 # sign in once (visible window)
pnpm muse:probe --send "text"   # calibrate selectors against the live page
pnpm dev / pnpm start
pnpm lint / pnpm test / pnpm build
```

## Definition of done

1. `pnpm lint`, `pnpm test`, `pnpm build` are green.
2. User-visible behaviour, config or endpoints changed → README and the owning doc updated.
3. Commits are focused, conventional-commit style, without AI attribution lines.
