import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

// The studies used to ship as raw 22 kHz WAV: 1.01 MB each, 5.1 MB of the
// 5.4 MB bundle, for twenty-four seconds of sine tones. They are encoded to
// MP3 here instead, which is the same sound at a twenty-fifth of the size and
// is decoded natively by Chromium, so nothing at runtime changed but the
// download. FFmpeg is only needed to regenerate them; the committed files are
// what ships.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-demo-"));
await fs.mkdir("public/demo", { recursive: true });
const studies = [
  ["golden", 196, "#d7b679", "#8e6948", "GOLDEN HOUR", 0],
  ["blue", 220, "#245bc1", "#aad4e2", "BLUE INTO BLUE", 1],
  ["green", 174, "#dbe1bb", "#647a65", "STILL, SOMEWHERE", 2],
  ["rose", 261, "#e9aeaa", "#922f3b", "A LITTLE CLOSER", 3],
  ["purple", 146, "#bbb0d0", "#62658f", "AFTER THE RAIN", 4],
];
for (const [color, base, light, dark, title, index] of studies) {
  const sampleRate = 22050,
    seconds = 24,
    length = sampleRate * seconds,
    data = Buffer.alloc(44 + length * 2);
  data.write("RIFF");
  data.writeUInt32LE(36 + length * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(length * 2, 40);
  const notes = [1, 1.25, 1.5, 2, 1.5, 1.25, 1.125, 1.5];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate,
      beat = Math.floor(t / 0.75),
      phase = t % 0.75;
    const f = base * notes[(beat + index) % notes.length];
    const envelope = (1 - Math.exp(-phase * 60)) * Math.exp(-phase * 4);
    const key =
      (Math.sin(2 * Math.PI * f * t) +
        0.2 * Math.sin(2 * Math.PI * f * 2 * t) +
        0.08 * Math.sin(2 * Math.PI * f * 3 * t)) *
      envelope;
    const pad =
      (Math.sin(2 * Math.PI * base * 0.5 * t) +
        Math.sin(2 * Math.PI * base * 0.75 * t)) *
      0.14;
    const fade = Math.min(1, t / 2, (seconds - t) / 3);
    data.writeInt16LE(
      Math.round((key * 0.23 + pad) * fade * 24000),
      44 + i * 2,
    );
  }
  const raw = path.join(temp, `${color}.wav`);
  await fs.writeFile(raw, data);
  execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      raw,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-y",
      `public/demo/${color}.mp3`,
    ],
    { windowsHide: true },
  );
  await fs.rm(raw, { force: true });
  const art =
    index === 0
      ? `<circle cx="280" cy="145" r="140" fill="#ffe3a0"/><path d="M-30 390Q140 140 430 260V450H-30" fill="#8c8962"/><path d="M-30 410Q180 190 450 310V450H-30" fill="#c2a674"/>`
      : index === 1
        ? `<ellipse cx="207" cy="210" rx="107" ry="170" fill="#d7ded9" transform="rotate(-25 200 200)"/><ellipse cx="225" cy="197" rx="64" ry="129" fill="#284c99" transform="rotate(-25 200 200)"/><path d="M199 50L159 365" stroke="#0b317c" stroke-width="18"/>`
        : index === 2
          ? `<circle cx="206" cy="172" r="108" fill="#f3edcf"/><path d="M0 335Q90 118 240 279T440 189V430H0" fill="#6d8a76"/><path d="M0 380Q150 220 320 313T450 280V430H0" fill="#3e6559"/>`
          : index === 3
            ? `<path d="M201 309C-13 185 129 51 201 153C276 51 418 186 201 309Z" fill="#872b39"/><path d="M195 295C32 186 134 84 195 169" stroke="#f2c1ba" fill="none" stroke-width="3"/>`
            : `<circle cx="201" cy="181" r="128" fill="#d7d0e0"/><path d="M0 248H400M0 263H400M0 282H400M0 306H400M0 335H400M0 372H400" stroke="#6d719b" stroke-width="9"/><circle cx="201" cy="182" r="66" fill="#8985ae" opacity=".6"/>`;
  await fs.writeFile(
    `public/demo/${color}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient><filter id="grain"><feTurbulence baseFrequency=".7" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".12"/></feComponentTransfer><feBlend in="SourceGraphic" mode="soft-light"/></filter></defs><g filter="url(#grain)"><rect width="400" height="400" fill="url(#bg)"/>${art}</g><text x="22" y="370" font-family="sans-serif" font-size="9" letter-spacing="3" fill="#ffffffb0">${title}</text><text x="22" y="388" font-family="sans-serif" font-size="5" letter-spacing="2" fill="#ffffff90">EDORAS SESSIONS / 0${index + 1}</text></svg>`,
  );
}
await fs.rm(temp, { recursive: true, force: true });
console.log(
  "Generated five original, offline sound studies and cover illustrations.",
);
