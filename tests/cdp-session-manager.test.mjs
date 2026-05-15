import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cdpBindingPath,
  getCdpBindingWarnings,
  isChatGptUrl,
  normalizeSessionName,
  readBoundCdpTarget,
  resolveBoundCdpTarget,
  writeBoundCdpTarget,
} from "../src/cdp-session-manager.mjs";

test("session names are normalized and constrained", () => {
  assert.equal(normalizeSessionName(), "default");
  assert.equal(normalizeSessionName(" agent-1 "), "agent-1");
  assert.throws(() => normalizeSessionName("../agent"), /INVALID_SESSION_NAME/);
  assert.throws(() => normalizeSessionName("agent name"), /INVALID_SESSION_NAME/);
});

test("binding paths are namespaced by session name", () => {
  const bindingsDir = path.join("tmp", "bindings");
  assert.equal(
    cdpBindingPath("agent.1", bindingsDir),
    path.join(bindingsDir, "agent.1.json"),
  );
});

test("ChatGPT URL detection accepts ChatGPT domains only", () => {
  assert.equal(isChatGptUrl("https://chatgpt.com/c/abc"), true);
  assert.equal(isChatGptUrl("https://foo.chatgpt.com/"), true);
  assert.equal(isChatGptUrl("https://notchatgpt.com/"), false);
  assert.equal(isChatGptUrl("https://chatgpt.com.evil.test/"), false);
});

test("binding read/write uses the selected bindings directory", async () => {
  const bindingsDir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-bindings-"));
  try {
    const binding = {
      sessionName: "test",
      baseUrl: "http://127.0.0.1:9222",
      tabId: "tab-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/abc",
    };
    await writeBoundCdpTarget("test", binding, { bindingsDir });
    assert.deepEqual(await readBoundCdpTarget("test", { bindingsDir }), binding);
  } finally {
    await rm(bindingsDir, { recursive: true, force: true });
  }
});

test("binding warnings report URL/title drift and baseUrl override", async () => {
  const warnings = await getCdpBindingWarnings({
    baseUrl: "http://127.0.0.1:9333",
    baseUrlOverridden: true,
    binding: {
      baseUrl: "http://127.0.0.1:9222",
      tabId: "tab-1",
      title: "Old title",
      url: "https://chatgpt.com/c/old",
    },
    findTab: async () => ({
      id: "tab-1",
      title: "New title",
      url: "https://chatgpt.com/c/new",
    }),
  });

  assert.deepEqual(
    warnings.map((warning) => warning.code),
    [
      "CDP_BINDING_BASE_URL_OVERRIDDEN",
      "CDP_BINDING_URL_CHANGED",
      "CDP_BINDING_TITLE_CHANGED",
    ],
  );
});

test("binding warnings report missing tab id and missing tabs", async () => {
  const missingId = await getCdpBindingWarnings({
    baseUrl: "http://127.0.0.1:9222",
    binding: {},
  });
  assert.deepEqual(missingId.map((warning) => warning.code), ["CDP_BINDING_TAB_ID_MISSING"]);

  const missingTab = await getCdpBindingWarnings({
    baseUrl: "http://127.0.0.1:9222",
    binding: { tabId: "gone" },
    findTab: async () => {
      throw new Error("CDP_TAB_NOT_FOUND");
    },
  });
  assert.deepEqual(missingTab.map((warning) => warning.code), ["CDP_BOUND_TAB_NOT_FOUND"]);
});

test("binding warnings report non-ChatGPT bound tabs", async () => {
  const warnings = await getCdpBindingWarnings({
    baseUrl: "http://127.0.0.1:9222",
    binding: {
      tabId: "tab-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/old",
    },
    findTab: async () => ({
      id: "tab-1",
      title: "Example",
      url: "https://example.com/",
    }),
  });

  assert.deepEqual(
    warnings.map((warning) => warning.code),
    [
      "CDP_BOUND_TAB_NOT_CHATGPT",
      "CDP_BINDING_URL_CHANGED",
      "CDP_BINDING_TITLE_CHANGED",
    ],
  );
});

test("resolveBoundCdpTarget supports warnings and strict failures", async () => {
  const bindingsDir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-bindings-"));
  try {
    await writeBoundCdpTarget(
      "stale",
      {
        sessionName: "stale",
        baseUrl: "http://127.0.0.1:9222",
        tabId: "tab-1",
        title: "Old title",
        url: "https://chatgpt.com/c/old",
      },
      { bindingsDir },
    );

    const loose = await resolveBoundCdpTarget({
      sessionName: "stale",
      bindingsDir,
      findTab: async () => ({
        id: "tab-1",
        title: "New title",
        url: "https://chatgpt.com/c/new",
      }),
    });
    assert.equal(loose.tabId, "tab-1");
    assert.deepEqual(
      loose.bindingWarnings.map((warning) => warning.code),
      ["CDP_BINDING_URL_CHANGED", "CDP_BINDING_TITLE_CHANGED"],
    );

    await assert.rejects(
      () =>
        resolveBoundCdpTarget({
          sessionName: "stale",
          strictBinding: true,
          bindingsDir,
          findTab: async () => ({
            id: "tab-1",
            title: "New title",
            url: "https://chatgpt.com/c/new",
          }),
        }),
      /CDP_BINDING_STALE/,
    );
  } finally {
    await rm(bindingsDir, { recursive: true, force: true });
  }
});
