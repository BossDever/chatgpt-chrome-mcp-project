import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectZipFile,
  sha256File,
  verifyDownloadedFiles,
  verifyLocalUploadFile,
} from "../src/file-safety.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-file-safety-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content ?? "", "utf8");
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    content.copy(local, 30 + name.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

function makeZipCentralDirectory(entries) {
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content ?? "", "utf8");
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += 30 + name.length + content.length;
  }
  return Buffer.concat(centralParts);
}

function makeVirtualZipReader(entries) {
  const central = makeZipCentralDirectory(entries);
  const centralOffset = 1024 * 1024 * 1024;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  const size = centralOffset + central.length + eocd.length;
  const reads = [];
  return {
    reads,
    statFile: async () => ({ size }),
    openFile: async () => ({
      async read(buffer, offset, length, position) {
        reads.push({ length, position });
        const tailPosition = size - Math.min(size, 22 + 0xffff);
        let source = Buffer.alloc(0);
        let sourceOffset = 0;
        if (position === centralOffset) {
          source = central;
          sourceOffset = Math.max(0, position - centralOffset);
        } else if (position >= tailPosition) {
          const tailLength = Math.min(size, 22 + 0xffff);
          const tail = Buffer.alloc(tailLength);
          eocd.copy(tail, tail.length - eocd.length);
          source = tail;
          sourceOffset = position - tailPosition;
        }
        const bytesRead = Math.min(length, Math.max(0, source.length - sourceOffset));
        if (bytesRead > 0) source.copy(buffer, offset, sourceOffset, sourceOffset + bytesRead);
        return { bytesRead, buffer };
      },
      async close() {},
    }),
  };
}

test("verifyLocalUploadFile accepts allowed files and hashes contents", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "note.txt");
    await writeFile(filePath, "hello", "utf8");

    const result = await verifyLocalUploadFile(filePath);

    assert.equal(result.name, "note.txt");
    assert.equal(result.extension, ".txt");
    assert.equal(result.length, 5);
    assert.equal(result.sha256, await sha256File(filePath));
    assert.equal(result.allowedExtension, true);
    assert.equal(result.blockedExtension, false);
    assert.equal(result.withinMaxBytes, true);
    assert.equal(result.safeForUpload, true);
  });
});

test("verifyLocalUploadFile blocks sensitive filenames", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, ".env");
    await writeFile(filePath, "TOKEN=secret", "utf8");

    const result = await verifyLocalUploadFile(filePath, { allowedExtensions: [".env"] });

    assert.equal(result.name, ".env");
    assert.equal(result.sensitiveFilename, true);
    assert.equal(result.safeForUpload, false);
  });
});

test("verifyLocalUploadFile inspects zip entries for risky contents", async () => {
  await withTempDir(async (dir) => {
    const zipPath = path.join(dir, "repo.zip");
    await writeFile(zipPath, makeStoredZip([
      { name: "src/index.md", content: "# ok" },
      { name: ".env", content: "TOKEN=secret" },
      { name: "scripts/run.ps1", content: "Write-Host nope" },
      { name: "../outside.txt", content: "escape" },
    ]));

    const result = await verifyLocalUploadFile(zipPath);

    assert.equal(result.extension, ".zip");
    assert.equal(result.safeForUpload, false);
    assert.equal(result.zipInspection.inspected, true);
    assert.equal(result.zipInspection.sensitiveEntries.includes(".env"), true);
    assert.equal(result.zipInspection.blockedEntries.includes("scripts/run.ps1"), true);
    assert.equal(result.zipInspection.unsafePathEntries.includes("../outside.txt"), true);
    assert.equal(result.zipInspection.warnings.includes("ZIP_ENTRY_SENSITIVE_FILENAME"), true);
  });
});

test("inspectZipFile uses bounded tail and central directory reads", async () => {
  const reader = makeVirtualZipReader([
    { name: "docs/readme.md", content: "# ok" },
  ]);

  const result = await inspectZipFile("virtual-large.zip", reader);

  assert.equal(result.ok, true);
  assert.equal(result.entries[0].name, "docs/readme.md");
  assert.equal(reader.reads.length, 2);
  assert.equal(Math.max(...reader.reads.map((read) => read.length)), 22 + 0xffff);
});

test("inspectZipFile fails closed when the central directory exceeds the bounded read cap", async () => {
  const reader = makeVirtualZipReader([
    { name: "docs/readme.md", content: "# ok" },
  ]);

  const result = await inspectZipFile("virtual-large.zip", {
    ...reader,
    maxCentralDirectoryBytes: 16,
  });

  assert.equal(result.ok, false);
  assert.equal(result.warnings.includes("ZIP_CENTRAL_DIRECTORY_TOO_LARGE"), true);
});


test("verifyLocalUploadFile blocks risky or disallowed uploads", async () => {
  await withTempDir(async (dir) => {
    const scriptPath = path.join(dir, "run.ps1");
    await writeFile(scriptPath, "Write-Host nope", "utf8");
    const script = await verifyLocalUploadFile(scriptPath, { allowedExtensions: [".ps1"] });
    assert.equal(script.allowedExtension, true);
    assert.equal(script.blockedExtension, true);
    assert.equal(script.safeForUpload, false);

    const jsonPath = path.join(dir, "data.json");
    await writeFile(jsonPath, "{}", "utf8");
    const disallowed = await verifyLocalUploadFile(jsonPath, { allowedExtensions: [".txt"] });
    assert.equal(disallowed.allowedExtension, false);
    assert.equal(disallowed.blockedExtension, false);
    assert.equal(disallowed.safeForUpload, false);
  });
});

test("verifyLocalUploadFile enforces maxBytes", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "large.txt");
    await writeFile(filePath, "abcdef", "utf8");

    const result = await verifyLocalUploadFile(filePath, { maxBytes: 3 });

    assert.equal(result.withinMaxBytes, false);
    assert.equal(result.safeForUpload, false);
    assert.equal(result.sha256, null);
  });
});

test("verifyDownloadedFiles annotates downloaded file safety", async () => {
  await withTempDir(async (dir) => {
    const goodPath = path.join(dir, "good.txt");
    const badPath = path.join(dir, "bad.exe");
    await writeFile(goodPath, "ok", "utf8");
    await writeFile(badPath, "bad", "utf8");

    const result = await verifyDownloadedFiles({
      ok: true,
      downloadedFiles: [
        { name: "good.txt", fullName: goodPath, length: 2 },
        { name: "bad.exe", fullName: badPath, length: 3 },
      ],
    });

    assert.equal(result.downloadedFiles[0].safeForAutoUse, true);
    assert.equal(result.downloadedFiles[0].sha256, await sha256File(goodPath));
    assert.equal(result.downloadedFiles[1].blockedExtension, true);
    assert.equal(result.downloadedFiles[1].safeForAutoUse, false);
    assert.equal(
      result.verificationWarnings.some((warning) =>
        warning.includes("Blocked risky downloaded extension: bad.exe"),
      ),
      true,
    );
  });
});
