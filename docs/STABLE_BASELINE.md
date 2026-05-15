# Stable Baseline

Baseline date: 2026-05-15

This project is currently stable as a local Windows MCP server for controlling
ChatGPT in Chrome. The preferred path is CDP automation against a bound tab. The
UI Automation path remains available as a visible-Chrome fallback.

## Supported Workflow

1. Start or connect to a Chrome instance with CDP enabled.
2. Open or select a ChatGPT tab.
3. Bind the intended tab with `chatgpt_cdp_bind_tab`.
4. Use `chatgpt_cdp_get_state` with `strictBinding=true` before sensitive work.
5. Use `chatgpt_cdp_send_and_wait` for normal agent messages.
6. Use `chatgpt_cdp_upload_file` for non-mouse file attachment.
7. Use `chatgpt_cdp_remove_attachments` after upload tests or before text-only
   messages.
8. Use `chatgpt_cdp_read` with `mode="structured"` only when visible-DOM
   structured turns are useful; keep `mode="raw"` or `mode="combined"` for
   diagnostics that need non-conversation page text.

## Stable Tool Surface

- Total MCP tools: 26
- CDP tools: 12
- UIA/visible-Chrome tools: 14

The regression smoke script asserts these counts so schema or registration
changes are noticed quickly.

## Verification

Run the baseline checks before packaging, reviewing, or handing the project to a
new agent:

```powershell
npm ci
npm run check
npm run smoke:mcp
npm run smoke:mcp -- --require-cdp --require-binding
npm run smoke:mcp -- --require-cdp --require-binding --upload-remove-file .\chatgpt_paste_upload_test.txt
```

`npm run check` runs `node --check` across `src`, `scripts`, and `tests`, then
runs `node --test`.

`npm run smoke:mcp` starts the MCP server over stdio, lists tools, checks CDP
status, reads the default bound tab if present, and verifies strict bound CDP
state when a binding exists.

The optional `--upload-remove-file <path>` check validates the live CDP
upload/remove workflow. It refuses to start if the bound ChatGPT composer
already has pending attachments, then uploads the explicit file, verifies an
attachment appears, removes all pending attachments created during the smoke
run, and verifies the composer returns to zero attachments.

CDP tab bindings are runtime state under `.chatgpt-chrome-mcp/bindings/` in the
server working directory. They are intentionally ignored by git. After cloning
the repository to a new path or changing the Codex MCP server path, bind the tab
again before running smoke checks that require `--require-binding`.

## Architecture Snapshot

- `src/server.mjs`: MCP bootstrap, dependency wiring, shared validation, and
  orchestration helpers.
- `src/cdp-client.mjs`: low-level CDP client, tab locking, ChatGPT DOM state,
  send/upload/remove helpers.
- `src/cdp-tools.mjs`: CDP MCP tool registration.
- `src/uia-tools.mjs`: UIA/visible-Chrome MCP tool registration.
- `src/uia-bridge.mjs`: serialized PowerShell/UIA runtime and state/wait
  wrappers.
- `src/cdp-session-manager.mjs`: session names, persisted bindings, and stale
  binding warnings.
- `src/chatgpt-dom-adapter.mjs`: shared DOM helpers used by CDP scripts and DOM
  fixture tests.
- `src/file-safety.mjs`: upload/download file validation and SHA-256 hashing.
- `src/audit-log.mjs`: metadata-only audit logging for CDP write operations.

## Current Consensus

The architecture and regression workflow are good enough for this stabilization
stage. New work should start as a separate hardening or feature loop instead of
continuing broad refactors.

Structured CDP read mode is intentionally not a full transcript export. It is a
visible-DOM snapshot with coverage warnings, role confidence, hashes, and
truncation metadata. Raw read remains the default and fallback.

Operational procedures and troubleshooting live in
[OPERATIONS.md](OPERATIONS.md).
