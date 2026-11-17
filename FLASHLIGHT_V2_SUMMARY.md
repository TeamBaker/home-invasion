# Flashlight v2 (`?v=shadow2`) — round-3 feature pass

Builds on the shadow-mapped spotlight (`shadow1`). Nothing changed in the draw-order ladder,
the darkness overlay concept, the existing settings rows (FLASHLIGHT MODE, ROOM BRIGHTNESS,
MASK REMOVAL), the Y button, trigger, stick, keyboard keys or the debug overlay.

## Files changed
| File | Change |
|---|---|
| `index.html` | `main.js?v=shadow1` → `?v=shadow2` |
| `js/flashlight.js` | Cone/falloff/bias are now **uniforms** (live sliders); new `innerCos`, `biasSlope`, `coneFalloff`, `penumbraAlpha`, `lightAmount`, `inFurniture`, `casterShaders`, `beamShaders`; `FLASH` gained `coneMin/coneMax/falloff/maxFurniture`. `isLit()` is still the exact mirror of the shader's discard predicate. |
| `js/main.js` | Furniture pass-through, penumbra blend, 3D model, light rays, 4 new settings rows. Imports `room.js?v=shadow2` / `flashlight.js?v=shadow2` so Quest Browser can't load a cached old module next to the new main.js. |
| `js/room.js` | Tags each occluder with `userData.lightRole` (`furniture` / `scan` / `wall`) and re-exports `FURNITURE_LABELS`. It imports `roommodel.js?v=shadow2`. Occlusion and navigation are unchanged. |
| `js/roommodel.js` | Adds `export const FURNITURE_LABELS` (table, couch, bed, desk, chair, shelf, storage, screen, lamp, plant, other). Pipeline logic is untouched. |
| `test/flashlight.test.mjs` | GLSL test updated for uniforms; 6 new tests (falloff, penumbra blend, lightAmount, cone diameter, furniture pass-through, caster/beam shaders). |

Tests: `node --test test/*.mjs` → 22/22 pass. (On this Node version, `node --test test/` with a
directory argument fails to resolve the directory as a module; the glob form runs every file.)
`node --check` passes on all changed JS files.

## 1. Pass-through furniture
- **Plane fallback / simroom:** furniture occluders (extruded `solid` tops, planes with furniture
  labels) get **no light proxy**. They cast no shadow and erase no darkness. Walls and the floor
  stand-ins work as before.
- **Quest 3 scene mesh:** furniture volume meshes (furniture-labelled `XRMesh`es) get no proxy.
  Furniture is also baked into the scanned global mesh, so the global mesh uses `FURN_MASK`
  receiver/caster variants. These discard fragments inside **furniture boxes** (OBBs from the
  furniture volumes, plus furniture planes extruded to the floor, padded 3 cm, up to 16 per frame,
  uploaded as world→unit-cube `mat4`s). The beam goes through the couch and lights the wall/floor
  behind it.
- The furniture itself stays dark: its depth-only occluder still hides what's behind it from the
  *viewer*, and nothing writes stencil on it. The monster's real-world occlusion is unchanged.

## 2. Darkness control — `DARKNESS (FINE)` row
- Steps of **1 %** on the same value as ROOM BRIGHTNESS (darkness = 100 − brightness), so the two
  rows stay in sync and share the stored value `mrh-room-brightness`. ROOM BRIGHTNESS keeps its 5 % steps.
- Hold the stick left/right on this row (and the rows below it) to auto-repeat: 400 ms delay,
  then about 14 steps/s. Desktop: arrow keys (key auto-repeat works too).

## 3. `CONE DIAMETER` row
- 10°–80° full angle in 2° steps (default 30°), stored in `mrh-cone-angle`. On change, the
  shadow camera FOV (`shadowFov`), `uConeCos`, `uInnerCos`, `uBiasSlope` and the beam width all
  update together before the next frame's light matrices are built (`_syncFlashConfig`).

## 4. `EDGE FALLOFF` row (soft penumbra)
- 0–100 % of the cone half-angle, 5 % steps, default 30 %, stored in `mrh-edge-falloff`.
  **0 % = the exact old hard edge.**
- Mechanism: the stencil stays **binary** and unchanged. Every lit fragment still writes stencil=1.
  The receiver now also outputs black at alpha `k = penumbraAlpha(base, mask, lit)` through
  explicit src-alpha blending. It is still in the opaque list (`transparent:false` + `CustomBlending`),
  so it draws at the same place in the ladder as before. With the overlays on top, the final
  darkness is `base·(1 − mask·lit)`. That goes smoothly from the mask-erased value in the core to
  full room darkness at the edge.
- In the beam core `lit = 1` → `k = 0` → framebuffer untouched (src·0 + dst·1). This matches the
  old `colorWrite:false` exactly. Outside the cone nothing changed.

## 5. 3D flashlight model
- Procedural mesh only: rubber tail cap, knurled handle with grip rings, red switch, pocket clip,
  flared neck, head, chrome bezel, reflector cup, glowing lens.
- Lives in **scene space**, posed every frame from the right **grip position + aim (pointing-ray)
  orientation**. The barrel is the group's −Z axis, which is the light axis. The light/shadow
  camera now sits at the **lens** (11.5 cm ahead of the grip on that same axis), so model, beam
  and lit spot can't disagree.
- Desktop, or no controller tracked: held low-right in view and aimed at the point 4 m straight
  ahead. *Previously the desktop light came from 0.5 m straight in front of the eye.*
- Drawn after the darkness passes (renderOrder 2002, transparent list), so it stays visible in a
  black room. It is not in the caster/receiver sets. The right grip's grey box marker is hidden
  while the flashlight is on.

## 6. Light rays
- Additive open cone shell from the lens (renderOrder 2003). It fades along its length (6 m),
  is brighter where you see it side-on, and has slowly drifting angular streaks and dust shimmer.
  It **samples the flashlight shadow map**, so it stops at walls (and passes through furniture,
  like the light).
- Plus an additive lens-glow sprite (2004).
- No depth writes, no stencil, framebuffer alpha left alone (`blendSrcAlpha: Zero, blendDstAlpha: One`),
  so passthrough blending and the darkness mechanic are unaffected.
- One draw call (96 tris) + one sprite. No per-frame allocations.
- `LIGHT RAYS` row: 0–100 % in 10 % steps, default 60 %. 0 % = OFF (beam hidden). Stored in `mrh-light-rays`.

## Settings panel
Seven rows: FLASHLIGHT MODE, ROOM BRIGHTNESS, MASK REMOVAL, **DARKNESS (FINE)**, **CONE
DIAMETER**, **EDGE FALLOFF**, **LIGHT RAYS**. The canvas grew from 512×300 to 512×480, and the
quad from 0.7×0.41 to 0.7×0.656 m. Same controls as before.

## Perf
Still one 512² depth-only pass per frame. The receiver shader adds about 8 ALU ops (falloff +
blend). Scanned-mesh fragments add a ≤16-iteration box loop that exits at `uFurnCount`. The beam
adds one cheap additive draw. Nothing in the render loop allocates (box cache entries are created
once per plane record).

## Headless verification (swiftshader, `?simroom`)
- Flashlight on vs off: the spot erases darkness with a visible soft edge, the beam and model
  render, and there are no shader or console errors.
- Old (`shadow1`) vs new, aimed at the simulated table: see the comparison below.

## Verify on the Quest 3 (can't be tested headless)
1. **Furniture labels on the scene mesh.** Pass-through on the global mesh depends on Quest
   reporting furniture volumes/planes with semantic labels (table, couch, …). If furniture still
   casts shadows, run Room Setup again and make sure the furniture is marked. Unlabelled scanned
   clutter is part of the global mesh and still casts shadows.
2. **Box margin:** 3 cm (`FURN_MARGIN` in main.js). If a thin dark band shows on a wall or floor
   right next to furniture, lower it. If furniture edges still catch light, raise it.
3. **Model alignment:** the model follows the *pointing ray* (like the beam), so it tilts a little
   relative to the physical Touch controller handle. This is intended, because the beam must leave
   the barrel. Check that it sits comfortably in the hand.
4. **Penumbra look in passthrough:** check EDGE FALLOFF at 0 % (hard edge, identical to shadow1)
   and around 30–60 %.
5. **Light-ray brightness** over passthrough at different DARKNESS settings. If it's too strong,
   lower the LIGHT RAYS row, or the `0.2` factor in `_syncFlashConfig`.
6. Wide cones (60–80°) spread the 512² shadow map: texels about 3× larger at 80°. If speckle shows,
   raise `biasConst` slightly.
7. Frame rate with LIGHT RAYS on vs OFF when the beam fills the view.
