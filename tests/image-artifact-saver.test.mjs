import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chatGptGeneratedImageScript,
  extensionForMime,
  sanitizeOutputFileName,
  writeImageArtifact,
} from "../src/image-artifact-saver.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-artifact-safety-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("sanitizeOutputFileName removes path and shell special characters", () => {
  assert.equal(sanitizeOutputFileName("../bad:name?.png"), "..-bad-name-.png");
  assert.equal(sanitizeOutputFileName(""), "generated-image");
});

test("extensionForMime maps common image MIME types", () => {
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("image/jpeg; charset=binary"), "jpg");
  assert.equal(extensionForMime("image/webp"), "webp");
});

test("writeImageArtifact saves under the safe artifact root", async () => {
  await withTempDir(async (dir) => {
    const outputRoot = path.join(dir, "artifacts");
    const result = await writeImageArtifact({
      outputRoot,
      outputDir: "images",
      fileNamePrefix: "ok",
      mime: "image/png",
      base64: Buffer.from("png-data").toString("base64"),
    });

    assert.equal(result.relativeOutputDir, "images");
    assert.match(result.relativeArtifactPath, /^images[\\/]+ok-\d+\.png$/);
    assert.equal(await readFile(result.filePath, "utf8"), "png-data");
    assert.equal(result.filePath.startsWith(outputRoot), true);
  });
});

test("writeImageArtifact rejects traversal and external absolute output directories", async () => {
  await withTempDir(async (dir) => {
    const outputRoot = path.join(dir, "artifacts");
    await assert.rejects(
      writeImageArtifact({
        outputRoot,
        outputDir: "..",
        mime: "image/png",
        base64: Buffer.from("x").toString("base64"),
      }),
      /UNSAFE_OUTPUT_DIR/,
    );
    await assert.rejects(
      writeImageArtifact({
        outputRoot,
        outputDir: path.parse(outputRoot).root,
        mime: "image/png",
        base64: Buffer.from("x").toString("base64"),
      }),
      /UNSAFE_OUTPUT_DIR/,
    );
  });
});

test("writeImageArtifact rejects output directory symlink escapes", async () => {
  await withTempDir(async (dir) => {
    const outputRoot = path.join(dir, "artifacts");
    const outside = path.join(dir, "outside");
    const link = path.join(outputRoot, "linked");
    await mkdir(outputRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      writeImageArtifact({
        outputRoot,
        outputDir: "linked",
        mime: "image/png",
        base64: Buffer.from("x").toString("base64"),
      }),
      /UNSAFE_OUTPUT_DIR_SYMLINK/,
    );
  });
});

test("ChatGPT generated image script includes estuary scoring and canvas fallback", () => {
  const script = chatGptGeneratedImageScript({ prefer: "auto" });
  assert.match(script, /backend-api\\\/estuary\\\/content/);
  assert.match(script, /direct_source_fetch/);
  assert.match(script, /canvas_png_fallback/);
});
