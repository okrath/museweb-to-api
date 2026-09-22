# Tool calling over the Muse web chat

Status: implemented by Codex (`gpt-5.6-luna`, reasoning max) on 2026-09-21 and verified live;
see `reports/phase-01-report.md` and the results below. Planning, supervision and review in the
Claude session.

## Live results (2026-09-21, user's gateway)

- OpenAI non-stream: `tool_calls` with parsed arguments, `finish_reason: tool_calls`; follow-up
  carrying the assistant `tool_calls` plus the `tool` result resumes the same side chat
  (`x-mta-session-reused: 1`) and Muse answers from the result ("The secret word stored in
  hello.txt is PINEAPPLE."). Streaming never leaked a fence and ended with `tool_calls`.
- Compliance depends on wording. Codex's first wording: Muse declined twice out of four because it
  believed it "would never see the result", or used its own workspace/web instead. Two
  reviewer patches to `renderToolProtocol` fixed this: (1) say that the program runs the function
  and sends the result back in the next message; (2) forbid looking things up, browsing, searching,
  reading files or acting on its own "even if you could". Measured after the patches: file tasks
  5/6 through the API (one refusal on "Count the lines in todo.txt", where Muse searched its own
  workspace), weather tasks 3/3 with a `get_weather` function (0/1 before patch 2, when Muse
  answered from its own web access).
- After both patches were deployed: the previously failing "Count the lines in todo.txt" turn
  requested `read_file` and the follow-up answered "todo.txt has 3 lines." (3.6 s, session
  reused); Anthropic `get_weather` returned `tool_use` in 3/3 samples with `stop_reason: tool_use`.
- Known limitation: some tool-eligible turns may still be answered directly by Muse instead of
  requesting a function (about one in six before the second wording patch, none observed after
  it in a small sample). Clients that need a call should send `tool_choice: required`; a
  gateway-side retry-with-reminder is a possible follow-up.

## Outcome

Clients that send OpenAI `tools` / Anthropic `tools` get real `tool_calls` / `tool_use` back,
and can continue the conversation with tool results, without any channel other than the chat
itself. Motivating client: `oh-my-ainovel`, which sends its full tool set on every chat turn and
relies on `create_entity`/`create_relation`/`create_event` calls for world extraction. Today those
requests fail with `400 tools_unsupported`.

## Approach

Prompt-emulated tool protocol: tool definitions are rendered into the prompt as "functions my
program can run", with an exact output format (a fenced `json` block holding one
`{"name","arguments"}` object per call). The gateway parses the reply, strips the blocks from the
text, and emits standard tool-call events. Tool results sent by the client are rendered back into
the transcript as "Function result of …". No MCP, no browser changes.

Verified live on 2026-09-21 before writing the spec: Muse refuses any framing that calls it a
model with a tool channel, but follows the structured-output framing and consumes the function
result in the next turn (see the phase file). omp's default 114 kB harness prompt is still refused
by Muse as a suspected injection; omp works as a plain chat client with `--no-tools` and a short
`--system-prompt`, which is outside this plan's scope.

## Constraints and non-goals

- No change under `src/muse/`; the driver keeps emitting Markdown text deltas.
- Streaming must never leak a tool_call block (or a partial one) as content.
- Non-goals: parallel tool call ordering guarantees beyond document order, strict JSON-schema
  validation of arguments (pass through what the model wrote when it parses as an object).

## Phases

1. `phase-01-prompt-tool-protocol.md` — the whole feature; single phase.

## Acceptance

See the phase file. Live check by the reviewer: oh-my-ainovel chat turn with tools succeeds; a
world-extraction run produces `create_entity` proposals through the gateway.
