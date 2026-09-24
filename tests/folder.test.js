import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { Library } from "../electron/library.js";

const tone = (file, title, frequency) =>
  execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=0.3`,
      "-metadata",
      `title=${title}`,
      "-metadata",
      "artist=Folder Artist",
      "-y",
      file,
    ],
    { windowsHide: true },
  );

// A file is read on the second scan that sees it unchanged, so a test scan
// is two passes.
const scan = async (library) => {
  const first = await library.reconcile();
  const second = await library.reconcile();
  return { first, second };
};

test("songs put in the library folder join the library where they are", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = await new Library(root).init();
  await fs.mkdir(path.join(root, "My uploads", "Deep"), { recursive: true });
  tone(path.join(root, "Loose.flac"), "Loose song", 330);
  tone(
    path.join(root, "My uploads", "Deep", "Nested.flac"),
    "Nested song",
    440,
  );
  const { first, second } = await scan(library);
  assert.equal(first.imported, 0, "nothing is read on the first sighting");
  assert.equal(first.waiting, 2);
  assert.equal(second.imported, 2);
  const nested = library.tracks.find((t) => t.title === "Nested song");
  assert.equal(nested.file, path.join("My uploads", "Deep", "Nested.flac"));
  assert.equal(nested.album, "Deep", "the folder names the album");
  // Nothing was copied into Artists: the file is catalogued in place.
  assert.deepEqual(await fs.readdir(path.join(root, "Artists")), []);
  // The app's own folder is never read as music.
  tone(path.join(root, ".edoras", "cache", "Hidden.flac"), "Hidden", 500);
  await scan(library);
  assert.equal(library.tracks.length, 2);
});

test("a moved song keeps its place, a copy is ignored, a deleted song leaves", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = await new Library(root).init();
  tone(path.join(root, "One.flac"), "One", 330);
  tone(path.join(root, "Two.flac"), "Two", 440);
  await scan(library);
  const one = library.tracks.find((t) => t.title === "One");
  await library.favorite(one.id);

  // Moved into a folder: the same track, favourite and all.
  await fs.mkdir(path.join(root, "Sorted"));
  await fs.rename(
    path.join(root, "One.flac"),
    path.join(root, "Sorted", "One.flac"),
  );
  const moved = await scan(library);
  assert.equal(moved.first.removed, 0, "not removed while its new place waits");
  assert.equal(moved.second.moved, 1);
  const again = library.tracks.find((t) => t.id === one.id);
  assert.equal(again.file, path.join("Sorted", "One.flac"));
  assert.equal(again.favorite, true);

  // A second copy of a song already in the library is remembered and left
  // alone, rather than read on every scan.
  await fs.copyFile(
    path.join(root, "Two.flac"),
    path.join(root, "Two copy.flac"),
  );
  await scan(library);
  assert.equal(library.tracks.length, 2);
  assert.ok(library.ignored["Two copy.flac"]);

  // Deleted from the folder: gone from the library, and from the snapshot's
  // playlists without anything else being touched.
  await library.createPlaylist("Mix");
  await library.addTracksToPlaylist(library.playlists[0].id, [
    library.tracks.find((t) => t.title === "Two").id,
  ]);
  await fs.rm(path.join(root, "Two.flac"));
  await fs.rm(path.join(root, "Two copy.flac"));
  const removed = await library.reconcile();
  assert.equal(removed.removed, 1);
  assert.equal(library.tracks.length, 1);
  assert.deepEqual(library.snapshot().playlists[0].trackIds, []);
  assert.deepEqual(library.ignored, {});

  // And it all survives a restart.
  const reopened = await new Library(root).init();
  assert.equal(reopened.tracks.length, 1);
  assert.equal(reopened.tracks[0].favorite, true);
});

test("a library that mostly vanishes at once is left alone", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = await new Library(root).init();
  // Thirty catalogued songs whose files are not there, as when a drive is
  // unplugged or a sync client has not finished.
  for (let i = 0; i < 30; i++)
    library.tracks.push({
      id: String(i).padStart(64, "0"),
      title: `Song ${i}`,
      file: path.join("Elsewhere", `${i}.flac`),
    });
  const result = await library.reconcile();
  assert.equal(result.removed, 0);
  assert.equal(library.tracks.length, 30);
});

test("importing a song that is already inside the library folder does not copy it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = await new Library(root).init();
  await fs.mkdir(path.join(root, "Mine"));
  tone(path.join(root, "Mine", "Here.flac"), "Here", 550);
  const result = await library.importPaths([path.join(root, "Mine")]);
  assert.equal(result.imported, 1);
  assert.equal(library.tracks[0].file, path.join("Mine", "Here.flac"));
  assert.deepEqual(await fs.readdir(path.join(root, "Artists")), []);
});
