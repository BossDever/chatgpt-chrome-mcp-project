export const attachmentFileNamePattern =
  /[^\n\r:]+\.(zip|txt|md|json|csv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|html?|css|js|ts|tsx|jsx|mjs|cjs|ps1|py|java|go|rs|cs|cpp|c|h|xml|yaml|yml)\b/i;

export function textOf(el) {
  return (el?.innerText || el?.textContent || el?.value || "").trim();
}

export function labelOf(el) {
  return [
    el?.getAttribute?.("aria-label") || "",
    el?.getAttribute?.("data-testid") || "",
    el?.id || "",
    textOf(el),
  ].join(" ").toLowerCase();
}

export function isElementDisabled(el) {
  return !el || Boolean(el.disabled) || el.getAttribute?.("aria-disabled") === "true";
}

export function isAttachmentRemoveControlLabel(label) {
  return (
    /^\s*(remove|delete)\b/i.test(label || "") ||
    /^\s*\u0e25\u0e1a/u.test(label || "")
  );
}

export function getAttachmentCandidateRecordsFromComposer({ prompt, form }) {
  if (!form) return [];
  const records = [];
  const seen = new Set();
  const elements = [
    ...form.querySelectorAll(
      "[role=group][aria-label], button[aria-label], [data-testid][aria-label], [role=button][aria-label]",
    ),
  ];
  for (const el of elements) {
    if (prompt?.contains(el)) continue;
    const ariaLabel = el.getAttribute("aria-label") || "";
    const testId = el.getAttribute("data-testid") || "";
    const role = el.getAttribute("role") || "";
    const text = textOf(el);
    const combined = ariaLabel + "\n" + text;
    const match = combined.match(attachmentFileNamePattern);
    if (!match) continue;

    const matchedName = (match[0] || "").replace(/^.*:\s*/, "").trim();
    if (!matchedName) continue;

    const group = el.closest("[role=group]") || el.parentElement || el;
    const removeButtons = [...group.querySelectorAll("button[aria-label], [role=button][aria-label]")]
      .filter((button) => isAttachmentRemoveControlLabel(button.getAttribute("aria-label") || textOf(button)));
    const selfRemoveButton = isAttachmentRemoveControlLabel(ariaLabel) || isAttachmentRemoveControlLabel(text)
      ? el
      : null;
    const removeButton = removeButtons[0] || selfRemoveButton;
    const removeLabel = removeButton ? (removeButton.getAttribute("aria-label") || textOf(removeButton)) : "";

    const key = matchedName + "|" + ariaLabel + "|" + testId + "|" + role;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      el,
      group,
      removeButton,
      candidate: {
        text,
        ariaLabel,
        testId,
        role,
        matchedName,
        hasRemoveControl: Boolean(removeButton),
        removeLabel,
        matchedBy: attachmentFileNamePattern.test(ariaLabel) ? "aria-label" : "text",
      },
    });
  }
  return records;
}

export function extractAttachmentCandidatesFromComposer(args) {
  return getAttachmentCandidateRecordsFromComposer(args).map((record) => record.candidate);
}

export function extractConversationTurnsFromDocument(doc = document) {
  return [...doc.querySelectorAll("[data-message-author-role]")].map((el, index) => ({
    index,
    role: el.getAttribute("data-message-author-role") || "unknown",
    text: textOf(el),
  }));
}

export function truncateText(text, maxChars) {
  const value = String(text ?? "");
  if (!Number.isInteger(maxChars) || maxChars < 0 || value.length <= maxChars) {
    return {
      text: value,
      returnedChars: value.length,
      chars: value.length,
      truncated: false,
      omittedChars: 0,
    };
  }
  return {
    text: value.slice(0, maxChars),
    returnedChars: maxChars,
    chars: value.length,
    truncated: true,
    omittedChars: value.length - maxChars,
  };
}

export function buildStructuredVisibleDomRead({
  doc = document,
  maxTurns = 6,
  maxCharsPerTurn = 6000,
  includeText = true,
} = {}) {
  const allTurns = extractConversationTurnsFromDocument(doc);
  const selectedTurns = Number.isInteger(maxTurns) && maxTurns > 0
    ? allTurns.slice(-maxTurns)
    : allTurns;
  const coverageWarnings = ["VISIBLE_DOM_ONLY"];

  if (selectedTurns.length < allTurns.length) {
    coverageWarnings.push("MAX_TURNS_APPLIED");
  }

  const hasStreaming = Boolean(doc.querySelector(".result-streaming")) ||
    [...doc.querySelectorAll("button, [role=button]")].some((el) => /stop/i.test(labelOf(el)));
  if (hasStreaming) {
    coverageWarnings.push("STREAMING_IN_PROGRESS");
  }

  const roleCounts = {};
  const turns = selectedTurns.map((turn) => {
    const normalizedRole = ["user", "assistant", "tool"].includes(turn.role) ? turn.role : "unknown";
    roleCounts[normalizedRole] = (roleCounts[normalizedRole] || 0) + 1;
    const clipped = truncateText(turn.text, maxCharsPerTurn);
    if (clipped.truncated && !coverageWarnings.includes("TURN_TRUNCATED")) {
      coverageWarnings.push("TURN_TRUNCATED");
    }
    if (normalizedRole === "unknown" && !coverageWarnings.includes("ROLE_DETECTION_LOW_CONFIDENCE")) {
      coverageWarnings.push("ROLE_DETECTION_LOW_CONFIDENCE");
    }
    return {
      index: turn.index,
      role: normalizedRole,
      roleConfidence: normalizedRole === "unknown" ? "low" : "high",
      source: "visible_dom",
      chars: clipped.chars,
      returnedChars: includeText ? clipped.returnedChars : 0,
      truncated: clipped.truncated,
      omittedChars: clipped.omittedChars,
      ...(includeText ? { text: clipped.text } : {}),
    };
  });

  return {
    mode: "structured_visible_dom",
    completeConversation: false,
    virtualizationPossible: true,
    rawFallbackAvailable: true,
    coverageWarnings,
    totalVisibleTurns: allTurns.length,
    returnedTurnCount: turns.length,
    maxTurnsApplied: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : null,
    maxCharsPerTurn,
    roleCounts,
    turns,
  };
}

export function getLastTurn(turns, role) {
  return [...turns].reverse().find((turn) => turn.role === role) ?? null;
}

export function findSendButton(doc = document) {
  const buttons = [...doc.querySelectorAll("button, [role=button]")];
  return buttons.find((el) => /send|submit|composer-submit/.test(labelOf(el)) && !isElementDisabled(el)) ?? null;
}

export function isVisibleInViewport(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.height <= 120 &&
    rect.width <= 600 &&
    rect.top >= 0 &&
    rect.bottom <= innerHeight &&
    rect.left >= 0 &&
    rect.right <= innerWidth &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

export function isUploadMenuItem(el, { isVisible = isVisibleInViewport } = {}) {
  if (!el || el.id === "composer-plus-btn") return false;
  if (!isVisible(el)) return false;
  const role = el.getAttribute("role") || "";
  const tag = el.tagName || "";
  if (!["menuitem", "option"].includes(role) && tag.toLowerCase() !== "button") return false;
  const label = labelOf(el);
  const hasEnglishUpload =
    (label.includes("upload") || label.includes("add")) &&
    (label.includes("file") || label.includes("photo"));
  const hasThaiUpload =
    label.includes("\u0e44\u0e1f\u0e25\u0e4c") &&
    (
      label.includes("\u0e40\u0e1e\u0e34\u0e48\u0e21") ||
      label.includes("\u0e23\u0e39\u0e1b") ||
      label.includes("\u0e2d\u0e31\u0e1b\u0e42\u0e2b\u0e25\u0e14")
    );
  return hasEnglishUpload || hasThaiUpload;
}

export function findUploadMenuItem(doc = document, options = {}) {
  const elements = [...doc.querySelectorAll('[role="menuitem"], [role="option"], button')];
  return elements.find((el) => el.getAttribute("role") === "menuitem" && isUploadMenuItem(el, options)) ||
    elements.find((el) => isUploadMenuItem(el, options)) ||
    null;
}

export function chatGptDomAdapterScript() {
  return String.raw`
      const chatGptDomAdapter = (() => {
        const attachmentFileNamePattern = ${attachmentFileNamePattern.toString()};
        const textOf = ${textOf.toString()};
        const labelOf = ${labelOf.toString()};
        const isElementDisabled = ${isElementDisabled.toString()};
        const isAttachmentRemoveControlLabel = ${isAttachmentRemoveControlLabel.toString()};
        const getAttachmentCandidateRecordsFromComposer = ${getAttachmentCandidateRecordsFromComposer.toString()};
        const extractAttachmentCandidatesFromComposer = ${extractAttachmentCandidatesFromComposer.toString()};
        const extractConversationTurnsFromDocument = ${extractConversationTurnsFromDocument.toString()};
        const truncateText = ${truncateText.toString()};
        const buildStructuredVisibleDomRead = ${buildStructuredVisibleDomRead.toString()};
        const getLastTurn = ${getLastTurn.toString()};
        const findSendButton = ${findSendButton.toString()};
        const isVisibleInViewport = ${isVisibleInViewport.toString()};
        const isUploadMenuItem = ${isUploadMenuItem.toString()};
        const findUploadMenuItem = ${findUploadMenuItem.toString()};
        return {
          textOf,
          labelOf,
          isElementDisabled,
          isAttachmentRemoveControlLabel,
          getAttachmentCandidateRecordsFromComposer,
          extractAttachmentCandidatesFromComposer,
          extractConversationTurnsFromDocument,
          truncateText,
          buildStructuredVisibleDomRead,
          getLastTurn,
          findSendButton,
          isVisibleInViewport,
          isUploadMenuItem,
          findUploadMenuItem,
        };
      })();
  `;
}
