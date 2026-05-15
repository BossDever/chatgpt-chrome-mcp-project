# Known Limitations

This project automates ChatGPT Web. It is not the official ChatGPT API, and it
depends on browser and page behavior that can change.

## Browser And ChatGPT UI

- ChatGPT DOM structure, labels, hidden file inputs, and attachment controls can
  change without notice.
- CDP helpers are tested against ChatGPT-like fixtures and live smoke checks,
  but they cannot guarantee future UI compatibility.
- UIA fallback tools depend on visible Windows UI state and can be affected by
  focus, window title ambiguity, language changes, or clipboard behavior.

## Security

- A Chrome DevTools Protocol port can control browser tabs. Treat
  `127.0.0.1:9222` as sensitive local automation access.
- Do not expose the CDP port to a network interface.
- Uploaded and downloaded files are hashed and extension-checked, but callers are
  still responsible for using trusted local paths.
- Audit logs intentionally store metadata and hashes, not raw prompts or full
  file paths.

## Multi-Agent Behavior

- CDP write operations use tab-level locking inside this MCP process.
- Session names let agents bind separate ChatGPT tabs.
- This is not a distributed lock across unrelated MCP server processes. Two
  separate server processes can still target the same tab unless callers
  coordinate.

## Downloads And Artifacts

- UIA download helpers can click visible ChatGPT download buttons and annotate
  created files.
- CDP-native download/artifact handling is not implemented yet.
- Code block extraction is currently stronger in the UIA path than the CDP path.

## Reliability Boundaries

- `chatgpt_cdp_send_and_wait` verifies the user's own turn and waits for a
  stable assistant reply, but ChatGPT can still stop early, rate limit, or show
  transient errors.
- Suspicious lossy text such as long `????` runs is blocked by default, but
  callers can override that guard when needed.
- Live smoke tests require a running CDP Chrome instance and, for strict checks,
  a saved default binding.
