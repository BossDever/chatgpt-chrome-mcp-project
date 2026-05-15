# Changelog

## 0.1.0 - Stable Local Baseline - 2026-05-15

This is the first documented stable baseline for the local
`chatgpt-chrome-mcp` project.

### Added

- CDP tab workflow with stable `tabId` binding, session names, strict binding
  checks, stale binding warnings, and per-tab write locks.
- CDP tools for reading state, sending, waiting for replies, uploading files
  without the Windows file picker, and removing pending attachments.
- UIA/visible-Chrome fallback tools for reading, sending, waiting, downloading,
  listing attachments, uploading, removing attachments, and copying code blocks.
- Metadata-only audit logging for CDP write tools.
- Shared DOM adapter plus fixture tests for ChatGPT-like conversation,
  attachment, upload-menu, and send-button behavior.
- Shared file-safety validation for uploads and downloads, including extension
  checks, max-size checks, and SHA-256 hashing.
- MCP tool registration tests for CDP and UIA tool surfaces.
- Runtime smoke script: `npm run smoke:mcp`.
- Optional live CDP upload/remove smoke via
  `npm run smoke:mcp -- --upload-remove-file <path>`.
- Consolidated check script: `npm run check`.
- Release smoke command: `npm run check:smoke`.
- Documentation snapshot in `docs/STABLE_BASELINE.md` and
  `docs/KNOWN_LIMITATIONS.md`.
- Operations runbook in `docs/OPERATIONS.md`.
- Root cleanup policy that archives old review zips and captured review
  responses instead of deleting them.
- `.gitignore` entries for dependencies, audit logs, archives, zips, and
  captured review artifacts.

### Verified

- `npm run check` passes.
- `node --test` passes 37 tests.
- `npm run check:smoke` passes in the current CDP environment.
- Live CDP smoke verifies 26 total tools, 12 CDP tools, 14 UIA tools, strict
  bound tab state, and no binding warnings.
- Optional live upload/remove smoke passed with
  `chatgpt_paste_upload_test.txt`, verifying attachment count moves from 0 to 1
  and back to 0.

### Known Gaps

- CDP-native download/artifact handling is not implemented yet.
- UIA fallback can still be affected by visible UI focus and window ambiguity.
- Tab locks are process-local, not distributed across multiple server processes.
