#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const requireCdp = args.has("--require-cdp");
const requireBinding = args.has("--require-binding");
const uploadRemoveFile = valueAfterFlag(rawArgs, "--upload-remove-file");

function valueAfterFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  assert(value && !value.startsWith("--"), `${flag} requires a file path value`);
  return value;
}

function toolNames(tools) {
  return tools.tools.map((tool) => tool.name).sort();
}

function countByPrefix(names, prefix) {
  return names.filter((name) => name.startsWith(prefix)).length;
}

async function getStrictDefaultState(client) {
  const state = await client.callTool({
    name: "chatgpt_cdp_get_state",
    arguments: { sessionName: "default", strictBinding: true, maxChars: 1000 },
  });
  assert.equal(state.structuredContent?.ok, true, "strict bound CDP state failed");
  assert.equal(state.isError ?? false, false, "strict bound CDP state returned an MCP error");
  return state;
}

function attachmentCountOf(stateResult) {
  return stateResult.structuredContent?.state?.attachmentCount ?? 0;
}

async function smokeUploadRemove(client, filePath) {
  const fullPath = path.resolve(filePath);
  assert(existsSync(fullPath), `upload/remove smoke file does not exist: ${fullPath}`);

  const before = await getStrictDefaultState(client);
  assert.equal(
    attachmentCountOf(before),
    0,
    "upload/remove smoke requires an empty composer before it starts",
  );

  const upload = await client.callTool({
    name: "chatgpt_cdp_upload_file",
    arguments: {
      sessionName: "default",
      strictBinding: true,
      filePath: fullPath,
      waitForUploadMs: 30000,
    },
  });
  assert.equal(upload.structuredContent?.ok, true, "CDP upload smoke failed");
  assert.equal(upload.isError ?? false, false, "CDP upload smoke returned an MCP error");

  const afterUpload = await getStrictDefaultState(client);
  assert(
    attachmentCountOf(afterUpload) > 0,
    "CDP upload smoke did not create a visible pending attachment",
  );

  const remove = await client.callTool({
    name: "chatgpt_cdp_remove_attachments",
    arguments: {
      sessionName: "default",
      strictBinding: true,
      removeAll: true,
      waitMs: 15000,
    },
  });
  assert.equal(remove.structuredContent?.ok, true, "CDP remove attachment smoke failed");
  assert.equal(remove.isError ?? false, false, "CDP remove attachment smoke returned an MCP error");

  const afterRemove = await getStrictDefaultState(client);
  assert.equal(attachmentCountOf(afterRemove), 0, "CDP remove smoke left pending attachments");

  return {
    filePath: fullPath,
    uploadOk: upload.structuredContent?.ok === true,
    removeOk: remove.structuredContent?.ok === true,
    attachmentCountAfterUpload: attachmentCountOf(afterUpload),
    attachmentCountAfterRemove: attachmentCountOf(afterRemove),
  };
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/server.mjs"],
    cwd: process.cwd(),
  });
  const client = new Client({ name: "chatgpt-chrome-mcp-smoke", version: "0.0.0" });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const names = toolNames(tools);
    const chatgptCdpToolCount = countByPrefix(names, "chatgpt_cdp_");
    const chromeCdpToolCount = countByPrefix(names, "chrome_cdp_");
    const uiaToolCount = countByPrefix(names, "chatgpt_") - chatgptCdpToolCount;

    assert.equal(names.length, 26, "unexpected MCP tool count");
    assert.equal(chatgptCdpToolCount + chromeCdpToolCount, 12, "unexpected CDP tool count");
    assert.equal(uiaToolCount, 14, "unexpected UIA tool count");
    assert(names.includes("chrome_cdp_status"), "missing chrome_cdp_status");
    assert(names.includes("chatgpt_cdp_get_state"), "missing chatgpt_cdp_get_state");
    assert(names.includes("chatgpt_cdp_get_bound_tab"), "missing chatgpt_cdp_get_bound_tab");

    const status = await client.callTool({ name: "chrome_cdp_status", arguments: {} });
    const cdpAvailable = status.structuredContent?.ok === true;
    if (requireCdp) assert.equal(cdpAvailable, true, "CDP is required but unavailable");

    let bound = null;
    let state = null;
    let uploadRemove = null;
    if (cdpAvailable) {
      bound = await client.callTool({
        name: "chatgpt_cdp_get_bound_tab",
        arguments: { sessionName: "default" },
      });

      const hasBoundTab = bound.structuredContent?.ok === true && Boolean(bound.structuredContent?.bound?.tabId);
      if (requireBinding) assert.equal(hasBoundTab, true, "default CDP binding is required but missing");

      if (hasBoundTab) {
        state = await getStrictDefaultState(client);
      }
    }
    if (uploadRemoveFile) {
      assert.equal(cdpAvailable, true, "--upload-remove-file requires an available CDP browser");
      assert(bound?.structuredContent?.bound?.tabId, "--upload-remove-file requires a default bound tab");
      uploadRemove = await smokeUploadRemove(client, uploadRemoveFile);
    }

    console.log(JSON.stringify({
      ok: true,
      toolCount: names.length,
      cdpToolCount: chatgptCdpToolCount + chromeCdpToolCount,
      uiaToolCount,
      cdpAvailable,
      boundTabId: bound?.structuredContent?.bound?.tabId ?? null,
      strictStateOk: state?.structuredContent?.ok ?? null,
      warnings: state?.structuredContent?.bindingWarnings?.map((warning) => warning.code) ?? [],
      uploadRemove,
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
