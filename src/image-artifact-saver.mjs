import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function sanitizeOutputFileName(value, fallback = "generated-image") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

export function extensionForMime(mime) {
  const normalized = String(mime || "").toLowerCase().split(";")[0].trim();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";
  return "bin";
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function decodeBase64Image({ base64, dataUrl }) {
  if (base64) return Buffer.from(base64, "base64");
  const match = String(dataUrl || "").match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s);
  if (!match) throw new Error("IMAGE_DATA_URL_INVALID");
  return Buffer.from(match[2], "base64");
}

export async function writeImageArtifact({
  outputDir = path.join(process.cwd(), "generated-downloads"),
  fileNamePrefix = "chatgpt-generated-image",
  mime,
  base64,
  dataUrl,
}) {
  const buffer = decodeBase64Image({ base64, dataUrl });
  const extension = extensionForMime(mime);
  const safePrefix = sanitizeOutputFileName(fileNamePrefix, "generated-image");
  const filePath = path.join(outputDir, `${safePrefix}-${Date.now()}.${extension}`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, buffer);
  return {
    filePath,
    sha256: sha256Buffer(buffer),
    byteLength: buffer.length,
    extension,
  };
}

export function chatGptGeneratedImageScript({
  which = "newest",
  index = 0,
  prefer = "auto",
  maxPixels = 4096 * 4096,
  waitForImageMs = 30000,
} = {}) {
  return String.raw`
    (async () => {
      const which = ${JSON.stringify(which)};
      const selectedIndex = ${JSON.stringify(index)};
      const prefer = ${JSON.stringify(prefer)};
      const maxPixels = ${JSON.stringify(maxPixels)};
      const waitForImageMs = ${JSON.stringify(waitForImageMs)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const classifySource = (src) => {
        if (!src) return "unknown";
        if (/\/backend-api\/estuary\/content\?id=file_/i.test(src)) return "chatgpt_estuary_file";
        if (src.startsWith("blob:")) return "chatgpt_blob";
        if (src.startsWith("data:")) return "data_url";
        if (src.startsWith("http")) return "http_image";
        return "unknown";
      };
      const scoreImage = (img, index) => {
        const src = img.currentSrc || img.src || "";
        const srcKind = classifySource(src);
        const rect = img.getBoundingClientRect();
        const area = Math.round(rect.width * rect.height);
        const naturalArea = Number(img.naturalWidth || 0) * Number(img.naturalHeight || 0);
        const container = img.closest("[data-message-author-role='assistant'], article, main, [class*='group'], [class*='message']");
        const surroundingText = textOf(container).slice(0, 240);
        const haystack = [src, img.alt || "", img.className || "", surroundingText].join(" ").toLowerCase();
        const likelyUiAsset = /avatar|favicon|logo|sprite|icon|profile|user|sidebar|openai|gravatar/.test(haystack) ||
          /\/assets\/|\/static\//.test(src);
        let score = 0;
        if (srcKind === "chatgpt_estuary_file") score += 9;
        if (/id=file_/i.test(src)) score += 4;
        if (img.naturalWidth >= 512 && img.naturalHeight >= 512) score += 3;
        if (area >= 256 * 256) score += 2;
        if (container?.getAttribute?.("data-message-author-role") === "assistant") score += 2;
        if (/generated|image|รูป|ภาพ/i.test(img.alt || surroundingText)) score += 1;
        if (likelyUiAsset) score -= 8;
        if (!isVisible(img)) score -= 10;
        if (!img.complete || !img.naturalHeight) score -= 2;
        return {
          index,
          score,
          area,
          naturalArea,
          src,
          srcKind,
          alt: img.alt || "",
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
          rect: rectOf(img),
          likelyUiAsset,
          surroundingText,
        };
      };
      const allImages = [...document.images];
      const candidates = allImages.map(scoreImage).filter((candidate) => candidate.score > 0);
      if (!candidates.length) {
        return { ok: false, errorCode: "GENERATED_IMAGE_NOT_FOUND", candidateCount: 0, candidates: [] };
      }
      const sorted = [...candidates].sort((a, b) => {
        if (which === "largest") return b.naturalArea - a.naturalArea || b.score - a.score || b.index - a.index;
        return b.index - a.index || b.score - a.score;
      });
      const candidate = which === "index" ? candidates[selectedIndex] : sorted[0];
      if (!candidate) {
        return { ok: false, errorCode: "GENERATED_IMAGE_INDEX_OUT_OF_RANGE", candidateCount: candidates.length, candidates };
      }
      const img = allImages[candidate.index];
      const deadline = Date.now() + waitForImageMs;
      while (Date.now() < deadline && (!img.complete || !img.naturalHeight)) {
        await sleep(250);
      }
      candidate.naturalWidth = img.naturalWidth || candidate.naturalWidth;
      candidate.naturalHeight = img.naturalHeight || candidate.naturalHeight;
      const pixelCount = Number(candidate.naturalWidth || 0) * Number(candidate.naturalHeight || 0);
      if (!img.complete || !img.naturalHeight) {
        return { ok: false, errorCode: "GENERATED_IMAGE_NOT_LOADED", candidate, candidateCount: candidates.length, candidates };
      }
      if (pixelCount > maxPixels) {
        return { ok: false, errorCode: "GENERATED_IMAGE_TOO_LARGE", candidate, pixelCount, maxPixels, candidateCount: candidates.length, candidates };
      }
      const warnings = [];
      const src = img.currentSrc || img.src || "";
      const trySource = prefer === "auto" || prefer === "source";
      if (trySource && src && !src.startsWith("data:")) {
        try {
          const response = await fetch(src, { credentials: "include", cache: "force-cache" });
          const contentType = response.headers.get("content-type") || "";
          if (response.ok && /^image\//i.test(contentType)) {
            const buffer = await response.arrayBuffer();
            let binary = "";
            const bytes = new Uint8Array(buffer);
            const chunkSize = 0x8000;
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
              binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
            }
            return {
              ok: true,
              provider: "chatgpt",
              savedMethod: "direct_source_fetch",
              mime: contentType.split(";")[0],
              base64: btoa(binary),
              width: img.naturalWidth,
              height: img.naturalHeight,
              naturalWidth: img.naturalWidth,
              naturalHeight: img.naturalHeight,
              srcKind: candidate.srcKind,
              metadataPreserved: true,
              originalMimePreserved: true,
              candidate,
              candidateCount: candidates.length,
              candidates,
              warnings,
            };
          }
          warnings.push({ code: "SOURCE_FETCH_NOT_IMAGE", status: response.status, contentType });
        } catch (error) {
          warnings.push({ code: "SOURCE_FETCH_FAILED", message: error.message });
        }
        if (prefer === "source") {
          return { ok: false, errorCode: "SOURCE_FETCH_FAILED", candidate, candidateCount: candidates.length, candidates, warnings };
        }
      }
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          ok: true,
          provider: "chatgpt",
          savedMethod: "canvas_png_fallback",
          mime: "image/png",
          dataUrl: canvas.toDataURL("image/png"),
          width: img.naturalWidth,
          height: img.naturalHeight,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          srcKind: candidate.srcKind,
          metadataPreserved: false,
          originalMimePreserved: false,
          candidate,
          candidateCount: candidates.length,
          candidates,
          warnings: [...warnings, { code: "CANVAS_FALLBACK_USED" }],
        };
      } catch (error) {
        return { ok: false, errorCode: "CANVAS_EXPORT_FAILED", error: error.message, candidate, candidateCount: candidates.length, candidates, warnings };
      }
    })()
  `;
}

export async function saveImageArtifactFromPage({
  evaluateCdp,
  session,
  script,
  outputDir,
  fileNamePrefix,
  dryRun = false,
  timeoutMs = 60000,
}) {
  const pageResult = await evaluateCdp(session, script, timeoutMs);
  if (!pageResult?.ok) return pageResult;
  if (dryRun) {
    return {
      ...pageResult,
      dryRun: true,
      filePath: null,
      sha256: null,
      byteLength: null,
    };
  }
  const written = await writeImageArtifact({
    outputDir,
    fileNamePrefix,
    mime: pageResult.mime,
    base64: pageResult.base64,
    dataUrl: pageResult.dataUrl,
  });
  return {
    ...pageResult,
    filePath: written.filePath,
    sha256: written.sha256,
    byteLength: written.byteLength,
    extension: written.extension,
    base64: undefined,
    dataUrl: undefined,
  };
}
