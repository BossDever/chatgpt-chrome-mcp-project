import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultCdpBaseUrl,
  findCdpTab,
  readBoundTab,
  writeBoundTab,
} from "./cdp-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const defaultCdpBindingsDir = path.join(
  __dirname,
  "..",
  ".chatgpt-chrome-mcp",
  "bindings",
);

export function normalizeSessionName(sessionName = "default") {
  const normalized = `${sessionName || "default"}`.trim() || "default";
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(normalized)) {
    throw new Error("INVALID_SESSION_NAME");
  }
  return normalized;
}

export function cdpBindingPath(sessionName = "default", bindingsDir = defaultCdpBindingsDir) {
  return path.join(bindingsDir, `${normalizeSessionName(sessionName)}.json`);
}

export function isChatGptUrl(url = "") {
  return /\/\/([^/]+\.)?chatgpt\.com(\/|$)/i.test(url);
}

export async function readBoundCdpTarget(sessionName = "default", options = {}) {
  return readBoundTab(cdpBindingPath(sessionName, options.bindingsDir));
}

export async function writeBoundCdpTarget(sessionName = "default", state, options = {}) {
  return writeBoundTab(cdpBindingPath(sessionName, options.bindingsDir), state);
}

export async function resolveBoundCdpTarget({
  baseUrl,
  tabId,
  useBoundTab = true,
  sessionName = "default",
  strictBinding = false,
  bindingsDir = defaultCdpBindingsDir,
  findTab = findCdpTab,
} = {}) {
  const normalizedSessionName = normalizeSessionName(sessionName);
  if (tabId) {
    return {
      baseUrl: baseUrl ?? defaultCdpBaseUrl(),
      tabId,
      sessionName: normalizedSessionName,
      binding: null,
      bindingWarnings: [],
    };
  }
  if (!useBoundTab) {
    return {
      baseUrl: baseUrl ?? defaultCdpBaseUrl(),
      tabId: undefined,
      sessionName: normalizedSessionName,
      binding: null,
      bindingWarnings: [],
    };
  }

  const binding = await readBoundCdpTarget(normalizedSessionName, { bindingsDir });
  if (!binding) {
    throw new Error(`CDP_BINDING_NOT_FOUND: ${normalizedSessionName}`);
  }

  const resolvedBaseUrl = baseUrl ?? binding?.baseUrl ?? defaultCdpBaseUrl();
  const bindingWarnings = await getCdpBindingWarnings({
    baseUrl: resolvedBaseUrl,
    binding,
    baseUrlOverridden: Boolean(baseUrl && binding?.baseUrl && baseUrl !== binding.baseUrl),
    findTab,
  });
  if (strictBinding && bindingWarnings.length > 0) {
    const codes = bindingWarnings.map((warning) => warning.code).join(",");
    throw new Error(`CDP_BINDING_STALE: ${normalizedSessionName}: ${codes}`);
  }

  return {
    baseUrl: resolvedBaseUrl,
    tabId: binding?.tabId,
    sessionName: normalizedSessionName,
    binding,
    bindingWarnings,
  };
}

export async function getCdpBindingWarnings({
  baseUrl,
  binding,
  baseUrlOverridden = false,
  findTab = findCdpTab,
} = {}) {
  const warnings = [];
  if (baseUrlOverridden) {
    warnings.push({
      code: "CDP_BINDING_BASE_URL_OVERRIDDEN",
      message: "The call supplied a baseUrl different from the stored binding baseUrl.",
      bindingBaseUrl: binding.baseUrl,
      effectiveBaseUrl: baseUrl,
    });
  }
  if (!binding?.tabId) {
    warnings.push({
      code: "CDP_BINDING_TAB_ID_MISSING",
      message: "The stored binding does not contain a tabId.",
    });
    return warnings;
  }

  let currentTab = null;
  try {
    currentTab = await findTab({ baseUrl, tabId: binding.tabId });
  } catch (error) {
    warnings.push({
      code: "CDP_BOUND_TAB_NOT_FOUND",
      message: "The stored bound tabId was not found in the CDP browser.",
      tabId: binding.tabId,
      error: error.message,
    });
    return warnings;
  }

  if (!isChatGptUrl(currentTab.url)) {
    warnings.push({
      code: "CDP_BOUND_TAB_NOT_CHATGPT",
      message: "The stored bound tabId no longer points at a ChatGPT URL.",
      tabId: binding.tabId,
      currentUrl: currentTab.url,
    });
  }
  if (binding.url && currentTab.url && binding.url !== currentTab.url) {
    warnings.push({
      code: "CDP_BINDING_URL_CHANGED",
      message: "The bound tab URL has changed since binding.",
      boundUrl: binding.url,
      currentUrl: currentTab.url,
    });
  }
  if (binding.title && currentTab.title && binding.title !== currentTab.title) {
    warnings.push({
      code: "CDP_BINDING_TITLE_CHANGED",
      message: "The bound tab title has changed since binding.",
      boundTitle: binding.title,
      currentTitle: currentTab.title,
    });
  }
  return warnings;
}
