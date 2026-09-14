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
| **output tab** | **MIDI** or **Analog Out** — each axis has one zone set per tab, edited in the same way; only what a zone drives differs |
| **Setup** | one saved file for one output: a name and the zones of both axes on that tab (a MIDI Setup, an Analog Out Setup; a Ground Control Setup later) |
| **Library** | one library per output tab; the Library panel shows the current tab's |
| **Set List** | an ordered performance list; position = program change number. Each **slot** holds one Setup per output, and a program change recalls them all at once. There can be several Set Lists (v1.10), each with a name and a **bank** number; a MIDI Bank Select picks the Set List, a Program Change picks the slot |

## The model (v1.8 / v1.9)

Each axis (**YAW** left→right, **PITCH** heel→toe) is one span of travel,
0–100%, holding **zones**. Since v1.9 there are two **output tabs** above
the editor, **MIDI** and **ANALOG OUT**, and each axis has its own zone set
per tab. The editor is identical on both; the tabs differ in what a
Controller zone drives: a transmit channel + CC (0–127) on MIDI, or the
axis's **EXP jack** (0–5 V) on Analog Out — pitch is EXP 1 and yaw is EXP 2,
fixed by the hardware, so there is nothing to pick. The Analog tab offers
only Controller, Switch and Dead zones and has no chips; its Switch zones
toggle the jack between two voltages. The ▲ sim marker is shared (it is the same pedal).

**Saving is per tab.** Each axis header has a **save** button that stores the
current tab's zones (both axes) as a Setup in that tab's Library, so a MIDI
Setup and an Analog Out Setup are separate files. The button lights up when
that axis differs from the saved file (or nothing is loaded yet).
A **Set List slot** holds one Setup per output (MIDI, Analog Out, and Ground
Control once that tab exists); a program change recalls every output's Setup
in the slot together. Drag a Library row *between* slots to add a new slot
holding it, or *onto* a slot to fill that slot's entry for the current tab.
A slot always has a Setup for every output: when it gains one for one tab,
the missing ones are created as mirrors with the same name (MIDI → Analog
turns every non-Controller zone into a Dead zone), and you edit them
independently from there. The slot row shows the current tab's Setup;
switch tabs to see the slot's other Setups. Every zone has a type, a travel range, and a
color, and zones **may overlap** — a second CC on the same sweep is just a
second Controller zone laid over the first. Controller zones always sit
underneath the other types; within a type the narrowest zone is drawn on top
and is the one a tap hits (a covered Controller is always reachable through
its `CH·CC` chip).
Where a Note, Freeze or Dead zone covers a Controller zone, the Controller
is inactive there and its curve is drawn dotted (a Switch zone does not mask). Two overlapping
Controller zones are both active — unless they share the same transmit
channel **and** CC, in which case only the topmost (narrowest) one sends in
the overlap, the other goes dotted there, and both chips turn amber.

| Type | What travel inside it does |
|---|---|
| 🎚 **Controller** | sends a CC on the zone's transmit channel, shaped by the zone's own response curve. The curve's first and last points are the zone's **end points** and set the output range; descending end points invert the output, so there is no polarity switch |
| 🎵 **Note** | note on (with velocity) when the pedal enters, note off when it leaves |
| ⚡ **Switch** | a **fast entry** (faster than the zone's Speed, in m/s along the travel, default 0.1 — the full span counts as 10 cm) toggles the switch on/off. On sends a note on (velocity 100) or the CC's *on* value; off sends note off or the *off* value. Speed is averaged over the last 100 ms, slow entry does nothing, and the pedal must leave the zone before it can fire again. On MIDI a Switch never masks what is underneath it: Controllers below keep sending, and the readout shows their value alongside the switch's on/off. On Analog Out the jack carries one voltage, so an on Switch overrides the Controller beneath it (its curve goes dotted there and the readout shows the switch voltage); off, the Controller's value is the output. A Switch that is on is drawn bright with a solid border; off it looks like any other zone. Either toggle glows the border for a moment |
| ❄️ **Freeze** | holds the other axis's value while the pedal is in the zone |
| 🪦 **Dead** | travel is ignored. A Dead zone is a **mask**: it silences any Controller zone underneath it, so you can carve a dead spot out of a wide Controller zone without splitting it. Travel with no zone at all is dead too |

Default Setup (MIDI): yaw is two Controller zones (the "bipolar Mid=Hi"
example: left 0→127, right 127→0) with empty travel at the ends and at
center; pitch is one Controller with empty travel at heel and toe. The
padding is plain empty travel, not Dead zones. Analog Out starts as a **mirror of the MIDI zones**: Controller curves
map 0–127 onto 0–5 V unchanged, and every other zone (Note, Freeze, Switch,
Dead) becomes a Dead zone of the same range, so the dead spots line up. From
there the two are edited independently. To start an
Analog Setup over from MIDI, delete it from the Analog library: its slot gets
a fresh mirror.

Pre-v1.8 Setups (with layers) migrate automatically: layer 1 and layer 2
both land on the MIDI tab as overlapping zones in two colors (an OFF layer 2
is dropped). v1.8 Setups keep their zones on the MIDI tab and get an Analog
Out Setup mirrored from them.

## Interactions

| Gesture | Effect |
|---|---|
| drag a point | move it in travel/value (end points move in value only; drag the zone's edge to move them in travel) |
| double-click / double-tap inside a Controller zone | add a curve point to the topmost Controller zone there |
| tap a point | popover: numeric travel/value, delete (end points can't be deleted) |
| MIDI / ANALOG OUT tabs | switch which output's zones you are editing |
| tap a zone (or its `CH·CC` chip on MIDI) | popover: type (Controller / Note / Switch / Freeze / Dead on MIDI; Controller / Switch / Dead on Analog), range %, color, the type's settings (transmit ch + CC, note, velocity, switch action / voltages + speed, linear ↔ smooth response curve), delete |
| drag a zone's end point | resize the zone — its response curve rescales to follow |
| drag a zone's body | move the zone, curve and all |
| **+ Zone** button | adds a Controller zone over the middle third, on top, in the next color, and opens its popover so you can pick the type |
| drag the ▲ marker | simulate pedal position; readout lists every active output at the marker (`DEAD` when none). Flick it fast into a ⚡ Switch zone to toggle it |
| **save** (in each axis header) / **+ new** | save stores the current tab's Setup in its Library (updating the loaded one); + new stores it as a new Setup under the SETUP name. The save button lights when that axis has unsaved changes (v1.2, per tab and per axis v1.9) |
| unsaved changes | loading another Setup or slot, + new, a MIDI-in program change, or reset demo first asks **Save / Discard / Cancel** when any tab's loaded Setup has been edited; Save saves every dirty tab (v1.7) |
| **RECEIVE CH** | the channel Orbit *receives* on (1–16 or OMNI) — separate from the transmit channels set per zone (v1.4, renamed v1.7) |
| Library row | tap to load into the current tab · `×` deletes the file after a confirmation (its slots get a fresh mirror from their other output, or are dropped if nothing is left) · drag the bar between slots to insert a new slot (the other outputs get mirrored copies), or onto a slot to replace its entry for this tab |
| Set List tools (v1.10) | the dropdown picks which Set List you are editing (shown as "NAME · bank N"); **+ new** opens a small window to name the new list and give it a Bank Select number; **edit** opens the same window for the current list, with rename, re-bank and delete (Setups stay in the Library). Caps: 16 Set Lists of 128 slots, 256 Setups per library |
| **MIDI IN · TEST** | simulate incoming MIDI: an optional BANK (Bank Select, CC 0) then a PC on the receive channel. The bank picks the Set List with that number; the PC recalls that slot (v1.4, bank v1.10) |
| **export file** / **import file** (footer) | export writes both libraries, every Set List and the receive channel to a `.json` file; import restores from such a file after a confirmation (replacing what is there) |
| Set List row | tap to recall the whole slot (every output) · drag the bar to reorder — position is the 1:1 program change number · drag it onto the Library to remove the slot (v1.3) · `×` removes the slot |

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
