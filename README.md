# Orbit UI — assignment editor (concept demo)

Live at <https://b-tice.github.io/orbit_ui/>. The current version is shown
in the page header (`APP_VERSION` in `orbit.js`) and bumps with every
feature addition.

A standalone web page that demos the Orbit pedal's Setup editor: setting
response **curves** and **zones** for the pitch and yaw axes.
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

## Vocabulary (v1.7)

The words in the UI follow the terminology agreed with David Mash:

| Term | Meaning |
|---|---|
| **Yaw axis** / **Pitch axis** | left→right travel / heel→toe travel |
| **span** | the whole travel of one axis, 0–100 % |
| **zone** | a range of travel within the span. Today a zone is one of Dead, Freeze, or Note; the gaps between zones are **Controller zones** |
| **Controller zone** (CTL) | travel here sends a CC on the zone's transmit channel, shaped by its response curve. Shown as the `CH·CC` chip |
| **end points** | the edges of a zone; drag them to resize it |
| **response curve** | the points that map travel to CC value (linear or smooth) |
| **transmit channel** | the MIDI channel a zone sends on, set per zone |
| **Receive Channel** | the channel Orbit listens on for program changes (`RECEIVE CH` in the header) |
| **Setup** | one saved configuration: name, zones, curves, layers |
| **Library** / **Set List** | where Setups are stored / the ordered performance list; position = program change number |

## The model

Each axis (**YAW** left→right, **PITCH** heel→toe) is one span of travel,
0–100%, with two primitives:

- **Points** define the response curve (travel % → CC value 0–127).
  The curve sends CC messages while the pedal is in a Controller zone.
- **Zones** are bands of travel where the curve is inactive. A zone is one
  of: **Dead**, **Freeze <other axis> value**, or **Send MIDI note**
  (transmit channel + note number).

**Controller zones** are simply the gaps between zones. Each Controller
zone owns its own transmit channel + CC number (shown as the `CH·CC` chip
above the strip). Inverting output is just a curve whose points descend —
no separate polarity switch, per the response-curves-cover-polarity
discussion.

## Layers (v1.5)

Each axis carries **two layers** — two full sets of points, spans, and
live-zone assignments driven by the same pedal movement (e.g. different
MIDI channels/CCs per layer). Tabs above the editors switch which layer
is being edited: **Layer 1** is indigo, **Layer 2** is magenta. The
inactive layer stays visible underneath, blurred like frosted glass, so
you can line up curves without visual clutter. Each tab's ⏻ toggles that
layer on/off (an off layer's ghost is hidden and it's marked OFF in the
exports). Layer on/off state is saved per program in the library.

## Interactions

| Gesture | Effect |
|---|---|
| drag a point | move it in travel/value |
| double-click / double-tap empty area | add a point |
| tap a point | popover: numeric travel/value, transmit ch + CC of its Controller zone, delete |
| tap a zone | popover: Dead / Freeze / Note mode (+ transmit ch & note #), delete |
| drag a zone's end point | resize the zone — curve points in the adjacent Controller zone rescale to follow (v1.1) |
| drag a zone's body | move the zone — curves in both neighboring Controller zones rescale (v1.1) |
| **+ Zone** button | drops a new zone in the widest Controller zone |
| tap a `CH·CC` chip | popover: the Controller zone's transmit channel and CC number |
| **smooth** toggle | linear ↔ monotone-cubic curve interpolation |
| drag the ▲ marker | simulate pedal position; readout shows the CC (or zone behavior) that would be sent |
| **Save** / **+ new** | open a review window showing the full Setup as readable text or JSON (with a copy button); its **Save** stores the Setup in the Library (Save updates the loaded one, + new makes a copy), **Cancel** / Esc closes without storing (v1.2, review step v1.6) |
| unsaved changes | loading another Setup, + new, a MIDI-in program change, or reset demo first asks **Save / Discard / Cancel** when the loaded Setup has been edited (v1.7) |
| **RECEIVE CH** | the channel Orbit *receives* on (1–16 or OMNI) — separate from the transmit channels set per zone (v1.4, renamed v1.7) |
| **MIDI IN · TEST** | simulate an incoming program change: on the receive channel it loads that Set List slot (with a flash); otherwise it's ignored (v1.4) |
| Library row | tap to load · `+` appends to the Set List · `×` twice deletes · drag the bar (anywhere, v1.3) into the Set List at any position |
| Set List row | drag the bar to reorder — position is the 1:1 program change number · drag it onto the Library to remove (v1.3) · `×` removes · tap loads |

Setup name (10 chars, like GC patches) and number (1–128) sit in the
header and are included in the review window's output. State persists in
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
- `orbit.js` — all editor logic (state, SVG rendering, gestures, save review)
- `ambient.css` — vendored Ambient CSS (unmodified, attributed)
- `reference/` — David's two source sketches
