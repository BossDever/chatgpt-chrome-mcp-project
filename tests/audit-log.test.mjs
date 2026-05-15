import assert from "node:assert/strict";
import test from "node:test";

import { buildAuditRecord, hashAuditValue } from "../src/audit-log.mjs";

test("audit records keep metadata and omit raw prompt or file path", () => {
  const record = buildAuditRecord(
    {
      tool: "chatgpt_cdp_send",
      requestId: "req-1",
      sessionName: "default",
      tabId: "tab-1",
      baseUrl: "http://127.0.0.1:9222",
      url: "https://chatgpt.com/c/private",
      ok: true,
      durationMs: 123,
      submit: true,
      messageHash: hashAuditValue("secret Thai prompt"),
      message: "secret Thai prompt",
      filePath: "C:/Users/suwit/Desktop/Test/private.zip",
    },
    new Date("2026-05-14T12:00:00.000Z"),
  );

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.tool, "chatgpt_cdp_send");
  assert.equal(record.baseUrlHash, hashAuditValue("http://127.0.0.1:9222"));
  assert.equal(record.urlHash, hashAuditValue("https://chatgpt.com/c/private"));
  assert.equal(record.submit, true);

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("secret Thai prompt"), false);
  assert.equal(serialized.includes("private.zip"), false);
  assert.equal(serialized.includes("127.0.0.1:9222"), false);
  assert.equal(serialized.includes("chatgpt.com/c/private"), false);
});

test("audit records hash attachment filters and preserve safe file metadata", () => {
  const record = buildAuditRecord({
    tool: "chatgpt_cdp_remove_attachments",
    attachmentNameContains: "private-report.zip",
    removeAll: false,
    maxAttachments: 3,
    fileSha256: "abc123",
    fileExtension: ".zip",
    fileLength: 42,
    bindingWarningCodes: ["CDP_BINDING_URL_CHANGED"],
  });

  assert.equal(record.attachmentFilterHash, hashAuditValue("private-report.zip"));
  assert.equal(record.removeAll, false);
  assert.equal(record.maxAttachments, 3);
  assert.equal(record.fileSha256, "abc123");
  assert.equal(record.fileExtension, ".zip");
  assert.equal(record.fileLength, 42);
  assert.deepEqual(record.bindingWarningCodes, ["CDP_BINDING_URL_CHANGED"]);
  assert.equal(JSON.stringify(record).includes("private-report.zip"), false);
});
