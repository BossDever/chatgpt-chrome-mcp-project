import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const AUDIT_SCHEMA_VERSION = 1;

export function hashAuditValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function buildAuditRecord(event = {}, now = new Date()) {
  return compactObject({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    at: now.toISOString(),
    tool: event.tool,
    requestId: event.requestId ?? null,
    sessionName: event.sessionName ?? null,
    tabId: event.tabId ?? null,
    baseUrlHash: event.baseUrlHash ?? hashAuditValue(event.baseUrl),
    urlHash: event.urlHash ?? hashAuditValue(event.url),
    ok: typeof event.ok === "boolean" ? event.ok : null,
    errorCode: event.errorCode ?? null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    dryRun: typeof event.dryRun === "boolean" ? event.dryRun : undefined,
    submit: typeof event.submit === "boolean" ? event.submit : undefined,
    messageHash: event.messageHash,
    fileSha256: event.fileSha256,
    fileExtension: event.fileExtension,
    fileLength: Number.isFinite(event.fileLength) ? event.fileLength : undefined,
    attachmentFilterHash: hashAuditValue(event.attachmentNameContains),
    removeAll: typeof event.removeAll === "boolean" ? event.removeAll : undefined,
    maxAttachments: Number.isFinite(event.maxAttachments) ? event.maxAttachments : undefined,
    bindingWarningCodes: Array.isArray(event.bindingWarningCodes)
      ? event.bindingWarningCodes
      : undefined,
  });
}

export async function appendAuditLog(event, { auditDir } = {}) {
  if (!auditDir) throw new Error("auditDir is required.");
  const record = buildAuditRecord(event);
  const fileName = `${record.at.slice(0, 10)}.jsonl`;
  await mkdir(auditDir, { recursive: true });
  await appendFile(path.join(auditDir, fileName), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}
