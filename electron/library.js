import fs from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseFile } from "music-metadata";

export const extensions = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".wave",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".aiff",
  ".aif",
  ".wma",
  ".alac",
  ".ape",
  ".wv",
  ".mp4",
  ".mka",
]);
// "Open with" on Windows hands the file over as a command-line argument: on
// the first launch in the process's own argv, and on every launch after that
// through second-instance, because the single-instance lock sends the new
// process's argv to the running app instead of opening a second window. The
// list that arrives is a whole command line, so it is filtered down to the
// part of it that is audio: Chromium's own switches, the "." that
// `npm start` passes and anything that is not a format the library reads all
// drop out. Whether the file is really there is checked separately, by the
// side that can look.
export function audioPathsFrom(argv) {
  return (argv || [])
    .slice(1)
    .filter(
      (value) =>
        typeof value === "string" &&
        !value.startsWith("-") &&
        extensions.has(path.extname(value).toLowerCase()),
    )
    .map((value) => path.resolve(value));
}
export function safeName(value, fallback = "Unknown") {
  let result = String(value || fallback)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 90);
  if (!result || /^\.+$/.test(result)) result = fallback;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(result))
    result = `_${result}`;
  return result;
}
export function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const imageExtension = (type) =>
  type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
// A song as the file itself describes it: its tags, or the file and folder
// names where the tags are silent. Read on import, and read again whenever
// fetched details are replaced or removed, so nothing an earlier fetch wrote
// can survive into the next one.
export function fileDetails(root, file, common) {
  const folder = path.dirname(file);
  const folderName =
    path.resolve(folder) === path.resolve(root) ||
    path.basename(folder) === "Inbox"
      ? ""
      : path.basename(folder);
  const title =
    common.title ||
    path
      .basename(file, path.extname(file))
      .replace(/^\d+[ ._-]+/, "")
      // The short id an imported copy carries in its name.
      .replace(/\s*\[[a-f\d]{10}\]$/i, "");
  const artist = common.artist || "Unknown artist";
  const rawLyrics = common.lyrics?.[0];
  const picture = common.picture?.find(
    (p) =>
      /^image\/(jpeg|png|webp)$/.test(p.format) &&
      p.data.length < 20 * 1024 * 1024,
  );
  return {
    title,
    artist,
    albumArtist: common.albumartist || artist,
    album: common.album || folderName || "Unknown album",
    number: common.track?.no || 0,
    disc: common.disk?.no || 1,
    year: common.year || null,
    genre: common.genre?.[0] || "",
    lyrics: typeof rawLyrics === "string" ? rawLyrics : rawLyrics?.text || "",
    picture: picture ? { type: picture.format, bytes: picture.data } : null,
  };
}
// Artist photos are stored per artist, not per track, so they need a key of
// their own. The same 64-hex shape as a track id keeps the media protocol's
// single validation rule honest.
export function artistKey(name) {
  return createHash("sha256")
    .update(
      String(name || "")
        .trim()
        .toLocaleLowerCase(),
    )
    .digest("hex");
}
export class Library {
  constructor(root, onProgress = () => {}) {
    this.root = root;
    this.onProgress = onProgress;
    this.tracks = [];
    this.playlists = [];
    this.artists = {};
    this.ignored = {};
    this.sightings = new Map();
    this.queue = Promise.resolve();
  }
  async init() {
    for (const dir of [
      "Artists",
      ".edoras/covers",
      ".edoras/artists",
      ".edoras/cache",
    ])
      await fs.mkdir(path.join(this.root, dir), { recursive: true });
    // Explorer shows dot-folders, so the app's own folder is marked hidden
    // there: what the user sees in the library folder is their music.
    if (process.platform === "win32")
      spawn("attrib", ["+h", path.join(this.root, ".edoras")], {
        windowsHide: true,
      }).on("error", () => {});
    this.index = path.join(this.root, ".edoras/library.json");
    try {
      const data = JSON.parse(await fs.readFile(this.index, "utf8"));
      if (!Array.isArray(data.tracks)) throw new Error("Invalid library index");
      this.tracks = data.tracks;
      // Absent in libraries written before playlists existed, so a missing
      // key is normal rather than corruption.
      this.playlists = Array.isArray(data.playlists) ? data.playlists : [];
      // Artist photos arrived after playlists did, so an older index simply
      // has none rather than being broken.
      this.artists =
        data.artists && typeof data.artists === "object" ? data.artists : {};
      // Files in the library folder that are known not to be songs of their
      // own: a second copy of a song already in the catalog, or a file that
      // could not be read. Remembered with their size and date so a scan
      // does not read them again until they change.
      this.ignored =
        data.ignored && typeof data.ignored === "object" ? data.ignored : {};
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(
          `Cannot read library index. Your music is safe. ${error.message}`,
        );
    }
    return this;
  }
  snapshot() {
    const known = new Set(this.tracks.map((track) => track.id));
    return {
      root: this.root,
      tracks: this.tracks.map(({ file, coverFile, ...track }) => ({
        ...track,
        cover: coverFile
          ? `edoras://app/media/cover/${track.id}?v=${track.coverVersion || 0}`
          : "",
      })),
      // Filtered on the way out rather than on delete, so a track that
      // disappears from disk cannot leave a playlist pointing at nothing.
      playlists: this.playlists.map(({ coverFile, ...playlist }) => ({
        ...playlist,
        cover: coverFile
          ? `edoras://app/media/playlist/${playlist.id}?v=${playlist.coverVersion || 0}`
          : "",
        trackIds: playlist.trackIds.filter((id) => known.has(id)),
      })),
      // Keyed by the artist name the renderer already has on every track,
      // so a card can find its photo without another round trip.
      artists: Object.fromEntries(
        Object.entries(this.artists)
          .filter(([, entry]) => entry?.file)
          .map(([key, entry]) => [
            entry.name,
            `edoras://app/media/artist/${key}?v=${entry.version || 0}`,
          ]),
      ),
    };
  }
  serialize(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async save() {
    const temporary = `${this.index}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify(
        {
          version: 1,
          tracks: this.tracks,
          playlists: this.playlists,
          artists: this.artists,
          ignored: this.ignored,
        },
        null,
        2,
      ),
    );
    await fs.rename(temporary, this.index);
  }
  importPaths(paths) {
    return this.serialize(() => this.importFiles(paths));
  }
  async importFiles(paths) {
    const files = [];
    const errors = [];
    const walk = async (file) => {
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
          if (
            inside(path.join(this.root, "Artists"), file) ||
            inside(path.join(this.root, ".edoras"), file)
          )
            return;
          for (const entry of await fs.readdir(file))
            await walk(path.join(file, entry));
        } else if (
          stat.isFile() &&
          extensions.has(path.extname(file).toLowerCase())
        )
          files.push(file);
      } catch (error) {
        errors.push({ file: path.basename(file), message: error.message });
      }
    };
    for (const input of paths) await walk(input);
    let imported = 0,
      duplicates = 0;
    const known = new Set(this.tracks.map((track) => track.id));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.onProgress({
        current: i + 1,
        total: files.length,
        name: path.basename(file),
      });
      try {
        const id = await digest(file);
        if (known.has(id)) {
          duplicates++;
          continue;
        }
        // A song that is already somewhere in the library folder is taken in
        // where it is. Copying it into Artists would leave two of it in the
        // same folder, and the second would be found on the next scan.
        const inPlace = inside(this.root, file);
        const track = await this.readTrack(file, id, inPlace ? null : "copy");
        this.tracks.push(track);
        known.add(id);
        await this.save();
        imported++;
      } catch (error) {
        errors.push({ file: path.basename(file), message: error.message });
      }
    }
    return { imported, duplicates, errors, library: this.snapshot() };
  }
  // Reads a song's tags and artwork into a catalog entry. With `copy` the
  // file is copied into Artists / Album first, which is what importing from
  // anywhere else on the computer does; without it the song is catalogued
  // where it already sits inside the library folder.
  async readTrack(file, id, copy) {
    const { common, format } = await parseFile(file, { duration: true });
    if (!format.codec && !format.container)
      throw new Error("Audio format could not be read");
    const own = fileDetails(this.root, file, common);
    const { title, albumArtist, album, number } = own;
    let dest = file;
    if (copy) {
      const directory = path.join(
        this.root,
        "Artists",
        safeName(albumArtist),
        safeName(album),
      );
      await fs.mkdir(directory, { recursive: true });
      dest = path.join(
        directory,
        `${number ? `${String(number).padStart(2, "0")} - ` : ""}${safeName(title)} [${id.slice(0, 10)}]${path.extname(file).toLowerCase()}`,
      );
      // Exclusive copies never overwrite user files, even after an interrupted import.
      try {
        await fs.copyFile(file, dest, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== "EEXIST" || (await digest(dest)) !== id) throw error;
      }
    }
    let coverFile = "";
    if (own.picture) {
      coverFile = `.edoras/covers/${id}.${imageExtension(own.picture.type)}`;
      await fs.writeFile(path.join(this.root, coverFile), own.picture.bytes);
    }
    return {
      id,
      title,
      artist: own.artist,
      albumArtist,
      album,
      number,
      disc: own.disc,
      year: own.year,
      genre: own.genre,
      duration: format.duration || 0,
      format: path.extname(file).slice(1).toUpperCase(),
      sampleRate: format.sampleRate || 0,
      bitDepth: format.bitsPerSample || 0,
      file: path.relative(this.root, dest),
      coverFile,
      lyrics: own.lyrics,
      favorite: false,
      addedAt: Date.now(),
    };
  }
  // Every audio file in the library folder, wherever it sits, except the
  // app's own .edoras folder. Only names are read here; a file is opened
  // only if the catalog does not already know it.
  async listFolder() {
    const found = new Map();
    const skip = path.join(this.root, ".edoras");
    const walk = async (directory) => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        // The library folder itself being unreadable is a different thing
        // from one subfolder being unreadable: the first must stop the scan
        // before it concludes that every song is gone.
        if (directory === this.root) throw error;
        return;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (full !== skip) await walk(full);
        } else if (
          entry.isFile() &&
          extensions.has(path.extname(entry.name).toLowerCase())
        )
          found.set(path.relative(this.root, full), full);
      }
    };
    await walk(this.root);
    return found;
  }
  // Brings the catalog in line with the library folder. A song dropped into
  // the folder, or any folder inside it, joins the library where it is. A
  // song moved within the folder keeps its place in playlists, favourites
  // and statistics, because it is recognised by its content. A song deleted
  // from the folder leaves the library. Nothing on disk is moved or removed.
  reconcile() {
    return this.serialize(async () => {
      const onDisk = await this.listFolder();
      const byFile = new Map(this.tracks.map((t) => [t.file, t]));
      const missing = new Set(
        this.tracks.filter((t) => !onDisk.has(t.file)).map((t) => t.id),
      );
      const known = new Set(this.tracks.map((t) => t.id));
      let added = 0,
        moved = 0,
        waiting = 0,
        changed = false;
      const errors = [];
      for (const [relative, full] of onDisk) {
        if (byFile.has(relative)) continue;
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        const seen = this.ignored[relative];
        if (seen && seen.size === stat.size && seen.mtime === stat.mtimeMs)
          continue;
        // A file is read only once it has looked the same on two scans in a
        // row, so a song still being copied in is never read half-written.
        // The watcher schedules the second scan.
        const signature = `${stat.size}:${stat.mtimeMs}`;
        if (this.sightings.get(relative) !== signature) {
          this.sightings.set(relative, signature);
          waiting++;
          continue;
        }
        this.sightings.delete(relative);
        try {
          const id = await digest(full);
          if (known.has(id)) {
            const track = this.tracks.find((t) => t.id === id);
            if (track && missing.has(id)) {
              track.file = relative;
              missing.delete(id);
              moved++;
            } else
              this.ignored[relative] = {
                size: stat.size,
                mtime: stat.mtimeMs,
              };
            changed = true;
            continue;
          }
          this.onProgress({
            current: added + 1,
            total: onDisk.size - byFile.size,
            name: path.basename(full),
          });
          const track = await this.readTrack(full, id, null);
          this.tracks.push(track);
          known.add(id);
          delete this.ignored[relative];
          added++;
          changed = true;
        } catch (error) {
          errors.push({ file: path.basename(full), message: error.message });
          this.ignored[relative] = { size: stat.size, mtime: stat.mtimeMs };
          changed = true;
        }
      }
      // A drive that has gone away or a sync client that has not finished
      // downloading looks exactly like a folder someone emptied. When most of
      // a sizeable library vanishes at once, nothing is removed; the songs
      // come back on their own when the files do.
      let removed = 0;
      const suspicious =
        missing.size > 25 && missing.size > this.tracks.length / 2;
      // A song renamed or moved inside the folder is missing from its old
      // place before its new place has been read. While anything is still
      // waiting to be read, nothing is removed, so a move is never mistaken
      // for a delete followed by an add.
      if (missing.size && !suspicious && !waiting) {
        for (const track of this.tracks.filter((t) => missing.has(t.id)))
          if (
            track.coverFile &&
            inside(
              path.join(this.root, ".edoras/covers"),
              path.join(this.root, track.coverFile),
            )
          )
            await fs
              .rm(path.join(this.root, track.coverFile), { force: true })
              .catch(() => {});
        this.tracks = this.tracks.filter((t) => !missing.has(t.id));
        await this.pruneArtists();
        removed = missing.size;
        changed = true;
      }
      for (const relative of Object.keys(this.ignored))
        if (!onDisk.has(relative)) {
          delete this.ignored[relative];
          changed = true;
        }
      if (changed) await this.save();
      return {
        imported: added,
        duplicates: 0,
        moved,
        removed,
        waiting,
        errors,
        library: this.snapshot(),
      };
    });
  }
  favorite(id) {
    return this.serialize(async () => {
      const track = this.tracks.find((t) => t.id === id);
      if (!track) throw new Error("Track not found");
      track.favorite = !track.favorite;
      await this.save();
      return this.snapshot();
    });
  }
  playlist(id) {
    const found = this.playlists.find((p) => p.id === id);
    if (!found) throw new Error("Playlist not found");
    return found;
  }
  createPlaylist(name) {
    return this.serialize(async () => {
      const clean = String(name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (!clean) throw new Error("A playlist needs a name.");
      if (
        this.playlists.some((p) => p.name.toLowerCase() === clean.toLowerCase())
      )
        throw new Error("You already have a playlist with that name.");
      this.playlists.push({
        id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: clean,
        trackIds: [],
        createdAt: Date.now(),
      });
      await this.save();
      return this.snapshot();
    });
  }
  renamePlaylist(id, name) {
    return this.serialize(async () => {
      const playlist = this.playlist(String(id));
      const clean = String(name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (!clean) throw new Error("A playlist needs a name.");
      if (
        this.playlists.some(
          (p) =>
            p.id !== playlist.id &&
            p.name.toLowerCase() === clean.toLowerCase(),
        )
      )
        throw new Error("You already have a playlist with that name.");
      playlist.name = clean;
      await this.save();
      return this.snapshot();
    });
  }
  // A playlist's own picture. The main process has already cropped it square
  // and scaled it down, so every picture on disk is the same small size
  // whatever the user picked.
  setPlaylistCover(id, bytes) {
    return this.serialize(async () => {
      const playlist = this.playlist(String(id));
      const previous = playlist.coverFile;
      if (bytes) {
        await fs.mkdir(path.join(this.root, ".edoras/playlists"), {
          recursive: true,
        });
        const relative = `.edoras/playlists/${playlist.id}-${Date.now()}.jpg`;
        await fs.writeFile(path.join(this.root, relative), bytes);
        playlist.coverFile = relative;
        playlist.coverVersion = Date.now();
      } else {
        delete playlist.coverFile;
        delete playlist.coverVersion;
      }
      await this.save();
      if (previous && previous !== playlist.coverFile)
        await fs
          .rm(path.join(this.root, previous), { force: true })
          .catch(() => {});
      return this.snapshot();
    });
  }
  deletePlaylist(id) {
    return this.serialize(async () => {
      const key = String(id);
      const doomed = this.playlists.find((p) => p.id === key);
      if (!doomed) throw new Error("Playlist not found");
      if (doomed.coverFile)
        await fs
          .rm(path.join(this.root, doomed.coverFile), { force: true })
          .catch(() => {});
      // Only the list goes; the tracks it pointed at are untouched.
      this.playlists = this.playlists.filter((p) => p.id !== key);
      await this.save();
      return this.snapshot();
    });
  }
  addToPlaylist(playlistId, trackId) {
    return this.serialize(async () => {
      const playlist = this.playlist(String(playlistId));
      const track = String(trackId);
      if (!this.tracks.some((t) => t.id === track))
        throw new Error("Track not found");
      if (!playlist.trackIds.includes(track)) playlist.trackIds.push(track);
      await this.save();
      return this.snapshot();
    });
  }
  removeFromPlaylist(playlistId, trackId) {
    return this.serialize(async () => {
      const playlist = this.playlist(String(playlistId));
      const track = String(trackId);
      playlist.trackIds = playlist.trackIds.filter((id) => id !== track);
      await this.save();
      return this.snapshot();
    });
  }
  addTracksToPlaylist(playlistId, trackIds) {
    return this.serialize(async () => {
      const playlist = this.playlist(String(playlistId));
      if (
        !Array.isArray(trackIds) ||
        trackIds.length > 10000 ||
        trackIds.some(
          (id) =>
            typeof id !== "string" || !this.tracks.some((t) => t.id === id),
        )
      )
        throw new Error("Invalid playlist tracks");
      playlist.trackIds = [...new Set([...playlist.trackIds, ...trackIds])];
      await this.save();
      return this.snapshot();
    });
  }
  movePlaylistTrack(playlistId, trackId, direction) {
    return this.serialize(async () => {
      if (direction !== -1 && direction !== 1)
        throw new Error("Invalid playlist direction");
      const playlist = this.playlist(String(playlistId));
      const index = playlist.trackIds.indexOf(trackId);
      if (index < 0) throw new Error("Track not found in playlist");
      const target = index + direction;
      if (target >= 0 && target < playlist.trackIds.length) {
        [playlist.trackIds[index], playlist.trackIds[target]] = [
          playlist.trackIds[target],
          playlist.trackIds[index],
        ];
        await this.save();
      }
      return this.snapshot();
    });
  }
  // Saves an artist photo. Stored once per artist rather than once per track,
  // so an album's worth of songs shares a single file and every view that
  // names that artist gets the same picture.
  async writeArtistPhoto(name, image) {
    const clean = String(name || "").trim();
    if (!clean || !image?.bytes?.length) return false;
    const key = artistKey(clean);
    const relative = `.edoras/artists/${key}-${Date.now()}.${imageExtension(image.type)}`;
    await fs.writeFile(path.join(this.root, relative), image.bytes);
    const previous = this.artists[key];
    this.artists[key] = { name: clean, file: relative, version: Date.now() };
    if (previous?.file && previous.file !== relative)
      await fs
        .rm(path.join(this.root, previous.file), { force: true })
        .catch(() => {});
    return true;
  }
  // The result of looking an artist's photo up on its own, from the artist
  // page or the library-wide fetch. A photo replaces the one there was; a
  // miss is remembered so the next library fetch does not ask again, and
  // never removes a photo that is already there.
  saveArtistPhoto(name, image) {
    return this.serialize(async () => {
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Artist not found");
      if (image) await this.writeArtistPhoto(clean, image);
      else {
        const key = artistKey(clean);
        this.artists[key] = {
          ...this.artists[key],
          name: this.artists[key]?.name || clean,
          checkedAt: Date.now(),
        };
      }
      await this.save();
      return this.snapshot();
    });
  }
  artistChecked(name) {
    const entry = this.artists[artistKey(name)];
    return !!(entry?.file || entry?.checkedAt);
  }
  // Photos of artists no song in the library names any more: left behind by
  // a delete, or by a fetch that turned out to be the wrong artist.
  async pruneArtists() {
    const named = new Set();
    for (const track of this.tracks)
      for (const name of [track.artist, track.albumArtist])
        if (name) named.add(artistKey(name));
    let changed = false;
    for (const [key, entry] of Object.entries(this.artists)) {
      if (named.has(key)) continue;
      if (entry?.file)
        await fs
          .rm(path.join(this.root, entry.file), { force: true })
          .catch(() => {});
      delete this.artists[key];
      changed = true;
    }
    return changed;
  }
  async ownDetails(track) {
    try {
      const file = this.resolve(track.id);
      const { common } = await parseFile(file, { duration: false });
      return fileDetails(this.root, file, common);
    } catch {
      return null;
    }
  }
  // Takes a song out of the library for good: its file goes to the Recycle
  // Bin through `discard`, supplied by the main process, and everything
  // Edoras saved about it goes with it: fetched details, cover, lyrics,
  // converted audio, its place in playlists and, if no other song needs it,
  // its artist's photo. Done inside the queue so the folder watcher cannot
  // see the file gone before the catalog knows why.
  removeTrack(trackId, discard) {
    return this.serialize(async () => {
      const track = this.tracks.find((t) => t.id === String(trackId));
      if (!track) throw new Error("Track not found");
      const file = path.resolve(this.root, track.file);
      let exists = true;
      try {
        await fs.access(file);
      } catch {
        exists = false;
      }
      // Only a file inside the library folder is ever removed from disk;
      // that is the promise the README makes.
      if (exists && inside(this.root, file)) await discard(file);
      for (const relative of [
        track.coverFile,
        `.edoras/cache/${track.id}.wav`,
      ]) {
        if (!relative) continue;
        const target = path.join(this.root, relative);
        if (inside(path.join(this.root, ".edoras"), target))
          await fs.rm(target, { force: true }).catch(() => {});
      }
      this.tracks = this.tracks.filter((t) => t.id !== track.id);
      for (const playlist of this.playlists)
        playlist.trackIds = playlist.trackIds.filter((id) => id !== track.id);
      await this.pruneArtists();
      await this.save();
      return this.snapshot();
    });
  }
  // Lyrics the user typed or pasted. Written to the catalog only; the audio
  // file itself is never rewritten.
  setLyrics(trackId, text, source = "You") {
    return this.serialize(async () => {
      const track = this.tracks.find((t) => t.id === String(trackId));
      if (!track) throw new Error("Track not found");
      const value = String(text ?? "")
        .replace(/\r\n?/g, "\n")
        .slice(0, 20000);
      track.lyrics = value;
      track.lyricsSource = value ? String(source) : "";
      await this.save();
      return this.snapshot();
    });
  }
  // Records that a song was looked up and nothing confident came back, so a
  // second library-wide fetch does not spend its requests on it again.
  markMetadataChecked(trackId) {
    return this.serialize(async () => {
      const track = this.tracks.find((t) => t.id === String(trackId));
      if (!track) throw new Error("Track not found");
      track.metadataFetchedAt = Date.now();
      track.metadataSource = "";
      await this.save();
      return this.snapshot();
    });
  }
  // Puts a song back in the queue for the next library-wide fetch. This is
  // the "unless the user chooses" half of never fetching the same song twice.
  clearMetadataState(trackId) {
    return this.serialize(async () => {
      const track = this.tracks.find((t) => t.id === String(trackId));
      if (!track) throw new Error("Track not found");
      delete track.metadataFetchedAt;
      delete track.metadataSource;
      await this.save();
      return this.snapshot();
    });
  }
  // Writes an identification result onto a track. A fetch replaces the one
  // before it completely: every detail, the cover and the lyrics start again
  // from what the file itself says, and the result is laid over that. So a
  // wrong match is fully undone by the right one, and a field the new result
  // does not have goes back to the file's own tag rather than keeping what
  // the wrong match wrote. With no result at all (`restore`), the song goes
  // back to exactly what the file says.
  applyIdentity(trackId, result, { restore = false } = {}) {
    return this.serialize(async () => {
      const previous = this.tracks.find((t) => t.id === String(trackId));
      if (!previous) throw new Error("Track not found");
      const own = await this.ownDetails(previous);
      const track = { ...previous };
      const found = restore ? {} : result || {};
      for (const field of [
        "title",
        "artist",
        "albumArtist",
        "album",
        "genre",
      ]) {
        const value = String(found[field] || "").trim();
        track[field] = value || (own ? own[field] : previous[field]);
      }
      track.year = found.year || (own ? own.year : previous.year) || null;
      for (const field of ["number", "disc"])
        track[field] =
          Number(found[field]) || (own ? own[field] : previous[field]);
      delete track.mbid;
      if (found.mbid) track.mbid = String(found.mbid);
      // Fetched words replace whatever was there. Without new words, fetched
      // ones go (back to the file's own, if it has any) and words the user
      // pasted themselves stay.
      if (found.lyrics) {
        track.lyrics = String(found.lyrics).slice(0, 20000);
        track.lyricsSource = String(found.lyricsSource || "LRCLIB");
      } else if (previous.lyricsSource !== "You") {
        track.lyrics = own
          ? own.lyrics
          : previous.lyricsSource
            ? ""
            : track.lyrics;
        track.lyricsSource = "";
      }
      if (restore) {
        delete track.metadataFetchedAt;
        delete track.metadataSource;
      } else {
        track.metadataSource = String(found.source || "");
        track.metadataFetchedAt = Date.now();
      }
      // The new cover, or the file's own, or none. An unreadable file keeps
      // the cover it had rather than losing it to a read error.
      const image = found.artwork?.bytes?.length
        ? found.artwork
        : own
          ? own.picture
          : null;
      if (image) {
        const relative = `.edoras/covers/${track.id}-${Date.now()}.${imageExtension(image.type)}`;
        await fs.writeFile(path.join(this.root, relative), image.bytes);
        track.coverFile = relative;
        track.coverVersion = Date.now();
      } else if (own) {
        track.coverFile = "";
        track.coverVersion = Date.now();
      }
      const index = this.tracks.indexOf(previous);
      this.tracks[index] = track;
      try {
        await this.save();
      } catch (error) {
        this.tracks[index] = previous;
        if (track.coverFile && track.coverFile !== previous.coverFile)
          await fs
            .rm(path.join(this.root, track.coverFile), { force: true })
            .catch(() => {});
        throw error;
      }
      // The photo belongs to the artist, not to this track, so it is written
      // after the track is safely committed and a failure here costs nothing.
      if (found.artistImage)
        await this.writeArtistPhoto(
          track.albumArtist || track.artist,
          found.artistImage,
        ).catch(() => {});
      if ((await this.pruneArtists().catch(() => false)) || found.artistImage)
        await this.save().catch(() => {});
      // Only remove the old cover once the new catalog is safely committed.
      if (
        previous.coverFile &&
        previous.coverFile !== track.coverFile &&
        inside(
          path.join(this.root, ".edoras/covers"),
          path.join(this.root, previous.coverFile),
        )
      )
        await fs
          .rm(path.join(this.root, previous.coverFile), { force: true })
          .catch(() => {});
      return this.snapshot();
    });
  }
  restoreOriginal(trackId) {
    return this.applyIdentity(trackId, null, { restore: true });
  }
  resolve(id, type = "audio") {
    if (type === "playlist") {
      const relative = this.playlists.find((p) => p.id === id)?.coverFile;
      if (!relative) throw new Error("Playlist picture not found");
      const file = path.resolve(this.root, relative);
      if (!inside(path.join(this.root, ".edoras/playlists"), file))
        throw new Error("Invalid library path");
      return file;
    }
    if (type === "artist") {
      const relative = this.artists[id]?.file;
      if (!relative) throw new Error("Artist photo not found");
      const file = path.resolve(this.root, relative);
      if (!inside(this.root, file)) throw new Error("Invalid library path");
      return file;
    }
    const track = this.tracks.find((t) => t.id === id);
    const relative = type === "cover" ? track?.coverFile : track?.file;
    if (!relative) throw new Error("Track not found");
    const file = path.resolve(this.root, relative);
    if (!inside(this.root, file)) throw new Error("Invalid library path");
    return file;
  }
}
