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
    listCdpArtifacts: asyncNoop,
    listCdpTabs: asyncNoop,
    normalizeSessionName: (value = "default") => value,
    openCdpTab: asyncNoop,
    readBoundCdpTarget: asyncNoop,
    readCdpPage: asyncNoop,
    removeCdpAttachments: asyncNoop,
    resolveBoundCdpTarget: asyncNoop,
    resolveMessageInput: noop,
    saveCdpGeneratedImage: asyncNoop,
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
    "chatgpt_cdp_prepare_session",
    "chrome_cdp_list_tabs",
    "chrome_cdp_open_tab",
    "chatgpt_cdp_bind_tab",
    "chatgpt_cdp_get_bound_tab",
    "chatgpt_cdp_get_state",
    "chatgpt_cdp_read",
    "chatgpt_cdp_list_artifacts",
    "chatgpt_cdp_save_generated_image",
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
  assert.equal(schemaKeys("chrome_cdp_launch").includes("waitForReadyMs"), true);
  assert.equal(schemaKeys("chrome_cdp_launch").includes("pollMs"), true);
  assert.equal(schemaKeys("chrome_cdp_launch").includes("bindSessionName"), true);
  assert.equal(schemaKeys("chatgpt_cdp_prepare_session").includes("launchIfUnavailable"), true);
  assert.equal(schemaKeys("chatgpt_cdp_prepare_session").includes("openIfNoTab"), true);
  assert.equal(schemaKeys("chatgpt_cdp_prepare_session").includes("waitForReadyMs"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("mode"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("maxTurns"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("maxCharsPerTurn"), true);
  assert.equal(schemaKeys("chatgpt_cdp_read").includes("includeRawFallback"), true);
  assert.equal(schemaKeys("chatgpt_cdp_upload_file").includes("strictBinding"), true);
  assert.equal(schemaKeys("chatgpt_cdp_save_generated_image").includes("prefer"), true);
  assert.equal(schemaKeys("chatgpt_cdp_save_generated_image").includes("dryRun"), true);
  assert.equal(schemaKeys("chatgpt_cdp_remove_attachments").includes("strictBinding"), true);
  assert.equal(schemaKeys("chatgpt_cdp_remove_attachments").includes("removeAll"), true);
  assert.equal(schemaKeys("chatgpt_cdp_bind_tab").includes("sessionName"), true);
});

test("chatgpt_cdp_prepare_session reports CDP unavailable without launching when disabled", async () => {
  const registered = new Map();
  registerCdpTools(
    {
      registerTool(name, definition, handler) {
        registered.set(name, { definition, handler });
      },
    },
    {
      ...makeDeps(),
      cdpStatus: async ({ baseUrl }) => ({ ok: false, baseUrl, errorCode: "CDP_NOT_AVAILABLE" }),
    },
  );

  const response = await registered.get("chatgpt_cdp_prepare_session").handler({
    baseUrl: "http://127.0.0.1:9444",
    launchIfUnavailable: false,
  });

  assert.equal(response.structuredContent.ok, false);
  assert.equal(response.structuredContent.ready, false);
  assert.equal(response.structuredContent.errorCode, "CDP_UNAVAILABLE");
  assert.match(response.structuredContent.nextStep, /Launch/);
});

test("chatgpt_cdp_prepare_session auto-binds a single ready ChatGPT tab", async () => {
  const registered = new Map();
  let writtenBinding = null;
  const tab = {
    id: "tab-1",
    tabId: "tab-1",
    title: "ChatGPT",
    url: "https://chatgpt.com/",
    webSocketDebuggerUrl: "ws://example",
  };

  registerCdpTools(
    {
      registerTool(name, definition, handler) {
        registered.set(name, { definition, handler });
      },
    },
    {
      ...makeDeps(),
      cdpStatus: async ({ baseUrl }) => ({ ok: true, baseUrl }),
      resolveBoundCdpTarget: async () => {
        throw new Error("CDP_BINDING_NOT_FOUND");
      },
      listCdpTabs: async () => [tab],
      getCdpState: async () => ({ ok: true, tab, state: { hasPrompt: true, isGenerating: false, attachmentCount: 0 } }),
      writeBoundCdpTarget: async (sessionName, binding) => {
        writtenBinding = { sessionName, binding };
      },
    },
  );

  const response = await registered.get("chatgpt_cdp_prepare_session").handler({
    baseUrl: "http://127.0.0.1:9222",
    sessionName: "review",
  });

  assert.equal(response.structuredContent.ok, true);
  assert.equal(response.structuredContent.ready, true);
  assert.equal(response.structuredContent.state, "ready");
  assert.equal(response.structuredContent.nextStep, "ready");
  assert.equal(writtenBinding.sessionName, "review");
  assert.equal(writtenBinding.binding.tabId, "tab-1");
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
