# Depth and plan image changes

This patch targets the published BXM viewer at commit `70d4145`.

## Depth handling

- Logarithmic depth and a camera clipping range based on the actual content replace the unnecessarily wide fixed clipping range.
- A bounded, once-per-load analysis identifies overlapping coplanar triangles. A deterministic graph colouring assigns small depth priorities to conflicting meshes. Geometry coordinates and authored colours are unchanged. No demolition, phase or construction precedence is inferred.
- A small fragment-depth bias resolves the ties with logarithmic depth. Biased materials share shader programs and are cached per source material and layer. Selection is placed above coincident context surfaces; a real depth separation still occludes normally.
- Picking at an equal-distance surface tie uses the same priority as rendering. The existing solid-before-Zone picking policy remains.
- The analysis is capped at 500,000 triangles, 200,000 overlapping mesh pairs, two million triangle comparisons and 32 depth layers. If a limit is exceeded, it leaves the model materials unchanged and displays a warning. Logarithmic depth and improved clipping still apply. This is a practical bounded fix, not a general geometric-intersection or order-independent-transparency renderer.

## JPG handling

- Image materials retain depth testing but no longer write depth. Explicit draw order gives coincident transparent plans stable compositing. Each image has a Front button to bring it above the other plans without moving it.
- Sizing is a visible choice: Preserve JPG proportions is the existing default; Use declared width and height honours both supplied dimensions. The existing `stretch` URL parameter still chooses declared sizing. The current samples have square declared dimensions for rectangular JPGs, so a warning explains the discrepancy. This patch does not guess which calibration is correct or edit the exported sidecars.
- Horizontal axes are validated and normalised; origins are preserved exactly. Unsupported tilted axes, invalid placement and failed images are reported explicitly.
- Fit visible plans frames all enabled, scope-visible images, including rotated drawings. The existing building-focused Plan preset remains available.
- Scope, type, manual-hide and image choices compose instead of overwriting one another. Show all objects resets geometry filters and scopes while preserving individual image choices.
- Missing JPGs appear as unavailable entries and are identified by filename. The second model6282 JPG is not present in the published sample files; this patch reports it and continues loading the usable model and images.
- Replaced image geometries, selection outlines/materials, cached depth materials and image textures have explicit cleanup. Back-forward-cache page preservation does not dispose live resources.

## Verification

No new runtime dependency, build step or asset conversion is required.

Run the focused geometry and sizing checks with Node.js 20 or newer:

```sh
npm test
```

Serve this repository using an ordinary local HTTP server. Open:

- `test/browser-depth.html` for real WebGL coplanar, foreground/background occlusion, multiple material-uniform and transparent-layer compositing checks.
- `test/viewer-regression.html` and click Run sample regressions for the four supplied models, sizing, origin, framing, combined filters, image ordering, picking, grey-out and hide/show checks.

The test suite uses the vendored Three.js modules and the existing sample files. The local test run used Chromium/ANGLE on an NVIDIA RTX 3080 Ti Laptop GPU; this is not cross-browser or cross-hardware qualification. No new performance claim is made. Logarithmic fragment depth can affect early depth-test optimisations, so performance on other hardware and much larger models should be checked before deployment.

## Remaining limits

Intersecting transparent volumes can still show ordinary alpha-blending order effects. The depth priority is a visual tie-break with finite precision; it is not an exact physical ordering of arbitrarily close surfaces or a replacement for source-authored display priorities. Large-coordinate georeferencing, arbitrary tilted image planes, and exhaustive picking coverage are outside this patch. The original project source should incorporate these changes before a generated public build is republished.
