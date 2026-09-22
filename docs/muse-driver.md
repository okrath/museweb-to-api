# Muse driver: how it reads the page and how to recalibrate it

`src/muse/selectors.ts` holds every DOM assumption. It was calibrated against the live muse.ai
web app on 2026-09-21 with `pnpm muse:probe`; the generic fallbacks after each calibrated
selector keep the driver limping (and the probe report useful) when Muse renames something.

## What the Muse web app looks like

- **Composer**: `textarea[aria-label="Message"]`. `button[aria-label="Send"]` appears once it
  holds text; `button[aria-label="Stop"]` is visible while Muse generates.
- **Chats**: one *main chat* at `/` (the user's own, continuous conversation with their agent)
  and *side chats* at `/thread/<uuid>`. `/thread/new` opens a draft side chat; the first message
  turns it into a real thread. The gateway never writes into the main chat: every new API
  conversation starts at `/thread/new`, and the resulting thread URL is the conversation id
  stored for follow-ups. Side chats therefore accumulate in the user's panel, one per API
  conversation; `thread-cleanup.ts` deletes the oldest ones after each new-thread turn to keep
  at most `MAX_SIDE_THREADS` (calibrated 2026-09-22).
- **Deleting a side chat**: hover its row to reveal `button[aria-label="More thread actions"]`
  (Radix dropdown; hidden by CSS until the row is hovered or focused, so a single `.hover()` can
  miss it on a busy/re-rendering panel — retry). Its menu holds `Pin` / `Rename` / `Archive` /
  `Delete`, each a plain `[role="menuitem"]` matched by text. Delete opens a confirm dialog
  (`[role="dialog"]` or `[role="alertdialog"]`, text containing "delete") with its own `Delete`
  button. The panel is virtualised beyond roughly 50 rows: rows past that need scrolling into
  view before they exist in the DOM, which `thread-cleanup.ts` avoids by staying under the cap
  instead of ever needing to find a row far down the list.
- **Messages**: `[data-message-item]` with `data-message-role="user|assistant"` and a stable
  `data-message-id`. The assistant bubble is `[data-hatch-assistant-message-body]`; the rendered
  Markdown sits in a `.prose` container inside it. User items carry an sr-only "You:" label and,
  when the agent VM did not accept the message, the notes "Delivery not confirmed" /
  "Message failed to send." (`deliveryFailurePattern`).
- **Transport**: the page talks to the user's Muse VM over `wss://hatch.metaaivm.com/v1/noise`;
  `POST /api/hatch/vm/wake` wakes it. Replies stream over that socket, not over GraphQL.
- **Mode picker**: none was found on the web UI (`modeLike: 0` in every probe). Models other
  than `muse` therefore fail with an explicit error until `modeMenuButton`/`modeOption` match
  something real.

## How a turn runs

New conversation (`/thread/new`):

1. Make sure the side-chat panel is open (`threadPanel`, `threadPanelTrigger`) and remember the
   rows (`threadRow`). New side chats are created one at a time per process so two parallel turns
   cannot claim each other's row.
2. Type and send. Muse's behaviour here varied within one day: at first the draft page kept its
   URL and never rendered the reply; later it re-routed to `/thread/<uuid>` and rendered the reply
   in place. The driver handles both: it polls the panel for a changed top row (the panel is a
   virtualised list, so a new thread changes the top row rather than the row count) and, at the
   same time, watches the draft page for a reply after the posted prompt.
3. When a row changed, the driver clicks the newest rows (up to three) until one holds a user
   item echoing the prompt; a thread opened right after creation often shows "Something went
   wrong", so it waits up to 15 s for the transcript and reloads up to three times. When the reply
   showed up on the draft page instead, it reads it there and then takes the conversation id from
   the URL, or from the panel row that holds the prompt. The thread URL becomes the conversation id.

Follow-up (`/thread/<uuid>` from the session store): navigate if the tab is elsewhere, type,
send, read.

## How the reply is read

1. Before sending, every element under `conversationRoot` is tagged `data-mta-seen`.
2. The snapshot script finds the last user item whose text contains the prompt head and takes the
   `assistantMessage` items that follow it in document order, using the last rendered one
   (width/height above 2 px, non-empty `innerText`). Without a posted user item it falls back to
   items containing untagged nodes, and without any explicit selector to "fresh subtrees minus
   composer, echo and chrome".
3. `strip` selectors are removed from a clone of the reply before turndown converts it to
   Markdown; `DeltaStreamer` streams finished paragraphs only.
4. Completion (`turn-reader.ts#decide`): non-empty text, no `stopButton` visible, and 1.5 s of
   quiet (4 s if no stop button was ever seen). Alerts matching `rateLimitPattern` become `429`;
   `upstreamErrorPattern` before any text becomes `502`. A timeout message includes whether the
   prompt was posted, any delivery note under it, and the page's visible alerts.
5. Signed-out detection: landing on `auth.muse.ai`/`facebook.com`, or, because muse.ai bounces
   a signed-out visitor back to its own landing page, no composer plus a visible "Log in" button
   three seconds after load (`signedOutButtonPattern`). Both become `502 upstream_auth`.

## Calibrating with `pnpm muse:probe`

```bash
pnpm muse:login                                   # once
pnpm muse:probe                                   # DOM inventory only
pnpm muse:probe --send "Reply with: READY"        # full traced turn in a fresh side chat
pnpm muse:probe --headed --send "..."             # same, with a visible window
```

Each run writes `DATA_DIR/probe-<timestamp>/` containing `report.json` and numbered
screenshots (`01-loaded.png`, `..-submitted.png`, one per 5 s of polling, `..-final.png`):

- `dom.composers`, `dom.buttons`, `dom.messages`, `dom.modeLike` — what the selectors matched.
- `turn.trace` — one entry per stage and per changed poll: `url`, `stopVisible`,
  `promptPosted`, `deliveryStatus`, `candidates`, `candidateSummaries` (tag, class, message id,
  visibility, text head of every reply candidate), `text`, `alerts`.
- `turn.events` — what the API client would have received.
- `network` — fetch calls to Meta hosts (method, URL, post-body head).
- `sockets` — every WebSocket with the first 60 frame heads and its close time. A socket that
  closes every few seconds while `consoleErrors` shows `GatewayRequestError` is a Muse VM
  problem, not a selector problem.
- `consoleErrors` — the page's own error log.

## Things most likely to need a change

| Symptom | Where to look |
|---|---|
| `502 Muse composer not found` although signed in | `selectors.composer`; check `dom.composers` |
| Prompt typed but nothing posted (`promptPosted: false`) | `selectors.sendButton`; the driver otherwise presses Enter |
| Reply cut off early | `stopButton` never matched, so completion used the 4 s quiet rule |
| Reply contains "Copy" / toolbar text | add the control's selector to `strip` |
| Wrong node picked as the reply | compare `candidateSummaries`; tighten `assistantMessage` |
| `mode "thinking" could not be selected` | `modeMenuButton` / `modeOption` / `modeLabels`; the web UI may simply not expose a picker |
| Follow-ups never reuse the chat (`x-mta-session-reused: 0`) | the URL stayed on `/thread/new` after the reply; check `turn.trace[*].snapshot.url` and `conversationIdFromUrl` |
| `504 Muse did not create a side chat … in time` while the reply is visible in the Muse UI | the panel changed in a way the driver did not recognise; compare the `threadRow` texts in `trace` before and after, and check `threadPanel`/`threadRow` selectors |
| Side chats keep growing past `MAX_SIDE_THREADS`, or a `"Side-chat cleanup skipped"` warning appears | `threadRowMenuButton`/`threadDeleteConfirmDialog` in `selectors.ts`, or the `Delete` wording matched by `threadDeleteItemPattern`/`threadDeleteConfirmPattern`; cleanup is best-effort and only logs a warning, it never fails the turn |
| Timeout with `Delivery not confirmed` and many short-lived sockets | Muse's VM rejected the message; see the note below |

## Known Muse-side failure: oversized main chat

Muse subscribes to the whole main-chat record when the page loads. Once that record exceeds
4 MB (for example after pasting very long texts into the main chat) the page logs
`Noise response exceeded 4194304-byte limit for chat.subscribe`, the VM socket reconnects in a
loop, `chat.stream send` fails, and every message, in any side chat, shows "Delivery not
confirmed". Replies may still arrive minutes later once the VM catches up. The fix is on the
Muse side: type `/clear` in the main chat (Muse wipes the conversation and answers "Đã xóa cuộc
trò chuyện." / "Conversation cleared"), or delete the oversized messages one by one via the
message context menu. Measured on 2026-09-21: before the cleanup a new conversation took 55 s
and every socket died within ~2.5 s; after it, 5–7 s in the probe and about 11 s through the
gateway, with one stable socket. The gateway reports the degraded state as `504 upstream_timeout`
with the delivery note in the message rather than retrying, which would only add to the backlog.

## Running the browser

- `HEADLESS=false` shows the tabs; useful while calibrating.
- `BROWSER_CHANNEL=chrome` uses the installed Google Chrome instead of Playwright's Chromium.
  Sign in again after switching: the profile directory is the same, but Chrome and Chromium keep
  separate cookie encryption on Windows.
- The profile in `DATA_DIR/browser-profile` is the login. `pnpm muse:login` can be rerun any time
  the gateway reports `upstream_auth`.
