# museweb-to-api

A local gateway that turns your signed-in [muse.ai](https://muse.ai) web session into
OpenAI- and Anthropic-compatible HTTP APIs. Clients such as the official SDKs, Cursor,
Continue or any chat UI talk to `http://127.0.0.1:8090/v1`; the gateway drives a real
browser tab on muse.ai for them.

Why the web UI instead of the Meta Model API: the Muse composer has no input length limit and
Muse keeps the whole conversation server-side. The gateway leans on both:

- **Same conversation, same session.** A follow-up request whose history matches a previous
  response is sent into the *same* Muse chat as just the newest user message. Muse answers
  from its own history and prompt cache instead of re-reading the whole transcript.
- **Response cache.** An identical request (model, mode, messages) inside the cache TTL is
  answered from disk without touching the browser.
- **Warm side-chat pool.** The gateway pre-creates idle side chats so new API conversations
  can use the faster follow-up path. Set `WARM_THREADS=0` to disable it.
- **Prompt-emulated tool calling.** Function definitions are described to Muse in the prompt;
  fenced JSON replies become normal OpenAI `tool_calls` or Anthropic `tool_use` responses.

Requires Node.js 22+, pnpm, and a Meta account that can use Muse (US rollout at the time of
writing). Unofficial browser automation: Muse UI changes can break the driver, and
`src/muse/selectors.ts` is the single place to fix that.

## Quick start

```bash
pnpm install
pnpm browser:install         # Playwright Chromium; skip if you set BROWSER_CHANNEL=chrome
cp .env.example .env
pnpm muse:login              # opens a window; sign in to Muse once
pnpm muse:probe --send "Say hi"   # optional: verify the driver against the live page
pnpm build && pnpm start     # gateway on http://127.0.0.1:8090
```

The first start prints where it wrote the client API key (`data/api-key.txt`) unless
`API_KEY` is set in `.env`.

```bash
curl -s http://127.0.0.1:8090/v1/chat/completions \
  -H "Authorization: Bearer $(cat data/api-key.txt)" \
  -H "Content-Type: application/json" \
  -d '{"model":"muse","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Using it with client SDKs

Point any OpenAI- or Anthropic-compatible client at the gateway with the key from
`data/api-key.txt` (or your own `API_KEY`).

**OpenAI Python SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8090/v1", api_key=open("data/api-key.txt").read().strip())
resp = client.chat.completions.create(model="muse", messages=[{"role": "user", "content": "Hello"}])
print(resp.choices[0].message.content)
```

**OpenAI Node SDK**

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8090/v1", apiKey: "<key from data/api-key.txt>" });
const resp = await client.chat.completions.create({ model: "muse", messages: [{ role: "user", content: "Hello" }] });
console.log(resp.choices[0].message.content);
```

**Anthropic Python SDK**

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8090", api_key=open("data/api-key.txt").read().strip())
resp = client.messages.create(model="muse", max_tokens=1024, messages=[{"role": "user", "content": "Hello"}])
print(resp.content[0].text)
```

Editor tools such as Cursor or Continue: set their OpenAI-compatible base URL to
`http://127.0.0.1:8090/v1` and the API key to the same value; pick any `muse*` model id from
the table below.

## Models

| Model id | Muse mode |
|---|---|
| `muse` | whatever the web UI currently has selected; `reasoning_effort` (`low` → Instant, `high` → Thinking, `xhigh` → Contemplating) refines it |
| `muse-spark` | Instant |
| `muse-spark-thinking` | Thinking |
| `muse-spark-contemplating` | Contemplating |

Selecting a mode relies on the mode picker selectors in `src/muse/selectors.ts`. The web UI
exposed no mode picker when this was calibrated, so the three `muse-spark-*` models currently
fail with an explicit error; use `muse` until a picker is found (see
[docs/muse-driver.md](docs/muse-driver.md)).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/healthz` | no auth; includes browser status |
| `GET` | `/v1/models` | OpenAI shape, or Anthropic shape when `anthropic-version` is sent |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions, streaming and non-streaming |
| `POST` | `/v1/messages` | Anthropic Messages, streaming and non-streaming |
| `GET` | `/v1/usage` | Muse's own account quota (Settings > General), not token counts |

Auth: `Authorization: Bearer <key>` or `x-api-key: <key>`.

`GET /v1/usage` reads the two usage meters Muse shows under Settings > General (a weekly plan
quota and any additional tokens) by opening that dialog in a browser tab and closing it again:

```json
{
  "entries": [
    { "label": "Free plan", "detail": "Weekly limit resets on Sep 28", "usedText": "20% used", "percentUsed": 20 },
    { "label": "Additional tokens", "detail": "Never expires", "usedText": "0% used (3B tokens left)", "percentUsed": 0 }
  ]
}
```

Response headers on every chat request: `x-mta-request-id`, `x-mta-model`, `x-mta-mode`,
`x-mta-session-reused` (`1` when the turn continued an existing Muse chat),
`x-mta-cache-hit`, `x-mta-warm-thread` (`1` when a pre-created side chat was used), and
`x-mta-conversation-id` when a resumed or cached Muse chat URL is known up front.

Not supported: `response_format`, token usage (reported as zero where the wire format requires
it).

## Attachments

Images, video and other files can be attached to the newest message of a request; the gateway
writes them to the real Muse composer before sending, the same as dragging a file in on
muse.ai. Only inline base64 is accepted (no remote URLs), and only on the last message — Muse
has no way to retroactively attach a file to an earlier turn.

**OpenAI dialect**

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is this?" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } },
    { "type": "file", "file": { "filename": "clip.mp4", "file_data": "data:video/mp4;base64,..." } }
  ]
}
```

**Anthropic dialect**

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is this?" },
    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } },
    { "type": "file", "source": { "type": "base64", "media_type": "video/mp4", "data": "..." }, "filename": "clip.mp4" }
  ]
}
```

`image` and `document` (PDF) are Anthropic's own block types; `file` is a gateway-specific
extension for anything else (video, and any other file Muse's own upload UI accepts), mirrored
on the OpenAI side since neither vendor defines a video content type. See
[docs/muse-driver.md](docs/muse-driver.md) for the DOM selectors involved and their calibration
status.

## Tool calling

OpenAI `tools` and Anthropic `tools` are rendered into a new Muse thread as functions the
program can run. Muse is asked to request a function by replying with one fenced `json` block
per call, for example:

```json
{"name": "read_file", "arguments": {"path": "notes.txt"}}
```

The gateway removes those blocks from streamed text and returns standard `tool_calls` or
`tool_use` events. Send the assistant call and the resulting tool messages back in the next
request to continue the same Muse conversation. This is prompt emulation: success depends on
the model following the format, and the gateway does not perform JSON Schema validation beyond
requiring an object for parsed arguments. Requests with active tools bypass the response cache.

Measured on 2026-09-21, Muse requested the function in about five of six eligible turns and
answered the rest directly from its own abilities; when a call is mandatory, send
`tool_choice: "required"` (or a specific function). Muse is a personal agent with its own
persona: very long harness-style system prompts (for example omp's default prompt) are refused
as suspected injections, so keep client system prompts short.

## Sessions and cache

Muse has one *main chat* plus *side chats*. The gateway never touches the main chat: every new
API conversation starts a fresh side chat (`/thread/new`) and the resulting thread URL becomes
the conversation id, so parallel API conversations stay isolated from each other and from the
user's own chatting. Side chats therefore pile up in the Muse panel, one per API conversation.

Every completed response is fingerprinted from the `x-conversation-id` header (or the OpenAI
`user` / Anthropic `metadata.user_id` field), the function definitions when present, plus the
full message list including the reply.
A later request whose messages *before* the newest user message hash to a stored fingerprint
continues that Muse conversation and types only the newest message. The match breaks when the
client edits earlier messages, changes the system prompt, or switches mode; the request then
starts a fresh chat with the whole transcript rendered into one prompt. If a stored Muse chat
can no longer be opened, the gateway retries once as a fresh chat before reporting an error.

Every new API conversation adds one side chat to the panel; after each one the gateway deletes
the oldest side chats down to `MAX_SIDE_THREADS` (10) so the panel does not grow without bound.
This is best-effort: a failed cleanup only logs a warning and never fails the turn that
triggered it. Deleting one that a client still has cached simply falls back to a fresh chat on
its next use.

Multi-turn clients should send `x-conversation-id` so two users with identical histories do
not share a Muse chat. Sessions expire after `SESSION_TTL_SEC` (default one day; `0` disables
reuse). The response cache is exact-match on model, mode, `max_tokens` and messages and lives
`CACHE_TTL_SEC` seconds (default 300; `0` disables); requests with active tools never use it.
The warm side-chat pool is stored in
`warm-threads.json` in `DATA_DIR`; entries expire with `SESSION_TTL_SEC` and refill in the
background after startup and completed turns. It is inactive when `SESSION_TTL_SEC=0`. Both the
pool and the other stores are JSON files in `DATA_DIR`.

## Configuration

See [`.env.example`](.env.example). The important knobs:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8090` / `127.0.0.1` | loopback listener |
| `DATA_DIR` | `./data` | browser profile, API key, sessions, cache, probe reports |
| `API_KEY` | generated | client key; generated into `DATA_DIR/api-key.txt` when empty |
| `HEADLESS` | `true` | set `false` to watch the browser |
| `BROWSER_CHANNEL` | Playwright Chromium | `chrome` or `msedge` to use an installed browser (needed if a Windows Application Control / AppLocker policy blocks Playwright's downloaded Chromium: `launchPersistentContext: spawn UNKNOWN` / "An Application Control policy has blocked this file") |
| `MAX_CONCURRENT_TURNS` | `2` | browser tabs, and therefore parallel requests |
| `WARM_THREADS` | `1` | idle side chats to keep ready; `0` disables; set `MAX_CONCURRENT_TURNS` one higher than desired client concurrency when enabled |
| `QUEUE_TIMEOUT_SEC` | `30` | wait for a free tab before answering `503` |
| `REQUEST_TIMEOUT_SEC` | `900` | hard ceiling per turn (`504`) |
| `STALL_TIMEOUT_SEC` | `180` | quiet time while generating that counts as hung |
| `SESSION_TTL_SEC` | `86400` | conversation reuse window |
| `CACHE_TTL_SEC` | `300` | exact-match response cache |

## Errors

| Status | When |
|---|---|
| `401` | missing or wrong API key |
| `400 invalid_request_error` | malformed content, function definitions, or tool results |
| `404 model_not_found` | unknown model id |
| `429` | Muse showed a usage-limit message; `Retry-After` is set |
| `502 upstream_auth` | the browser profile is not signed in; run `pnpm muse:login` |
| `502` | the page did not behave as the driver expects; run `pnpm muse:probe` |
| `503 queue_timeout` | all tabs busy past `QUEUE_TIMEOUT_SEC` |
| `504 upstream_timeout` | no reply started, generation stalled, or the hard timeout hit |

## Development

```bash
pnpm dev      # gateway from source with reload
pnpm lint     # tsc --noEmit
pnpm test     # vitest: protocol, stores, reader logic, HTTP e2e with a scripted driver
pnpm build
```

Read [docs/architecture.md](docs/architecture.md) for the request flow and
[docs/muse-driver.md](docs/muse-driver.md) for how the browser driver reads the page and how
to recalibrate it after a Muse UI change.

This is independent software, not affiliated with or endorsed by Meta. Use it only with your
own account and within Meta's terms; it does not bypass authentication.
