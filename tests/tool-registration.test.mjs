import assert from "node:assert/strict";
import test from "node:test";

import { registerCdpTools } from "../src/cdp-tools.mjs";
import { registerUiaTools } from "../src/uia-tools.mjs";

function makeDeps() {
  const noop = () => {};
  const asyncNoop = async () => ({ ok: true });
  return {
    auditCdpWrite: asyncNoop,
    cdpStatus: asyncNoop,
    defaultCdpBaseUrl: () => "http://127.0.0.1:9222",
    defaultChromeUserDataDir: () => ".chatgpt-chrome-mcp/chrome-profile",
    findCdpTab: asyncNoop,
    getCdpState: asyncNoop,
    isChatGptUrl: () => true,
    launchCdpChrome: asyncNoop,
    listCdpTabs: asyncNoop,
    normalizeSessionName: (value = "default") => value,
    openCdpTab: asyncNoop,
    readBoundCdpTarget: asyncNoop,
    readCdpPage: asyncNoop,
    removeCdpAttachments: asyncNoop,
    resolveBoundCdpTarget: asyncNoop,
    resolveMessageInput: noop,
    sendCdpMessage: asyncNoop,
    sendCdpMessageAndWait: asyncNoop,
    sha256: () => "hash",
    uploadCdpFile: asyncNoop,
    verifyLocalUploadFile: asyncNoop,
    withMeta: (result) => result,
    writeBoundCdpTarget: asyncNoop,
  };
}

function makeUiaDeps() {
  const asyncNoop = async () => ({ ok: true });
  return {
    getCodeBlocks: asyncNoop,
    getLastResponse: asyncNoop,
    getState: asyncNoop,
    hasErrorText: () => false,
    readChat: asyncNoop,
    resolveMessageInput: ({ message }) => message ?? "message",
    runBridge: asyncNoop,
    sha256: () => "hash",
    verifyDownloadedFiles: asyncNoop,
    verifyLocalUploadFile: asyncNoop,
    waitForState: asyncNoop,
    withMeta: (result) => result,
  };
}

test("registerCdpTools registers the expected CDP tools", () => {
  const registered = new Map();
  const server = {
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };

  registerCdpTools(server, makeDeps());

  assert.deepEqual([...registered.keys()], [
    "chrome_cdp_status",
    "chrome_cdp_launch",
    "chrome_cdp_list_tabs",
    "chrome_cdp_open_tab",
    "chatgpt_cdp_bind_tab",
    "chatgpt_cdp_get_bound_tab",
    "chatgpt_cdp_get_state",
    "chatgpt_cdp_read",
    "chatgpt_cdp_send",
    "chatgpt_cdp_send_and_wait",
    "chatgpt_cdp_upload_file",
    "chatgpt_cdp_remove_attachments",
  ]);

  for (const [name, tool] of registered) {
    assert.equal(typeof tool.handler, "function", `${name} handler`);
    assert.equal(typeof tool.definition.title, "string", `${name} title`);
    assert.equal(typeof tool.definition.description, "string", `${name} description`);
    assert.equal(typeof tool.definition.inputSchema, "object", `${name} schema`);
  }
});

test("registerCdpTools preserves key CDP schema fields", () => {
  const registered = new Map();
  registerCdpTools(
    {
      registerTool(name, definition, handler) {
        registered.set(name, { definition, handler });
      },
    },
    makeDeps(),
  );

  const schemaKeys = (toolName) => Object.keys(registered.get(toolName).definition.inputSchema);

  assert.deepEqual(
    [
      "strictBinding",
      "lockTimeoutMs",
      "requireOwnTurn",
      "allowAttachments",
      "replaceDraft",
    ].every((key) => schemaKeys("chatgpt_cdp_send_and_wait").includes(key)),
    true,
  );
  assert.equal(schemaKeys("chatgpt_cdp_send").includes("strictBinding"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("mode"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("maxTurns"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("maxCharsPerTurn"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("includeRawFallback"), true);
  assert.equal(schemaKeys("chatgpt_cdp_upload_file").includes("strictBinding"), true);
  assert.equal(schemaKeys("chatgpt_cdp_remove_attachments").includes("strictBinding"), true);
  assert.equal(schemaKeys("chatgpt_cdp_remove_attachments").includes("removeAll"), true);
  assert.equal(schemaKeys("chatgpt_cdp_bind_tab").includes("sessionName"), true);
});

test("registerUiaTools registers the expected UIA tools", () => {
  const registered = new Map();
  registerUiaTools(
    {
      registerTool(name, definition, handler) {
        registered.set(name, { definition, handler });
      },
    },
    makeUiaDeps(),
  );

  assert.deepEqual([...registered.keys()], [
    "chatgpt_read",
    "chatgpt_send",
    "chatgpt_list_downloads",
    "chatgpt_list_attachments",
    "chatgpt_upload_file",
    "chatgpt_remove_attachments",
    "chatgpt_get_state",
    "chatgpt_wait_state",
    "chatgpt_get_code_blocks",
    "chatgpt_get_last_response",
    "chatgpt_stop_generation",
    "chatgpt_download_files",
    "chatgpt_wait_for_update",
    "chatgpt_send_and_wait",
  ]);

  for (const [name, tool] of registered) {
    assert.equal(typeof tool.handler, "function", `${name} handler`);
    assert.equal(typeof tool.definition.title, "string", `${name} title`);
    assert.equal(typeof tool.definition.description, "string", `${name} description`);
    assert.equal(typeof tool.definition.inputSchema, "object", `${name} schema`);
  }
});

test("registerUiaTools preserves key UIA schema fields", () => {
  const registered = new Map();
  registerUiaTools(
    {
      registerTool(name, definition, handler) {
        registered.set(name, { definition, handler });
      },
    },
    makeUiaDeps(),
  );

  const schemaKeys = (toolName) => Object.keys(registered.get(toolName).definition.inputSchema);

  assert.equal(schemaKeys("chatgpt_send").includes("messageBase64"), true);
  assert.equal(schemaKeys("chatgpt_send").includes("allowSuspiciousText"), true);
  assert.equal(schemaKeys("chatgpt_send").includes("allowAttachments"), true);
  assert.equal(schemaKeys("chatgpt_upload_file").includes("allowedExtensions"), true);
  assert.equal(schemaKeys("chatgpt_upload_file").includes("maxBytes"), true);
  assert.equal(schemaKeys("chatgpt_download_files").includes("autoDownload"), false);
  assert.equal(schemaKeys("chatgpt_send_and_wait").includes("autoDownload"), true);
  assert.equal(schemaKeys("chatgpt_send_and_wait").includes("allowAttachments"), true);
});
