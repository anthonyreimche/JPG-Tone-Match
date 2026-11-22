// The per-photo fit through a fake host: stores, catalogue and capture are stubs,
// and the browser's bitmap and canvas calls are stubbed on globalThis so the fit
// path runs in node. Run: node --test "test/*.test.mjs"
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { activate, deactivate } from "../index.js";

const PIPE_ID = "com.anthonyreimche.jpg-tone-match.transform";

globalThis.createImageBitmap = async (src) => ({ width: src.width || 192, height: src.height || 128, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() {
    return {
      translate() {}, rotate() {}, drawImage() {},
      getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(128) }),
    };
  }
};

function store(initial) {
  let state = initial;
  const subs = new Set();
  return {
    getState: () => state,
    setState(patch) { state = { ...state, ...patch }; subs.forEach((f) => f()); },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const NOT_JPEG = new Uint8Array([1, 2, 3, 4]);
const fileOf = (bytes) => ({ getFile: async () => ({ arrayBuffer: async () => bytes.slice().buffer }) });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function setup({ photos, capture = () => Promise.resolve({ width: 192, height: 128, close() {} }), stored = {} }) {
  const dev = store({ photoId: "A", params: { displayTransform: PIPE_ID } });
  const cat = store({ photos });
  const pipe = store({ activeId: "default" });
  const putPhotoData = mock.fn();
  const setStageTexture = mock.fn();
  const dropStageTextureVariants = mock.fn();
  const providers = new Map();
  const registerProcessingStage = mock.fn();
  const unregisterProcessingStage = mock.fn();
  const captureFrame = mock.fn(capture);
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useReducer: (_r, init) => [init, () => {}],
    useEffect: () => {},
  };
  const slots = [];
  activate({
    react,
    stores: { useDevelopStore: dev, useCatalogStore: cat, usePipelineStore: pipe },
    pipelines: { effectiveId: (dt) => dt ?? "default" },
    settings: { get: (k, d) => (k === "ignoreCache" ? true : d), onChange: () => () => {} },
    registerPipeline() {},
    registerSettings() {},
    registerProcessingStage,
    unregisterProcessingStage,
    registerSlot: (c) => slots.push(c),
    unregisterSlot() {},
    setStageTexture,
    setStageTextureProvider: (stageId, key, provide) => providers.set(`${stageId}.${key}`, provide),
    dropStageTextureVariants,
    develop: {
      getPhotoData: async (key, photoId) => stored[`${photoId ?? dev.getState().photoId}:${key}`] ?? null,
      putPhotoData,
      captureFrame,
    },
  });
  const text = (el) => (el == null || el === false ? "" : typeof el === "string" ? el : (el.children || []).map(text).join(""));
  const notice = () => slots.map((s) => text(s.component())).join("");
  // What a frame of `photoId` draws the match with, as Safelight asks for it.
  const provide = (photoId) =>
    providers.get("com.anthonyreimche.jpg-tone-match.match.uMatchLut")(photoId, new AbortController().signal);
  return {
    dev,
    putPhotoData,
    setStageTexture,
    dropStageTextureVariants,
    registerProcessingStage,
    unregisterProcessingStage,
    captureFrame,
    notice,
    provide,
  };
}

const ATLAS_BYTES = 17 * 17 * 17 * 4 * 4;
const savedFit = (value) => new Uint8Array(new Float32Array(ATLAS_BYTES / 4).fill(value).buffer);

// SafeLight #278: the stage came and went with the open photo's transform, and
// while it was in, every thumbnail and export drawn took the open photo's LUT.
// It now stays registered and the host draws it only for photos that render
// with this transform (the stage's `transform`).
test("the stage stays registered as photos with other transforms open", async (t) => {
  t.after(deactivate);
  const { dev, registerProcessingStage, unregisterProcessingStage } = setup({
    photos: [{ id: "A", fileHandle: fileOf(JPEG) }, { id: "B", fileHandle: fileOf(JPEG) }],
  });
  await settle();
  dev.setState({ photoId: "B", params: { displayTransform: null } });
  dev.setState({ photoId: "A", params: { displayTransform: PIPE_ID } });
  await settle();
  assert.equal(registerProcessingStage.mock.callCount(), 1);
  assert.equal(unregisterProcessingStage.mock.callCount(), 0);
});

// The match is each photo's own: a thumbnail or an export of one photo draws
// its own fit while another is open, and never the open photo's.
test("a photo's frames draw its own match while another photo is open", async (t) => {
  t.after(deactivate);
  const { dev, provide } = setup({
    photos: [{ id: "A", fileHandle: fileOf(JPEG) }, { id: "B", fileHandle: fileOf(JPEG) }, { id: "C" }],
    stored: { "C:lut": savedFit(0.25) },
  });
  await settle();
  dev.setState({ photoId: "B" });
  await settle();
  const a = await provide("A");
  const c = await provide("C");
  assert.ok(a, "A's fit, made while it was open, is drawn for A");
  assert.equal(c.data[0], 0.25, "C draws the fit saved with it");
  assert.notDeepEqual(a.data, c.data);
});

test("a photo with no fit draws without a match, not another photo's", async (t) => {
  t.after(deactivate);
  const { provide } = setup({ photos: [{ id: "A", fileHandle: fileOf(JPEG) }, { id: "B" }] });
  await settle();
  assert.equal(await provide("B"), null);
});

// SafeLight #278 (in-app): a thumbnail drawn while its photo was being fitted
// (picking the transform commits, and the grid preview is drawn at once) drew
// without a match and kept that look. A frame of a photo being fitted waits for
// the fit; the fit's own capture draws the RAW alone.
test("a frame of a photo being fitted waits for the fit, and draws it", async (t) => {
  t.after(deactivate);
  const shot = deferred();
  const { provide, captureFrame } = setup({
    photos: [{ id: "A", fileHandle: fileOf(JPEG) }],
    capture: () => shot.promise,
  });
  await settle();
  let drawn;
  const frame = provide("A").then((tex) => (drawn = tex));
  await settle();
  assert.equal(drawn, undefined, "the frame waits while the fit runs");
  shot.resolve({ width: 192, height: 128, close() {} });
  await frame;
  assert.ok(drawn, "and draws the new fit");
  const bag = captureFrame.mock.calls[0].arguments[1]?.paramBag ?? {};
  const named = bag["com.anthonyreimche.jpg-tone-match.match.uMatchLut"];
  assert.ok(typeof named === "string" && named !== "A", "the fit's capture names no photo's match");
});

test("a frame of a photo whose fit fails draws without a match", async (t) => {
  t.after(deactivate);
  mock.method(console, "warn", () => {});
  t.after(() => console.warn.mock.restore());
  const { provide } = setup({
    photos: [{ id: "A", fileHandle: fileOf(JPEG) }],
    capture: () => Promise.reject(new Error("no frame")),
    stored: { "A:lut": savedFit(0.5) },
  });
  await settle();
  const tex = await provide("A");
  assert.equal(tex?.data[0] ?? null, 0.5, "the saved fit, not a half-made one");
});

test("a fit that finishes after switching to an unmatched photo leaves that photo alone", async (t) => {
  t.after(deactivate);
  const shot = deferred();
  const { dev, putPhotoData, setStageTexture, captureFrame } = setup({
    photos: [{ id: "A", fileHandle: fileOf(JPEG) }, { id: "B", fileHandle: fileOf(JPEG) }],
    capture: () => shot.promise,
  });
  await settle();
  assert.equal(captureFrame.mock.callCount(), 1, "the fit on A reached its capture");

  dev.setState({ photoId: "B", params: { displayTransform: null } });
  const uploadsAtSwitch = setStageTexture.mock.callCount();
  shot.resolve({ width: 192, height: 128, close() {} });
  await settle();

  assert.equal(putPhotoData.mock.callCount(), 0, "A's LUT was saved as B's");
  assert.equal(setStageTexture.mock.callCount(), uploadsAtSwitch, "A's LUT was uploaded after the switch");
});

test("a fit that finishes after switching to another matched photo saves nothing for it", async (t) => {
  t.after(deactivate);
  const shot = deferred();
  const { dev, putPhotoData } = setup({
    photos: [{ id: "A", fileHandle: fileOf(JPEG) }, { id: "B" }],
    capture: () => shot.promise,
  });
  await settle();
  dev.setState({ photoId: "B" });
  shot.resolve({ width: 192, height: 128, close() {} });
  await settle();
  assert.equal(putPhotoData.mock.callCount(), 0);
});

test("a finished fit is saved for its own photo", async (t) => {
  t.after(deactivate);
  const { putPhotoData, notice } = setup({ photos: [{ id: "A", fileHandle: fileOf(JPEG) }] });
  await settle();
  assert.equal(putPhotoData.mock.callCount(), 1);
  assert.equal(putPhotoData.mock.calls[0].arguments[0], "lut");
  assert.equal(notice(), "");
});

test("a photo without an embedded JPG says so", async (t) => {
  t.after(deactivate);
  const { notice } = setup({ photos: [{ id: "A", fileHandle: fileOf(NOT_JPEG) }] });
  await settle();
  assert.match(notice(), /no embedded camera JPG/);
});

test("a photo whose original can't be read says so", async (t) => {
  t.after(deactivate);
  const { notice } = setup({ photos: [{ id: "A" }] });
  await settle();
  assert.match(notice(), /original file/);
});

test("a fit that fails says so, and the notice leaves with the photo", async (t) => {
  t.after(deactivate);
  mock.method(console, "warn", () => {});
  t.after(() => console.warn.mock.restore());
  const { dev, notice } = setup({
    photos: [{ id: "A", fileHandle: fileOf(JPEG) }, { id: "B" }],
    capture: () => Promise.reject(new Error("no frame")),
  });
  await settle();
  assert.match(notice(), /couldn't match/);
  dev.setState({ photoId: "B", params: { displayTransform: null } });
  assert.equal(notice(), "");
});
