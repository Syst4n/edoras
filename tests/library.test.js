import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import {
  Library,
  safeName,
  inside,
  audioPathsFrom,
} from "../electron/library.js";

test("Windows-safe names preserve Arabic and cannot escape the library", () => {
  assert.equal(safeName("فيروز"), "فيروز");
  for (const name of [
    "../outside",
    "C:\\Windows",
    "CON",
    "NUL.mp3",
    "hello:",
    "..",
    "a/b",
  ]) {
    const safe = safeName(name);
    assert.ok(!/[<>:"/\\|?*]/.test(safe));
    assert.ok(!/^(con|nul)(?:\.|$)/i.test(safe));
    assert.ok(inside(path.resolve("library"), path.resolve("library", safe)));
  }
  assert.equal(inside("C:/music", "C:/music-other/file.mp3"), false);
});

test("imports organize by embedded album artist, deduplicate, retain originals and survive restart", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-library-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source"),
    root = path.join(temp, "library");
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  const file = path.join(source, "nested", "original.flac");
  execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.3",
      "-metadata",
      "title=أغنية / One",
      "-metadata",
      "artist=Singer",
      "-metadata",
      "album_artist=Various Artists",
      "-metadata",
      "album=Album:One",
      "-metadata",
      "track=2",
      "-metadata",
      "date=2026",
      "-y",
      file,
    ],
    { windowsHide: true },
  );
  const original = await fs.readFile(file);
  const lib = await new Library(root).init();
  const result = await lib.importPaths([source]);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 0);
  const track = lib.tracks[0];
  assert.equal(track.artist, "Singer");
  assert.equal(track.albumArtist, "Various Artists");
  assert.equal(track.title, "أغنية / One");
  assert.equal(track.number, 2);
  assert.ok(
    track.file.startsWith(path.join("Artists", "Various Artists", "Album_One")),
  );
  assert.deepEqual(await fs.readFile(lib.resolve(track.id)), original);
  assert.deepEqual(await fs.readFile(file), original);
  const duplicate = await lib.importPaths([source]);
  assert.equal(duplicate.imported, 0);
  assert.equal(duplicate.duplicates, 1);
  await lib.favorite(track.id);
  const reloaded = await new Library(root).init();
  assert.equal(reloaded.tracks.length, 1);
  assert.equal(reloaded.tracks[0].favorite, true);
  assert.throws(() => reloaded.resolve("../outside"));
  const ownFolder = await reloaded.importPaths([root]);
  assert.equal(ownFolder.imported, 0);
});

test("simultaneous imports serialize, corrupt audio is reported and same-title songs never overwrite", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-edge-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const files = [];
  for (const freq of [440, 550]) {
    const file = path.join(temp, `${freq}.mp3`);
    execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${freq}:duration=0.2`,
        "-metadata",
        "title=Same",
        "-metadata",
        "album=Same",
        "-metadata",
        "artist=Same",
        "-y",
        file,
      ],
      { windowsHide: true },
    );
    files.push(file);
  }
  const corrupt = path.join(temp, "broken.mp3");
  await fs.writeFile(corrupt, "not audio");
  const lib = await new Library(path.join(temp, "library")).init();
  const [a, b] = await Promise.all([
    lib.importPaths([...files, corrupt]),
    lib.importPaths(files),
  ]);
  assert.equal(a.imported, 2);
  assert.equal(a.errors.length, 1);
  assert.equal(b.duplicates, 2);
  assert.equal(lib.tracks.length, 2);
  assert.notEqual(lib.tracks[0].file, lib.tracks[1].file);
  const data = JSON.parse(await fs.readFile(lib.index, "utf8"));
  assert.equal(data.tracks.length, 2);
});

test("a corrupt library index fails visibly without overwriting the existing index", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-corrupt-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.mkdir(path.join(temp, ".edoras"));
  const index = path.join(temp, ".edoras/library.json");
  await fs.writeFile(index, "broken index");
  await assert.rejects(new Library(temp).init(), /Cannot read library index/);
  assert.equal(await fs.readFile(index, "utf8"), "broken index");
});

// Windows "Open with" arrives as a command line, and a command line is not a
// list of files. Anything that is not audio has to fall out before the main
// process goes anywhere near the disk with it.
test("a launch command line is reduced to the audio files in it", () => {
  const argv = [
    "C:\\Program Files\\Edoras\\Edoras.exe",
    "--no-sandbox",
    "--user-data-dir=C:\\temp",
    ".",
    "C:\\Music\\A song.mp3",
    "C:\\Docs\\notes.txt",
    "C:\\Music\\Another.FLAC",
    "",
    42,
    null,
  ];
  const paths = audioPathsFrom(argv);
  assert.equal(paths.length, 2);
  assert.ok(paths[0].endsWith("A song.mp3"));
  assert.ok(paths[1].toLowerCase().endsWith("another.flac"));
  // The executable's own path is never one of them, whatever it is called.
  assert.ok(!paths.some((p) => p.endsWith(".exe")));
  // Every listed format is recognised, and nothing else is.
  assert.deepEqual(audioPathsFrom(["edoras", "song.m4a"]), [
    path.resolve("song.m4a"),
  ]);
  assert.deepEqual(audioPathsFrom(["edoras", "cover.jpg", "list.m3u"]), []);
  assert.deepEqual(audioPathsFrom([]), []);
  assert.deepEqual(audioPathsFrom(undefined), []);
});
