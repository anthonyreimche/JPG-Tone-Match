// The GPU stage's contract with the host. On process version 2 the host clips a
// display stage that declares no space to [0, 1] ahead of its block, outside its
// own gate, for as long as it is registered, which reaches every photo rendered
// meanwhile (thumbnails, exports), not just the matched one. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE } from "../index.js";

test("declares the display's own space, so the host adds no clip outside the gate", () => {
  assert.deepEqual(STAGE.space, { encoding: "perceptual" });
});

test("passes through before clipping when no LUT is bound", () => {
  const guard = STAGE.helpers.indexOf("return rgb;");
  const clip = STAGE.helpers.indexOf("rgb = clamp(rgb, 0.0, 1.0);");
  assert.ok(guard > 0, "no-LUT guard present");
  assert.ok(clip > guard, "the clip comes after the no-LUT guard");
});
