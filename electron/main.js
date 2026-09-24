import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  shell,
  session,
  nativeImage,
} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import ffmpeg from "./ffmpeg.js";
import { watch as fsWatch } from "node:fs";
import {
  Library,
  extensions,
  inside,
  digest,
  audioPathsFrom,
} from "./library.js";
import { mediaResponse } from "./media.js";
import { identify } from "./identify.js";
import {
  searchMetadata,
  completeCandidate,
  bestMatch,
  findArtistPhoto,
  findLyrics,
} from "./metadata.js";
import { recognizeAudio } from "./recognize.js";
import { ListeningStore } from "./stats.js";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.join(here, "../dist");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "edoras",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
let win, library, watcher, settingsFile, listening;
let watching = true;
const converting = new Map();
const metadataChoices = new Map();
const metadataJobs = new Set();
let bulkMetadata = null;
const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
// The library folder is watched as a whole, not just an Inbox inside it:
// a song dropped anywhere in it joins the library where it is, and a song
// deleted from it leaves. One recursive watch on the folder, rather than one
// per album, and the actual work is a scan that compares names with the
// catalog, so a burst of changes costs one pass.
let scanTimer = null;
function scheduleScan(delay = 1500) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void scanFolder(), delay);
}
async function scanFolder() {
  const owner = library;
  try {
    const result = await owner.reconcile();
    if (owner !== library) return;
    if (result.imported || result.removed || result.moved)
      send("library:folder", result);
    // A new file is read once it has stopped changing, which takes a second
    // look.
    if (result.waiting) scheduleScan(2500);
  } catch (error) {
    send("library:error", error.message);
  }
}
async function watchFolder() {
  watcher?.close();
  watcher = null;
  clearTimeout(scanTimer);
  if (!watching) return;
  const root = library.root;
  try {
    watcher = fsWatch(root, { recursive: true }, (_event, name) => {
      const file = String(name ?? "");
      if (file.split(/[\\/]/)[0] === ".edoras") return;
      scheduleScan();
    });
    watcher.on("error", () => scheduleScan(5000));
  } catch (error) {
    send(
      "library:error",
      `The library folder cannot be watched: ${error.message}`,
    );
  }
  // Whatever arrived while Edoras was closed.
  scheduleScan(300);
}
// A file can arrive before the library has loaded or before the renderer is
// listening, so it waits for both. The renderer asking for the library is
// the signal that it is up: nothing else tells the main process that its
// messages will be heard.
let openQueue = [];
let openingFiles = false;
let rendererReady = false;
async function openFiles(paths) {
  if (!paths.length) return;
  if (!library || !rendererReady || openingFiles) {
    openQueue.push(...paths);
    return;
  }
  openingFiles = true;
  try {
    const usable = [];
    for (const candidate of paths) {
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isFile()) usable.push(candidate);
      } catch {
        /* a file that has since moved is simply skipped */
      }
    }
    if (!usable.length) return;
    const result = await library.importPaths(usable);
    send("library:changed", result);
    // Double-clicking a song means play it, and it means that whether the
    // song was new or has been in the library all along. The id is the
    // file's own digest, so the same file always resolves to the same track
    // and an import that found a duplicate still points at the right one.
    let id = "";
    try {
      id = await digest(usable[0]);
    } catch {
      /* unreadable now; the import result above already said so */
    }
    send("library:opened", {
      id: library.tracks.some((track) => track.id === id) ? id : "",
      imported: result.imported,
      duplicates: result.duplicates,
      name: path.basename(usable[0]),
    });
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  } finally {
    openingFiles = false;
    await flushOpenQueue();
  }
}
async function flushOpenQueue() {
  if (openingFiles || !openQueue.length) return;
  const queued = openQueue;
  openQueue = [];
  await openFiles(queued).catch((error) =>
    send("library:error", error.message),
  );
}
async function setLibrary(root) {
  const next = await new Library(root, (progress) =>
    send("library:progress", progress),
  ).init();
  watcher?.close();
  if (library) await library.queue;
  listening?.flushNow();
  library = next;
  listening = await new ListeningStore(root).load();
  await fs.writeFile(settingsFile, JSON.stringify({ root, watching }));
  await watchFolder();
}
async function convertedAudio(id) {
  const file = library.resolve(id);
  const output = path.join(library.root, ".edoras/cache", `${id}.wav`);
  try {
    await fs.access(output);
    return output;
  } catch {
    /* First playback of a legacy codec */
  }
  if (!converting.has(output)) {
    const job = new Promise((resolve, reject) => {
      const executable = ffmpeg;
      const child = spawn(
        executable,
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          file,
          "-vn",
          "-ac",
          "2",
          "-ar",
          "48000",
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          "-y",
          `${output}.tmp`,
        ],
        { windowsHide: true },
      );
      let error = "";
      child.stderr.on("data", (data) => {
        error = (error + data).slice(-2000);
      });
      const timer = setTimeout(() => child.kill(), 300000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          await fs.rm(`${output}.tmp`, { force: true });
          reject(new Error(error || "Audio conversion failed"));
        } else {
          try {
            await fs.rename(`${output}.tmp`, output);
            resolve(output);
          } catch (err) {
            reject(err);
          }
        }
      });
    }).finally(() => converting.delete(output));
    converting.set(output, job);
  }
  return converting.get(output);
}
function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      !event.senderFrame.url.startsWith("edoras://app/")
    )
      throw new Error("Untrusted sender");
    return callback(...args);
  });
}
if (process.env.EDORAS_TEST_HOME)
  app.setPath("userData", process.env.EDORAS_TEST_HOME);
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    win?.restore();
    win?.focus();
    void openFiles(audioPathsFrom(argv)).catch((error) =>
      send("library:error", error.message),
    );
  });
  // macOS and Linux hand the file over as an event rather than in argv.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    void openFiles([path.resolve(file)]).catch((error) =>
      send("library:error", error.message),
    );
  });
  app
    .whenReady()
    .then(async () => {
      settingsFile = path.join(app.getPath("userData"), "settings.json");
      await fs.mkdir(app.getPath("userData"), { recursive: true });
      let settings = {};
      try {
        settings = JSON.parse(await fs.readFile(settingsFile, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      watching = settings.watching !== false;
      await setLibrary(
        settings.root ||
          path.join(
            process.env.EDORAS_TEST_HOME || app.getPath("music"),
            "Edoras Library",
          ),
      );
      protocol.handle("edoras", async (request) => {
        try {
          const url = new URL(request.url);
          let file;
          if (url.hostname === "app" && url.pathname.startsWith("/media/")) {
            const [, , type, id] = url.pathname.split("/");
            if (
              !["audio", "cover", "converted", "artist", "playlist"].includes(
                type,
              ) ||
              !(type === "playlist"
                ? /^pl-[a-z0-9-]{1,40}$/.test(id)
                : /^[a-f0-9]{64}$/.test(id))
            )
              return new Response("Not found", { status: 404 });
            file =
              type === "converted"
                ? await convertedAudio(id)
                : library.resolve(id, type);
            if (type === "audio" || type === "converted")
              return await mediaResponse(file, request);
          } else if (url.hostname === "app") {
            file = path.resolve(
              uiRoot,
              `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
            );
            if (!inside(uiRoot, file))
              return new Response("Forbidden", { status: 403 });
          } else return new Response("Not found", { status: 404 });
          return await net.fetch(pathToFileURL(file).toString(), {
            headers: request.headers,
          });
        } catch {
          return new Response("File unavailable", { status: 404 });
        }
      });
      session.defaultSession.setPermissionRequestHandler(
        (_web, _permission, done) => done(false),
      );
      handle("library:get", () => {
        if (!rendererReady) {
          rendererReady = true;
          // After this call returns, so the renderer has its library before
          // it is told a song arrived.
          setImmediate(() => void flushOpenQueue());
        }
        return { ...library.snapshot(), watching };
      });
      handle("library:import", async (kind) => {
        const selected = await dialog.showOpenDialog(win, {
          title:
            kind === "files"
              ? "Add music to Edoras"
              : "Import an album or music folder",
          properties:
            kind === "files"
              ? ["openFile", "multiSelections"]
              : ["openDirectory"],
          filters: [
            {
              name: "Audio",
              extensions: [...extensions].map((e) => e.slice(1)),
            },
          ],
        });
        if (selected.canceled) return null;
        return library.importPaths(selected.filePaths);
      });
      handle("library:favorite", (id) => library.favorite(String(id)));
      // Drag and drop. The renderer can only ever hand over paths the user
      // actually dropped on the window, and the main process still checks
      // that each one is a string pointing at something that exists.
      handle("library:import-paths", async (paths) => {
        if (
          !Array.isArray(paths) ||
          !paths.length ||
          paths.length > 5000 ||
          paths.some((p) => typeof p !== "string" || !p || p.length > 4096)
        )
          throw new Error("Nothing usable was dropped.");
        const usable = [];
        for (const candidate of paths) {
          const resolved = path.resolve(candidate);
          try {
            const stat = await fs.lstat(resolved);
            if (stat.isDirectory() || stat.isFile()) usable.push(resolved);
          } catch {
            /* a path that no longer exists is simply skipped */
          }
        }
        if (!usable.length) throw new Error("Nothing usable was dropped.");
        return library.importPaths(usable);
      });
      handle("track:identify", async (id) => {
        const key = String(id);
        const track = library.tracks.find((t) => t.id === key);
        if (!track) throw new Error("Track not found");
        const result = await identify(track);
        // Nothing confidently matched: say so plainly and change nothing.
        if (!result) return { matched: false, library: library.snapshot() };
        return {
          matched: true,
          name: `${result.artist ? `${result.artist} — ` : ""}${result.title}`,
          artwork: !!result.artwork,
          library: await library.applyIdentity(key, result),
        };
      });
      handle("track:find-metadata", async (id, options = {}) => {
        if (typeof id !== "string" || !options || typeof options !== "object")
          throw new Error("Invalid metadata request");
        const owner = library;
        const track = owner.tracks.find((t) => t.id === id);
        if (!track) throw new Error("Track not found");
        if (
          options.query != null &&
          (typeof options.query !== "string" || options.query.length > 300)
        )
          throw new Error("Search must be under 300 characters");
        if (options.mode != null && !["name", "audio"].includes(options.mode))
          throw new Error("Invalid search mode");
        if (
          options.position != null &&
          (!Number.isFinite(options.position) || options.position < 0)
        )
          throw new Error("Invalid playback position");
        if (metadataJobs.has(owner))
          throw new Error(
            "A lookup is already running. Please wait for it to finish.",
          );
        metadataJobs.add(owner);
        try {
          const matches =
            options.mode === "audio"
              ? await recognizeAudio(
                  owner.resolve(id),
                  track.duration,
                  options.position || 0,
                )
              : await searchMetadata(track, options.query || "");
          if (owner !== library)
            throw new Error(
              "The library changed during this lookup. Search again in the current library.",
            );
          for (const [key, entry] of metadataChoices)
            if (entry.trackId === id || Date.now() - entry.created > 600000)
              metadataChoices.delete(key);
          return matches.map((candidate) => {
            const candidateId = randomUUID();
            if (metadataChoices.size >= 100)
              metadataChoices.delete(metadataChoices.keys().next().value);
            metadataChoices.set(candidateId, {
              candidate,
              owner,
              trackId: id,
              created: Date.now(),
            });
            const {
              title,
              artist,
              album,
              year,
              duration,
              genre,
              source,
              durationDifference,
            } = candidate;
            return {
              candidateId,
              title,
              artist,
              album,
              year,
              duration,
              genre,
              source,
              durationDifference,
            };
          });
        } finally {
          metadataJobs.delete(owner);
        }
      });
      handle("track:apply-metadata", async (id, candidateId) => {
        const choice = metadataChoices.get(candidateId);
        if (
          !choice ||
          choice.trackId !== id ||
          choice.owner !== library ||
          Date.now() - choice.created > 600000
        )
          throw new Error("This result expired. Please search again.");
        metadataChoices.delete(candidateId);
        const track = choice.owner.tracks.find((t) => t.id === id);
        const result = await completeCandidate(choice.candidate, { track });
        if (choice.owner !== library)
          throw new Error("The library changed. Please search again.");
        return {
          library: await choice.owner.applyIdentity(id, result),
          artwork: !!result.artwork,
          artistPhoto: !!result.artistImage,
        };
      });
      // Back to what the file itself says: the fetched details, cover and
      // lyrics go, and the song is looked up again by the next library fetch.
      handle("track:restore-metadata", (id) => {
        if (typeof id !== "string") throw new Error("Invalid track");
        for (const [key, entry] of metadataChoices)
          if (entry.trackId === id) metadataChoices.delete(key);
        return library.restoreOriginal(id);
      });
      // Deleting a song moves its file to the Recycle Bin, so a mistake can be
      // undone from there, and removes everything Edoras saved about it.
      handle("track:delete", async (id) => {
        if (typeof id !== "string") throw new Error("Invalid track");
        const owner = library;
        const snapshot = await owner.removeTrack(id, async (file) => {
          try {
            await shell.trashItem(file);
          } catch (error) {
            throw new Error(
              `The file couldn't be moved to the Recycle Bin, so nothing was deleted. ${error.message}`,
            );
          }
        });
        for (const [key, entry] of metadataChoices)
          if (entry.trackId === id) metadataChoices.delete(key);
        if (owner === library) listening.forget(id);
        return snapshot;
      });
      // An artist's photo on its own, for an artist whose songs never had
      // their details fetched, or whose photo is wrong.
      handle("artist:find-photo", async (name) => {
        if (typeof name !== "string" || !name.trim() || name.length > 300)
          throw new Error("Invalid artist");
        const owner = library;
        if (
          !owner.tracks.some((t) => t.albumArtist === name || t.artist === name)
        )
          throw new Error("Artist not found");
        const image = await findArtistPhoto(name);
        if (owner !== library)
          throw new Error("The library changed during this lookup.");
        return {
          found: !!image,
          library: await owner.saveArtistPhoto(name, image),
        };
      });
      // One click for the whole library. Only a match the ranking is sure of
      // is written without the user seeing it; anything less is left for the
      // per-song button, which always shows the choices.
      handle("track:fetch-library-metadata", async (options = {}) => {
        if (!options || typeof options !== "object")
          throw new Error("Invalid request");
        if (bulkMetadata)
          throw new Error("A library fetch is already running.");
        const owner = library;
        const redo = options.redo === true;
        // Songs never looked up, and songs an earlier run found nothing
        // confident for: the catalogs and the matching both grow, so a miss
        // is worth asking about again. A song already matched is left alone
        // unless the user asks for everything again.
        const queue = owner.tracks
          .filter(
            (track) =>
              redo || !track.metadataFetchedAt || !track.metadataSource,
          )
          .map((track) => track.id);
        const job = { cancelled: false };
        bulkMetadata = job;
        let matched = 0,
          skipped = 0,
          failed = 0,
          done = 0,
          photos = 0;
        try {
          for (const id of queue) {
            if (job.cancelled) break;
            if (owner !== library) break;
            const track = owner.tracks.find((t) => t.id === id);
            if (!track) continue;
            done++;
            send("library:metadata-progress", {
              current: done,
              total: queue.length,
              name: track.title,
              matched,
              skipped,
            });
            try {
              const best = await bestMatch(track);
              if (best) {
                await owner.applyIdentity(
                  id,
                  await completeCandidate(best, { track }),
                );
                matched++;
              } else {
                await owner.markMetadataChecked(id);
                skipped++;
              }
            } catch {
              // A song that could not be reached keeps no state at all, so
              // the next run tries it again.
              failed++;
            }
          }
          // Then a photo for every artist still without one, whether or not
          // their songs matched: an album with good tags of its own never
          // needed its details fetched, but its artist still wants a face.
          const artists = [
            ...new Set(owner.tracks.map((t) => t.albumArtist).filter(Boolean)),
          ].filter((name) => redo || !owner.artistChecked(name));
          let found = 0;
          for (let i = 0; i < artists.length; i++) {
            if (job.cancelled || owner !== library) break;
            send("library:metadata-progress", {
              current: i + 1,
              total: artists.length,
              name: artists[i],
              artists: true,
            });
            try {
              const image = await findArtistPhoto(artists[i]);
              await owner.saveArtistPhoto(artists[i], image);
              if (image) found++;
            } catch {
              /* tried again on the next library fetch */
            }
          }
          photos = found;
        } finally {
          bulkMetadata = null;
        }
        send("library:metadata-progress", { done: true });
        return {
          total: queue.length,
          matched,
          skipped,
          failed,
          photos,
          cancelled: job.cancelled,
          library: owner === library ? library.snapshot() : owner.snapshot(),
        };
      });
      handle("track:cancel-library-metadata", () => {
        if (bulkMetadata) bulkMetadata.cancelled = true;
        return true;
      });
      handle("track:reset-metadata", (id) =>
        library.clearMetadataState(String(id)),
      );
      handle("track:set-lyrics", (id, text) => {
        if (typeof text !== "string" || text.length > 20000)
          throw new Error("Those lyrics are too long to save.");
        return library.setLyrics(String(id), text);
      });
      handle("track:fetch-lyrics", async (id) => {
        const owner = library;
        const track = owner.tracks.find((t) => t.id === String(id));
        if (!track) throw new Error("Track not found");
        const text = await findLyrics({
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
        });
        if (owner !== library)
          throw new Error("The library changed during this lookup.");
        if (!text) return { found: false, library: owner.snapshot() };
        return {
          found: true,
          library: await owner.setLyrics(String(id), text, "LRCLIB"),
        };
      });
      handle("playlist:create", (name) => library.createPlaylist(name));
      handle("playlist:rename", (id, name) => library.renamePlaylist(id, name));
      handle("playlist:delete", (id) => library.deletePlaylist(id));
      handle("playlist:add", (playlistId, trackId) =>
        library.addToPlaylist(playlistId, trackId),
      );
      handle("playlist:remove", (playlistId, trackId) =>
        library.removeFromPlaylist(playlistId, trackId),
      );
      handle("playlist:add-many", (playlistId, trackIds) =>
        library.addTracksToPlaylist(playlistId, trackIds),
      );
      handle("playlist:move", (playlistId, trackId, direction) =>
        library.movePlaylistTrack(playlistId, trackId, direction),
      );
      handle("library:folder", async () => {
        const result = await shell.openPath(library.root);
        if (result) throw new Error(result);
      });
      handle("stats:get", () => listening.stats);
      handle("stats:record", (entries) => listening.record(entries));
      // The picture is read, cropped square and scaled here, on the trusted
      // side, and only ever saved as a 600px JPEG. Whatever the user picks,
      // the library holds one small file of one size, and the renderer never
      // sees a path.
      handle("playlist:cover", async (id, clear) => {
        const playlistId = String(id);
        library.playlist(playlistId);
        if (clear === true) return library.setPlaylistCover(playlistId, null);
        const selected = await dialog.showOpenDialog(win, {
          title: "Choose a picture for this playlist",
          properties: ["openFile"],
          filters: [
            { name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] },
          ],
        });
        if (selected.canceled) return null;
        const file = selected.filePaths[0];
        const stat = await fs.stat(file);
        if (stat.size > 40 * 1024 * 1024)
          throw new Error("That picture is too large. Choose one under 40 MB.");
        const image = nativeImage.createFromPath(file);
        if (image.isEmpty())
          throw new Error("That file could not be read as a picture.");
        const { width, height } = image.getSize();
        const side = Math.min(width, height);
        const square = image.crop({
          x: Math.floor((width - side) / 2),
          y: Math.floor((height - side) / 2),
          width: side,
          height: side,
        });
        const size = Math.min(600, side);
        const bytes = square
          .resize({ width: size, height: size, quality: "best" })
          .toJPEG(88);
        return library.setPlaylistCover(playlistId, bytes);
      });
      handle("library:reveal", (id) =>
        shell.showItemInFolder(library.resolve(String(id))),
      );
      handle("library:choose", async () => {
        const selected = await dialog.showOpenDialog(win, {
          title: "Choose where Edoras Library should live",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selected.canceled) return null;
        await setLibrary(path.join(selected.filePaths[0], "Edoras Library"));
        return { ...library.snapshot(), watching };
      });
      handle("library:watch", async (value) => {
        watching = Boolean(value);
        await fs.writeFile(
          settingsFile,
          JSON.stringify({ root: library.root, watching }),
        );
        await watchFolder();
        return watching;
      });
      handle("library:rescan", () => library.reconcile());
      handle("window:action", (action) => {
        if (action === "minimize") win.minimize();
        if (action === "maximize")
          win.isMaximized() ? win.unmaximize() : win.maximize();
        if (action === "close") win.close();
      });
      // Whatever the app was launched with, queued before the window exists
      // so it cannot be missed between the renderer starting and asking for
      // its library.
      openQueue.push(...audioPathsFrom(process.argv));
      win = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 900,
        minHeight: 650,
        title: "Edoras",
        backgroundColor: "#f2f2f0",
        autoHideMenuBar: true,
        icon: path.join(uiRoot, "icon.png"),
        webPreferences: {
          preload: path.join(here, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      await win.loadURL("edoras://app/");
    })
    .catch((error) => {
      dialog.showErrorBox("Edoras could not start", error.message);
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  watcher?.close();
  listening?.flushNow();
});
