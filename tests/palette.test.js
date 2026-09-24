import test from "node:test";
import assert from "node:assert/strict";
import {
  rgbToLch,
  build,
  accentFromHash,
  textOnAccent,
} from "../src/palette.ts";

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
// Representative cover colours, including the two the reference screenshots use.
const samples = {
  gold: [184, 160, 56],
  blue: [74, 111, 165],
  green: [72, 140, 92],
  purple: [124, 86, 168],
  rose: [198, 96, 118],
  nearBlack: [12, 12, 14],
  nearWhite: [246, 246, 244],
};

test("accent lightness is clamped into the readable band", () => {
  for (const [name, rgb] of Object.entries(samples)) {
    const { l } = rgbToLch(...hexToRgb(build(rgbToLch(...rgb)).art));
    assert.ok(
      l >= 0.45 && l <= 0.61,
      `${name} resolved to lightness ${l.toFixed(3)}, outside the band`,
    );
  }
});

test("accent chroma never exceeds the cap", () => {
  for (const [name, rgb] of Object.entries(samples)) {
    const { c } = rgbToLch(...hexToRgb(build(rgbToLch(...rgb)).art));
    assert.ok(c <= 0.16, `${name} resolved to chroma ${c.toFixed(3)}`);
  }
});

test("the dark-mode variant is lighter than the light-mode one", () => {
  for (const [name, rgb] of Object.entries(samples)) {
    const accent = build(rgbToLch(...rgb));
    const light = rgbToLch(...hexToRgb(accent.art)).l;
    const lifted = rgbToLch(...hexToRgb(accent.lift)).l;
    assert.ok(lifted > light, `${name} lift ${lifted} not above ${light}`);
  }
});

test("hue survives the clamp, so tracks stay distinguishable", () => {
  const hue = (rgb) => rgbToLch(...hexToRgb(build(rgbToLch(...rgb)).art)).h;
  const gold = hue(samples.gold);
  const blue = hue(samples.blue);
  const source = (rgb) => rgbToLch(...rgb).h;
  assert.ok(
    Math.abs(gold - source(samples.gold)) < 0.02,
    "gold hue drifted through the clamp",
  );
  assert.ok(
    Math.abs(blue - source(samples.blue)) < 0.02,
    "blue hue drifted through the clamp",
  );
  assert.ok(Math.abs(gold - blue) > 1, "gold and blue collapsed together");
});

test("every accent is a valid opaque hex colour", () => {
  for (const seed of [0, 1, 97, 1234, 65535]) {
    const accent = accentFromHash(seed);
    assert.match(accent.art, /^#[0-9a-f]{6}$/);
    assert.match(accent.lift, /^#[0-9a-f]{6}$/);
    assert.match(accent.wash, /^#[0-9a-f]{8}$/);
    assert.match(accent.glow, /^#[0-9a-f]{8}$/);
  }
});

test("button text meets 4.5:1 contrast for both artwork accent variants", () => {
  for (const rgb of Object.values(samples)) {
    const palette = build(rgbToLch(...rgb));
    for (const hex of [palette.art, palette.lift]) {
      const linear = hexToRgb(hex).map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      const l = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      const ratio =
        textOnAccent(hex) === "#ffffff" ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
      assert.ok(ratio >= 4.5, `${hex}: ${ratio}`);
    }
  }
});
