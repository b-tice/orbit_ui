/* Effect / parameter reference — a plain-JS port of gc_dsp/web/src/effects.ts.
   Mirrors gc_ui menu.cpp's effects[] table. Wire-stable: indices and order
   must match firmware. Exposed as window.GCFX. */

'use strict';

(function () {
const EFFECTS = [
  { id: 0, name: 'Shimmer Reverb', params: [
    { name: 'Mix',       unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Feedback',  unit: '',   defaultVal: 0.92,   min: 0,    max: 0.99,  step: 0.01, decimals: 2 },
    { name: 'LP Freq',   unit: 'Hz', defaultVal: 14000,  min: 1000, max: 20000, step: 100,  decimals: 0 },
    { name: 'Shim HP',   unit: 'Hz', defaultVal: 2000,   min: 200,  max: 8000,  step: 50,   decimals: 0 },
    { name: 'Shim Res',  unit: '',   defaultVal: 0.3,    min: 0,    max: 2,     step: 0.01, decimals: 2 },
    { name: 'Shim Gain', unit: '',   defaultVal: 0.3,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 1, name: 'Vox Wah', params: [
    { name: 'Sweep',     unit: 'Hz', defaultVal: 1000,   min: 350,  max: 2200,  step: 10,   decimals: 0 },
    { name: 'Resonance', unit: '',   defaultVal: 0.87,   min: 0.1,  max: 2.0,   step: 0.01, decimals: 2 },
    { name: 'Blend',     unit: '%',  defaultVal: 70,     min: 0,    max: 100,   step: 1,    decimals: 0 },
  ]},
  { id: 2, name: 'Pong Delay', params: [
    { name: 'Time',      unit: 'ms', defaultVal: 350,    min: 100,  max: 600,   step: 5,    decimals: 0 },
    { name: 'Feedback',  unit: '',   defaultVal: 0.45,   min: 0,    max: 0.95,  step: 0.01, decimals: 2 },
    { name: 'Mix',       unit: '',   defaultVal: 0.4,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Tone',      unit: 'Hz', defaultVal: 3000,   min: 200,  max: 8000,  step: 50,   decimals: 0 },
  ]},
  { id: 3, name: 'Big Muff', params: [
    { name: 'Mix',       unit: '%',  defaultVal: 15,     min: 0,    max: 30,    step: 0.5,  decimals: 1 },
    { name: 'Drive',     unit: '',   defaultVal: 0.85,   min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Tone',      unit: 'Hz', defaultVal: 800,    min: 200,  max: 5000,  step: 50,   decimals: 0 },
  ]},
  { id: 4, name: 'Whammy', params: [
    { name: 'Semitones', unit: 'st', defaultVal: 0,      min: -12,  max: 12,    step: 1,    decimals: 0 },
  ]},
  { id: 5, name: 'Chorus', params: [
    { name: 'Depth',     unit: '',   defaultVal: 0.5,    min: 0.1,  max: 0.9,   step: 0.05, decimals: 2 },
    { name: 'Rate',      unit: 'Hz', defaultVal: 1.0,    min: 0.2,  max: 3.0,   step: 0.1,  decimals: 1 },
    { name: 'Feedback',  unit: '',   defaultVal: 0.2,    min: 0,    max: 0.95,  step: 0.01, decimals: 2 },
  ]},
  { id: 6, name: 'Fuzz Face', params: [
    { name: 'Fuzz',      unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Volume',    unit: '',   defaultVal: 0.7,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Tone',      unit: 'Hz', defaultVal: 4000,   min: 500,  max: 8000,  step: 100,  decimals: 0 },
    { name: 'Bias',      unit: '',   defaultVal: 0,      min: -0.3, max: 0.3,   step: 0.01, decimals: 2 },
    { name: 'Sag',       unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 7, name: 'Octavia', params: [
    { name: 'Drive',     unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Tone',      unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Mix',       unit: '',   defaultVal: 1.0,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Volume',    unit: '',   defaultVal: 0.7,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 8, name: 'Carbon Copy', params: [
    { name: 'Time',      unit: 'ms', defaultVal: 300,    min: 50,   max: 650,   step: 5,    decimals: 0 },
    { name: 'Feedback',  unit: '',   defaultVal: 0.4,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Mix',       unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Tone',      unit: '',   defaultVal: 0.4,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Mod Rate',  unit: 'Hz', defaultVal: 0,      min: 0,    max: 2,     step: 0.05, decimals: 2 },
    { name: 'Mod Depth', unit: '',   defaultVal: 0,      min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 9, name: 'Hall', params: [
    { name: 'Mix',       unit: '',   defaultVal: 0.35,   min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Size',      unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Damping',   unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'PreDelay',  unit: '',   defaultVal: 0.25,   min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Mod Depth', unit: '',   defaultVal: 0,      min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 10, name: 'Flange', params: [
    { name: 'Mix',       unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Rate',      unit: '',   defaultVal: 0.3,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Depth',     unit: '',   defaultVal: 0.6,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Feedback',  unit: '',   defaultVal: 0.5,    min: -0.92, max: 0.92, step: 0.01, decimals: 2 },
    { name: 'Center',    unit: '',   defaultVal: 0.4,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 11, name: 'Tube Screamer', params: [
    { name: 'Drive',     unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Tone',      unit: '',   defaultVal: 0.6,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Level',     unit: '',   defaultVal: 0.7,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 12, name: 'Tremolo', params: [
    { name: 'Rate',      unit: 'Hz', defaultVal: 5.0,    min: 0.1,  max: 20,    step: 0.1,  decimals: 1 },
    { name: 'Depth',     unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
    { name: 'Shape',     unit: '',   defaultVal: 0,      min: 0,    max: 2,     step: 1,    decimals: 0 },
  ]},
  { id: 13, name: 'Ring Mod', params: [
    { name: 'Freq',      unit: 'Hz', defaultVal: 220,    min: 20,   max: 4000,  step: 1,    decimals: 0 },
    { name: 'Mix',       unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  { id: 14, name: 'Harmonizer', params: [
    { name: 'Interval',  unit: 'st', defaultVal: 7,      min: -12,  max: 12,    step: 1,    decimals: 0 },
    { name: 'Mix',       unit: '',   defaultVal: 0.5,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
  // Volume: pure output gain at the end of the Daisy chain. Level 1.0 = unity.
  { id: 15, name: 'Volume', params: [
    { name: 'Level',     unit: '',   defaultVal: 1.0,    min: 0,    max: 1,     step: 0.01, decimals: 2 },
  ]},
];

function formatValue(p, v) {
  const s = v.toFixed(p.decimals);
  return p.unit ? `${s} ${p.unit}` : s;
}

window.GCFX = { EFFECTS, formatValue };
})();
