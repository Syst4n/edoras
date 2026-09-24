// Derives a per-track accent colour from its cover artwork.
//
// A cover is mostly background, so the most *common* colour is usually a dull
// wash. We weight each sample by how colourful it is, which is what makes a
// gold record read gold and a blue one read blue. The winner is then clamped
// in OKLab, where lightness and chroma are perceptually even, so every track
// lands in a band that stays legible against the page and against dark mode.

const LIGHT_MIN = 0.46;
const LIGHT_MAX = 0.6;
const CHROMA_MAX = 0.15;
const DARK_LIGHT_MIN = 0.62;
const DARK_LIGHT_MAX = 0.78;

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export interface Lch {
  l: number;
  c: number;
  h: number;
}

export function rgbToLch(r: number, g: number, b: number): Lch {
  const lr = toLinear(r / 255),
    lg = toLinear(g / 255),
    lb = toLinear(b / 255);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: okL,
    c: Math.hypot(okA, okB),
    h: Math.atan2(okB, okA),
  };
}

export function lchToHex({ l, c, h }: Lch) {
  const a = Math.cos(h) * c,
    b = Math.sin(h) * c;
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((v) =>
    Math.round(clamp(toGamma(clamp(v, 0, 1)), 0, 1) * 255)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${rgb.join("")}`;
}

// Bucket to 4 bits per channel so near-identical pixels group together,
// then score each bucket by population weighted towards colourful samples.
function dominant(data: Uint8ClampedArray): Lch | null {
  const buckets = new Map<number, { score: number; lch: Lch; n: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    const r = data[i]!,
      g = data[i + 1]!,
      b = data[i + 2]!;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    // Skip near-black, near-white and greys: they carry no hue to borrow.
    if (max < 26 || min > 235 || max - min < 18) continue;
    const lch = rgbToLch(r, g, b);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const entry = buckets.get(key) ?? { score: 0, lch, n: 0 };
    // Chroma weighting is what stops a large muted area outvoting the
    // saturated detail a listener actually reads as "the colour of this song".
    entry.score += 1 + lch.c * 12;
    entry.n += 1;
    buckets.set(key, entry);
  }
  let best: { score: number; lch: Lch; n: number } | null = null;
  for (const entry of buckets.values())
    if (!best || entry.score > best.score) best = entry;
  return best && best.n >= 4 ? best.lch : null;
}

function readPixels(image: HTMLImageElement) {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, size, size);
  try {
    return ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // tainted canvas; fall back to the hashed hue
  }
}

function load(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export interface Accent {
  art: string;
  lift: string;
  wash: string;
  glow: string;
}

export function build(lch: Lch): Accent {
  const c = Math.min(lch.c, CHROMA_MAX);
  const art = lchToHex({
    l: clamp(lch.l, LIGHT_MIN, LIGHT_MAX),
    c,
    h: lch.h,
  });
  // Dark mode needs the same hue carried higher up the lightness scale,
  // otherwise the accent disappears into the surface behind it.
  const lift = lchToHex({
    l: clamp(lch.l, DARK_LIGHT_MIN, DARK_LIGHT_MAX),
    c: Math.min(c, 0.13),
    h: lch.h,
  });
  return { art, lift, wash: `${art}24`, glow: `${art}3d` };
}

// Deterministic stand-in for tracks with no usable artwork, so a coverless
// track still gets a stable colour of its own rather than a grey default.
export function accentFromHash(hash: number): Accent {
  const h = ((hash % 360) / 180) * Math.PI;
  return build({ l: 0.53, c: 0.11, h });
}

export async function accentFromArtwork(
  src: string,
  fallback: number,
): Promise<Accent> {
  const image = await load(src);
  if (!image) return accentFromHash(fallback);
  const pixels = readPixels(image);
  const lch = pixels && dominant(pixels);
  return lch ? build(lch) : accentFromHash(fallback);
}

// Both variants are published, and the stylesheet picks between them per
// theme. Setting --art directly would defeat that: an inline custom property
// on the root element outranks any [data-theme] rule that tries to override
// it, so a dark theme could never lighten the accent.
export function applyAccent(accent: Accent) {
  const root = document.documentElement.style;
  root.setProperty("--art-light", accent.art);
  root.setProperty("--art-dark", accent.lift);
  root.setProperty("--art-wash-light", accent.wash);
  root.setProperty("--art-wash-dark", `${accent.lift}2e`);
  root.setProperty("--art-glow-light", accent.glow);
  root.setProperty("--art-glow-dark", `${accent.lift}47`);
  root.setProperty("--on-art-light", textOnAccent(accent.art));
  root.setProperty("--on-art-dark", textOnAccent(accent.lift));
}

export function textOnAccent(hex: string) {
  const linear = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const lightness =
    0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return lightness > 0.179 ? "#000000" : "#ffffff";
}
