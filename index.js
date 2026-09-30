// JPG Tone Match — a Safelight extension by Anthony Reimche.
//
// The libraw RAW decode is colorimetrically close to the camera but lacks the
// manufacturer's "look" (the camera-specific tone curve + hue-dependent
// rendering) that the embedded JPG preview — and Lightroom — apply. This
// extension auto-derives that look per photo: it compares the photo's own
// embedded camera JPG to the live RAW render and fits a 3D colour LUT that maps
// one to the other.
//
// It is exposed as a **Display transform**, picked per photo from Develop's
// bottom-bar dropdown — or set as the fallback under Preferences ▸ Rendering ▸
// Default display transform, followed by photos without their own pick — not a
// develop panel. Selecting it for a photo enables the match for that photo; the
// only setting is the match intensity. Implementation note: a display-transform
// pipeline can't carry a per-photo texture, so the actual lookup runs in a GPU
// processing stage that is registered ONLY while the open photo's transform is
// this one, and removed otherwise.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXT_ID = "com.anthonyreimche.jpg-tone-match";
const PIPE_ID = EXT_ID + ".transform"; // the selectable Display transform
const STAGE_ID = EXT_ID + ".match"; // the GPU LUT stage (gated on selection)
const LUT_DATA_KEY = "lut"; // per-photo sidecar blob key (namespaced by the host)

const N = 17; // 3D LUT edge resolution (17^3 nodes)
const ATLAS_W = N * N; // tiled-along-blue atlas: 289 x 17
const ATLAS_H = N;
const ATLAS_FLOATS = ATLAS_W * ATLAS_H * 4;
const ATLAS_BYTES = ATLAS_FLOATS * 4; // Float32

const FIT_MAX_EDGE = 192; // downsample both images to this max edge before fitting
const FIT_LAMBDA = 2.0; // identity-prior strength (nodes with < ~2 samples lean identity)
const FIT_CLIP_LO = 0.012; // reject near-clipped input pixels (ambiguous mapping)
const FIT_CLIP_HI = 0.988;

// ---------------------------------------------------------------------------
// GPU stage: a display-referred 3D-LUT lookup. `c` at the effects phase is
// sRGB display-encoded, clamped [0,1] — the exact space the camera JPG lives in,
// so the LUT maps sRGB -> sRGB directly. Manual trilinear interpolation (nearest
// fetches) avoids tiled-atlas seams. The textureSize guard makes the stage a
// safe pass-through whenever no LUT is bound (before a fit completes, or in
// contexts like export that don't supply per-photo stage textures).
// ---------------------------------------------------------------------------

const STAGE = {
  id: STAGE_ID,
  name: "JPG Tone Match",
  phase: "effects",
  priority: 40, // before vignette (50) / grain (60): the camera look sits under creative effects
  glsl: "c = jtmSample(uMatchLut, c);",
  helpers: [
    "vec3 jtmFetch(sampler2D lut, float ri, float gi, float bi) {",
    "  float n = 17.0;",
    "  float x = (bi * n + ri + 0.5) / (n * n);",
    "  float y = (gi + 0.5) / n;",
    "  return texture(lut, vec2(x, y)).rgb;",
    "}",
    "vec3 jtmSample(sampler2D lut, vec3 rgb) {",
    "  if (textureSize(lut, 0).x < 4) return rgb;", // no LUT bound -> pass through
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
  ].join("\n"),
  uniforms: [],
  textures: [
    { key: "uMatchLut", kind: "lut", width: ATLAS_W, height: ATLAS_H, format: "rgba16f" },
  ],
};

// ---------------------------------------------------------------------------
// 3D LUT construction
// ---------------------------------------------------------------------------

function nodeIndex(r, g, b) {
  return (b * N + g) * N + r;
}

// Identity LUT atlas (output == input): the stage is a no-op. Used as the
// "before"-capture texture, the intensity=0 endpoint, and the no-JPG fallback.
function identityAtlas() {
  const data = new Float32Array(ATLAS_FLOATS);
  const n1 = N - 1;
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const x = b * N + r;
        const o = (g * ATLAS_W + x) * 4;
        data[o] = r / n1;
        data[o + 1] = g / n1;
        data[o + 2] = b / n1;
        data[o + 3] = 1;
      }
    }
  }
  return data;
}

// Light smoothing: blend each node 25% toward its 6-neighbour average. Tames
// single-image fit speckle without erasing genuine hue twists.
function smoothNodes(lut) {
  const out = new Float32Array(lut.length);
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const i = nodeIndex(r, g, b);
        const nb = [
          r > 0 ? nodeIndex(r - 1, g, b) : -1,
          r < N - 1 ? nodeIndex(r + 1, g, b) : -1,
          g > 0 ? nodeIndex(r, g - 1, b) : -1,
          g < N - 1 ? nodeIndex(r, g + 1, b) : -1,
          b > 0 ? nodeIndex(r, g, b - 1) : -1,
          b < N - 1 ? nodeIndex(r, g, b + 1) : -1,
        ];
        for (let c = 0; c < 3; c++) {
          let acc = lut[i * 3 + c] * 2;
          let wn = 2;
          for (let k = 0; k < 6; k++) {
            if (nb[k] < 0) continue;
            acc += lut[nb[k] * 3 + c];
            wn++;
          }
          const avg = acc / wn;
          out[i * 3 + c] = lut[i * 3 + c] * 0.75 + avg * 0.25;
        }
      }
    }
  }
  return out;
}

// Fit a 3D LUT mapping `before` (the RAW render, sRGB) -> `after` (the JPG, sRGB).
// Each corresponding pixel pair is trilinearly splatted into the grid at its
// input colour; an identity prior regularises unseen/under-sampled nodes so
// colours absent from the image pass through untouched. Returns the full-strength
// (intensity-independent) atlas — intensity is applied later by blending toward
// identity, so the cached fit is reusable at any intensity.
function fitAtlas(before, after) {
  const nodes = N * N * N;
  const sum = new Float32Array(nodes * 3);
  const wsum = new Float32Array(nodes);
  const n1 = N - 1;
  const bd = before.data;
  const ad = after.data;
  const px = Math.min(before.width * before.height, after.width * after.height);

  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const br = bd[o] / 255, bg = bd[o + 1] / 255, bb = bd[o + 2] / 255;
    if (br <= FIT_CLIP_LO || bg <= FIT_CLIP_LO || bb <= FIT_CLIP_LO ||
        br >= FIT_CLIP_HI || bg >= FIT_CLIP_HI || bb >= FIT_CLIP_HI) continue;
    const ar = ad[o] / 255, ag = ad[o + 1] / 255, ab = ad[o + 2] / 255;

    const fr = br * n1, fg = bg * n1, fb = bb * n1;
    const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    const dr = fr - r0, dg = fg - g0, db = fb - b0;

    for (let kb = 0; kb < 2; kb++) {
      const bi = Math.min(b0 + kb, n1);
      const wb = kb ? db : 1 - db;
      for (let kg = 0; kg < 2; kg++) {
        const gi = Math.min(g0 + kg, n1);
        const wg = kg ? dg : 1 - dg;
        for (let kr = 0; kr < 2; kr++) {
          const ri = Math.min(r0 + kr, n1);
          const w = (kr ? dr : 1 - dr) * wg * wb;
          if (w <= 0) continue;
          const idx = nodeIndex(ri, gi, bi);
          sum[idx * 3] += ar * w;
          sum[idx * 3 + 1] += ag * w;
          sum[idx * 3 + 2] += ab * w;
          wsum[idx] += w;
        }
      }
    }
  }

  // Regularise toward identity, then smooth.
  const lut = new Float32Array(nodes * 3);
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const idx = nodeIndex(r, g, b);
        const denom = wsum[idx] + FIT_LAMBDA;
        lut[idx * 3] = (sum[idx * 3] + FIT_LAMBDA * (r / n1)) / denom;
        lut[idx * 3 + 1] = (sum[idx * 3 + 1] + FIT_LAMBDA * (g / n1)) / denom;
        lut[idx * 3 + 2] = (sum[idx * 3 + 2] + FIT_LAMBDA * (b / n1)) / denom;
      }
    }
  }
  const sm = smoothNodes(lut);

  // Bake to the tiled atlas.
  const data = new Float32Array(ATLAS_FLOATS);
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const idx = nodeIndex(r, g, b);
        const x = b * N + r;
        const o = (g * ATLAS_W + x) * 4;
        data[o] = sm[idx * 3];
        data[o + 1] = sm[idx * 3 + 1];
        data[o + 2] = sm[idx * 3 + 2];
        data[o + 3] = 1;
      }
    }
  }
  return data;
}

// Blend a fitted atlas toward identity by (1 - t) to apply match intensity.
function atlasAtIntensity(fitted, identity, t) {
  if (t >= 0.999) return fitted;
  const out = new Float32Array(ATLAS_FLOATS);
  for (let i = 0; i < ATLAS_FLOATS; i += 4) {
    out[i] = identity[i] + (fitted[i] - identity[i]) * t;
    out[i + 1] = identity[i + 1] + (fitted[i + 1] - identity[i + 1]) * t;
    out[i + 2] = identity[i + 2] + (fitted[i + 2] - identity[i + 2]) * t;
    out[i + 3] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Embedded JPG extraction (vendored from core src/modules/library/raw-preview.ts)
// RAW files are TIFF/CIFF containers embedding one or more JPEGs; walk marker
// segments so a nested EXIF thumbnail's EOI doesn't truncate the outer preview.
// ---------------------------------------------------------------------------

function findJpegEnd(buf, start) {
  const n = buf.length;
  let p = start + 2;
  while (p + 1 < n) {
    if (buf[p] !== 0xff) { p++; continue; }
    let marker = buf[p + 1];
    while (marker === 0xff && p + 2 < n) { p++; marker = buf[p + 1]; }
    if (marker === 0xd9) return p + 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (p + 4 > n) return -1;
    const len = (buf[p + 2] << 8) | buf[p + 3];
    if (len < 2) return -1;
    if (marker === 0xda) {
      let q = p + 2 + len;
      while (q + 1 < n) {
        if (buf[q] === 0xff) {
          const m = buf[q + 1];
          if (m === 0xd9) return q + 2;
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { q += 2; continue; }
          break;
        }
        q++;
      }
      if (q + 1 >= n) return -1;
      p = q;
      continue;
    }
    p += 2 + len;
  }
  return -1;
}

function collectJpegs(buf) {
  const found = [];
  const n = buf.length;
  let i = 0;
  while (i < n - 2) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const end = findJpegEnd(buf, i);
      if (end === -1) { i += 3; continue; }
      found.push({ start: i, end });
      i = end;
    } else {
      i++;
    }
  }
  return found.sort((a, b) => b.end - b.start - (a.end - a.start));
}

async function extractEmbeddedJpeg(file) {
  const arrayBuffer = await file.arrayBuffer();
  const candidates = collectJpegs(new Uint8Array(arrayBuffer));
  for (const { start, end } of candidates) {
    const blob = new Blob([arrayBuffer.slice(start, end)], { type: "image/jpeg" });
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return blob;
    } catch {
      /* not a decodable baseline JPEG — try the next candidate */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orientation (vendored from core src/catalog/orient.ts)
// Embedded previews are usually sensor-native and carry no orientation tag, so
// the master EXIF orientation is the source of truth — aspect-gated to leave
// already-uprighted previews alone.
// ---------------------------------------------------------------------------

function normalizeRotation(deg) {
  if (!Number.isFinite(deg)) return 0;
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

function orientationToRotation(orientation) {
  switch (orientation) {
    case 3: return 180;
    case 6: return 90;
    case 8: return 270;
    default: return 0;
  }
}

function previewUprightRotation(previewW, previewH, rotation, orientation) {
  const exifRot = orientationToRotation(orientation);
  const manual = normalizeRotation(rotation - exifRot);
  const quarter = exifRot === 90 || exifRot === 270;
  const alreadyUpright = quarter && previewH > previewW;
  return normalizeRotation((alreadyUpright ? 0 : exifRot) + manual);
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

async function uprightBitmap(src, deg) {
  const d = normalizeRotation(deg);
  if (d === 0) return src;
  const swap = d === 90 || d === 270;
  const w = swap ? src.height : src.width;
  const h = swap ? src.width : src.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.translate(w / 2, h / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return createImageBitmap(canvas);
}

function toImageData(src, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function atlasFromBytes(u8) {
  const copy = u8.slice(); // fresh 4-byte-aligned buffer
  return new Float32Array(copy.buffer);
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

let cleanup = null;

export function activate(api) {
  const dev = api.stores.useDevelopStore;
  const cat = api.stores.useCatalogStore;
  const pipe = api.stores.usePipelineStore;

  const IDENTITY = identityAtlas();
  let texVersion = 1;
  let generation = 0; // bumped per (re)fit to cancel stale async work
  let stageOn = false; // whether the GPU stage is currently registered
  let fittedAtlas = null; // intensity-independent fit for the current photo
  let fittedForPhoto = null; // photoId fittedAtlas belongs to

  // The display-transform option (the user-facing switch). No GLSL: the actual
  // lookup is the gated processing stage, which a pipeline can't host (it can't
  // carry a per-photo texture).
  api.registerPipeline({
    id: PIPE_ID,
    name: "JPG Tone Match",
    description: "Match the decoded RAW to the camera's embedded JPG preview (per-photo auto LUT).",
  });

  api.registerSettings({
    title: "JPG Tone Match",
    order: 100,
    fields: [
      {
        key: "intensity", label: "Match intensity (%)", type: "number",
        default: 100, min: 0, max: 100, step: 1,
        hint: "How strongly to apply the camera-JPG match. Turn it on for a photo by choosing \"JPG Tone Match\" from the display transform menu in Develop's bottom bar, or make it the default under Preferences ▸ Rendering.",
      },
      {
        key: "ignoreCache", label: "Always recompute", type: "boolean", default: false,
        hint: "Re-fit the LUT from the embedded JPG every time a photo opens, instead of reusing the saved fit.",
      },
    ],
  });

  // The transform the open photo renders with: its own pick, else the
  // Preferences default. Cores before per-photo transforms only have the
  // global choice.
  const effectiveId = () =>
    api.pipelines.effectiveId
      ? api.pipelines.effectiveId(dev.getState().params.displayTransform ?? null)
      : pipe.getState().activeId;
  const isActive = () => effectiveId() === PIPE_ID;
  const intensity = () => {
    const v = Number(api.settings.get("intensity", 100));
    return Math.max(0, Math.min(1, (Number.isFinite(v) ? v : 100) / 100));
  };
  const ignoreCache = () => api.settings.get("ignoreCache", false) === true;

  function uploadAtlas(data) {
    api.setStageTexture(STAGE_ID, "uMatchLut", {
      data, width: ATLAS_W, height: ATLAS_H, format: "rgba16f", version: texVersion++,
    });
  }

  function setStage(on) {
    if (on && !stageOn) { api.registerProcessingStage(STAGE); stageOn = true; }
    else if (!on && stageOn) { api.unregisterProcessingStage(STAGE_ID); stageOn = false; }
  }

  function bakeAndUpload() {
    if (!fittedAtlas) { uploadAtlas(IDENTITY); return; }
    uploadAtlas(atlasAtIntensity(fittedAtlas, IDENTITY, intensity()));
  }

  async function ensureLut(photoId) {
    const token = ++generation;
    if (!isActive() || !photoId) return;

    // Already have this photo's fit — just (re)bake at the current intensity.
    if (fittedForPhoto === photoId && fittedAtlas) { bakeAndUpload(); return; }

    // Clean slate: identity so the stage is a visible no-op while we load/fit
    // (this is also what makes the fit capture feedback-free).
    fittedAtlas = null;
    fittedForPhoto = null;
    uploadAtlas(IDENTITY);

    try {
      if (!ignoreCache()) {
        const cached = await api.develop.getPhotoData(LUT_DATA_KEY);
        if (token !== generation) return;
        if (cached && cached.byteLength === ATLAS_BYTES) {
          fittedAtlas = atlasFromBytes(cached);
          fittedForPhoto = photoId;
          bakeAndUpload();
          return;
        }
      }

      const photo = cat.getState().photos.find((p) => p.id === photoId);
      if (!photo || !photo.fileHandle) return;
      const file = await photo.fileHandle.getFile();
      if (token !== generation) return;

      const blob = await extractEmbeddedJpeg(file);
      if (token !== generation) return;
      if (!blob) { console.warn("[JPG Tone Match] no embedded JPG in", photo.relPath || photoId); return; }

      const jpeg = await createImageBitmap(blob, { imageOrientation: "none" });
      if (token !== generation) { jpeg.close(); return; }

      // "before" = the live RAW render (identity LUT now, so feedback-free), in
      // display-encoded sRGB — the same space as the JPG.
      const capture = await api.develop.captureFrame(dev.getState().params);
      if (token !== generation) { jpeg.close(); if (capture.close) capture.close(); return; }

      const scale = FIT_MAX_EDGE / Math.max(capture.width, capture.height);
      const W = Math.max(1, Math.round(capture.width * scale));
      const H = Math.max(1, Math.round(capture.height * scale));

      const before = toImageData(capture, W, H);
      const deg = previewUprightRotation(
        jpeg.width, jpeg.height, photo.rotation || 0, photo.exif && photo.exif.orientation,
      );
      const upright = await uprightBitmap(jpeg, deg);
      const after = toImageData(upright, W, H);
      if (upright !== jpeg) upright.close();
      jpeg.close();
      if (capture.close) capture.close();
      if (token !== generation) return;

      fittedAtlas = fitAtlas(before, after);
      fittedForPhoto = photoId;
      api.develop.putPhotoData(LUT_DATA_KEY, new Uint8Array(fittedAtlas.buffer.slice(0)));
      bakeAndUpload();
    } catch (err) {
      console.warn("[JPG Tone Match] fit failed:", err);
    }
  }

  // Reconcile to the current selection: register/remove the stage and (when on)
  // make sure the current photo's LUT is ready.
  function sync() {
    const on = isActive();
    setStage(on);
    if (on) {
      void ensureLut(dev.getState().photoId);
    } else {
      fittedAtlas = null;
      fittedForPhoto = null;
    }
  }

  sync();

  // The stage follows the open photo: switching photos, changing this photo's
  // pick, or changing the default can each turn the match on or off.
  let lastPhoto = dev.getState().photoId;
  let lastEffective = effectiveId();
  const reconcile = () => {
    const photoId = dev.getState().photoId;
    const eff = effectiveId();
    if (eff !== lastEffective) {
      lastEffective = eff;
      lastPhoto = photoId;
      sync();
      return;
    }
    if (photoId !== lastPhoto) {
      lastPhoto = photoId;
      if (isActive()) void ensureLut(photoId);
    }
  };
  const unsubDev = dev.subscribe(reconcile);
  const unsubPipe = pipe.subscribe(reconcile);

  const unsubSettings = api.settings.onChange((key, value) => {
    if (!isActive()) return;
    if (key === "ignoreCache" && value) {
      fittedForPhoto = null; // force a fresh fit on the current photo
      void ensureLut(dev.getState().photoId);
    } else if (key === "intensity") {
      bakeAndUpload();
    }
  });

  cleanup = () => {
    unsubDev();
    unsubPipe();
    if (unsubSettings) unsubSettings();
    setStage(false);
  };
}

export function deactivate() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
}
