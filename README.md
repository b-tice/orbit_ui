# Orbit UI — assignment editor (concept demo)

Live at <https://b-tice.github.io/orbit_ui/>. The current version is shown
in the page header (`APP_VERSION` in `orbit.js`) and bumps with every
feature addition.

A standalone web page that demos the Orbit pedal's assignment UI: setting
response **curves** and **spans** (dead zones) for the pitch and yaw axes.
It is not connected to the device — it's a UI concept for review, based on
David Mash's `reference/Orbit_UI_Rough.jpeg` and
`reference/Assignment_Rough.jpeg` sketches and the email thread of
Aug–Sep 2026.

## Run it

No build step. Either open `index.html` directly in a browser, or serve it
(required for some clipboard features on some browsers):

```sh
cd orbit_ui
python3 -m http.server 8080
# → http://localhost:8080
```

Works on desktop and phone (pointer + touch events, `touch-action: none`
on the editors).

## The model

Each axis (**YAW** left→right, **PITCH** heel→toe) is one strip of travel,
0–100%, with two primitives:

- **Points** define the response curve (travel % → CC value 0–127).
  The curve sends CC messages while the pedal is in a live zone.
- **Spans** are bands of travel where the curve is inactive. A span is one
  of: **Dead**, **Freeze <other axis> value**, or **Send MIDI note**
  (channel + note number).

**Live zones** are simply the gaps between spans. Each live zone owns its
own MIDI channel + CC number (shown as the `CH·CC` chip above the strip).
Inverting output is just a curve whose points descend — no separate
polarity switch, per the response-curves-cover-polarity discussion.

## Interactions

| Gesture | Effect |
|---|---|
| drag a point | move it in travel/value |
| double-click / double-tap empty area | add a point |
| tap a point | popover: numeric travel/value, MIDI ch + CC of its zone, delete |
| tap a span | popover: Dead / Freeze / Note mode (+ ch & note #), delete |
| drag a span's edge | resize the span — curve points in the adjacent live zone rescale to follow (v1.1) |
| drag a span's body | move the span — curves in both neighboring live zones rescale (v1.1) |
| **+ span** button | drops a new span in the widest live gap |
| tap a `CH·CC` chip | popover: live zone's MIDI channel and CC number |
| **smooth** toggle | linear ↔ monotone-cubic curve interpolation |
| drag the ▲ marker | simulate pedal position; readout shows the CC (or span behavior) that would be sent |
| **Publish** | modal with the full settings as readable text or JSON, with a copy button |

Program name (10 chars, like GC patches) and number (1–128) sit in the
header and are included in the published output. State persists in
`localStorage`; the *reset demo* button restores the default layout
(the "bipolar Mid=Hi" yaw example and a simple heel→toe pitch ramp).

## Theme

Styling uses [Ambient CSS](https://ambientcss.vercel.app/) — a
physics-based lighting system — vendored as `ambient.css`, with its
**Night** preset variables applied in `orbit.css`
(`keyLight .125 · fillLight 0 · hue 250 · sat 30% · LED #6366f1`), plus
the Michroma display font via Google Fonts (falls back to sans-serif
offline).

## Files

- `index.html` — page shell
- `orbit.css` — night theme overrides + app/editor styles
- `orbit.js` — all editor logic (state, SVG rendering, gestures, publish)
- `ambient.css` — vendored Ambient CSS (unmodified, attributed)
- `reference/` — David's two source sketches
