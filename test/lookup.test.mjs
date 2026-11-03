// The stage's LUT lookup, run on the CPU from its own GLSL. In range it must
// give what the clipping lookup gave; beyond [0, 1] it must keep the range a
// process version 2 photo carries there. Run: node --test "test/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE } from "../index.js";
import { compileGlsl, forVersion } from "./glsl-eval.mjs";

const N = 17;
const W = N * N;

// The lookup as it shipped in 1.1.1, which clipped its input to [0, 1].
const CLIPPING_LOOKUP = [
  "vec3 jtmFetch(sampler2D lut, float ri, float gi, float bi) {",
  "  float n = 17.0;",
  "  float x = (bi * n + ri + 0.5) / (n * n);",
  "  float y = (gi + 0.5) / n;",
  "  return texture(lut, vec2(x, y)).rgb;",
  "}",
  "vec3 jtmSample(sampler2D lut, vec3 rgb) {",
  "  if (textureSize(lut, 0).x < 4) return rgb;",
  "  float n = 17.0;",
  "  rgb = clamp(rgb, 0.0, 1.0);",
  "  vec3 p = rgb * (n - 1.0);",
  "  vec3 i0 = floor(p);",
  "  vec3 f = p - i0;",
  "  vec3 i1 = min(i0 + 1.0, n - 1.0);",
  "  vec3 c000 = jtmFetch(lut, i0.x, i0.y, i0.z);",
  "  vec3 c100 = jtmFetch(lut, i1.x, i0.y, i0.z);",
  "  vec3 c010 = jtmFetch(lut, i0.x, i1.y, i0.z);",
  "  vec3 c110 = jtmFetch(lut, i1.x, i1.y, i0.z);",
  "  vec3 c001 = jtmFetch(lut, i0.x, i0.y, i1.z);",
  "  vec3 c101 = jtmFetch(lut, i1.x, i0.y, i1.z);",
  "  vec3 c011 = jtmFetch(lut, i0.x, i1.y, i1.z);",
  "  vec3 c111 = jtmFetch(lut, i1.x, i1.y, i1.z);",
  "  vec3 c00 = mix(c000, c100, f.x);",
  "  vec3 c10 = mix(c010, c110, f.x);",
  "  vec3 c01 = mix(c001, c101, f.x);",
  "  vec3 c11 = mix(c011, c111, f.x);",
  "  vec3 c0 = mix(c00, c10, f.y);",
  "  vec3 c1 = mix(c01, c11, f.y);",
  "  return mix(c0, c1, f.z);",
  "}",
].join("\n");

// A camera-like look: a lifted, compressed curve per channel with a little
// cross-talk, so the edges aren't the identity.
function lookAtlas() {
  const data = new Float32Array(W * N * 4);
  const n1 = N - 1;
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const R = r / n1, G = g / n1, B = b / n1;
        const o = (g * W + b * N + r) * 4;
        data[o] = 0.03 + 0.9 * Math.pow(R, 0.8) + 0.04 * G;
        data[o + 1] = 0.02 + 0.92 * Math.pow(G, 0.85) + 0.03 * B;
        data[o + 2] = 0.04 + 0.88 * Math.pow(B, 0.9) + 0.02 * R;
        data[o + 3] = 1;
      }
    }
  }
  return { width: W, height: N, data };
}

const lut = lookAtlas();
const sample = compileGlsl(forVersion(STAGE.helpers, 2));
const sampleV1 = compileGlsl(forVersion(STAGE.helpers, 1));
const clipped = compileGlsl(CLIPPING_LOOKUP);
const now = (rgb) => sample("jtmSample", [lut, rgb]);
const before = (rgb) => clipped("jtmSample", [lut, rgb]);

function close(actual, expected, eps, what) {
  for (let c = 0; c < expected.length; c++) {
    assert.ok(Math.abs(actual[c] - expected[c]) <= eps, `${what}: channel ${c} is ${actual[c]}, expected ${expected[c]}`);
  }
}

test("an identity LUT gives the colour back (checks the interpreter too)", () => {
  const id = lookAtlas();
  for (let i = 0; i < id.data.length; i += 4) {
    const x = (i / 4) % W, y = Math.floor(i / 4 / W);
    id.data[i] = (x % N) / (N - 1);
    id.data[i + 1] = y / (N - 1);
    id.data[i + 2] = Math.floor(x / N) / (N - 1);
  }
  for (const p of [[0.1, 0.52, 0.93], [0, 1, 0.25], [0.77, 0.3, 0.6]]) {
    close(sample("jtmSample", [id, p]), p, 1e-6, `identity at ${p}`);
  }
});

test("in range the lookup is unchanged", () => {
  const points = [[0, 0, 0], [1, 1, 1], [0, 1, 0.5], [1, 0, 1], [0.5, 0.5, 0.5]];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 200; i++) points.push([rand(), rand(), rand()]);
  for (const p of points) close(now(p), before(p), 1e-12, `at ${p}`);
});

test("above 1 keeps its range instead of clipping", () => {
  const edge = before([1, 0.5, 0.5]);
  const over = now([1.4, 0.5, 0.5]);
  assert.ok(over[0] > edge[0] + 0.3, `1.4 red came out ${over[0]}, the clipped edge is ${edge[0]}`);
  close(over.slice(1), edge.slice(1), 1e-12, "the other channels");
  const white = now([2, 2, 2]);
  for (let c = 0; c < 3; c++) assert.ok(white[c] > before([1, 1, 1])[c] + 0.9, `2.0 white channel ${c} is ${white[c]}`);
});

test("below 0 keeps its range instead of clipping", () => {
  const edge = before([0.5, 0, 0.5]);
  const under = now([0.5, -0.25, 0.5]);
  assert.ok(under[1] < edge[1] - 0.2, `-0.25 green came out ${under[1]}, the clipped edge is ${edge[1]}`);
});

test("continuous and increasing across 0 and 1", () => {
  for (const [lo, hi] of [[0.999, 1.001], [-0.001, 0.001]]) {
    const a = now([lo, 0.5, 0.5])[0];
    const b = now([hi, 0.5, 0.5])[0];
    assert.ok(b > a && b - a < 0.01, `red ${lo} -> ${a}, ${hi} -> ${b}`);
  }
  let last = -Infinity;
  for (let v = -0.5; v <= 1.5; v += 0.05) {
    const out = now([v, 0.3, 0.7])[0];
    assert.ok(out > last, `red at ${v.toFixed(2)} came out ${out}, not above ${last}`);
    last = out;
  }
});

test("passes through untouched with no LUT bound", () => {
  const empty = { width: 1, height: 1, data: new Float32Array(4) };
  assert.deepEqual(sample("jtmSample", [empty, [1.5, -0.2, 0.4]]), [1.5, -0.2, 0.4]);
});

// Process version 1 photos keep the lookup they were edited with, clipped at
// both ends, so a value an earlier stage left outside [0, 1] still lands on the
// LUT's edge there.
test("process version 1 keeps 1.1.1's clipping lookup, in range and out", () => {
  const points = [[0, 0, 0], [1, 1, 1], [1.4, 0.5, 0.5], [0.5, -0.25, 0.5], [2, 2, 2], [-0.3, 1.2, 0.7]];
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 0.5;
  for (let i = 0; i < 200; i++) points.push([rand(), rand(), rand()]);
  for (const p of points) assert.deepEqual(sampleV1("jtmSample", [lut, p]), before(p), `at ${p}`);
});

test("version 3 takes the version 2 lookup; each directive sits on its own line", () => {
  assert.ok(STAGE.helpers.includes("#if SL_PROCESS_VERSION >= 2"));
  assert.equal(forVersion(STAGE.helpers, 3), forVersion(STAGE.helpers, 2));
  for (const line of STAGE.helpers.split("\n").filter((l) => l.trim().startsWith("#"))) {
    assert.match(line, /^(#if SL_PROCESS_VERSION >= 2|#else|#endif)$/);
  }
});
