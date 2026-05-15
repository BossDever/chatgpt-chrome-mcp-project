#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendAuditLog } from "./audit-log.mjs";
import { registerCdpTools } from "./cdp-tools.mjs";
import { verifyDownloadedFiles, verifyLocalUploadFile } from "./file-safety.mjs";
import { createUiaBridge, hasErrorText } from "./uia-bridge.mjs";
import { registerUiaTools } from "./uia-tools.mjs";
import {
  isChatGptUrl,
  normalizeSessionName,
  readBoundCdpTarget,
  resolveBoundCdpTarget,
  writeBoundCdpTarget,
} from "./cdp-session-manager.mjs";
import {
  cdpStatus,
  defaultCdpBaseUrl,
  defaultChromeUserDataDir,
  findCdpTab,
  getCdpState,
  launchCdpChrome,
  listCdpArtifacts,
  listCdpTabs,
  openCdpTab,
  readCdpPage,
  removeCdpAttachments,
  sendCdpMessage,
  sendCdpMessageAndWait,
  saveCdpGeneratedImage,
  uploadCdpFile,
} from "./cdp-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const bridgeScript = path.join(__dirname, "uia-chatgpt.ps1");
const auditDir = path.join(__dirname, "..", ".chatgpt-chrome-mcp", "audit");

const server = new McpServer({
  name: "chatgpt-chrome",
  version: "0.1.0",
});

function looksSuspiciousEncodingLoss(text) {
  if (!text) return false;

  const longQuestionRuns = text.match(/\?{5,}/g) ?? [];
  const questionCount = (text.match(/\?/g) ?? []).length;
  const nonWhitespaceCount = (text.match(/\S/g) ?? []).length;
  const questionRatio = nonWhitespaceCount === 0 ? 0 : questionCount / nonWhitespaceCount;

  return longQuestionRuns.length > 0 || (questionCount >= 8 && questionRatio > 0.18);
}

function resolveMessageInput({ message, messageBase64, allowSuspiciousText = false }) {
  let text = message;

  if (messageBase64) {
    text = Buffer.from(messageBase64, "base64").toString("utf8");
  }

  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Provide message or messageBase64.");
  }

  if (!allowSuspiciousText && looksSuspiciousEncodingLoss(text)) {
    throw new Error(
      "Refusing to send because the message looks like it suffered encoding loss, " +
        "for example many '?' characters. Use messageBase64 for Thai/special text, " +
        "or set allowSuspiciousText=true if the question marks are intentional.",
    );
  }

  return text;
}

function sha256(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

function withMeta(result, { requestId, startedAt }) {
  const finishedAt = new Date().toISOString();
  return {
    ...result,
    requestId: requestId ?? null,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  };
}

async function auditCdpWrite(tool, result, context = {}) {
  try {
    const tab = result?.tab ?? context.tab ?? null;
    const binding = result?.binding ?? context.binding ?? null;
    await appendAuditLog(
      {
        tool,
        requestId: result?.requestId ?? context.requestId,
        sessionName: result?.sessionName ?? context.sessionName,
        tabId: tab?.id ?? result?.tabId ?? context.tabId ?? binding?.tabId,
        baseUrl: context.baseUrl ?? binding?.baseUrl,
        url: tab?.url,
        ok: Boolean(result?.ok),
        errorCode: result?.errorCode,
        durationMs: result?.durationMs,
        dryRun: result?.dryRun,
        submit: context.submit,
        messageHash: context.messageHash,
        fileSha256: context.fileSha256,
        fileExtension: context.fileExtension,
        fileLength: context.fileLength,
        attachmentNameContains: context.attachmentNameContains,
        removeAll: context.removeAll,
        maxAttachments: context.maxAttachments,
        bindingWarningCodes: (result?.bindingWarnings ?? context.bindingWarnings ?? []).map(
          (warning) => warning.code,
        ),
      },
      { auditDir },
    );
  } catch {
    // Audit is best-effort and must never change tool behavior.
  }
}

const {
  getCodeBlocks,
  getLastResponse,
  getState,
  readChat,
  runBridge,
  waitForState,
} = createUiaBridge({ bridgeScript });

registerCdpTools(server, {
  auditCdpWrite,
  cdpStatus,
  defaultCdpBaseUrl,
  defaultChromeUserDataDir,
  findCdpTab,
  getCdpState,
  isChatGptUrl,
  launchCdpChrome,
  listCdpArtifacts,
  listCdpTabs,
  normalizeSessionName,
  openCdpTab,
  readBoundCdpTarget,
  readCdpPage,
  removeCdpAttachments,
  resolveBoundCdpTarget,
  resolveMessageInput,
  sendCdpMessage,
  sendCdpMessageAndWait,
  saveCdpGeneratedImage,
  sha256,
  uploadCdpFile,
  verifyLocalUploadFile,
  withMeta,
  writeBoundCdpTarget,
});

registerUiaTools(server, {
  getCodeBlocks,
  getLastResponse,
  getState,
  hasErrorText,
  readChat,
  resolveMessageInput,
  runBridge,
  sha256,
  verifyDownloadedFiles,
  verifyLocalUploadFile,
  waitForState,
  withMeta,
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
