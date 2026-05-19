import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
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
