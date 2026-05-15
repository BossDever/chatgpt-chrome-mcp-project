import assert from "node:assert/strict";
import test from "node:test";

import {
  chatGptGeneratedImageScript,
  extensionForMime,
  sanitizeOutputFileName,
} from "../src/image-artifact-saver.mjs";

test("sanitizeOutputFileName removes path and shell special characters", () => {
  assert.equal(sanitizeOutputFileName("../bad:name?.png"), "..-bad-name-.png");
  assert.equal(sanitizeOutputFileName(""), "generated-image");
});

test("extensionForMime maps common image MIME types", () => {
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("image/jpeg; charset=binary"), "jpg");
  assert.equal(extensionForMime("image/webp"), "webp");
});

test("ChatGPT generated image script includes estuary scoring and canvas fallback", () => {
  const script = chatGptGeneratedImageScript({ prefer: "auto" });
  assert.match(script, /backend-api\\\/estuary\\\/content/);
  assert.match(script, /direct_source_fetch/);
  assert.match(script, /canvas_png_fallback/);
});
