# Orbit UI — assignment editor (concept demo)

Live at <https://b-tice.github.io/orbit_ui/>. The current version is shown
in the page header (`APP_VERSION` in `orbit.js`) and bumps with every
feature addition.

A standalone web page that demos the Orbit pedal's Setup editor: setting
response **curves** and **zones** for the pitch and yaw axes, and (v1.15)
editing the **Ground Control** unit's Setups from a third tab.
The MIDI and Analog Out tabs are not connected to a device — they are a UI
concept for review, based on David Mash's `reference/Orbit_UI_Rough.jpeg`
and `reference/Assignment_Rough.jpeg` sketches and the email thread of
Aug–Sep 2026. The Ground Control tab speaks the unit's real bridge
protocol, against a simulated unit in the page or a real one over WiFi /
USB.

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
toggle the jack between two voltages. Each Analog axis has a **Polarity** toggle in its header: on, the
jack's output is inverted (5→0 V instead of 0→5 V) across the same curve, the
graph stays as drawn but its voltage labels flip (5.0 V at the bottom), the
readout shows the actual voltage with a ⇅ mark,
and the setting saves with the Analog Setup. The ▲ sim marker is shared (it
is the same pedal).

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
color (an 8-color palette with no red or green, for colorblind users), and
zones **may overlap** — a second CC on the same sweep is just a
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
| 🎚 **Controller** | sends a CC on the zone's transmit channel, shaped by the zone's own response curve. The curve's first and last points are the zone's **end points** and set the output range; descending end points invert the output, so there is no polarity switch. **On exit** (Hold, the default, or Reset) says what the output does when the pedal leaves the zone: keep its last value, or drop to zero. The readout shows the held or reset value while the marker is outside |
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

## The Ground Control tab (v1.15 · zone editor v1.16)

The third output tab edits the Ground Control unit's Setups. It appears
when a unit can be reached: when the page is served by the pedal over its
WiFi, or when the footer switch **simulate Ground Control** is on — that
wires the tab to a Ground Control simulated in the page (`gc/sim.js`),
which answers with the same bytes the real unit's `bridge.cpp` does and
starts with the factory Setup bank (A1–D3, from `gc_ui/src/presets.cpp`).
The simulated unit persists its bank in `localStorage` like the real one's
NVS; *reset demo* returns it to the factory bank.

**The strips are the editor (v1.16).** On this tab the YAW and PITCH
strips hold the loaded Setup's assignments: a **Controller zone drives one
effect parameter** (picked in its popover, from the unit's effect table)
over its travel range, and its curve is the sweep — the end points are the
parameter's low and high in the parameter's own units (Hz, ms, %, st), and
the value axis reads in the units of the selected (else topmost) zone. The
chip reads `EFFECT · PARAMETER`. A **Dead** zone masks a Controller under
it; two Controllers on the same parameter: the topmost sends. Note, Switch
and Freeze have no meaning on the unit and are not offered here.

Every edit is compiled and sent to the unit as you make it: per
parameter, `SET_ASSIGN` (REPLACE for the first, ADD for the rest, which
also drops what left), `SET_THRESH` (the curve's low and high) and
`SET_CURVE` (a 33-point table over the whole travel; outside the zone the
unit holds the nearer end, a Dead zone holds too). Loading a Setup goes the
other way: the unit's assignments, sweep ranges and tables become zones
(the table's moving part is the zone, its points are a simplified trace,
at most 8). The axis **save** buttons light while the unit's live state
differs from the slot and send `SAVE_PRESET`; **discard** reloads the slot.

The strips are half again as tall on this tab. PITCH sits above YAW on
every tab (the unit's own order, v1.20). Right under them sit
**Screens** (the unit's two round displays, following the ▲ markers) and
the Library / Set List; below those: **Connection** (link: simulated / WiFi
/ USB, connect, refresh setups, ping), **Active Setup** (colour, slot,
name, save / discard / delete), **Parameters** (the static value of every parameter of the
Setup's effects — tap a driven row to select its zone on the strip, which
then reads in that parameter's units, and a tap on a zone lights its row
in return; a driven row also shows the sweep the zone set as a read-only
band under its value slider with the low → high values beside it; the LED
at the left of each row is the map
toggle — lit means a zone drives it: tap a dark LED and pick PITCH or YAW
to add a zone for it, tap a lit one to take it off the pedal on both
strips; an axis left with no zone keeps its last parameter on the unit
until you add one, since the unit never runs an axis empty), **Effect Chain** (audio order; drag a row to reorder, press-and-hold on
a phone), **Firmware** (WiFi update of the
unit, DSP update mode) and **Log**.

The **Library of Setups** column is the unit's Setup bank, shown in two
columns; the loaded row lights in a see-through tint of that Setup's own
colour. Tap a row to load it (`LOAD_PRESET`), double-tap to rename it on
the unit, `×` deletes it there, **+ new** saves the live state into the
first free slot as UNTITLED. Dragging a bank row into the **Set List**
gives that slot a `gc` entry (the unit's slot id, e.g. `B3`), recalled
with the MIDI and Analog Out Setups on the same program change when a unit
is connected. The header SETUP field shows the loaded Setup's name and
renames it. Names on the unit keep their case (10 characters).

**Backup and restore.** With a Ground Control connected, **export file**
first reads every Setup off the unit (name, colour, chain, each axis's
assignments with their sweep ranges and curves, and the stored value of
every parameter) and writes them into the file under `groundControl`,
next to the MIDI and Analog Out libraries. **import file** then offers to
write those Setups back to whatever unit is connected, slot by slot,
through the ordinary edit commands and a save per slot, and reloads the
Setup you had open. Unsaved edits are not part of a backup — save first.
Curves are per parameter on the unit, so two restored Setups that drive
the same parameter end up sharing the last one's curve.

The wire vocabulary is unchanged (`LIST_PRESETS`, `LOAD_PRESET`, …); only
the words on screen say Setup. Two commands are new and exist only in the
simulator so far — they are the spec for the firmware:

| Command | Payload | Replies |
|---|---|---|
| `GET_PRESET_DUMP` 0x19 | `[L][D]` | `PRESET_INFO`, `PRESET_MASKS`, one `PRESET_VALUES` 0x94 per effect `[L][D][eff][n][f32 × n]`, one `PRESET_THRESH` 0x95 per assigned parameter `[L][D][axis][eff][par][lo f32][hi f32]`, a `PRESET_CURVE` 0x97 `[L][D][eff][par][33 × u8]` where a table is stored, then `PRESET_DUMP_END` 0x96 `[L][D]` |
| `SET_PRESET_COLOR` 0x1a | `[L][D][colorIdx]` | `PRESET_INFO`, `PRESET_MASKS` |

## Interactions

| Gesture | Effect |
|---|---|
| drag a point | move it in travel/value (end points move in value only; drag the zone's edge to move them in travel) |
| double-click / double-tap inside a Controller zone | add a curve point to the topmost Controller zone there (a single tap selects the zone and, after a short pause, opens its popover; the second tap of a double-tap cancels that) |
| select a zone | a tap on a zone or its chip selects it (dashed outline, chip border lit). **Delete** / **Backspace** removes the selected zone; **Esc** or a tap on empty travel clears the selection |
| tap a point | popover: numeric travel/value, delete (end points can't be deleted) |
| MIDI / ANALOG OUT / GROUND CONTROL tabs | switch which output you are editing (the third tab shows only when a Ground Control can be reached — see above) |
| tap a zone (or its `CH·CC` chip on MIDI) | popover: type (Controller / Note / Switch / Freeze / Dead on MIDI; Controller / Switch / Dead on Analog), range %, color, the type's settings (transmit ch + CC, note, velocity, switch action / voltages + speed, linear ↔ smooth response curve), delete |
| drag a zone's end point | resize the zone — its response curve rescales to follow |
| drag a zone's body | move the zone, curve and all |
| **+ Zone** button | adds a Controller zone over the middle third, on top, in the next color, and opens its popover so you can pick the type |
| drag the ▲ marker | simulate pedal position; readout lists every active output at the marker (`DEAD` when none). Flick it fast into a ⚡ Switch zone to toggle it |
| **save** (in each axis header) / **+ new** | save stores the current tab's Setup in its Library (updating the loaded one); + new stores it as a new Setup named UNTITLED (UNTITLED2, …) and opens its name for editing right away. The save button lights when that axis has unsaved changes (v1.2, per tab and per axis v1.9) |
| unsaved changes | loading another Setup or slot, + new, a MIDI-in program change, or reset demo first asks **Save / Discard / Cancel** when any tab's loaded Setup has been edited; Save saves every dirty tab (v1.7) |
| **RECEIVE CH** | the channel Orbit *receives* on (1–16 or OMNI) — separate from the transmit channels set per zone (v1.4, renamed v1.7) |
| Library row | tap to load into the current tab · double-click / double-tap the name to rename it (Enter or click away to keep, Esc to cancel) · `×` deletes the file after a confirmation (its slots get a fresh mirror from their other output, or are dropped if nothing is left) · drag the bar between slots to insert a new slot (the other outputs get mirrored copies), or onto a slot to replace its entry for this tab |
| Set List tools (v1.10) | the dropdown picks which Set List you are editing (shown as "NAME · bank N"); **+ new** opens a small window to name the new list and give it a Bank Select number; **edit** opens the same window for the current list, with rename, re-bank and delete (Setups stay in the Library). Caps: 16 Set Lists of 128 slots, 256 Setups per library |
| **MIDI IN · TEST** | simulate incoming MIDI: an optional BANK (Bank Select, CC 0) then a PC on the receive channel. The bank picks the Set List with that number; the PC recalls that slot (v1.4, bank v1.10) |
| **vertical pitch** (footer switch, a test) | draws the PITCH strip upright, in a tall narrow panel to the right of YAW: heel at the bottom, toe at the top, the ▲ marker moving up and down with its guide line across, the value running left → right with its labels along the bottom; chips sit in rows above the strip. Everything else (zones, points, popovers) works the same, just turned (v1.21, side by side v1.22; YAW : PITCH widths in the golden ratio and YAW grown to the same height, v1.23; the Library tucked under YAW with YAW + Library as tall as PITCH, v1.24; YAW : Library heights in the golden ratio too, the lists taking what the Library's share leaves and the MIDI-in test widget hidden in this view, v1.25; the lists show exactly three rows and PITCH's height follows from that through the golden ratio, YAW's column 7 % wider than the golden split, v1.26). The Library and Set List tools sit on their headings' row on every view (v1.26). v1.27: four rows in the lists on a computer; on a phone the upright view becomes YAW across the top with the Library and PITCH side by side under it, PITCH as tall as the Library (three rows per list, Library and Set List stacked) On a phone the panels stack again |
| **export file** / **import file** (footer) | export writes both libraries, every Set List and the receive channel to a `.json` file; import restores from such a file after a confirmation (replacing what is there) |
| long lists | the Library and Set List show about five rows and then scroll (swipe on a phone). On touch, dragging a row starts with a short press-and-hold (the row lights up); a plain swipe scrolls |
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
- `link.js` — how the page reaches a Ground Control: WebSocket (page served by the pedal), Web Serial (USB) or the simulator
- `gc.css` — the Ground Control tab's styles (on the same night tokens)
- `gc/protocol.js` — the bridge protocol: frame codec, command / reply ids, PRESET_INFO / PRESET_MASKS (port of `gc_dsp/web/src/protocol.ts` + `types.ts`)
- `gc/effects.js` — the effect / parameter table (port of `effects.ts`; wire-stable indices)
- `gc/curve.js` — the 33-point curve table helpers (port of `curve.ts`; the strips replaced its editor in v1.16)
- `gc/factory.js` — the factory Setup bank, extracted from `gc_ui/src/presets.cpp`
- `gc/sim.js` — the simulated Ground Control
- `gc/tab.js` — the tab's settings panels, link events, and the zones ⇄ frames compile / decompile (port of `main.ts`)
- `ambient.css` — vendored Ambient CSS (unmodified, attributed)
- `reference/` — David's two source sketches
