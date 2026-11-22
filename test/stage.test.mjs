// The GPU stage's contract with the host. On process version 2 the host clips a
// display stage that declares no space to [0, 1] ahead of its block, outside its
// own gate, for as long as it is registered, which reaches every photo rendered
// meanwhile (thumbnails, exports), not just the matched one. Run: node --test "test/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STAGE } from "../index.js";

test("declares the display's own space, so the host adds no clip outside the gate", () => {
  assert.deepEqual(STAGE.space, { encoding: "perceptual" });
});

test("passes through before the lookup when no LUT is bound", () => {
  const guard = STAGE.helpers.indexOf("return rgb;");
  const lookup = STAGE.helpers.indexOf("clamp(rgb, 0.0, 1.0)");
  assert.ok(guard > 0, "no-LUT guard present");
  assert.ok(lookup > guard, "the lookup comes after the no-LUT guard");
});

// Older builds ignore `transform` and would draw the always-registered stage
// on every photo.
test("belongs to its display transform, so photos that render with another never draw it", () => {
  assert.equal(STAGE.transform, "com.anthonyreimche.jpg-tone-match.transform");
});

test("draws each photo's own match: its LUT is a per-photo texture", () => {
  assert.equal(STAGE.textures[0].perPhoto, true);
});

test("needs Safelight 3.2.7, the first to draw a stage only with its transform", () => {
  const manifest = JSON.parse(readFileSync(new URL("../safelight.json", import.meta.url), "utf8"));
  assert.equal(manifest.minAppVersion, "3.2.7");
});
