# Architecture

```text
OpenAI / Anthropic client
      │ HTTP on 127.0.0.1:8090/v1
      ▼
Fastify gateway (src/server.ts)
  ├─ api/          normalize request → ChatRequest, serialize TurnEvents → wire format, SSE
  ├─ router/       response cache → session lookup → turn slot → driver → store session/cache
  ├─ sessions/     fingerprint(history) → Muse conversation URL   (JSON file)
  ├─ cache/        exact-match response cache                      (JSON file)
  └─ muse/         Playwright driver over one persistent Chromium profile
                     ├─ browser.ts      profile + tab pool
                     ├─ page-driver.ts  open chat → pick mode → type → send → read reply
                     ├─ page-scripts.ts code that runs inside the page
                     ├─ turn-reader.ts  pure streaming / completion rules
                     ├─ selectors.ts    every DOM assumption
                     └─ markdown.ts     reply HTML → Markdown
```

## Request flow

1. **Normalize.** `protocol/normalize-openai.ts` and `normalize-anthropic.ts` validate the
   body with zod and produce one `ChatRequest` (`core/types.ts`): text messages with an
   optional leading system message, normalized function definitions and call/result messages,
   the model id, an effort hint, and a conversation hint from `x-conversation-id` / `user` /
   `metadata.user_id`. Images and `response_format` are rejected with explicit 400s.
2. **Resolve the model.** `protocol/models.ts` maps the model id (plus effort for `muse`) to a
   Muse composer mode.
3. **Cache.** `cache/response-cache.ts` keys on model, mode, `max_tokens`, the function
   definition hash and the exact messages. A hit replays the stored text as events and never
   touches the browser. Requests with active functions bypass the cache.
4. **Session.** `sessions/session-store.ts` hashes the conversation hint, function definition
   hash and every message before the newest user or function-result message. A stored row with
   the same mode yields the Muse conversation URL to continue. `prompt/render-transcript.ts`
   renders only the newest user message, or the latest function results plus the next user
   message; otherwise it renders the whole transcript into one prompt (Muse has no composer
   limit). A fresh prompt places `prompt/tool-protocol.ts` after the system section.
5. **Warm pool and slot.** `router/warm-pool.ts` keeps pre-created side-chat ids in
   `warm-threads.json` and refills the pool in the background after the listener starts. A new
   request with no resumable session takes one ready id and sends the full transcript into that
   side chat; the pool refills in parallel. `router/slots.ts` is a counting semaphore sized
   `MAX_CONCURRENT_TURNS`; waiting longer than `QUEUE_TIMEOUT_SEC` yields `503`.
6. **Turn.** `router/route-request.ts` runs `driver.runTurn` and bridges its callback events into
   an async iterable (`router/event-channel.ts`). When functions are active, the router holds text
   from the first possible fenced block (including the observed detached `json` line), parses
   the complete Markdown at `done`, and emits cleaned text, function-call events, and a
   `tool_use` stop reason. A resumed turn, or a turn using a warm side chat, is held back until
   its first content delta; if it fails before that (for example the Muse
   chat no longer opens) the router deletes the dead session or warm entry and reruns the request
   as a fresh chat, so the client never sees the failed attempt. Rate-limit and sign-in failures
   are not retried.
7. **Finish.** On success the router stores the new fingerprint (history + reply → conversation
   URL) and the cache body. The serializers stream `TurnEvent`s as OpenAI chunks or Anthropic
   SSE events; a failure before any content becomes a proper HTTP status, a failure after
   content becomes an in-stream error frame.

## Browser driver

`muse/browser.ts` launches one `launchPersistentContext` on `DATA_DIR/browser-profile`. The
profile holds the Muse sign-in created by `pnpm muse:login`; the gateway never handles credentials.
Up to `MAX_CONCURRENT_TURNS` tabs share it. A resumed turn prefers a tab already parked on that
conversation URL, avoiding a navigation.

`muse/page-driver.ts#executeTurn` performs one turn:

1. Navigate to the conversation URL (a Muse side chat, `/thread/<id>`) or to `/thread/new` for a
   new conversation, and wait for the composer. Landing on `auth.muse.ai` or `facebook.com`, or on
   Muse's signed-out landing page, means the profile is signed out → `auth` error.
2. Select the mode unless the model is `muse`.
3. Tag every element under the transcript root with `data-mta-seen`.
4. Fill the composer (`fill`, falling back to `insertText`) and verify the page kept the whole
   prompt.
5. Click the send button (or press Enter) and wait for the composer to clear, a stop button, or a
   new reply node. For a new conversation the draft page never shows the reply: the driver waits
   for the new side chat to appear in the panel, opens it (reloading if Muse shows "Something went
   wrong") and reads the reply there. See `docs/muse-driver.md`.
6. Poll the page every 250 ms. The snapshot script takes the assistant items that follow the
   posted user message and returns the last rendered one as the reply.
   `turn-reader.ts` decides when the reply is complete (stop button gone and text quiet) and
   `DeltaStreamer` turns successive Markdown renderings into append-only deltas, committing
   only finished paragraphs so partially rendered formatting never reaches the client.
7. Flush the final Markdown, emit the conversation URL, and finish.

All timeouts come from config: first token 120 s, `STALL_TIMEOUT_SEC` while generating,
`REQUEST_TIMEOUT_SEC` overall.

## Storage

`DATA_DIR` holds `browser-profile/` (sensitive: it authorizes Muse access), `api-key.txt`
(mode 0600), `sessions.json`, `response-cache.json`, `warm-threads.json` and `probe-*/`
reports. Stores are debounced atomic JSON writes (`store/json-store.ts`); expired rows are
pruned hourly and on start.

## Security notes

- The listener binds to loopback by default and requires one bearer key. Another process under
  the same OS user can read `data/`; treat the machine as single-user.
- Never copy, sync or commit `data/browser-profile`. Sign out from Muse if it leaks.
- The gateway does not retry or rotate anything to evade Muse usage limits: a limit message
  becomes `429` with `Retry-After`.
- Prompts and replies are stored on disk only in the response cache (`CACHE_TTL_SEC=0` disables
  it) and in Muse's own conversation history.
