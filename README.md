# HOME INVASION — Mixed Reality Horror

A mixed-reality VR horror game for Meta Quest 3 (WebXR + three.js, no build step, zero assets — everything procedural). A monster walks your **real house**, navigating the room scan Meta makes of your home, paths around your furniture, and comes for you. Physically walking away matters as much as the stick.

## Play

Serve the folder and open it in the Quest browser:

```
python3 -m http.server 8091
```

## Controls

- **Left stick** — slide · **Right stick** — snap turn · **Trigger / pinch** — retry after death
- **Y** — settings menu: FLASHLIGHT MODE, ROOM BRIGHTNESS, MASK REMOVAL
- **X** (left) / **G** (desktop) — room diagnostics
- Desktop preview: **WASD** move, **Q/E** snap, mouse look · add `?simroom` to the URL for a simulated room without a headset

## Rules for changing this game

`master` is protected: all changes land through pull requests and need **one approving review from someone other than the author**. Direct pushes and force pushes are blocked — including for admins.
