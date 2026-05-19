import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDuplicateFilenamePattern,
  defaultChromePath,
  getOwnUserTurnVerification,
  isAttachmentRemoveControlLabel,
  normalizeForTurnMatch,
  summarizeRemoveAttachmentResult,
} from "../src/cdp-client.mjs";

test("defaultChromePath honors explicit environment override", () => {
  const previousChatGpt = process.env.CHATGPT_CHROME_PATH;
  const previousChrome = process.env.CHROME_PATH;
  try {
    process.env.CHATGPT_CHROME_PATH = "C:\\Custom\\chrome.exe";
    delete process.env.CHROME_PATH;
    assert.equal(
      defaultChromePath(),
      process.platform === "win32" ? "C:\\Custom\\chrome.exe" : "google-chrome",
    );
  } finally {
    if (previousChatGpt === undefined) delete process.env.CHATGPT_CHROME_PATH;
    else process.env.CHATGPT_CHROME_PATH = previousChatGpt;
    if (previousChrome === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousChrome;
  }
});

test("attachment remove labels require a command prefix", () => {
  assert.equal(isAttachmentRemoveControlLabel("Remove cdp-remove-test.txt"), true);
  assert.equal(isAttachmentRemoveControlLabel("Delete attachment cdp-remove-test.txt"), true);
  assert.equal(isAttachmentRemoveControlLabel("ลบไฟล์ 1: cdp-remove-test.txt"), true);
  assert.equal(isAttachmentRemoveControlLabel("ลบ cdp-remove-test.txt"), true);
  assert.equal(isAttachmentRemoveControlLabel("cdp-remove-test.txt"), false);
  assert.equal(isAttachmentRemoveControlLabel("Please remove cdp-remove-test.txt"), false);
  assert.equal(isAttachmentRemoveControlLabel("review-remove-plan.txt"), false);
  assert.equal(isAttachmentRemoveControlLabel("ไฟล์ที่ต้อง remove.zip"), false);
});

test("duplicate filename pattern matches ChatGPT duplicate names only", () => {
  const filePattern = new RegExp(buildDuplicateFilenamePattern("file.txt"), "i");
  assert.equal(filePattern.test("file.txt"), true);
  assert.equal(filePattern.test("file(2).txt"), true);
  assert.equal(filePattern.test("file (2).txt"), true);
  assert.equal(filePattern.test("ลบไฟล์ 1: file.txt"), true);
  assert.equal(filePattern.test("other-file.txt"), false);

  const dottedPattern = new RegExp(buildDuplicateFilenamePattern("archive.v1.zip"), "i");
  assert.equal(dottedPattern.test("archive.v1.zip"), true);
  assert.equal(dottedPattern.test("archive.v1(2).zip"), true);
  assert.equal(dottedPattern.test("archive-v1.zip"), false);
});

test("turn matching normalizes whitespace and case", () => {
  assert.equal(normalizeForTurnMatch("  Hello\r\n  World  "), "hello world");
});

test("own user turn verification requires both a new turn and matching text", () => {
  const message = "Please review the MCP project.";
  const beforeState = { turnCount: 4, lastUserTurnIndex: 2 };
  const afterState = {
    turnCount: 5,
    lastUserTurnIndex: 4,
    lastUserText: " please   REVIEW the MCP project. ",
  };

  const verified = getOwnUserTurnVerification({ beforeState, afterState, message });
  assert.equal(verified.ok, true);
  assert.equal(verified.mode, "own-user-turn");

  const staleTurn = getOwnUserTurnVerification({
    beforeState,
    afterState: { ...afterState, turnCount: 4, lastUserTurnIndex: 2 },
    message,
  });
  assert.equal(staleTurn.ok, false);

  const wrongText = getOwnUserTurnVerification({
    beforeState,
    afterState: { ...afterState, lastUserText: "Different request" },
    message,
  });
  assert.equal(wrongText.ok, false);
});

test("own user turn verification handles edge cases", () => {
  const beforeState = { turnCount: 8, lastUserTurnIndex: 6 };

  const longMessage = "Review this project. ".repeat(80);
  const longVerified = getOwnUserTurnVerification({
    beforeState,
    afterState: {
      turnCount: 9,
      lastUserTurnIndex: 8,
      lastUserText: longMessage.slice(0, 420),
    },
    message: longMessage,
  });
  assert.equal(longVerified.ok, true);

  const repeatedPrompt = getOwnUserTurnVerification({
    beforeState,
    afterState: {
      turnCount: 9,
      lastUserTurnIndex: 8,
      lastUserText: "same prompt",
    },
    message: "same prompt",
  });
  assert.equal(repeatedPrompt.ok, true);

  const emptyMessage = getOwnUserTurnVerification({
    beforeState,
    afterState: {
      turnCount: 9,
      lastUserTurnIndex: 8,
      lastUserText: "",
    },
    message: "",
  });
  assert.equal(emptyMessage.ok, false);
});

test("remove attachment summary reports incomplete states", () => {
  assert.deepEqual(
    summarizeRemoveAttachmentResult({ requested: 0, clicked: [], remainingMatches: [] }),
    {
      ok: false,
      errorCode: "CDP_ATTACHMENT_NOT_FOUND",
      requested: 0,
      clickedCount: 0,
      remainingCount: 0,
    },
  );

  assert.equal(
    summarizeRemoveAttachmentResult({
      requested: 1,
      clicked: [{ clicked: false }],
      remainingMatches: [],
    }).errorCode,
    "CDP_REMOVE_ATTACHMENTS_INCOMPLETE",
  );

  assert.equal(
    summarizeRemoveAttachmentResult({
      requested: 1,
      clicked: [{ clicked: true }],
      remainingMatches: [{ matchedName: "file.txt" }],
    }).errorCode,
    "CDP_REMOVE_ATTACHMENTS_INCOMPLETE",
  );

  assert.deepEqual(
    summarizeRemoveAttachmentResult({
      requested: 1,
      clicked: [{ clicked: true }],
      remainingMatches: [],
    }),
    {
      ok: true,
      errorCode: undefined,
      requested: 1,
      clickedCount: 1,
      remainingCount: 0,
    },
  );
});
