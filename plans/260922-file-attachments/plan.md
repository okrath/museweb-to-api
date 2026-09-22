# File attachments over the Muse web chat

Status: implemented and verified live, 2026-09-22.

## Live results (2026-09-22)

`pnpm muse:probe --send "What is this?" --attach <1x1 test PNG>` against the user's real,
signed-in muse.ai account: the file uploaded through the real `input[type="file"]`, a preview
thumbnail rendered in the composer (matched by `attachmentPreview`'s generic guesses — no
recalibration needed), and Muse's reply correctly described the image ("Nó là một ảnh PNG chỉ
có 1×1 pixel màu đen..."), proving the browser genuinely received the file rather than just the
text prompt. The visible "attach" control turned out to be `button[aria-label="Attach file"]`;
the driver does not click it (goes straight to the hidden file input) so no change was needed
there. `fileInput`/`attachmentPreview` in `selectors.ts` are now marked calibrated instead of
best-effort guesses.

## Post-ship fix (2026-09-22): composer instability after attaching on a resumed turn

Live use surfaced `locator.evaluate: Timeout 20000ms exceeded ... textarea[aria-label="Message"]`
on a resumed/warm-thread turn with an attachment, which the router correctly retried as a fresh
chat (existing `shouldRetryFresh` logic), but added real latency. Reproduced directly against the
running gateway: a fresh-thread attachment answered in ~20 s every time; the same request
resumed into an existing thread once took 4m37s (succeeded, `x-mta-session-reused: 1`, no retry
needed that time) — consistent with the composer being transiently unstable right after the
attachment's preview renders (layout reflow), which `composer.evaluate()`'s actionability check
can lose the race against. Fix: `typePrompt` in `page-driver.ts` now retries its whole
click-fill-verify sequence once after a 500 ms pause before failing for real — a bounded,
same-page retry, not a Muse-usage-limit workaround. `pnpm lint/test/build` re-verified green
after the change. The extra minutes-scale latency itself, when it isn't a failure, looks like
Muse's own backend being slower to process a new image inside an existing conversation, not
something the driver can fix; documented in `docs/muse-driver.md`.

## Outcome

A client sending an OpenAI `image_url`/`file` content part, or an Anthropic
`image`/`document`/`file` content block, gets that file actually attached to the
Muse composer and sent, instead of the current explicit `400 "only text content
is supported"`. Motivating request: the user wants images and video attached to
a chat turn the same way they can on muse.ai directly.

## Constraints and non-goals

- Inline base64 only (`data:` URLs / base64 `source.data`). No server-side
  fetching of remote URLs — that adds a network/SSRF surface the user did not
  ask for.
- Attachments are honored only on the newest message of a request (the one this
  browser turn actually sends); any attachment on an earlier message is a
  `400`, not a silent drop.
- No new upload endpoint; still one JSON call, relying on the existing 256 MB
  `bodyLimit`.
- No change to `src/muse/` turn-reader/markdown/thread logic beyond attaching
  files before typing the prompt.

## Approach

- `core/types.ts`: `Attachment { filename, mediaType, data }`, added to
  `ChatMessage.attachments?` and `TurnInput.attachments?`.
- `protocol/attachments.ts` (new, shared by both dialects): base64 `data:` URL
  parsing, a small media-type → extension table, base64 shape validation.
- `normalize-openai.ts`: accept `image_url` (data URL) and `file`
  (`file.file_data` data URL) content parts.
- `normalize-anthropic.ts`: accept `image`/`document`/`file` blocks with a
  `base64` source.
- `route-request.ts`: pass the newest user message's attachments into every
  `driver.runTurn` call (fresh, resumed and retry-as-fresh paths all re-derive
  them from `req.messages`, so a resumed-turn retry still attaches the file).
- `sessions/session-store.ts`: fold an attachment digest into the fingerprint
  so two histories that differ only by attachment content are never treated as
  the same conversation state.
- `muse/page-driver.ts`: before typing the prompt, write each attachment to a
  temp file and `setInputFiles` on the composer's file input; clean up temp
  files in `finally`.
- `muse/selectors.ts`: new `fileInput` / `attachmentPreview` guesses, following
  the existing pattern (try a list, fail explicitly with a `pnpm muse:probe`
  hint if none match) used for `modeMenuButton`.

## Calibration tooling added along the way

`pnpm muse:probe` now takes a repeatable `--attach <path>` (added specifically
to make the live check above possible without further code changes). The
browser profile was locked by the user's own running gateway for most of the
session; they stopped it to free the profile for calibration, and it was
restarted afterward.

## Acceptance

- [x] `pnpm lint && pnpm test && pnpm build` green.
- [x] Unit tests: normalize accepts image_url/file/image/document, rejects
  remote URLs and non-last-message attachments, for both dialects.
- [x] `FakeDriver`-based router test asserts `TurnInput.attachments` reaches
  the driver.
- [x] README "Attachments" section and `docs/architecture.md` /
  `docs/muse-driver.md` updated to describe the new behavior.
- [x] Live check: a real attachment sent through `pnpm muse:probe --attach`
  reaches Muse and is correctly understood (see "Live results" above).
