import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { Library } from "../electron/library.js";

// Two real files, so tracks carry the content-hash ids playlists refer to.
async function libraryWithTracks(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-playlist-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source"),
    root = path.join(temp, "library");
  await fs.mkdir(source, { recursive: true });
  for (const [name, freq] of [
    ["First song.flac", 440],
    ["Second song.flac", 523],
  ])
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freq}:duration=1`,
      "-metadata",
      `title=${name.replace(".flac", "")}`,
      "-metadata",
      "artist=Test artist",
      path.join(source, name),
    ]);
  const library = await new Library(root).init();
  await library.importPaths([source]);
  return { library, root, temp };
}

test("a playlist is created, named cleanly, and rejects empties and duplicates", async (t) => {
  const { library } = await libraryWithTracks(t);
  const snap = await library.createPlaylist("  Late   night  ");
  assert.equal(snap.playlists.length, 1);
  assert.equal(snap.playlists[0].name, "Late night", "whitespace is collapsed");
  assert.deepEqual(snap.playlists[0].trackIds, []);

  await assert.rejects(() => library.createPlaylist("   "), /needs a name/);
  await assert.rejects(
    () => library.createPlaylist("late NIGHT"),
    /already have/,
  );
});

test("tracks are added and removed, and adding twice does not duplicate", async (t) => {
  const { library } = await libraryWithTracks(t);
  const [a, b] = library.tracks.map((track) => track.id);
  const {
    playlists: [made],
  } = await library.createPlaylist("Driving");

  await library.addToPlaylist(made.id, a);
  await library.addToPlaylist(made.id, b);
  let snap = await library.addToPlaylist(made.id, a);
  assert.deepEqual(snap.playlists[0].trackIds, [a, b], "no duplicate entry");

  snap = await library.removeFromPlaylist(made.id, a);
  assert.deepEqual(snap.playlists[0].trackIds, [b]);
});

test("playlists survive a restart", async (t) => {
  const { library, root } = await libraryWithTracks(t);
  const id = library.tracks[0].id;
  const {
    playlists: [made],
  } = await library.createPlaylist("Sunday morning");
  await library.addToPlaylist(made.id, id);

  const reopened = await new Library(root).init();
  const snap = reopened.snapshot();
  assert.equal(snap.playlists.length, 1);
  assert.equal(snap.playlists[0].name, "Sunday morning");
  assert.deepEqual(snap.playlists[0].trackIds, [id]);
});

test("deleting a playlist leaves every track in the library", async (t) => {
  const { library } = await libraryWithTracks(t);
  const before = library.tracks.length;
  const {
    playlists: [made],
  } = await library.createPlaylist("Temporary");
  await library.addToPlaylist(made.id, library.tracks[0].id);

  const snap = await library.deletePlaylist(made.id);
  assert.deepEqual(snap.playlists, []);
  assert.equal(snap.tracks.length, before, "songs are untouched");
  await assert.rejects(() => library.deletePlaylist(made.id), /not found/);
});

test("a playlist never reports a track the library no longer has", async (t) => {
  const { library } = await libraryWithTracks(t);
  const [a, b] = library.tracks.map((track) => track.id);
  const {
    playlists: [made],
  } = await library.createPlaylist("Mixed");
  await library.addToPlaylist(made.id, a);
  await library.addToPlaylist(made.id, b);

  // Simulate a track disappearing from the catalog underneath the playlist.
  library.tracks = library.tracks.filter((track) => track.id !== a);
  assert.deepEqual(library.snapshot().playlists[0].trackIds, [b]);
});

test("a playlist cannot hold a track that is not in the library", async (t) => {
  const { library } = await libraryWithTracks(t);
  const {
    playlists: [made],
  } = await library.createPlaylist("Nope");
  await assert.rejects(
    () => library.addToPlaylist(made.id, "not-a-real-track-id"),
    /Track not found/,
  );
});

test("renaming applies the same rules as creating", async (t) => {
  const { library } = await libraryWithTracks(t);
  const {
    playlists: [one],
  } = await library.createPlaylist("One");
  await library.createPlaylist("Two");
  const snap = await library.renamePlaylist(one.id, "  Renamed  ");
  assert.equal(snap.playlists.find((p) => p.id === one.id).name, "Renamed");
  await assert.rejects(
    () => library.renamePlaylist(one.id, "two"),
    /already have/,
  );
  await assert.rejects(
    () => library.renamePlaylist(one.id, ""),
    /needs a name/,
  );
});

test("bulk additions are validated atomically and reordered songs survive restart", async (t) => {
  const { library, root } = await libraryWithTracks(t);
  const [a, b] = library.tracks.map((track) => track.id);
  const {
    playlists: [made],
  } = await library.createPlaylist("A set");
  await assert.rejects(
    () => library.addTracksToPlaylist(made.id, [a, "missing"]),
    /Invalid/,
  );
  assert.deepEqual(library.snapshot().playlists[0].trackIds, []);
  await library.addTracksToPlaylist(made.id, [a, b, a]);
  assert.deepEqual(library.snapshot().playlists[0].trackIds, [a, b]);
  await library.movePlaylistTrack(made.id, b, -1);
  await library.movePlaylistTrack(made.id, b, -1);
  assert.deepEqual(library.snapshot().playlists[0].trackIds, [b, a]);
  await assert.rejects(
    () => library.movePlaylistTrack(made.id, b, 100),
    /Invalid/,
  );
  const reopened = await new Library(root).init();
  assert.deepEqual(reopened.snapshot().playlists[0].trackIds, [b, a]);
});
