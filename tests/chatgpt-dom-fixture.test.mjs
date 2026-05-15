import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseHTML } from "linkedom";

import {
  buildStructuredVisibleDomRead,
  extractAttachmentCandidatesFromComposer,
  extractConversationTurnsFromDocument,
  findSendButton,
  findUploadMenuItem,
  getAttachmentCandidateRecordsFromComposer,
  getLastTurn,
  isUploadMenuItem,
} from "../src/chatgpt-dom-adapter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, "fixtures", "chatgpt-like-page.html");

async function loadFixture() {
  const html = await readFile(fixturePath, "utf8");
  return parseHTML(html).document;
}

test("fixture extracts conversation turns with stable indexes", async () => {
  const document = await loadFixture();
  const turns = extractConversationTurnsFromDocument(document);

  assert.deepEqual(
    turns.map((turn) => ({ index: turn.index, role: turn.role, text: turn.text })),
    [
      { index: 0, role: "user", text: "Please review the project." },
      { index: 1, role: "assistant", text: "First reply." },
      { index: 2, role: "user", text: "Upload this file." },
    ],
  );
  assert.equal(getLastTurn(turns, "user").index, 2);
  assert.equal(getLastTurn(turns, "assistant").text, "First reply.");
});

test("fixture finds send button by stable labels/test ids", async () => {
  const document = await loadFixture();
  const sendButton = findSendButton(document);

  assert.equal(sendButton?.getAttribute("data-testid"), "composer-submit-button");
});

test("fixture send button lookup skips disabled candidates", () => {
  const document = parseHTML(`
    <form>
      <button data-testid="composer-submit-button" aria-label="Send prompt" disabled>Send</button>
      <button id="enabled-fallback" aria-label="Submit message">Send</button>
    </form>
  `).document;

  assert.equal(findSendButton(document)?.id, "enabled-fallback");
});

test("fixture send button lookup returns null when all send candidates are disabled", () => {
  const document = parseHTML(`
    <form>
      <button data-testid="composer-submit-button" aria-label="Send prompt" disabled>Send</button>
      <div role="button" aria-label="Submit message" aria-disabled="true">Send</div>
    </form>
  `).document;

  assert.equal(findSendButton(document), null);
});

test("fixture attachment candidates target remove control, not file card", async () => {
  const document = await loadFixture();
  const prompt = document.querySelector("#prompt-textarea");
  const form = prompt.closest("form");
  const records = getAttachmentCandidateRecordsFromComposer({ prompt, form });
  const candidates = extractAttachmentCandidatesFromComposer({ prompt, form });

  assert.equal(candidates.length, 3);
  assert.deepEqual([...new Set(candidates.map((candidate) => candidate.matchedName))], [
    "cdp-remove-test.txt",
  ]);
  assert.equal(candidates.every((candidate) => candidate.hasRemoveControl), true);
  assert.equal(
    candidates.every((candidate) => candidate.removeLabel === "ลบไฟล์ 1: cdp-remove-test.txt"),
    true,
  );

  const removeTargets = new Set(records.map((record) => record.removeButton?.id));
  assert.deepEqual([...removeTargets], ["remove-file"]);
  assert.equal(records.some((record) => record.removeButton?.id === "file-card"), false);
});

test("fixture upload menu selection ignores arbitrary page text and plus button", () => {
  const document = parseHTML(`
    <main>
      <section>Upload files for project review</section>
      <button id="composer-plus-btn" aria-label="เพิ่มไฟล์และอื่นๆ">+</button>
      <div role="menu">
        <div id="recent-files" role="menuitem">ไฟล์ล่าสุด</div>
        <div id="upload-files" role="menuitem">เพิ่มรูปภาพและไฟล์ Ctrl U</div>
      </div>
    </main>
  `).document;
  const visible = () => true;

  assert.equal(isUploadMenuItem(document.querySelector("section"), { isVisible: visible }), false);
  assert.equal(isUploadMenuItem(document.querySelector("#composer-plus-btn"), { isVisible: visible }), false);
  assert.equal(findUploadMenuItem(document, { isVisible: visible })?.id, "upload-files");
});

test("fixture upload menu selection supports English upload labels", () => {
  const document = parseHTML(`
    <div role="menu">
      <div id="other" role="menuitem">Search web</div>
      <button id="upload" aria-label="Upload files">Upload files</button>
    </div>
  `).document;

  assert.equal(findUploadMenuItem(document, { isVisible: () => true })?.id, "upload");
});

test("structured visible-DOM read reports truncation and conservative coverage", () => {
  const document = parseHTML(`
    <main>
      <div data-message-author-role="user">Short question</div>
      <div data-message-author-role="assistant">This assistant response is intentionally long.</div>
      <button aria-label="Stop generating">Stop</button>
    </main>
  `).document;

  const structured = buildStructuredVisibleDomRead({
    doc: document,
    maxTurns: 1,
    maxCharsPerTurn: 12,
  });

  assert.equal(structured.mode, "structured_visible_dom");
  assert.equal(structured.completeConversation, false);
  assert.equal(structured.virtualizationPossible, true);
  assert.deepEqual(structured.coverageWarnings, [
    "VISIBLE_DOM_ONLY",
    "MAX_TURNS_APPLIED",
    "STREAMING_IN_PROGRESS",
    "TURN_TRUNCATED",
  ]);
  assert.equal(structured.totalVisibleTurns, 2);
  assert.equal(structured.returnedTurnCount, 1);
  assert.equal(structured.turns[0].role, "assistant");
  assert.equal(structured.turns[0].roleConfidence, "high");
  assert.equal(structured.turns[0].text, "This assista");
  assert.equal(structured.turns[0].truncated, true);
  assert.equal(structured.turns[0].omittedChars > 0, true);
});

test("structured visible-DOM read marks unknown roles without guessing", () => {
  const document = parseHTML(`
    <main>
      <div data-message-author-role="critic">Unexpected role text</div>
    </main>
  `).document;

  const structured = buildStructuredVisibleDomRead({ doc: document });

  assert.equal(structured.turns[0].role, "unknown");
  assert.equal(structured.turns[0].roleConfidence, "low");
  assert.equal(structured.coverageWarnings.includes("ROLE_DETECTION_LOW_CONFIDENCE"), true);
});

test("structured visible-DOM read does not treat composer attachments as turns", () => {
  const document = parseHTML(`
    <main>
      <div data-message-author-role="user">Real user turn</div>
      <form>
        <div id="prompt-textarea"></div>
        <div role="group" aria-label="file.txt">
          <button aria-label="Remove file.txt">x</button>
        </div>
      </form>
    </main>
  `).document;

  const structured = buildStructuredVisibleDomRead({ doc: document });

  assert.equal(structured.returnedTurnCount, 1);
  assert.equal(structured.turns[0].text, "Real user turn");
});
