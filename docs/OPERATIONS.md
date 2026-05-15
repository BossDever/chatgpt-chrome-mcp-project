# Operations Runbook

This runbook covers day-to-day use and troubleshooting for the local
`chatgpt-chrome-mcp` server.

## Start A CDP Chrome Session

Check whether a CDP browser is already available:

```powershell
npm run cdp:status
```

If it is not available, launch the dedicated profile:

```powershell
npm run cdp:launch
```

Log in to ChatGPT in that Chrome profile once. Keep the CDP port bound to
`127.0.0.1`; do not expose it to a network interface.

## Bind A ChatGPT Tab

List CDP tabs:

```powershell
npm run cdp:list
```

Bind the intended ChatGPT tab through MCP:

```json
{
  "sessionName": "default",
  "tabId": "PASTE_TAB_ID_HERE"
}
```

Use `chatgpt_cdp_get_state` with `strictBinding=true` before sends, uploads, or
removes. If several agents need separate conversations, give each one a
different `sessionName`.

Bindings are local runtime state, not project source. They are stored under the
server instance's working directory, for example:

```text
.chatgpt-chrome-mcp/bindings/default.json
```

If you clone the repository to a new path, change the Codex MCP server path, or
start a different server instance, bind the tab again. A smoke failure such as
`default CDP binding is required but missing` usually means the active server
path does not have a saved binding yet; it does not mean `npm ci` or the test
suite failed.

## Normal Agent Workflow

Use the CDP tools first:

- `chatgpt_cdp_get_state`
- `chatgpt_cdp_send_and_wait`
- `chatgpt_cdp_upload_file`
- `chatgpt_cdp_remove_attachments`

Use UIA tools only as a visible-Chrome fallback. UIA can depend on focus,
window visibility, localized labels, and clipboard state.

## Checks Before A Release Or Handoff

Run:

```powershell
npm ci
npm run check
npm run smoke:mcp
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --upload-remove-file .\chatgpt_paste_upload_test.txt
```

The upload/remove smoke requires the bound composer to start with zero pending
attachments.

## Audit Logs

CDP write tools append metadata-only audit records under:

```text
.chatgpt-chrome-mcp/audit/YYYY-MM-DD.jsonl
```

Audit entries include hashes and metadata such as tool name, request ID,
session name, tab ID, duration, result code, file hash, and binding warnings.
They do not store raw prompts, full URLs, or full local file paths.

## Troubleshooting

### CDP is unavailable

Run:

```powershell
npm run cdp:status
```

If it fails, start the dedicated profile with `npm run cdp:launch`. If another
process already owns the port, close that Chrome instance or launch on another
port with the lower-level CDP launch tool.

### Binding is missing

`CDP_BINDING_NOT_FOUND` means the session has no saved tab binding. Run
`npm run cdp:list`, pick the intended ChatGPT tab, then call
`chatgpt_cdp_bind_tab` again.

Also confirm Codex is loading the MCP server from the repository path you
expect. Binding files are path-local runtime files, so a binding created through
one MCP server path does not automatically appear in another clone.

### Binding is stale

Binding warnings such as `BOUND_TAB_URL_CHANGED`, `BOUND_TAB_TITLE_CHANGED`, or
`BOUND_TAB_NOT_FOUND` mean the saved tab metadata no longer matches the live
tab. Confirm the target with `npm run cdp:list` and re-bind the intended tab.

### ChatGPT is still generating

Send and upload tools refuse to act while ChatGPT appears to be generating
unless `force=true` is passed. Prefer waiting with `chatgpt_cdp_get_state` or
`chatgpt_wait_state` instead of forcing.

### Draft text exists

CDP send refuses to overwrite existing composer text unless `replaceDraft=true`
is set. Read state first and decide whether the draft should be preserved or
replaced.

### Attachments are pending

CDP send refuses pending attachments unless `allowAttachments=true` is set. Use
`chatgpt_cdp_remove_attachments` with `removeAll=true` only when you know the
composer attachments are safe to remove.

### Upload smoke fails before starting

The optional upload/remove smoke intentionally fails if `attachmentCount` is not
zero. Remove pending attachments manually or with
`chatgpt_cdp_remove_attachments`, then run the smoke again.

### Upload does not create an attachment

`chatgpt_cdp_upload_file` first tries ChatGPT's hidden file input and falls back
to CDP file chooser interception. If both fail, check whether ChatGPT changed
its upload UI, whether the file path exists, and whether the file extension or
size was blocked by validation.

### Remove does not return attachmentCount to zero

Run `chatgpt_cdp_get_state` and inspect `attachmentCandidates`. The remove tool
uses trusted remove labels and can refuse to click controls that do not look
like remove buttons. Re-bind the tab and retry only after confirming the pending
attachments are test artifacts.

### Suspicious `????` text is blocked

The server blocks long runs of `????` by default because that usually means
encoding loss. Use `messageBase64` for Thai or unusual symbols. Override with
`allowSuspiciousText=true` only when the literal question marks are intentional.

## Cleanup Policy

Keep source, tests, docs, scripts, package files, the current project zip, and
the explicit upload test file in the project root. Move old review zips,
captured ChatGPT review responses, and one-off test artifacts into `archive/`
instead of deleting them.
