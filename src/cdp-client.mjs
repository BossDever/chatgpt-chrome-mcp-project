import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chatGptDomAdapterScript } from "./chatgpt-dom-adapter.mjs";
import {
  chatGptGeneratedImageScript,
  saveImageArtifactFromPage,
} from "./image-artifact-saver.mjs";
import { verifyLocalUploadFile } from "./file-safety.mjs";

export { isAttachmentRemoveControlLabel } from "./chatgpt-dom-adapter.mjs";

const DEFAULT_CDP_BASE_URL = "http://127.0.0.1:9222";
const cdpQueues = new Map();

export function defaultCdpBaseUrl() {
  return process.env.CHATGPT_CHROME_MCP_CDP_URL || DEFAULT_CDP_BASE_URL;
}

export function defaultChromeUserDataDir() {
  return path.join(process.cwd(), ".chatgpt-chrome-mcp", "chrome-profile");
}

export function defaultChromePath() {
  if (process.platform !== "win32") return "google-chrome";

  const configured = process.env.CHATGPT_CHROME_PATH || process.env.CHROME_PATH;
  if (configured) return configured;

  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? "chrome.exe";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(baseUrl = defaultCdpBaseUrl()) {
  const normalized = String(baseUrl ?? "").replace(/\/+$/, "");
  const parsed = new URL(normalized);
  const hostname = parsed.hostname.toLowerCase();
  const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  const allowRemote = process.env.CHATGPT_CHROME_MCP_ALLOW_REMOTE_CDP === "1" || process.env.MCP_ALLOW_REMOTE_CDP === "1";
  if (!localHost && !allowRemote) {
    const error = new Error("REMOTE_CDP_BLOCKED: remote Chrome DevTools baseUrl is disabled by default");
    error.code = "REMOTE_CDP_BLOCKED";
    error.errorCode = "REMOTE_CDP_BLOCKED";
    error.remoteCdpAllowed = false;
    error.baseUrlHost = hostname;
    throw error;
  }
  return normalized;
}

function sha256Text(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

function assertChatGptTab(tab) {
  try {
    const parsed = new URL(tab?.url ?? "");
    if (parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com")) return;
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error(`CDP_TAB_NOT_CHATGPT: ${tab?.url ?? "unknown URL"}`);
}

export async function withCdpTabLock(
  { baseUrl = defaultCdpBaseUrl(), tabId, queueWaitTimeoutMs = 30000 },
  fn,
) {
  if (!tabId) return fn();

  const key = `${normalizeBaseUrl(baseUrl)}|${tabId}`;
  const previous = cdpQueues.get(key) ?? Promise.resolve();
  const queuedAt = Date.now();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => {}).then(() => gate);
  cdpQueues.set(key, next);

  let queueTimer = null;
  let queueTimedOut = false;
  try {
    await Promise.race([
      previous.catch(() => {}),
      new Promise((_, reject) => {
        queueTimer = setTimeout(() => {
          queueTimedOut = true;
          const error = new Error(`CDP_TAB_LOCK_QUEUE_TIMEOUT: ${key}`);
          error.code = "CDP_TAB_LOCK_QUEUE_TIMEOUT";
          error.errorCode = "CDP_TAB_LOCK_QUEUE_TIMEOUT";
          error.queueWaitMs = Date.now() - queuedAt;
          error.queueWaitTimeoutMs = queueWaitTimeoutMs;
          reject(error);
        }, queueWaitTimeoutMs);
      }),
    ]);
  } catch (error) {
    release();
    if (cdpQueues.get(key) === next) cdpQueues.set(key, previous);
    throw error;
  } finally {
    if (queueTimer) clearTimeout(queueTimer);
  }

  const lockAcquiredAt = Date.now();
  try {
    return await fn({
      lockKey: key,
      queueWaitMs: lockAcquiredAt - queuedAt,
      queueWaitTimeoutMs,
      lockAcquiredAt,
      queueTimedOut,
    });
  } finally {
    release();
    if (cdpQueues.get(key) === next) cdpQueues.delete(key);
  }
}

async function withLockedCdpTab({
  baseUrl = defaultCdpBaseUrl(),
  tab,
  lockTimeoutMs = 120000,
  queueWaitTimeoutMs = lockTimeoutMs,
}, fn) {
  if (!tab?.webSocketDebuggerUrl) {
    throw new Error("Selected CDP tab does not expose webSocketDebuggerUrl.");
  }

  const key = `${normalizeBaseUrl(baseUrl)}|${tab.id}`;
  return withCdpTabLock({ baseUrl, tabId: tab.id, queueWaitTimeoutMs }, async () => {
    const session = new CdpSession(tab.webSocketDebuggerUrl);
    let timedOut = false;
    let timer = null;

    try {
      await session.connect();
      timer = setTimeout(() => {
        timedOut = true;
        session.close();
      }, lockTimeoutMs);
      await session.send("Runtime.enable");
      await session.send("Page.enable");
      const result = await fn(session);
      if (timedOut) {
        throw new Error(`CDP_TAB_OPERATION_TIMEOUT: ${key}`);
      }
      return result;
    } catch (error) {
      if (timedOut && !error.message.startsWith("CDP_TAB_OPERATION_TIMEOUT")) {
        throw new Error(`CDP_TAB_OPERATION_TIMEOUT: ${key}: ${error.message}`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      session.close();
    }
  });
}

async function fetchJson(url, { timeoutMs = 5000, method = "GET" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function cdpStatus({ baseUrl = defaultCdpBaseUrl(), timeoutMs = 2500 } = {}) {
  try {
    const normalized = normalizeBaseUrl(baseUrl);
    const remoteCdpAllowed = process.env.CHATGPT_CHROME_MCP_ALLOW_REMOTE_CDP === "1" || process.env.MCP_ALLOW_REMOTE_CDP === "1";
    const version = await fetchJson(`${normalized}/json/version`, { timeoutMs });
    return {
      ok: true,
      baseUrl: normalized,
      remoteCdpAllowed,
      browser: version.Browser ?? null,
      protocolVersion: version["Protocol-Version"] ?? null,
      userAgent: version["User-Agent"] ?? null,
      webSocketDebuggerUrl: version.webSocketDebuggerUrl ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      errorCode: error.errorCode ?? "CDP_NOT_AVAILABLE",
      error: error.message,
      remoteCdpAllowed: error.remoteCdpAllowed ?? (process.env.CHATGPT_CHROME_MCP_ALLOW_REMOTE_CDP === "1" || process.env.MCP_ALLOW_REMOTE_CDP === "1"),
    };
  }
}

export async function launchCdpChrome({
  port = 9222,
  userDataDir = defaultChromeUserDataDir(),
  chromePath = defaultChromePath(),
  url = "https://chatgpt.com/",
  waitMs = 2500,
  waitForReadyMs = 0,
  pollMs = 1000,
} = {}) {
  await mkdir(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    url,
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  await sleep(waitMs);
  const baseUrl = `http://127.0.0.1:${port}`;
  const status = await cdpStatus({ baseUrl, timeoutMs: 5000 });
  const ready = status.ok
    ? await waitForChatGptReady({ baseUrl, waitForReadyMs, pollMs })
    : { ok: false, ready: false, errorCode: "CDP_NOT_AVAILABLE", elapsedMs: 0 };
  return {
    ok: status.ok,
    launchedProcessId: child.pid ?? null,
    chromePath,
    userDataDir,
    port,
    baseUrl,
    initialUrl: url,
    status,
    ready,
    actionRequired: ready.ready
      ? null
      : "Log in to ChatGPT in the Chrome window that opened, then report back so the tab can be checked and bound.",
  };
}

export async function waitForChatGptReady({
  baseUrl = defaultCdpBaseUrl(),
  waitForReadyMs = 300000,
  pollMs = 1000,
} = {}) {
  const started = Date.now();
  const deadline = started + Math.max(0, waitForReadyMs);
  let last = null;

  do {
    try {
      const tabs = await listCdpTabs({ baseUrl });
      const candidates = tabs.filter((tab) => {
        try {
          const parsed = new URL(tab.url);
          return parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com");
        } catch {
          return false;
        }
      });
      for (const tab of candidates) {
        const readiness = await inspectChatGptReadiness(tab).catch((error) => ({
          ok: false,
          ready: false,
          errorCode: "CHATGPT_READY_INSPECTION_FAILED",
          error: error.message,
          tab,
        }));
        last = readiness;
        if (readiness.ready) {
          return { ...readiness, elapsedMs: Date.now() - started, timedOut: false };
        }
      }
      if (!last) {
        last = {
          ok: false,
          ready: false,
          errorCode: "CHATGPT_TAB_NOT_FOUND",
          loginLikelyRequired: true,
          tabCount: tabs.length,
        };
      }
    } catch (error) {
      last = { ok: false, ready: false, errorCode: "CHATGPT_READY_CHECK_FAILED", error: error.message };
    }

    if (Date.now() >= deadline) break;
    await sleep(Math.min(Math.max(250, pollMs), Math.max(250, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    ...(last ?? { ok: false, ready: false, errorCode: "CHATGPT_READY_TIMEOUT" }),
    ready: false,
    timedOut: waitForReadyMs > 0,
    elapsedMs: Date.now() - started,
  };
}

async function inspectChatGptReadiness(tab) {
  return withCdpTab(tab, async (session) => {
    const state = await evaluateCdp(session, `(() => {
      const prompt = document.querySelector("#prompt-textarea");
      const text = (document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 1000);
      const loginLikelyRequired = /log in|sign up|continue with|เข้าสู่ระบบ|ลงชื่อเข้าใช้/i.test(text);
      return {
        url: location.href,
        title: document.title,
        hasPrompt: Boolean(prompt),
        loginLikelyRequired,
      };
    })()`);
    return {
      ok: true,
      ready: Boolean(state?.hasPrompt),
      errorCode: state?.hasPrompt ? undefined : "CHATGPT_LOGIN_OR_APP_NOT_READY",
      loginLikelyRequired: !state?.hasPrompt && Boolean(state?.loginLikelyRequired),
      tab: {
        ...tab,
        title: state?.title ?? tab.title,
        url: state?.url ?? tab.url,
      },
      state,
    };
  });
}

export async function listCdpTabs({
  baseUrl = defaultCdpBaseUrl(),
  includeNonPages = false,
  timeoutMs = 5000,
} = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tabs = await fetchJson(`${normalized}/json/list`, { timeoutMs });
  return tabs
    .filter((tab) => includeNonPages || tab.type === "page")
    .map((tab, index) => ({
      index,
      id: tab.id,
      tabId: tab.id,
      type: tab.type,
      title: tab.title ?? "",
      url: tab.url ?? "",
      attached: Boolean(tab.attached),
      canAttach: Boolean(tab.webSocketDebuggerUrl),
      webSocketDebuggerUrl: tab.webSocketDebuggerUrl ?? null,
    }));
}

export async function openCdpTab({
  baseUrl = defaultCdpBaseUrl(),
  url = "https://chatgpt.com/",
  timeoutMs = 5000,
} = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await fetchJson(`${normalized}/json/new?${encodeURIComponent(url)}`, {
    timeoutMs,
    method: "PUT",
  });
  return {
    id: tab.id,
    tabId: tab.id,
    type: tab.type,
    title: tab.title ?? "",
    url: tab.url ?? "",
    webSocketDebuggerUrl: tab.webSocketDebuggerUrl ?? null,
  };
}

export async function findCdpTab({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  titleContains,
  urlContains = "chatgpt.com",
} = {}) {
  const tabs = await listCdpTabs({ baseUrl });
  let matches = tabs;

  if (tabId) {
    matches = tabs.filter((tab) => tab.id === tabId || tab.tabId === tabId);
  } else {
    if (titleContains) {
      matches = matches.filter((tab) =>
        tab.title.toLowerCase().includes(titleContains.toLowerCase()),
      );
    }
    if (urlContains) {
      matches = matches.filter((tab) => tab.url.toLowerCase().includes(urlContains.toLowerCase()));
    }
  }

  if (matches.length === 0) {
    throw new Error("CDP_TAB_NOT_FOUND");
  }
  if (!tabId && matches.length > 1) {
    throw new Error(`AMBIGUOUS_CDP_TAB: ${matches.map((tab) => `${tab.id}:${tab.title}`).join(" | ")}`);
  }

  return matches[0];
}

export class CdpSession {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.ws = null;
  }

  async connect() {
    if (typeof WebSocket !== "function") {
      throw new Error("Node.js global WebSocket is not available. Use Node 22+ or add a WebSocket dependency.");
    }

    this.ws = new WebSocket(this.webSocketDebuggerUrl);
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.ws.addEventListener("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP websocket closed."));
      }
      this.pending.clear();
      for (const { reject, timer } of this.waiters) {
        clearTimeout(timer);
        reject(new Error("CDP websocket closed."));
      }
      this.waiters = [];
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening CDP websocket.")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket error."));
      });
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      const remaining = [];
      for (const waiter of this.waiters) {
        if (waiter.method === message.method && waiter.predicate(message.params ?? {})) {
          clearTimeout(waiter.timer);
          waiter.resolve(message.params ?? {});
        } else {
          remaining.push(waiter);
        }
      }
      this.waiters = remaining;
    }
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error(`Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

export async function withCdpTab(tab, fn) {
  if (!tab?.webSocketDebuggerUrl) {
    throw new Error("Selected CDP tab does not expose webSocketDebuggerUrl.");
  }

  const session = new CdpSession(tab.webSocketDebuggerUrl);
  await session.connect();
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    return await fn(session);
  } finally {
    session.close();
  }
}

export async function evaluateCdp(session, expression, timeoutMs = 10000) {
  const result = await session.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeoutMs,
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "CDP Runtime.evaluate failed.");
  }

  return result.result?.value;
}

function attachmentCandidateExtractorScript() {
  return chatGptDomAdapterScript();
}

async function collectCdpState(session, tab, maxChars = 20000) {
  const snapshot = await evaluateCdp(
    session,
    `(() => {
      const textOf = (el) => (el?.innerText || el?.textContent || el?.value || "").trim();
      const labelOf = (el) => [
        el?.getAttribute?.("aria-label") || "",
        el?.getAttribute?.("data-testid") || "",
        el?.id || "",
        textOf(el)
      ].join(" ").toLowerCase();
      const prompt = document.querySelector("#prompt-textarea");
      const form = prompt?.closest("form") || null;
      const turns = [...document.querySelectorAll("[data-message-author-role]")].map((el, index) => ({
        index,
        role: el.getAttribute("data-message-author-role") || "unknown",
        text: textOf(el)
      }));
      const lastUser = [...turns].reverse().find((turn) => turn.role === "user");
      const lastAssistant = [...turns].reverse().find((turn) => turn.role === "assistant");
      const buttons = [...document.querySelectorAll("button, [role=button]")];
      const sendButton = buttons.find((el) => /send|submit|composer-submit/.test(labelOf(el)));
      const stopButton = buttons.find((el) => /stop/.test(labelOf(el)));
      const formText = textOf(form);
      const promptText = textOf(prompt);
      ${attachmentCandidateExtractorScript()}
      const attachmentCandidates = chatGptDomAdapter.extractAttachmentCandidatesFromComposer({ prompt, form });
      const confirmedAttachmentCandidates = attachmentCandidates.filter((candidate) =>
        candidate.hasRemoveControl || candidate.role === "group" || candidate.matchedBy === "aria-label"
      );
      const attachmentNames = [...new Set(confirmedAttachmentCandidates.map((candidate) => candidate.matchedName))];
      const conversationText = turns.map((turn) => turn.text).join("\\n\\n");
      const isDisabled = (el) =>
        !el || Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
      return {
        title: document.title,
        url: location.href,
        hasPrompt: Boolean(prompt),
        promptText,
        formText,
        isGenerating: Boolean(stopButton || document.querySelector(".result-streaming")),
        attachmentCount: attachmentNames.length,
        attachmentNames,
        attachmentCandidates: confirmedAttachmentCandidates,
        sendButtonEnabled: Boolean(sendButton) && !isDisabled(sendButton),
        stopButtonVisible: Boolean(stopButton),
        conversationTurns: turns.map((turn) => ({
          index: turn.index,
          role: turn.role,
          text: turn.text.slice(0, ${JSON.stringify(maxChars)})
        })),
        conversationText,
        conversationTextLength: conversationText.length,
        turnCount: turns.length,
        lastUserText: (lastUser?.text || "").slice(0, ${JSON.stringify(maxChars)}),
        lastUserTextLength: lastUser?.text?.length || 0,
        lastUserTurnIndex: lastUser?.index ?? -1,
        lastAssistantText: (lastAssistant?.text || "").slice(0, ${JSON.stringify(maxChars)}),
        lastAssistantTextLength: lastAssistant?.text?.length || 0,
        lastAssistantTurnIndex: lastAssistant?.index ?? -1
      };
    })()`,
  );

  const conversationText = snapshot?.conversationText ?? "";
  return {
    ...snapshot,
    conversationText: conversationText.slice(-maxChars),
    conversationTextHash: sha256Text(conversationText),
    lastUserTextHash: sha256Text(snapshot?.lastUserText ?? ""),
    lastAssistantTextHash: sha256Text(snapshot?.lastAssistantText ?? ""),
    tabId: tab.id,
  };
}

async function collectStructuredCdpRead(
  session,
  {
    maxTurns = 6,
    maxCharsPerTurn = 6000,
    includeText = true,
  } = {},
) {
  const result = await evaluateCdp(
    session,
    `(() => {
      ${chatGptDomAdapterScript()}
      return chatGptDomAdapter.buildStructuredVisibleDomRead({
        doc: document,
        maxTurns: ${JSON.stringify(maxTurns)},
        maxCharsPerTurn: ${JSON.stringify(maxCharsPerTurn)},
        includeText: ${JSON.stringify(includeText)}
      });
    })()`,
  );
  return {
    ...result,
    turns: (result?.turns ?? []).map((turn) => ({
      ...turn,
      textHash: typeof turn.text === "string" ? sha256Text(turn.text) : null,
      hashSource: typeof turn.text === "string" ? "returned_text" : "none",
    })),
  };
}

function sanitizeStateForStructuredRead(state) {
  return {
    ...state,
    promptText: "",
    formText: "",
    conversationTurns: [],
    conversationText: "",
    conversationTextHash: "",
    conversationTextLength: 0,
    lastUserText: "",
    lastUserTextHash: "",
    lastUserTextLength: 0,
    lastAssistantText: "",
    lastAssistantTextHash: "",
    lastAssistantTextLength: 0,
  };
}

export function getOwnUserTurnVerification({ beforeState, afterState, message }) {
  const expected = normalizeForTurnMatch(message);
  const actual = normalizeForTurnMatch(afterState?.lastUserText ?? "");
  const beforeTurnCount = beforeState?.turnCount ?? 0;
  const beforeUserIndex = beforeState?.lastUserTurnIndex ?? -1;
  const afterTurnCount = afterState?.turnCount ?? 0;
  const afterUserIndex = afterState?.lastUserTurnIndex ?? -1;
  const sampleLength = Math.min(300, Math.max(40, expected.length));
  const expectedSample = expected.slice(0, sampleLength);
  const actualSample = actual.slice(0, sampleLength);
  const indexAdvanced = afterTurnCount > beforeTurnCount && afterUserIndex > beforeUserIndex;
  const textMatches =
    expected.length > 0 &&
    actual.length > 0 &&
    (actual === expected ||
      actual.includes(expectedSample) ||
      expected.includes(actualSample));

  return {
    ok: Boolean(indexAdvanced && textMatches),
    mode: indexAdvanced && textMatches ? "own-user-turn" : "not-matched",
    indexAdvanced,
    textMatches,
    beforeTurnCount,
    afterTurnCount,
    beforeUserIndex,
    afterUserIndex,
    expectedHash: sha256Text(message ?? ""),
    actualHash: afterState?.lastUserTextHash ?? sha256Text(afterState?.lastUserText ?? ""),
    expectedPreview: (message ?? "").slice(0, 200),
    actualPreview: (afterState?.lastUserText ?? "").slice(0, 200),
  };
}

async function clearAndInsertPrompt(session, message) {
  const prepared = await evaluateCdp(
    session,
    `(() => {
      const prompt = document.querySelector("#prompt-textarea");
      if (!prompt) return { ok: false, errorCode: "PROMPT_NOT_FOUND" };
      prompt.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(prompt);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete");
      prompt.textContent = "";
      prompt.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      return { ok: true };
    })()`,
  );
  if (!prepared?.ok) return { prepared };

  await session.send("Input.insertText", { text: message });
  await sleep(250);

  const verify = await evaluateCdp(
    session,
    `(() => {
      const prompt = document.querySelector("#prompt-textarea");
      const text = prompt ? (prompt.innerText || prompt.textContent || prompt.value || "") : "";
      return { ok: Boolean(prompt), text };
    })()`,
  );

  return { prepared, verify };
}

async function submitPrompt(session, stateBeforeSubmit, waitForSendReadyMs = 30000) {
  const deadline = Date.now() + waitForSendReadyMs;
  let clicked = null;

  while (Date.now() < deadline) {
    clicked = await evaluateCdp(
      session,
      `(() => {
      const prompt = document.querySelector("#prompt-textarea");
      const form = prompt?.closest("form") || document;
      const textOf = (el) => [
        el?.getAttribute?.("aria-label") || "",
        el?.getAttribute?.("data-testid") || "",
        el?.id || "",
        el?.innerText || el?.textContent || ""
      ].join(" ").toLowerCase();
      const buttons = [...form.querySelectorAll("button, [role=button]")];
      const button =
        buttons.find((el) => /send|submit|composer-submit/.test(textOf(el)) && !el.disabled && el.getAttribute("aria-disabled") !== "true") ||
        buttons.find((el) => /send|submit|composer-submit/.test(textOf(el)));
      if (!button) return { ok: false, errorCode: "SEND_BUTTON_NOT_FOUND" };
      if (button.disabled || button.getAttribute("aria-disabled") === "true") {
        return { ok: false, errorCode: "SEND_BUTTON_DISABLED" };
      }
      button.click();
      return {
        ok: true,
        method: "button-click",
        label: (button.getAttribute("aria-label") || button.getAttribute("data-testid") || button.id || button.innerText || "").trim()
      };
    })()`,
      10000,
    );
    if (clicked?.ok) return clicked;
    if (clicked?.errorCode !== "SEND_BUTTON_DISABLED") break;
    await sleep(500);
  }

  await session.send("Input.dispatchKeyEvent", enterKeyEvent("keyDown"));
  await session.send("Input.dispatchKeyEvent", enterKeyEvent("keyUp"));
  await sleep(500);

  const afterEnter = await collectCdpState(session, { id: stateBeforeSubmit.tabId ?? "" }, 12000);
  return {
    ok: afterEnter.promptText.length === 0 || afterEnter.conversationTextHash !== stateBeforeSubmit.conversationTextHash,
    method: "enter-key",
    buttonClick: clicked,
    afterEnter,
  };
}

async function waitForOwnUserTurn(session, tab, { beforeState, message, timeoutMs = 10000, pollMs = 500 }) {
  const start = Date.now();
  let lastState = null;
  let lastVerification = null;

  while (Date.now() - start < timeoutMs) {
    lastState = await collectCdpState(session, tab, 12000);
    lastVerification = getOwnUserTurnVerification({
      beforeState,
      afterState: lastState,
      message,
    });
    if (lastVerification.ok) {
      return {
        ok: true,
        state: lastState,
        verification: lastVerification,
        elapsedMs: Date.now() - start,
      };
    }
    await sleep(pollMs);
  }

  return {
    ok: false,
    state: lastState,
    verification: lastVerification,
    elapsedMs: Date.now() - start,
  };
}

async function sendCdpMessageInSession({
  session,
  tab,
  message,
  submit = true,
  force = false,
  allowAttachments = false,
  replaceDraft = false,
  waitForSendReadyMs = 30000,
  ownTurnWaitMs = 10000,
} = {}) {
  const stateBeforeSend = await collectCdpState(session, tab, 12000);
  if (stateBeforeSend.isGenerating && !force) {
    return {
      ok: false,
      errorCode: "BUSY_GENERATING",
      message: "Refusing to send while ChatGPT appears to be generating.",
      tab,
      stateBeforeSend,
    };
  }

  if (submit && stateBeforeSend.attachmentCount > 0 && !allowAttachments) {
    return {
      ok: false,
      errorCode: "PENDING_ATTACHMENTS",
      message:
        "Refusing to submit while ChatGPT has pending attachments. Set allowAttachments=true to submit them.",
      tab,
      stateBeforeSend,
    };
  }

  if (stateBeforeSend.promptText && !replaceDraft) {
    return {
      ok: false,
      errorCode: "DRAFT_PRESENT",
      message: "Refusing to replace existing prompt text. Set replaceDraft=true to overwrite it.",
      tab,
      stateBeforeSend,
    };
  }

  const { prepared, verify } = await clearAndInsertPrompt(session, message);
  if (!prepared?.ok) return { ok: false, tab, prepared };

  const exactVerified = normalizePromptText(verify?.text) === normalizePromptText(message);
  const looseVerified = normalizeLooseText(verify?.text) === normalizeLooseText(message);
  const verified = exactVerified || looseVerified;
  if (!verified) {
    return {
      ok: false,
      errorCode: "CDP_PROMPT_VERIFY_FAILED",
      tab,
      promptValue: verify?.text ?? "",
      stateBeforeSend,
    };
  }

  let submitResult = null;
  let stateAfterSubmit = null;
  let ownTurn = null;
  let ownTurnAppeared = false;
  let ownTurnVerifyMode = submit ? "not-submitted" : null;

  if (submit) {
    submitResult = await submitPrompt(session, stateBeforeSend, waitForSendReadyMs);
    ownTurn = await waitForOwnUserTurn(session, tab, {
      beforeState: stateBeforeSend,
      message,
      timeoutMs: ownTurnWaitMs,
    });
    stateAfterSubmit = ownTurn.state ?? (await collectCdpState(session, tab, 12000));
    ownTurnAppeared = Boolean(ownTurn.ok);
    ownTurnVerifyMode = ownTurn.verification?.mode ?? "not-matched";
    const fallbackSubmitEvidence =
      stateAfterSubmit.promptText.length === 0 && stateAfterSubmit.isGenerating;
    const submitVerified = ownTurnAppeared || fallbackSubmitEvidence;
    if (!submitVerified) {
      return {
        ok: false,
        errorCode: "CDP_SUBMIT_VERIFY_FAILED",
        message: "The prompt was written, but ChatGPT did not appear to submit this user turn.",
        tab,
        submitResult,
        ownTurnAppeared,
        ownTurnVerifyMode,
        ownTurn,
        stateBeforeSend,
        stateAfterSubmit,
      };
    }

    if (!ownTurnAppeared && fallbackSubmitEvidence) {
      ownTurnVerifyMode = "fallback-generating";
    }
  }

  return {
    ok: true,
    tab,
    submitted: submit,
    submitResult,
    ownTurnAppeared,
    ownTurnVerifyMode,
    ownTurn,
    verifiedBeforeSubmit: true,
    verificationMode: exactVerified ? "exact" : "whitespace-normalized",
    promptValueBeforeSubmit: verify.text,
    stateBeforeSend,
    stateAfterSubmit,
  };
}

export async function getCdpState({ baseUrl = defaultCdpBaseUrl(), tabId, maxChars = 20000 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);

  return withCdpTab(tab, async (session) => {
    const state = await collectCdpState(session, tab, maxChars);
    return {
      ok: true,
      tab,
      state,
    };
  });
}

export async function readCdpPage({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  maxChars = 20000,
  mode = "raw",
  maxTurns = 6,
  maxCharsPerTurn = 6000,
  includeRawFallback = false,
  includeText = true,
} = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);

  return withCdpTab(tab, async (session) => {
    const normalizedMode = ["raw", "structured", "combined"].includes(mode) ? mode : "raw";
    const needsRaw = normalizedMode === "raw" || normalizedMode === "combined" || includeRawFallback;
    const needsStructured = normalizedMode === "structured" || normalizedMode === "combined";
    const state = needsRaw ? await collectCdpState(session, tab, maxChars) : await collectCdpState(session, tab, 1000);
    const pageState = needsRaw ? state : sanitizeStateForStructuredRead(state);
    const structured = needsStructured
      ? await collectStructuredCdpRead(session, { maxTurns, maxCharsPerTurn, includeText })
      : null;
    return {
      ok: true,
      tab,
      page: {
        mode: normalizedMode,
        title: pageState.title,
        url: pageState.url,
        text: needsRaw ? pageState.conversationText : "",
        textLength: needsRaw ? pageState.conversationTextLength : 0,
        hasPrompt: pageState.hasPrompt,
        promptText: pageState.promptText,
        conversationTurns: needsRaw ? pageState.conversationTurns : [],
        lastAssistantText: needsRaw ? pageState.lastAssistantText : "",
        structured,
        rawFallbackIncluded: needsRaw,
        state: pageState,
      },
    };
  });
}

export async function listCdpArtifacts({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  maxItems = 50,
} = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);

  return withCdpTab(tab, async (session) => {
    const artifacts = await evaluateCdp(session, `(() => {
      const maxItems = ${JSON.stringify(maxItems)};
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const images = [...document.images]
        .filter(isVisible)
        .slice(0, maxItems)
        .map((img, index) => {
          const src = img.currentSrc || img.src || "";
          const srcKind = src.startsWith("blob:") ? "blob" : src.startsWith("data:") ? "data" : src.startsWith("http") ? "http" : "other";
          const surroundingText = textOf(img.closest("[data-message-author-role], article, main, div")).slice(0, 240);
          const generatedSrc = /\\/backend-api\\/estuary\\/content|files\\.oaiusercontent|oaidalleapiprodscus/i.test(src);
          const likelyUiAsset = !generatedSrc && (/avatar|profile|gravatar|googleusercontent\\.com\\/(a\\/|ogw\\/)|favicon|sprite|logo/i.test(src) ||
            /avatar|profile/i.test(img.alt || surroundingText));
          const likelyGenerated = generatedSrc || (!likelyUiAsset && (
            srcKind === "blob" ||
            srcKind === "data" ||
            (img.naturalWidth >= 256 && img.naturalHeight >= 256)
          ));
          return {
            index,
            type: "image",
            srcKind,
            srcPreview: src.slice(0, 240),
            alt: img.alt || "",
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            rect: rectOf(img),
            surroundingText,
            likelyUiAsset,
            likelyGenerated,
          };
        });
      const downloadControls = [...document.querySelectorAll("button, a, [role='button']")]
        .filter(isVisible)
        .map((el, index) => {
          const label = [
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || "",
            el.getAttribute("download") || "",
            el.href || "",
            textOf(el),
            el.getAttribute("data-testid") || "",
            el.getAttribute("data-test-id") || "",
            String(el.className || ""),
          ].join(" ").replace(/\\s+/g, " ").trim();
          return {
            index,
            type: "download_control",
            tagName: el.tagName,
            label: label.slice(0, 240),
            hrefKind: (el.href || "").startsWith("blob:") ? "blob" : (el.href || "").startsWith("data:") ? "data" : (el.href || "").startsWith("http") ? "http" : "",
            hrefPreview: (el.href || "").slice(0, 240),
            rect: rectOf(el),
          };
        })
        .filter((entry) => /download|save as|save image|ดาวน์โหลด|บันทึก|blob:|data:/i.test(entry.label))
        .slice(0, maxItems);
      const imagePlaceholders = [...document.querySelectorAll("[data-message-author-role] p, article p, main p")]
        .map((el, index) => ({ el, index, text: textOf(el) }))
        .filter((entry) => /\\[\\s*image\\s*:/i.test(entry.text))
        .slice(0, maxItems)
        .map((entry) => ({
          index: entry.index,
          type: "image_placeholder",
          text: entry.text.slice(0, 500),
          rect: rectOf(entry.el),
        }));
      return {
        url: location.href,
        title: document.title,
        imageCount: images.length,
        likelyGeneratedImageCount: images.filter((image) => image.likelyGenerated).length,
        downloadControlCount: downloadControls.length,
        imagePlaceholderCount: imagePlaceholders.length,
        images,
        downloadControls,
        imagePlaceholders,
      };
    })()`, 10000);
    return { ok: true, tab, artifacts };
  });
}

export async function saveCdpGeneratedImage({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  outputDir,
  fileNamePrefix = "chatgpt-generated-image",
  which = "newest",
  index = 0,
  prefer = "auto",
  maxPixels = 4096 * 4096,
  waitForImageMs = 30000,
  dryRun = false,
  lockTimeoutMs = 120000,
} = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);
  return withLockedCdpTab({ baseUrl: normalized, tab, lockTimeoutMs }, async (session) => {
    const saved = await saveImageArtifactFromPage({
      evaluateCdp,
      session,
      outputDir,
      fileNamePrefix,
      dryRun,
      timeoutMs: Math.max(waitForImageMs + 15000, 60000),
      script: chatGptGeneratedImageScript({
        which,
        index,
        prefer,
        maxPixels,
        waitForImageMs,
      }),
    });
    return {
      ...saved,
      tab,
    };
  });
}

export async function sendCdpMessage({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  message,
  submit = true,
  force = false,
  allowAttachments = false,
  replaceDraft = false,
  waitForSendReadyMs = 30000,
  ownTurnWaitMs = 10000,
  lockTimeoutMs = 120000,
} = {}) {
  if (!message) throw new Error("Message is empty.");
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);

  return withLockedCdpTab(
    { baseUrl: normalized, tab, lockTimeoutMs },
    async (session) =>
      sendCdpMessageInSession({
        session,
        tab,
        message,
        submit,
        force,
        allowAttachments,
        replaceDraft,
        waitForSendReadyMs,
        ownTurnWaitMs,
      }),
  );
}

async function waitForAssistantReplyStable(
  session,
  tab,
  {
    baselineState,
    timeoutMs = 120000,
    pollMs = 750,
    stableMs = 2000,
    postStableReadDelayMs = 1500,
  } = {},
) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const baselineAssistantIndex = baselineState?.lastAssistantTurnIndex ?? -1;
  const baselineAssistantHash = baselineState?.lastAssistantTextHash ?? "";
  const minAssistantIndex = baselineState?.lastUserTurnIndex ?? -1;
  let replyStartedAt = null;
  let generationStoppedAt = null;
  let stableAt = null;
  let candidateHash = "";
  let candidateLength = 0;
  let candidateTurnIndex = -1;
  let candidateSince = 0;
  let lastState = null;

  while (Date.now() - started < timeoutMs) {
    lastState = await collectCdpState(session, tab, 20000);
    const hasNewAssistant =
      lastState.lastAssistantTurnIndex > minAssistantIndex &&
      (lastState.lastAssistantTurnIndex > baselineAssistantIndex ||
        (lastState.lastAssistantTextHash !== baselineAssistantHash &&
          lastState.lastAssistantTextLength > 0));

    if (hasNewAssistant && !replyStartedAt) {
      replyStartedAt = new Date().toISOString();
    }

    if (hasNewAssistant && !lastState.isGenerating) {
      if (!generationStoppedAt) generationStoppedAt = new Date().toISOString();

      if (
        candidateHash !== lastState.lastAssistantTextHash ||
        candidateLength !== lastState.lastAssistantTextLength ||
        candidateTurnIndex !== lastState.lastAssistantTurnIndex
      ) {
        candidateHash = lastState.lastAssistantTextHash;
        candidateLength = lastState.lastAssistantTextLength;
        candidateTurnIndex = lastState.lastAssistantTurnIndex;
        candidateSince = Date.now();
      } else if (Date.now() - candidateSince >= stableMs) {
        if (postStableReadDelayMs > 0) {
          await sleep(postStableReadDelayMs);
          const verifiedState = await collectCdpState(session, tab, 20000);
          if (
            verifiedState.isGenerating ||
            verifiedState.lastAssistantTurnIndex !== candidateTurnIndex ||
            verifiedState.lastAssistantTextHash !== candidateHash ||
            verifiedState.lastAssistantTextLength !== candidateLength
          ) {
            lastState = verifiedState;
            candidateHash = verifiedState.lastAssistantTextHash;
            candidateLength = verifiedState.lastAssistantTextLength;
            candidateTurnIndex = verifiedState.lastAssistantTurnIndex;
            candidateSince = Date.now();
            await sleep(pollMs);
            continue;
          }
          lastState = verifiedState;
        }
        stableAt = new Date().toISOString();
        return {
          ok: true,
          timeout: false,
          startedAt,
          replyStartedAt,
          generationStoppedAt,
          stableAt,
          elapsedMs: Date.now() - started,
          state: lastState,
          lastAssistantText: lastState.lastAssistantText,
          lastAssistantTextHash: lastState.lastAssistantTextHash,
        };
      }
    } else {
      candidateHash = "";
      candidateLength = 0;
      candidateTurnIndex = -1;
      candidateSince = 0;
    }

    await sleep(pollMs);
  }

  return {
    ok: false,
    timeout: true,
    startedAt,
    replyStartedAt,
    generationStoppedAt,
    stableAt,
    elapsedMs: Date.now() - started,
    state: lastState,
    lastAssistantText: lastState?.lastAssistantText ?? "",
    lastAssistantTextHash: lastState?.lastAssistantTextHash ?? "",
  };
}

export async function sendCdpMessageAndWait({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  message,
  force = false,
  allowAttachments = false,
  replaceDraft = false,
  waitForSendReadyMs = 30000,
  ownTurnWaitMs = 10000,
  timeoutMs = 120000,
  pollMs = 750,
  stableMs = 2000,
  lockTimeoutMs,
  requireOwnTurn = true,
} = {}) {
  if (!message) throw new Error("Message is empty.");
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);
  const effectiveLockTimeoutMs = lockTimeoutMs ?? timeoutMs + waitForSendReadyMs + ownTurnWaitMs + 15000;

  return withLockedCdpTab(
    { baseUrl: normalized, tab, lockTimeoutMs: effectiveLockTimeoutMs },
    async (session) => {
      const sent = await sendCdpMessageInSession({
        session,
        tab,
        message,
        submit: true,
        force,
        allowAttachments,
        replaceDraft,
        waitForSendReadyMs,
        ownTurnWaitMs,
      });
      if (!sent.ok) return { ...sent, wait: null };
      if (requireOwnTurn && !sent.ownTurnAppeared) {
        return {
          ok: false,
          errorCode: "CDP_OWN_TURN_NOT_VERIFIED",
          tab,
          sent,
          wait: null,
          submitted: sent.submitted,
          ownTurnAppeared: sent.ownTurnAppeared,
          ownTurnVerifyMode: sent.ownTurnVerifyMode,
          stateBeforeSend: sent.stateBeforeSend,
          stateAfterSubmit: sent.stateAfterSubmit,
        };
      }

      const wait = await waitForAssistantReplyStable(session, tab, {
        baselineState: sent.stateBeforeSend,
        timeoutMs,
        pollMs,
        stableMs,
      });

      return {
        ok: wait.ok,
        errorCode: wait.ok ? undefined : "CDP_REPLY_WAIT_TIMEOUT",
        tab,
        sent,
        wait,
        submitted: sent.submitted,
        ownTurnAppeared: sent.ownTurnAppeared,
        ownTurnVerifyMode: sent.ownTurnVerifyMode,
        lastUserText: wait.state?.lastUserText ?? sent.stateAfterSubmit?.lastUserText ?? "",
        lastUserTextHash:
          wait.state?.lastUserTextHash ?? sent.stateAfterSubmit?.lastUserTextHash ?? "",
        lastAssistantText: wait.lastAssistantText,
        lastAssistantTextHash: wait.lastAssistantTextHash,
        stateBeforeSend: sent.stateBeforeSend,
        stateAfterSubmit: sent.stateAfterSubmit,
        finalState: wait.state,
      };
    },
  );
}

export async function uploadCdpFile({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  filePath,
  waitForUploadMs = 15000,
  force = false,
  lockTimeoutMs = 120000,
} = {}) {
  if (!filePath) throw new Error("filePath is required.");
  const fileSafety = await verifyLocalUploadFile(filePath);
  if (!fileSafety.safeForUpload) {
    return {
      ok: false,
      errorCode: fileSafety.blockedExtension
        ? "BLOCKED_UPLOAD_EXTENSION"
        : !fileSafety.allowedExtension
          ? "DISALLOWED_UPLOAD_EXTENSION"
          : !fileSafety.withinMaxBytes
            ? "UPLOAD_FILE_TOO_LARGE"
            : "UNSAFE_UPLOAD_FILE",
      fileSafety,
    };
  }
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);
  const fileName = path.basename(filePath);

  return withLockedCdpTab({ baseUrl: normalized, tab, lockTimeoutMs }, async (session) => {
    const stateBeforeUpload = await collectCdpState(session, tab, 12000);
    if (stateBeforeUpload.isGenerating && !force) {
      return {
        ok: false,
        errorCode: "BUSY_GENERATING",
        message: "Refusing to attach a file while ChatGPT appears to be generating.",
        tab,
        stateBeforeUpload,
      };
    }

    await session.send("DOM.enable");
    const directUpload = await tryDirectHiddenInputUpload(session, filePath, fileName, waitForUploadMs);
    if (directUpload?.ok) {
      return {
        ...directUpload,
        tab,
        stateBeforeUpload,
        fileSafety,
      };
    }

    const fallbackUpload = await uploadViaFileChooserInterception(
      session,
      filePath,
      fileName,
      waitForUploadMs,
    );
    return {
      ...fallbackUpload,
      directUploadAttempt: directUpload,
      tab,
      stateBeforeUpload,
      fileSafety,
    };
  });
}

export async function removeCdpAttachments({
  baseUrl = defaultCdpBaseUrl(),
  tabId,
  attachmentNameContains,
  removeAll = false,
  maxAttachments = 10,
  waitMs = 10000,
  lockTimeoutMs = 120000,
} = {}) {
  if (!removeAll && !attachmentNameContains) {
    throw new Error("Provide attachmentNameContains or set removeAll=true.");
  }
  const normalized = normalizeBaseUrl(baseUrl);
  const tab = await findCdpTab({ baseUrl: normalized, tabId });
  assertChatGptTab(tab);
  const filterText = (attachmentNameContains ?? "").toLowerCase();

  return withLockedCdpTab({ baseUrl: normalized, tab, lockTimeoutMs }, async (session) => {
    const stateBeforeRemove = await collectCdpState(session, tab, 12000);
    const removed = await evaluateCdp(
      session,
      `(() => {
        const textOf = (el) => (el?.innerText || el?.textContent || el?.value || "").trim();
        const prompt = document.querySelector("#prompt-textarea");
        const form = prompt?.closest("form") || null;
        const filterText = ${JSON.stringify(filterText)};
        const removeAll = ${JSON.stringify(Boolean(removeAll))};
        const maxAttachments = ${JSON.stringify(maxAttachments)};
        ${attachmentCandidateExtractorScript()}
        const matchingRecords = chatGptDomAdapter.getAttachmentCandidateRecordsFromComposer({ prompt, form })
          .filter((record) => {
            const candidate = record.candidate;
            const haystack = [candidate.matchedName, candidate.ariaLabel, candidate.text, candidate.removeLabel]
              .join(" ")
              .toLowerCase();
            return removeAll || haystack.includes(filterText);
          });
        const records = [];
        const seenControls = new WeakSet();
        const seenFallbackKeys = new Set();
        for (const record of matchingRecords) {
          const identity = record.removeButton || record.group || record.el;
          if (identity) {
            if (seenControls.has(identity)) continue;
            seenControls.add(identity);
          } else {
            const candidate = record.candidate;
            const fallbackKey = candidate.matchedName + "|" + candidate.ariaLabel + "|" + candidate.removeLabel;
            if (seenFallbackKeys.has(fallbackKey)) continue;
            seenFallbackKeys.add(fallbackKey);
          }
          records.push(record);
          if (records.length >= maxAttachments) break;
        }
        const clicked = [];
        const clickedControls = new WeakSet();
        for (const record of records) {
          const candidate = record.candidate;
          if (!record.removeButton) {
            clicked.push({ matchedName: candidate.matchedName, clicked: false, reason: "REMOVE_BUTTON_NOT_FOUND" });
            continue;
          }
          const label = record.removeButton.getAttribute("aria-label") || textOf(record.removeButton);
          if (!chatGptDomAdapter.isAttachmentRemoveControlLabel(label)) {
            clicked.push({ matchedName: candidate.matchedName, clicked: false, reason: "REMOVE_BUTTON_LABEL_NOT_TRUSTED", label });
            continue;
          }
          if (clickedControls.has(record.removeButton)) continue;
          clickedControls.add(record.removeButton);
          record.removeButton.click();
          clicked.push({ matchedName: candidate.matchedName, clicked: true, label });
          if (clicked.filter((entry) => entry.clicked).length >= maxAttachments) {
            break;
          }
        }
        return { ok: true, requested: records.length, clicked };
      })()`,
      10000,
    );

    const deadline = Date.now() + waitMs;
    let stateAfterRemove = await collectCdpState(session, tab, 12000);
    let remainingMatches = [];
    while (Date.now() < deadline) {
      remainingMatches = stateAfterRemove.attachmentCandidates.filter((candidate) => {
        const haystack = [
          candidate.matchedName,
          candidate.ariaLabel,
          candidate.text,
          candidate.removeLabel,
        ]
          .join(" ")
          .toLowerCase();
        return removeAll || haystack.includes(filterText);
      });
      if (remainingMatches.length === 0) break;
      await sleep(500);
      stateAfterRemove = await collectCdpState(session, tab, 12000);
    }
    remainingMatches = stateAfterRemove.attachmentCandidates.filter((candidate) => {
      const haystack = [
        candidate.matchedName,
        candidate.ariaLabel,
        candidate.text,
        candidate.removeLabel,
      ]
        .join(" ")
        .toLowerCase();
      return removeAll || haystack.includes(filterText);
    });
    const removeSummary = summarizeRemoveAttachmentResult({
      requested: removed.requested,
      clicked: removed.clicked,
      remainingMatches,
    });

    return {
      ok: removeSummary.ok,
      errorCode: removeSummary.errorCode,
      tab,
      removed,
      removeSummary,
      remainingMatches,
      stateBeforeRemove,
      stateAfterRemove,
    };
  });
}

async function tryDirectHiddenInputUpload(session, filePath, fileName, waitForUploadMs) {
  const selectors = ["#upload-files", "input[type=file]"];
  const attempts = [];
  const seenNodeIds = new Set();
  const directWaitForUploadMs = Math.min(waitForUploadMs, 10000);
  for (const selector of selectors) {
    const input = await setFileInputBySelector(session, selector, filePath);
    if (!input.nodeId) continue;
    if (seenNodeIds.has(input.nodeId)) continue;
    seenNodeIds.add(input.nodeId);

    const attachment = await waitForAttachmentByName(session, fileName, directWaitForUploadMs);
    const attempt = {
      ok: Boolean(attachment?.found),
      method: "DOM.setFileInputFiles",
      fileName,
      input,
      attachment,
    };
    attempts.push(attempt);
    if (attempt.ok) return attempt;
  }

  return attempts.length > 0
    ? { ok: false, method: "DOM.setFileInputFiles", fileName, attempts }
    : null;
}

async function setFileInputBySelector(session, selector, filePath) {
  try {
    const document = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const result = await session.send("DOM.querySelector", {
      nodeId: document.root.nodeId,
      selector,
    });
    if (!result.nodeId) return { nodeId: 0, selector };

    await session.send("DOM.setFileInputFiles", { nodeId: result.nodeId, files: [] }, 10000).catch(() => {});
    await session.send("DOM.setFileInputFiles", { nodeId: result.nodeId, files: [filePath] }, 10000);
    return { nodeId: result.nodeId, selector };
  } catch (error) {
    return { nodeId: 0, selector, error: error.message };
  }
}

async function uploadViaFileChooserInterception(session, filePath, fileName, waitForUploadMs) {
  await session.send("Page.setInterceptFileChooserDialog", { enabled: true });

  try {
    const chooserPromise = session
      .waitForEvent("Page.fileChooserOpened", () => true, 7000)
      .catch((error) => ({ errorCode: "FILE_CHOOSER_NOT_OPENED", message: error.message }));
    const clicked = await evaluateCdp(
      session,
      `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        ${chatGptDomAdapterScript()}
        const clickElement = (el) => {
          el.scrollIntoView?.({ block: "center", inline: "center" });
          const rect = el.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            el.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX,
              clientY,
            }));
          }
        };
        const plus = document.querySelector("#composer-plus-btn");
        if (!plus) return { ok: false, errorCode: "PLUS_BUTTON_NOT_FOUND" };
        let item = chatGptDomAdapter.findUploadMenuItem(document);
        if (!item) {
          clickElement(plus);
          await sleep(500);
          item = chatGptDomAdapter.findUploadMenuItem(document);
        }
        if (!item) return { ok: false, errorCode: "UPLOAD_MENU_ITEM_NOT_FOUND" };
        clickElement(item);
        return { ok: true, label: chatGptDomAdapter.textOf(item) };
      })()`,
      10000,
    );
    if (!clicked?.ok) return { ok: false, method: "FileChooserIntercept", clicked };

    const chooser = await chooserPromise;
    if (chooser.errorCode) {
      return { ok: false, method: "FileChooserIntercept", clicked, ...chooser };
    }
    const params = { files: [filePath] };
    if (chooser.backendNodeId) {
      params.backendNodeId = chooser.backendNodeId;
    } else if (chooser.frameId) {
      params.frameId = chooser.frameId;
    }

    await session.send("DOM.setFileInputFiles", params, 10000);

    const attachment = await waitForAttachmentByName(session, fileName, waitForUploadMs);
    return {
      ok: Boolean(attachment?.found),
      method: "FileChooserIntercept",
      clicked,
      fileName,
      attachment,
    };
  } finally {
    await session.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}

async function waitForAttachmentByName(session, fileName, waitForUploadMs) {
  const duplicateNamePattern = buildDuplicateFilenamePattern(fileName);
  const deadline = Date.now() + waitForUploadMs;
  let attachment = null;
  while (Date.now() < deadline) {
    attachment = await evaluateCdp(
      session,
      `(() => {
        const textOf = (el) => (el?.innerText || el?.textContent || el?.value || "").trim();
        const prompt = document.querySelector("#prompt-textarea");
        const form = prompt?.closest("form") || null;
        const fileNamePattern = new RegExp(${JSON.stringify(duplicateNamePattern)}, "i");
        ${attachmentCandidateExtractorScript()}
        const candidates = chatGptDomAdapter.extractAttachmentCandidatesFromComposer({ prompt, form })
          .filter((candidate) =>
            fileNamePattern.test(candidate.matchedName) ||
            fileNamePattern.test(candidate.ariaLabel) ||
            fileNamePattern.test(candidate.text)
          );
        const removeButton = candidates.find((candidate) => candidate.hasRemoveControl)?.removeLabel || "";
        return {
          found: candidates.length > 0,
          fileName: ${JSON.stringify(fileName)},
          removeButton,
          candidates
        };
      })()`,
    );
    if (attachment?.found) break;
    await sleep(500);
  }

  return attachment;
}

export function summarizeRemoveAttachmentResult({ requested = 0, clicked = [], remainingMatches = [] } = {}) {
  const clickedCount = clicked.filter((entry) => entry?.clicked).length;
  const remainingCount = remainingMatches.length;
  const ok = requested > 0 && clickedCount > 0 && remainingCount === 0;
  return {
    ok,
    errorCode: ok
      ? undefined
      : requested === 0
        ? "CDP_ATTACHMENT_NOT_FOUND"
        : "CDP_REMOVE_ATTACHMENTS_INCOMPLETE",
    requested,
    clickedCount,
    remainingCount,
  };
}

export function buildDuplicateFilenamePattern(fileName) {
  const parsed = path.parse(fileName);
  return `(^|[\\s:/\\\\])${escapeRegExp(parsed.name)}(?:\\s*\\(\\d+\\))?${escapeRegExp(parsed.ext)}($|[\\s,;:)\\]])`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function enterKeyEvent(type) {
  return {
    type,
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
}

function normalizePromptText(text) {
  return (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function normalizeLooseText(text) {
  return normalizePromptText(text).replace(/\s+/g, " ");
}

export function normalizeForTurnMatch(text) {
  return normalizeLooseText(text).toLowerCase();
}

export async function readBoundTab(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writeBoundTab(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}
