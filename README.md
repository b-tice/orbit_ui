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
| **zone** | a range of travel within the span, with a type: **Controller**, **Note**, **Switch**, **Freeze**, or **Dead**. Zones may overlap |
| **Controller zone** (CTL) | travel here sends a CC on the zone's transmit channel, shaped by the zone's own response curve. Shown as the `CH·CC` chip |
| **end points** | the edges of a zone; drag them to resize it |
| **response curve** | a Controller zone's points, mapping travel to CC value (linear or smooth). Its first and last points are the zone's end points |
| **transmit channel** | the MIDI channel a zone sends on, set per zone |
| **Receive Channel** | the channel Orbit listens on for program changes (`RECEIVE CH` in the header) |
| **Setup** | one saved configuration: name and the zones of both axes |
| **Library** / **Set List** | where Setups are stored / the ordered performance list; position = program change number |

## The model (v1.8)

Each axis (**YAW** left→right, **PITCH** heel→toe) is one span of travel,
0–100%, holding **zones**. Every zone has a type, a travel range, and a
color, and zones **may overlap** — a second CC on the same sweep is just a
second Controller zone laid over the first. Controller zones always sit
underneath the other types; within a type the narrowest zone is drawn on top
and is the one a tap hits (a covered Controller is always reachable through
its `CH·CC` chip).
Where a Note, Switch, Freeze or Dead zone covers a Controller zone, the
Controller is inactive there and its curve is drawn dotted. Two overlapping
Controller zones are both active — unless they share the same transmit
channel **and** CC, in which case only the topmost (narrowest) one sends in
the overlap, the other goes dotted there, and both chips turn amber.

| Type | What travel inside it does |
|---|---|
| 🎚 **Controller** | sends a CC on the zone's transmit channel, shaped by the zone's own response curve. The curve's first and last points are the zone's **end points** and set the output range; descending end points invert the output, so there is no polarity switch |
| 🎵 **Note** | note on (with velocity) when the pedal enters, note off when it leaves |
| ⚡ **Switch** | a **fast entry** (faster than the zone's Speed, in % of travel per second, default 250) toggles the switch on/off. On sends a note on or the CC's *on* value; off sends note off or the *off* value. Slow entry does nothing, and the pedal must leave the zone before it can fire again |
| ❄️ **Freeze** | holds the other axis's value while the pedal is in the zone |
| 🪦 **Dead** | travel is ignored. A Dead zone is a **mask**: it silences any Controller zone underneath it, so you can carve a dead spot out of a wide Controller zone without splitting it. Travel with no zone at all is dead too |

Default Setup: yaw is Dead · CTL · Dead · CTL · Dead (the "bipolar Mid=Hi"
example: left zone 0→127, right zone 127→0), pitch is Dead · CTL · Dead.

Pre-v1.8 Setups (with layers) migrate automatically: layer 1 and layer 2
both land on the axis as overlapping zones in two colors (an OFF layer 2 is
dropped).

## Interactions

| Gesture | Effect |
|---|---|
| drag a point | move it in travel/value (end points move in value only; drag the zone's edge to move them in travel) |
| double-click / double-tap inside a Controller zone | add a curve point to the topmost Controller zone there |
| tap a point | popover: numeric travel/value, delete (end points can't be deleted) |
| tap a zone (or its `CH·CC` chip) | popover: type (Controller / Note / Switch / Freeze / Dead), range %, color, the type's settings (transmit ch, CC, note, velocity, switch action + speed, linear ↔ smooth response curve), delete |
| drag a zone's end point | resize the zone — its response curve rescales to follow |
| drag a zone's body | move the zone, curve and all |
| **+ Zone** button | adds a Controller zone over the middle third, on top, in the next color, and opens its popover so you can pick the type |
| drag the ▲ marker | simulate pedal position; readout lists every active output at the marker (`DEAD` when none). Flick it fast into a ⚡ Switch zone to toggle it |
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
- `orbit.js` — all editor logic (zone model + migration, SVG rendering, gestures, popovers, librarian, save review)
- `ambient.css` — vendored Ambient CSS (unmodified, attributed)
- `reference/` — David's two source sketches
