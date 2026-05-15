# ChatGPT Chrome MCP

Local MCP server that lets Codex read and send messages in an already-open
Chrome window running ChatGPT.

This is browser automation, not the official ChatGPT API. Chrome must be open,
logged in, and showing the ChatGPT conversation. The implementation uses Windows
UI Automation and looks for ChatGPT's `prompt-textarea` element.
If another Chrome tab is active, the bridge tries to select a visible tab whose
title contains `ChatGPT`; if it cannot confirm a visible ChatGPT prompt, it
fails instead of acting on the wrong tab.
When more than one active Chrome window has a visible ChatGPT prompt, calls
without `windowTitleContains` fail with `AMBIGUOUS_CHATGPT_TARGET`; pass a
distinct conversation/window title substring to choose the intended target.

## Current Stable Workflow

The current stable path is CDP automation against a bound ChatGPT tab:

```powershell
npm run cdp:status
npm run cdp:launch
npm run cdp:list
```

Then bind the intended ChatGPT tab through `chatgpt_cdp_bind_tab` and use:

- `chatgpt_cdp_get_state` with `strictBinding=true` before sensitive work.
- `chatgpt_cdp_send_and_wait` for normal agent messages.
- `chatgpt_cdp_upload_file` for file attachment without mouse control.
- `chatgpt_cdp_remove_attachments` to clean pending composer attachments.

See [docs/STABLE_BASELINE.md](docs/STABLE_BASELINE.md) for the baseline
snapshot and [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) for current
boundaries. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the runbook.

## Tools

- `chatgpt_read`: read visible conversation text from Chrome.
- `chatgpt_send`: fill and optionally submit a message. Messages are passed
  through UTF-8 base64, then verified in the prompt before Enter is pressed.
- `chatgpt_get_state`: report prompt availability, visible text hash, code
  block count, download count, pending attachment count, and whether ChatGPT
  appears to be generating.
- `chatgpt_wait_state`: wait for `idle`, `generating`, `download_available`,
  or likely `error`.
- `chatgpt_get_last_response`: return the latest assistant response, optionally
  with current state and copied code blocks.
- `chatgpt_get_code_blocks`: copy recent code blocks through ChatGPT's code
  block copy buttons and return exact clipboard text.
- `chatgpt_stop_generation`: click a visible stop-generation button if present.
- `chatgpt_list_downloads`: list visible ChatGPT download buttons/links.
- `chatgpt_download_files`: click ChatGPT download buttons/links and report
  newly created files in the Downloads folder, including extension checks and
  SHA-256 hashes.
- `chatgpt_list_attachments`: list files currently attached in the composer.
- `chatgpt_upload_file`: attach a local file through ChatGPT's file picker
  without submitting the message. It validates size, extension, and SHA-256
  first.
- `chatgpt_remove_attachments`: remove pending composer attachments, useful
  after tests or before sending a text-only message.
- `chrome_cdp_status`: check whether a Chrome DevTools Protocol instance is
  available.
- `chrome_cdp_launch`: launch a dedicated Chrome profile with remote debugging
  on `127.0.0.1`. Log in to ChatGPT once in this profile before using it for
  real ChatGPT work.
- `chrome_cdp_list_tabs` / `chrome_cdp_open_tab`: list or open CDP tabs with
  stable `tabId` values.
- `chatgpt_cdp_bind_tab`: bind one ChatGPT tab by `tabId`, title, or URL so
  future CDP actions do not guess between multiple ChatGPT tabs. Bindings are
  namespaced by `sessionName`, so multiple agents can keep separate targets.
- `chatgpt_cdp_get_state`: return structured CDP state for the bound tab,
  including prompt text, pending attachment count, generation state, and latest
  assistant text.
- `chatgpt_cdp_read` / `chatgpt_cdp_send`: read or send in the bound tab
  without using the active Chrome tab, mouse, or Windows file picker. Sends are
  guarded against busy generation, pending attachments, and overwriting drafts.
- `chatgpt_cdp_send_and_wait`: main CDP workflow for agents. It submits a
  message, verifies that the user's own turn appeared, waits for the assistant
  reply after that user turn to stabilize, and returns turn hashes/timings.
- `chatgpt_cdp_upload_file`: attaches files through ChatGPT's hidden file input
  with `DOM.setFileInputFiles`, falling back to CDP file chooser interception if
  the hidden input changes. This avoids the Windows file picker.
- `chatgpt_cdp_remove_attachments`: removes pending composer attachments in the
  bound CDP tab using the same attachment candidate extraction as state/upload.
- `chatgpt_wait_for_update`: wait until visible text changes.
- `chatgpt_send_and_wait`: send a message and wait for likely reply text.
  It now returns structured state, last response, optional code blocks, timing
  metadata, and optional downloads. Set `autoDownload=true` to download files
  if the reply creates them.

## Run Manually

```powershell
npm run chatgpt:read
npm run chatgpt:send -- "hello from Codex"
npm run chatgpt:state
npm run chatgpt:lastresponse
npm run chatgpt:codeblocks
npm run chatgpt:downloads
npm run chatgpt:download
npm run chatgpt:attachments
npm run chatgpt:upload -- -FilePath .\chatgpt_paste_upload_test.txt
npm run chatgpt:remove-attachments -- -AttachmentNameContains chatgpt_paste_upload_test
npm run cdp:status
npm run cdp:launch
npm run cdp:list
npm test
npm run mcp
```

## Unicode And Verification

`chatgpt_send` and `chatgpt_send_and_wait` avoid shell encoding issues by
base64-encoding the message in Node and decoding it as UTF-8 in PowerShell.
For MCP calls made from shell scripts, pass `messageBase64` directly when the
source text contains Thai or unusual symbols. Before submitting, the bridge
reads the ChatGPT prompt back and compares hashes.

The server refuses to send text that looks like lossy encoding, such as long
runs of `?????`, unless `allowSuspiciousText=true` is set.

The send result includes:

- `verifiedBeforeSubmit`
- `writeMethod`
- `messageHash`
- `promptHashBeforeSubmit`
- `requestId`, `startedAt`, `finishedAt`, and `durationMs` when called through
  MCP tools that support request metadata.

If direct UI Automation writing fails, the bridge falls back to Unicode
clipboard paste, verifies again, and only submits if verification passes.

For manual shell use:

```powershell
$msg = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("ทดสอบภาษาไทย ✓ 😀"))
npm run chatgpt:send -- --base64 $msg
```

## Tests

Run the Node test suite with:

```powershell
npm test
```

The current unit tests cover CDP remove-label matching, duplicate filename
matching, own-user-turn verification, text normalization, and remove result
semantics. DOM fixture tests use `linkedom` to exercise ChatGPT-like
conversation/composer HTML without opening Chrome. Tool-registration tests
assert the CDP tool set and key schema fields stay registered after refactors.
The DOM fixture coverage includes disabled send buttons and upload-menu
selection so arbitrary conversation text containing upload/file words is not
treated as a menu action.

Run the MCP runtime smoke test with:

```powershell
npm run smoke:mcp
```

For a live CDP regression check that requires a running CDP Chrome instance and
a saved default bound tab:

```powershell
npm run smoke:mcp -- --require-cdp --require-binding
```

To also exercise live CDP upload and removal, pass an explicit local file. The
smoke script requires the composer to have no pending attachments before it
starts, uploads the file, verifies a pending attachment appears, removes it, and
verifies the composer is clean again:

```powershell
npm run smoke:mcp -- --require-cdp --require-binding --upload-remove-file .\chatgpt_paste_upload_test.txt
```

The smoke script starts the MCP server over stdio, asserts the expected 26-tool
surface, verifies 12 CDP tools and 14 UIA tools, checks `chrome_cdp_status`, and
when a default binding exists reads `chatgpt_cdp_get_state` with
`strictBinding=true`.

## Release Checks

Before packaging or reviewing a new build:

```powershell
npm ci
npm run check
npm run smoke:mcp
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --upload-remove-file .\chatgpt_paste_upload_test.txt
```

`npm run check` runs `node --check` across `src`, `scripts`, and `tests`, then
runs `node --test`.

## Downloads

`chatgpt_read` includes a `downloadButtons` array when ChatGPT has created a
downloadable file. To click one and verify that a new local file appeared:

```powershell
npm run chatgpt:download
```

The MCP tool `chatgpt_download_files` returns `downloadedFiles` with the file
name, full path, byte length, timestamp, SHA-256 hash, extension status, and
whether the file is considered safe for automatic use.

Risky script/executable extensions such as `.exe`, `.bat`, `.cmd`, `.ps1`,
`.vbs`, `.js`, `.msi`, and `.scr` are marked unsafe. Pass
`allowedExtensions` and `maxBytes` to tighten policy further.

## Uploads

Pasting a Windows file drop list with Ctrl+V was not reliable in ChatGPT's
composer during testing. The reliable path is ChatGPT's `เพิ่มไฟล์และอื่นๆ` /
`เพิ่มรูปภาพและไฟล์` file picker.

Use MCP `chatgpt_upload_file` to attach a file without submitting:

```json
{
  "filePath": "C:/Users/suwit/Desktop/Test/chatgpt_paste_upload_test.txt",
  "waitForUploadSeconds": 30
}
```

The result includes local validation (`sha256`, byte length, extension checks)
and the attachment names found in the composer. Use `chatgpt_list_attachments`
to verify pending files and `chatgpt_remove_attachments` to clean up anything
that should not be sent.

`chatgpt_send` and `chatgpt_send_and_wait` refuse to submit while attachments
are pending unless `allowAttachments=true` is set. This prevents a leftover test
file from being sent accidentally.

## CDP Tab Workflow

The UIA tools operate on visible Chrome UI, so they can still steal focus or be
confused by active-tab changes. For multiple agents or multiple ChatGPT tabs,
prefer the CDP workflow:

1. Start a dedicated Chrome profile:

   ```powershell
   npm run cdp:launch
   ```

2. Log in to ChatGPT in that Chrome profile once.
3. List tabs and bind the intended ChatGPT tab to a named session:

   ```powershell
   npm run cdp:list
   ```

   Use MCP `chatgpt_cdp_bind_tab({ sessionName: "default", tabId })`.

4. Check state before acting:

   ```json
   { "sessionName": "default" }
   ```

   Call MCP `chatgpt_cdp_get_state` with that input.

5. Use `chatgpt_cdp_read`, `chatgpt_cdp_send`, and
   `chatgpt_cdp_upload_file` with the same `sessionName`.
   If direct hidden-input upload does not produce a visible attachment, CDP
   upload falls back to file chooser interception and targets ChatGPT's
   localized upload menu item instead of scanning arbitrary page text.

`chatgpt_cdp_send` refuses to submit when ChatGPT is still generating unless
`force=true`, refuses to send pending attachments unless `allowAttachments=true`,
and refuses to overwrite existing composer text unless `replaceDraft=true`.
It clicks ChatGPT's send button, waits for ChatGPT's send button to become
enabled when uploads are still settling, and verifies after submit that the
latest user turn matches the submitted message. If the own-turn check fails and
there is no strong fallback evidence, it returns `CDP_SUBMIT_VERIFY_FAILED`.
For agent workflows, prefer `chatgpt_cdp_send_and_wait` over composing
`chatgpt_cdp_send` + polling manually.
`chatgpt_cdp_send_and_wait` defaults `requireOwnTurn=true`, so it fails clearly
if the submitted user turn cannot be correlated before waiting for the reply.
CDP send/upload calls are serialized per `baseUrl|tabId`, so two agents sharing
one tab cannot clear or insert into the same prompt at the same time.
When `useBoundTab=true`, the requested `sessionName` must already be bound; the
server returns `CDP_BINDING_NOT_FOUND` instead of guessing a tab.
CDP tools that use a bound tab return `bindingWarnings` when the stored tab
metadata looks stale, such as a changed URL/title, a missing tab, or a non-
ChatGPT URL. This is non-breaking by default. Set `strictBinding=true` to fail
the call when any binding warning is detected.
CDP write operations use a locked CDP session. `lockTimeoutMs` closes that CDP
session on timeout so pending protocol calls reject before the tab lock is
released.

This gives a stable `tabId`/target identity and can work with inactive tabs. It
also avoids moving the global mouse pointer. Remote debugging is powerful, so
the launcher binds it to `127.0.0.1` and uses a dedicated local user data
directory by default. Do not expose the CDP port to a network.

## Concurrency

Windows UI Automation and the clipboard are not safe to drive in parallel. The
MCP server serializes bridge calls internally so multiple tool calls do not
race Chrome, clipboard copy, or prompt writes.

CDP send/upload calls use a separate per-tab queue keyed by `baseUrl|tabId`.
Use different `sessionName` values when multiple agents need different ChatGPT
tabs; use the same `sessionName` only when they intentionally share a tab.

## Audit Log

CDP write tools append best-effort metadata-only audit entries under
`.chatgpt-chrome-mcp/audit/YYYY-MM-DD.jsonl`.

Audited tools:

- `chatgpt_cdp_send`
- `chatgpt_cdp_send_and_wait`
- `chatgpt_cdp_upload_file`
- `chatgpt_cdp_remove_attachments`

Audit entries include metadata such as tool name, requestId, sessionName,
tabId, ok/errorCode, duration, message hash, file SHA-256, file extension/size,
hashed base URL, hashed tab URL, hashed attachment filter, and binding warning
codes. They do not store raw prompts, full file paths, raw URLs, or full
attachment filter text. Audit write failures are ignored so they cannot make a
tool call fail.

## Internal Layout

- `src/cdp-client.mjs`: low-level CDP client, tab locking, ChatGPT DOM state,
  send/upload/remove helpers.
- `src/chatgpt-dom-adapter.mjs`: shared ChatGPT DOM helpers used by both CDP
  Runtime.evaluate scripts and DOM fixture tests.
- `src/cdp-session-manager.mjs`: CDP session names, binding file paths,
  bound-tab resolution, ChatGPT URL checks, and stale binding warnings.
- `src/audit-log.mjs`: metadata-only JSONL audit record creation and appending.
- `src/server.mjs`: MCP server bootstrap, dependency wiring, shared validation,
  and orchestration helpers.
- `src/cdp-tools.mjs`: CDP MCP tool registration. It receives server-side
  helpers through dependency injection so public schemas stay centralized while
  `server.mjs` stays smaller.
- `src/uia-tools.mjs`: UIA/visible-Chrome MCP tool registration for the legacy
  fallback path and download/code-block helpers.
- `src/uia-bridge.mjs`: serialized PowerShell/UIA bridge runtime plus
  read/state/wait/response wrappers used by UIA tools.
- `src/file-safety.mjs`: shared upload/download file validation, extension
  policy, max-size checks, and SHA-256 hashing.

## Add To Codex

```powershell
codex mcp add chatgpt-chrome -- node C:\Users\suwit\Desktop\Test\src\server.mjs
codex mcp list
```

Restart Codex after adding the MCP server so the new tools are loaded.

## Auto Reply Note

MCP tools are request/response tools. They let an agent read and send messages
when the agent calls a tool, but MCP alone does not make the agent run forever
or wake up on every new ChatGPT reply.

For fully automatic replies, add a separate watcher/agent loop that:

1. calls `chatgpt_read` repeatedly,
2. detects a new ChatGPT reply,
3. asks an LLM or active Codex host what to answer,
4. calls `chatgpt_send`.

Keep that loop local-only unless you intentionally add an API key or remote
service.
