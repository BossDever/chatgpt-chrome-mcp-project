import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const blockedExtensions = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".js",
  ".msi",
  ".scr",
  ".com",
  ".jar",
]);

const defaultDownloadAllowedExtensions = [
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".html",
];

const defaultUploadAllowedExtensions = [
  ...defaultDownloadAllowedExtensions,
  ".xml",
  ".yaml",
  ".yml",
  ".zip",
];

function normalizeAllowedExtensions(extensions) {
  return extensions.map((extension) => {
    const normalized = extension.toLowerCase();
    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  });
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifyDownloadedFiles(downloadResult, options = {}) {
  const allowedExtensions = normalizeAllowedExtensions(
    options.allowedExtensions ?? defaultDownloadAllowedExtensions,
  );
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;

  const files = [];
  const warnings = [];

  for (const file of downloadResult.downloadedFiles ?? []) {
    const extension = path.extname(file.name ?? file.fullName ?? "").toLowerCase();
    const blocked = blockedExtensions.has(extension);
    const allowed = allowedExtensions.includes(extension);
    const tooLarge = Number(file.length ?? 0) > maxBytes;
    let hash = null;

    try {
      hash = await sha256File(file.fullName);
    } catch (error) {
      warnings.push(`Could not hash downloaded file '${file.fullName}': ${error.message}`);
    }

    if (blocked) warnings.push(`Blocked risky downloaded extension: ${file.name}`);
    if (!allowed) warnings.push(`Downloaded extension is not in allowlist: ${file.name}`);
    if (tooLarge) warnings.push(`Downloaded file exceeds maxBytes: ${file.name}`);

    files.push({
      ...file,
      extension,
      sha256: hash,
      allowedExtension: allowed,
      blockedExtension: blocked,
      withinMaxBytes: !tooLarge,
      safeForAutoUse: allowed && !blocked && !tooLarge,
    });
  }

  return { ...downloadResult, downloadedFiles: files, verificationWarnings: warnings };
}

export async function verifyLocalUploadFile(filePath, options = {}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("Provide filePath.");
  }

  const fullName = path.resolve(filePath);
  const info = await stat(fullName);
  if (!info.isFile()) {
    throw new Error(`Upload path is not a file: ${fullName}`);
  }

  const allowedExtensions = normalizeAllowedExtensions(
    options.allowedExtensions ?? defaultUploadAllowedExtensions,
  );
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const name = path.basename(fullName);
  const extension = path.extname(name).toLowerCase();
  const allowedExtension = allowedExtensions.includes(extension);
  const blockedExtension = blockedExtensions.has(extension);
  const withinMaxBytes = info.size <= maxBytes;
  const hash = withinMaxBytes ? await sha256File(fullName) : null;

  return {
    name,
    fullName,
    extension,
    length: info.size,
    sha256: hash,
    allowedExtension,
    blockedExtension,
    withinMaxBytes,
    safeForUpload: allowedExtension && !blockedExtension && withinMaxBytes,
  };
}
