import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { Library, artistKey } from "../electron/library.js";

const png = (bytes) => ({ type: "image/png", bytes: Buffer.from(bytes) });

// A real MP3 with its own tags and an embedded red cover, imported into a
// disposable library.
async function taggedLibrary(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-details-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source"),
    root = path.join(temp, "library");
  await fs.mkdir(source, { recursive: true });
  const cover = path.join(temp, "cover.png");
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32",
    "-frames:v",
    "1",
    cover,
  ]);
  execFileSync(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-i",
    cover,
    "-map",
    "0",
    "-map",
    "1",
    "-c:a",
    "libmp3lame",
    "-c:v",
    "png",
    "-id3v2_version",
    "3",
    "-disposition:v",
    "attached_pic",
    "-metadata",
    "title=Lost and Found",
    "-metadata",
    "artist=Camel",
    "-metadata",
    "album=Rajaz",
    "-metadata",
    "date=1999",
    "-metadata",
    "genre=Rock",
    path.join(source, "Lost and Found.mp3"),
  ]);
  const library = await new Library(root).init();
  await library.importPaths([source]);
  return { library, root, id: library.tracks[0].id };
}
const coverBytes = async (root, library, id) =>
  fs.readFile(
    path.join(root, library.tracks.find((t) => t.id === id).coverFile),
  );

test("a fetch replaces every detail, the cover and the lyrics of the fetch before it", async (t) => {
  const { library, root, id } = await taggedLibrary(t);
  const embedded = await coverBytes(root, library, id);
  // The wrong match, applied by mistake.
  await library.applyIdentity(id, {
    title: "Lost and Found",
    artist: "Someone Else",
    albumArtist: "Someone Else",
    album: "Wrong Album",
    year: 1985,
    genre: "Pop",
    source: "Deezer",
    artwork: png([1, 2, 3]),
    artistImage: png([9, 9]),
    lyrics: "Wrong words",
  });
  let track = library.tracks[0];
  assert.equal(track.album, "Wrong Album");
  assert.deepEqual([...(await coverBytes(root, library, id))], [1, 2, 3]);
  assert.ok(library.artists[artistKey("Someone Else")]?.file);
  const wrongCover = path.join(root, track.coverFile);
  // The right one. It has no album, year or genre of its own, so those go
  // back to what the file says rather than keeping the wrong match's.
  await library.applyIdentity(id, {
    title: "Lost and Found",
    artist: "Camel",
    source: "Shazam · audio match",
    artwork: png([4, 5, 6]),
    lyrics: "Right words",
  });
  track = library.tracks[0];
  assert.equal(track.artist, "Camel");
  assert.equal(track.album, "Rajaz");
  assert.equal(track.year, 1999);
  assert.equal(track.genre, "Rock");
  assert.equal(track.lyrics, "Right words");
  assert.equal(track.metadataSource, "Shazam · audio match");
  assert.deepEqual([...(await coverBytes(root, library, id))], [4, 5, 6]);
  await assert.rejects(fs.access(wrongCover), "the old cover file is gone");
  assert.equal(
    library.artists[artistKey("Someone Else")],
    undefined,
    "the wrong artist's photo goes once no song names them",
  );
  // A fetch that finds no cover puts the file's own back, not the last one.
  await library.applyIdentity(id, { title: "Lost and Found", source: "X" });
  assert.deepEqual(await coverBytes(root, library, id), embedded);
  assert.equal(library.tracks[0].lyrics, "", "fetched words do not linger");
});

test("fetched details can be removed, back to the file's own", async (t) => {
  const { library, root, id } = await taggedLibrary(t);
  const embedded = await coverBytes(root, library, id);
  await library.applyIdentity(id, {
    title: "Wrong",
    artist: "Wrong",
    album: "Wrong",
    source: "Deezer",
    artwork: png([7]),
    lyrics: "Fetched",
  });
  await library.setLyrics(id, "Typed by hand");
  const restored = await library.restoreOriginal(id);
  const track = library.tracks[0];
  assert.equal(track.title, "Lost and Found");
  assert.equal(track.artist, "Camel");
  assert.equal(track.album, "Rajaz");
  assert.equal(track.metadataFetchedAt, undefined);
  assert.equal(track.metadataSource, undefined);
  assert.equal(track.lyrics, "Typed by hand", "words the user typed stay");
  assert.deepEqual(await coverBytes(root, library, id), embedded);
  assert.match(restored.tracks[0].cover, /^edoras:\/\/app\/media\/cover\//);
});

test("deleting a song discards its file and everything saved about it", async (t) => {
  const { library, root, id } = await taggedLibrary(t);
  await library.applyIdentity(id, {
    title: "Lost and Found",
    artist: "Camel",
    source: "Deezer",
    artwork: png([1]),
    artistImage: png([2]),
  });
  await library.createPlaylist("Mix");
  const playlist = library.playlists[0].id;
  await library.addToPlaylist(playlist, id);
  const track = library.tracks[0];
  const file = path.join(root, track.file);
  const cover = path.join(root, track.coverFile);
  const photo = path.join(root, library.artists[artistKey("Camel")].file);
  await fs.writeFile(path.join(root, ".edoras/cache", `${id}.wav`), "x");
  const discarded = [];
  const snapshot = await library.removeTrack(id, async (target) => {
    discarded.push(target);
    await fs.rm(target);
  });
  assert.deepEqual(discarded, [file]);
  assert.equal(snapshot.tracks.length, 0);
  assert.deepEqual(library.playlists[0].trackIds, []);
  for (const gone of [
    cover,
    photo,
    path.join(root, ".edoras/cache", `${id}.wav`),
  ])
    await assert.rejects(fs.access(gone));
  assert.deepEqual(snapshot.artists, {});
  // And it stays deleted after a restart and a folder scan.
  const again = await new Library(root).init();
  await again.reconcile();
  assert.equal(again.tracks.length, 0);
});

test("a delete that cannot discard the file changes nothing", async (t) => {
  const { library, root, id } = await taggedLibrary(t);
  await assert.rejects(
    library.removeTrack(id, async () => {
      throw new Error("Recycle Bin unavailable");
    }),
    /Recycle Bin unavailable/,
  );
  assert.equal(library.tracks.length, 1);
  await fs.access(path.join(root, library.tracks[0].file));
});
