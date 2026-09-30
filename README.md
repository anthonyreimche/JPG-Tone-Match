# JPG Tone Match

Match the decoded RAW to your camera's JPG preview.

A Safelight **display transform** that auto-derives a per-photo colour correction
by comparing each photo's embedded camera JPG to the live RAW render, then applies
it so the decoded RAW takes on the camera's look.

## Why

Safelight's libraw decode is colorimetrically close to the camera (it applies a
camera→sRGB matrix), but it lacks the manufacturer's *look* — the camera-specific
tone curve and hue-dependent rendering that the in-camera JPG (and Lightroom's
camera-matching profiles) apply. That look is exactly the difference you see
between the neutral RAW and the JPG. This extension reconstructs it automatically,
straight from the JPG already embedded in your RAW file. No profile files, no
manual tuning.

## Using it

Turn it on for a photo by choosing **"JPG Tone Match"** from the display transform menu
in Develop's bottom bar, or make it that photo's fallback by setting it as the
default under **Preferences ▸ Rendering ▸ Default display transform** (followed by
any photo without its own pick). Open a RAW photo that uses it in Develop — the
match is computed from its embedded JPG and applied automatically, everywhere
that photo renders (Develop, Loupe, thumbnails).

Adjust **Match intensity** in **Preferences ▸ Extensions ▸ JPG Tone Match** (0% = neutral
RAW, 100% = full match). The same section has **Always recompute** to ignore the saved
fit and re-derive on every open.

To turn it off, pick a different Display transform from Develop's bottom bar (e.g.
Built-in) or remove it from your Preferences default.

## How it works

1. It extracts the largest decodable embedded JPG from the RAW container and
   orients it upright.
2. It captures the live RAW render (in display-encoded sRGB — the same space the
   JPG lives in) with its own lookup forced to a no-op, so the capture is clean.
3. It fits a **17³ 3D colour LUT** that maps the RAW render → the JPG. The fit is
   regularised toward identity, so colours that don't appear in the image pass
   through untouched (no invented shifts), and lightly smoothed to tame single-
   image noise.
4. The LUT is applied on the GPU as the last look stage (`effects` phase), after
   the display transform and core tone adjustments — a single trilinear lookup.
   Match intensity is baked into the LUT (the fitted LUT is blended toward
   identity), so changing it never needs a re-fit.

The fitted LUT is saved per photo, so reopening is instant (no recompute) and the
match survives across sessions.

### Implementation note

A Safelight display-transform *pipeline* maps scene-linear → display and can't
carry a per-photo texture, so the actual lookup runs in a GPU **processing stage**
that is registered only while the open photo's Display transform is "JPG Tone
Match", and removed otherwise. Picking the transform for a photo is that photo's
on/off switch; the stage is the engine.

## Known limitations

- The match stage is on for the whole app while the open photo uses it, so exporting
  a different photo at that moment also gets the open photo's match.
- The fit pairs the JPG and the RAW render by position. It's most accurate on an
  uncropped frame; a heavy crop can reduce alignment (mitigated by outlier
  rejection). Toggle **Always recompute** (or reopen) after a big crop.
- Mirrored EXIF orientations (2/4/5/7) are approximated as unmirrored, matching
  Safelight core.

## Install

No-build, single-file extension. Install from the in-app Extensions store (tag the
repo `safelight-extension`), or point a local install at this repo — `main` is
`index.js`, committed as-is.

## License

GPL-3.0. Safelight — founded and principally authored by Anthony Reimche.
