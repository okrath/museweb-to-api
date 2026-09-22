# Phase 1 — prompt-emulated tool calling

## Context

Read `AGENTS.md`, `docs/architecture.md`, `src/core/types.ts`, `src/protocol/*.ts`,
`src/prompt/render-transcript.ts`, `src/router/route-request.ts`, `src/sessions/session-store.ts`,
`src/cache/response-cache.ts`, `src/api/chat-handler.ts`, `tests/**`. The Muse driver
(`src/muse/*`) emits `text_delta` events containing Markdown converted from the page and must not
be modified. `E:\Projects\cli-to-api` (read-only reference) has mature tool handling in
`apps/gateway/src/protocol/normalize-*.ts` and `serialize-*.ts`; mirror its wire semantics.

## Requirements

### 1. Contracts (`src/core/types.ts`)

- `ChatMessage` gains `role: "tool"`, `toolCalls?: ToolCall[]` (assistant), `toolCallId?: string`
  and `isError?: boolean` (tool). `ToolCall = { id, name, argumentsJson }`.
- `ChatRequest` gains `tools?: ToolDefinition[]` (`{ name, description?, parameters }`) and
  `toolChoice?: "auto" | "none" | "required" | { name: string }`.
- `TurnEvent` gains `{ type: "tool_call"; id; name; argumentsJson }`; `done.stopReason` gains
  `"tool_use"`. The `MuseDriver` never emits these itself; the router does.

### 2. Normalization (`src/protocol/normalize-openai.ts`, `normalize-anthropic.ts`)

- Accept OpenAI `tools[].function`, `tool_choice` (`auto|none|required|{type:function,function:{name}}`),
  assistant `tool_calls`, and `tool` messages (a tool message must reference a tool call id seen
  earlier in the same request → otherwise 400). Validate tool names `^[a-zA-Z0-9_-]{1,64}$` and
  that arguments parse as a JSON object.
- Accept Anthropic `tools[]` (`name`, `description`, `input_schema`), `tool_choice`
  (`auto|any→required|tool→{name}|none`), assistant `tool_use` blocks, user `tool_result` blocks
  (`content` string or text blocks, `is_error`).
- `tool_choice: none` drops the tools. Remove the `tools_unsupported` error path entirely.

### 3. Tool protocol (`src/prompt/tool-protocol.ts`, new)

**Muse behaviour, measured on 2026-09-21 (read before writing the wording).** Muse is a personal
agent with its own persona and its own tools, not a bare model. It refused every prompt that
described it as "the model inside my tool", mentioned a "tool_call channel", "your tools", or
"actions on my computer" ("I'm your agent inside Muse, I don't have a tool_call channel"). It
complied immediately when the same task was framed as *structured output*: "I am building a
program; here are the functions the program can run; decide which single function the program
should run next and reply with exactly one fenced `json` block `{"name","arguments"}`; do not run
anything yourself". It also answered correctly when the next message started with
`Function result of read_file("hello.txt"): …`. Its renderer sometimes detaches the fence
language: the reply came back as a line `json`, a blank line, then a bare ```` ``` ```` block.

- `renderToolProtocol(tools, toolChoice)`: a text block placed at the top of a *new* thread's
  prompt (after the `<system>` section). Wording constraints: speak as the account owner building
  a program; call the tools "functions the program can run"; never use the words tool, tool_call,
  channel, computer, execute, or refer to Muse's own tools or workspace. Content:
  - Every function as `name(arguments schema)` with its description and JSON Schema.
  - The contract: to have the program run functions, reply with one fenced code block per call,
    language `json`, containing exactly one object `{"name": "...", "arguments": {...}}`; several
    blocks are allowed; nothing after the last block; a short sentence before the blocks is
    allowed; do not run or simulate anything yourself; when no function is needed, reply to the
    end user as plain text with no such block.
  - `required` → "Your reply must request at least one function"; `{name}` → "Your reply must
    request the function `name`".
- `parseToolCalls(markdown)` → `{ text: string; calls: Array<{ name; argumentsJson }> }`. A tool
  call is any fenced code block (3+ backticks, any or no language) whose body parses as a JSON
  object with a string `name` and an object `arguments`; a line consisting only of `json` or
  `tool_call` immediately before such a block is dropped with it. As a fallback also accept
  `<tool_call>…</tool_call>` tags. Blocks that do not match are left in the text untouched.
  `text` is the Markdown outside the matched blocks, trimmed.
- `renderToolResults(messages)` for a resumed thread whose trailing messages are tool results:
  ```
  Function result of <name> (call <id>):
  <content>
  ```
  one block per result (`(error)` appended to the header when `isError`), followed by
  `Continue: reply to the end user, or request the next function in the same json format.`
  In a full transcript render, assistant tool calls appear as
  `[function requested: <name> (call <id>)]\n<argumentsJson>` and tool results as above.

### 4. Router (`src/router/route-request.ts`)

- Tool call ids: `call_` + 24 url-safe random chars.
- When the request has tools, wrap the driver's `emit`: forward text deltas only up to the first
  point that could start a call block (a line starting with ` ``` `, a line that is exactly `json`
  or `tool_call`, or `<tool_call>`), hold the rest, and at `done` run `parseToolCalls` over the
  complete Markdown. Emit any unsent part of
  `text`, then one `tool_call` event per call, then `done` with `stopReason: "tool_use"` when calls
  exist, else `"end_turn"`. Text held back that turns out not to be a tool block is flushed at the end.
- The assistant message stored for the session fingerprint includes `toolCalls`, so the client's
  follow-up (assistant with `tool_calls` + `tool` results + maybe a user message) matches and resumes
  the thread. `lookupFingerprint` must accept a newest message of role `tool` as well as `user`.
- Session and cache identity include a hash of the tool definitions (name + parameters); a changed
  tool set starts a fresh thread so the protocol block is re-sent. Responses to requests with tools
  are never cached.
- `resolveMode`, warm-pool consumption and the fresh-thread retry keep working unchanged.

### 5. Serialization (`src/protocol/serialize-*.ts`)

- OpenAI streaming: `tool_calls` delta chunks (`index`, `id`, `type: "function"`,
  `function: { name, arguments }`), `finish_reason: "tool_calls"`. Non-streaming: `message.tool_calls`,
  `content: null` when there is no text.
- Anthropic streaming: `tool_use` content blocks with `input_json_delta`, `stop_reason: "tool_use"`.
  Non-streaming: `tool_use` blocks with parsed `input`.

### 6. Docs and config

- README: replace the "tools not supported" statements with a "Tool calling" section explaining
  the fenced protocol, its limits (model compliance, no schema validation), and that tool requests
  bypass the response cache. Update the Errors table (drop `tools_unsupported`).
- `docs/architecture.md`: request-flow step for the tool protocol and the emit filter.

## Files you may modify

`src/core/types.ts`, `src/protocol/**`, `src/prompt/**`, `src/router/**`, `src/sessions/**`,
`src/cache/**`, `src/api/chat-handler.ts`, `README.md`, `docs/architecture.md`, `tests/**`.
Do not modify `src/muse/**`, `src/server.ts`, `src/config.ts`, `src/index.ts`.

## Acceptance criteria

- `pnpm lint`, `pnpm test`, `pnpm build` green; existing tests keep passing except the two that
  asserted `tools_unsupported`, which you replace with the new behaviour.
- Unit tests for `tool-protocol.ts`: render includes every tool and the contract and contains none
  of the forbidden words; parse handles one block, several blocks, a block with no language
  preceded by a bare `json` line (the observed Muse rendering), tags fallback, malformed JSON (left
  as text), a JSON block without `name`/`arguments` (left as text), text before a block, fences of
  4 backticks.
- Unit tests for normalization of tools, tool_calls, tool messages (OpenAI) and tool_use/tool_result
  (Anthropic), including the unknown-tool-call-id 400.
- E2E with the fake driver (extend `tests/helpers/fake-driver.ts` so a script can emit Markdown that
  contains a ```tool_call fence, streamed in several chunks):
  (a) OpenAI non-stream returns `tool_calls` and `finish_reason: tool_calls`; the prompt the driver
  received contains the tool names and the output contract;
  (b) OpenAI stream never emits any chunk whose content contains "```" or "tool_call", and ends with
  `finish_reason: tool_calls`;
  (c) follow-up with the assistant tool_calls plus `tool` results resumes the same conversation
  (`x-mta-session-reused: 1`) and the driver receives a prompt containing `[tool_result id=`;
  (d) Anthropic non-stream returns a `tool_use` block with parsed `input` and `stop_reason: tool_use`;
  (e) a reply without any fence behaves exactly as today (plain text, `end_turn`);
  (f) `tool_choice: none` sends no protocol block;
  (g) requests with tools are not served from cache.

## Constraints

- KISS/DRY; files under ~300 lines; no classes beyond existing patterns.
- No fake data in `src/`; do not run `pnpm muse:*`, `pnpm start`, `pnpm dev`, or a browser.
- Do not commit. Do not put plan or phase identifiers in code comments or test names.

## Report

`plans/260921-tool-calling/reports/phase-01-report.md` ending with
`Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, `Summary:`, `Concerns/Blockers:`.

## Rollback

Revert the phase commit(s). Clients can keep sending `tool_choice: "none"` to get today's behaviour.
