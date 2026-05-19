import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
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

const sensitiveFilenamePatterns = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials$/i,
  /^kubeconfig$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:^|[._-])private(?:[._-])?key\.(?:pem|key|txt)$/i,
  /(?:^|[._-])service-account(?:[._-])?key\.json$/i,
];

function normalizeAllowedExtensions(extensions) {
  return extensions.map((extension) => {
    const normalized = extension.toLowerCase();
    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  });
}

function isSensitiveFileName(name) {
  const baseName = path.basename(String(name ?? "").replace(/\\/g, "/"));
  return sensitiveFilenamePatterns.some((pattern) => pattern.test(baseName));
}

function isUnsafeZipEntryName(name) {
  const value = String(name ?? "");
  return path.isAbsolute(value) || value.includes("\\") || value.split("/").includes("..");
}

const zipEocdMinLength = 22;
const zipEocdTailMaxBytes = zipEocdMinLength + 0xffff;
const defaultMaxCentralDirectoryBytes = 8 * 1024 * 1024;

async function readFileSlice(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

async function readZipCentralDirectory(filePath, {
  openFile = open,
  statFile = stat,
  maxCentralDirectoryBytes = defaultMaxCentralDirectoryBytes,
} = {}) {
  const fileInfo = await statFile(filePath);
  const fileSize = fileInfo.size;
  const handle = await openFile(filePath, "r");
  try {
    const tailLength = Math.min(fileSize, zipEocdTailMaxBytes);
    const tailPosition = fileSize - tailLength;
    const tail = await readFileSlice(handle, tailLength, tailPosition);
    const eocdSignature = 0x06054b50;
    let eocdOffset = -1;
    for (let offset = tail.length - zipEocdMinLength; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === eocdSignature) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) {
      return { ok: false, errorCode: "ZIP_EOCD_NOT_FOUND", entryCount: 0, warnings: ["ZIP_EOCD_NOT_FOUND"] };
    }

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralOffset = tail.readUInt32LE(eocdOffset + 16);
    const warnings = [];
    if (centralOffset + centralSize > fileSize) warnings.push("ZIP_CENTRAL_DIRECTORY_OUT_OF_RANGE");
    if (centralSize > maxCentralDirectoryBytes) warnings.push("ZIP_CENTRAL_DIRECTORY_TOO_LARGE");

    const readableCentralSize = Math.min(
      Math.max(0, fileSize - centralOffset),
      centralSize,
      maxCentralDirectoryBytes,
    );
    const centralDirectory = readableCentralSize > 0
      ? await readFileSlice(handle, readableCentralSize, centralOffset)
      : Buffer.alloc(0);
    return { ok: true, entryCount, centralSize, centralOffset, centralDirectory, warnings };
  } finally {
    await handle.close();
  }
}

export async function inspectZipFile(filePath, options = {}) {
  const maxEntries = options.maxEntries ?? 2000;
  const allowedExtensions = normalizeAllowedExtensions(
    options.allowedExtensions ?? defaultUploadAllowedExtensions,
  );
  const zip = await readZipCentralDirectory(filePath, options);
  if (!zip.ok) {
    return { ok: false, errorCode: zip.errorCode, inspected: true, entryCount: zip.entryCount, warnings: zip.warnings };
  }
  const data = zip.centralDirectory;
  const centralSignature = 0x02014b50;
  const entryCount = zip.entryCount;
  const warnings = [...zip.warnings];
  const blockedEntries = [];
  const sensitiveEntries = [];
  const unsafePathEntries = [];
  if (entryCount > maxEntries) warnings.push("ZIP_ENTRY_COUNT_TOO_LARGE");

  let offset = 0;
  const entries = [];
  for (let index = 0; index < Math.min(entryCount, maxEntries) && offset + 46 <= data.length; index += 1) {
    if (data.readUInt32LE(offset) !== centralSignature) {
      warnings.push("ZIP_CENTRAL_DIRECTORY_INVALID");
      break;
    }
    const flags = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const fileNameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > data.length) {
      warnings.push("ZIP_ENTRY_NAME_OUT_OF_RANGE");
      break;
    }
    const name = data.toString("utf8", fileNameStart, fileNameEnd);
    const isDirectory = name.endsWith("/");
    const extension = isDirectory ? "" : path.extname(name).toLowerCase();
    const blockedExtension = extension ? blockedExtensions.has(extension) : false;
    const allowedExtension = isDirectory || !extension || allowedExtensions.includes(extension);
    const sensitiveFilename = !isDirectory && isSensitiveFileName(name);
    const unsafePath = isUnsafeZipEntryName(name);
    const encrypted = Boolean(flags & 0x1);
    if (blockedExtension) blockedEntries.push(name);
    if (sensitiveFilename) sensitiveEntries.push(name);
    if (unsafePath) unsafePathEntries.push(name);
    if (encrypted) warnings.push("ZIP_ENTRY_ENCRYPTED");
    entries.push({ name, extension, compressedSize, uncompressedSize, blockedExtension, allowedExtension, sensitiveFilename, unsafePath, encrypted });
    offset = fileNameEnd + extraLength + commentLength;
  }

  if (blockedEntries.length > 0) warnings.push("ZIP_ENTRY_EXTENSION_BLOCKED");
  if (sensitiveEntries.length > 0) warnings.push("ZIP_ENTRY_SENSITIVE_FILENAME");
  if (unsafePathEntries.length > 0) warnings.push("ZIP_ENTRY_UNSAFE_PATH");
  return {
    ok: warnings.length === 0,
    inspected: true,
    entryCount,
    entriesInspected: entries.length,
    entries,
    blockedEntries,
    sensitiveEntries,
    unsafePathEntries,
    warnings,
  };
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
  const sensitiveFilename = isSensitiveFileName(name);
  const zipInspection = extension === ".zip" && withinMaxBytes
    ? await inspectZipFile(fullName, { allowedExtensions })
    : null;
  const zipSafe = !zipInspection || zipInspection.ok;

  return {
    name,
    fullName,
    extension,
    length: info.size,
    sha256: hash,
    allowedExtension,
    blockedExtension,
    sensitiveFilename,
    withinMaxBytes,
    zipInspection,
    safeForUpload: allowedExtension && !blockedExtension && !sensitiveFilename && withinMaxBytes && zipSafe,
  };
}
