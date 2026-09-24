const { contextBridge, ipcRenderer, webUtils } = require("electron");
const listen = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("edoras", {
  getLibrary: () => ipcRenderer.invoke("library:get"),
  importMusic: (kind) => ipcRenderer.invoke("library:import", kind),
  favorite: (id) => ipcRenderer.invoke("library:favorite", id),
  // Dropped files arrive as File objects with no readable path of their own;
  // only the privileged side can turn them back into paths on disk. It has to
  // be handed a real array: a FileList does not survive the context bridge
  // intact — it arrives here as a plain object with no `length`, so
  // `Array.from` quietly returns nothing and every drop fails.
  importDropped: (files) =>
    ipcRenderer.invoke(
      "library:import-paths",
      Array.from(files || [])
        .map((file) => {
          try {
            return webUtils.getPathForFile(file);
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  identify: (id) => ipcRenderer.invoke("track:identify", id),
  findMetadata: (id, options) =>
    ipcRenderer.invoke("track:find-metadata", id, options),
  applyMetadata: (id, candidateId) =>
    ipcRenderer.invoke("track:apply-metadata", id, candidateId),
  fetchLibraryMetadata: (options) =>
    ipcRenderer.invoke("track:fetch-library-metadata", options),
  cancelLibraryMetadata: () =>
    ipcRenderer.invoke("track:cancel-library-metadata"),
  resetMetadata: (id) => ipcRenderer.invoke("track:reset-metadata", id),
  restoreMetadata: (id) => ipcRenderer.invoke("track:restore-metadata", id),
  deleteTrack: (id) => ipcRenderer.invoke("track:delete", id),
  findArtistPhoto: (name) => ipcRenderer.invoke("artist:find-photo", name),
  fetchLyrics: (id) => ipcRenderer.invoke("track:fetch-lyrics", id),
  setLyrics: (id, text) => ipcRenderer.invoke("track:set-lyrics", id, text),
  createPlaylist: (name) => ipcRenderer.invoke("playlist:create", name),
  renamePlaylist: (id, name) => ipcRenderer.invoke("playlist:rename", id, name),
  deletePlaylist: (id) => ipcRenderer.invoke("playlist:delete", id),
  addToPlaylist: (playlistId, trackId) =>
    ipcRenderer.invoke("playlist:add", playlistId, trackId),
  removeFromPlaylist: (playlistId, trackId) =>
    ipcRenderer.invoke("playlist:remove", playlistId, trackId),
  addTracksToPlaylist: (playlistId, trackIds) =>
    ipcRenderer.invoke("playlist:add-many", playlistId, trackIds),
  movePlaylistTrack: (playlistId, trackId, direction) =>
    ipcRenderer.invoke("playlist:move", playlistId, trackId, direction),
  openFolder: (kind) => ipcRenderer.invoke("library:folder", kind),
  reveal: (id) => ipcRenderer.invoke("library:reveal", id),
  chooseLibrary: () => ipcRenderer.invoke("library:choose"),
  setWatching: (value) => ipcRenderer.invoke("library:watch", value),
  rescan: () => ipcRenderer.invoke("library:rescan"),
  setPlaylistCover: (id, clear) =>
    ipcRenderer.invoke("playlist:cover", id, clear === true),
  getStats: () => ipcRenderer.invoke("stats:get"),
  recordListening: (entries) => ipcRenderer.invoke("stats:record", entries),
  // Songs that appeared in, moved within or left the library folder.
  onFolder: (callback) => listen("library:folder", callback),
  onProgress: (callback) => listen("library:progress", callback),
  onMetadataProgress: (callback) =>
    listen("library:metadata-progress", callback),
  onLibrary: (callback) => listen("library:changed", callback),
  // A file opened from Explorer, or dropped on the app's icon.
  onOpened: (callback) => listen("library:opened", callback),
  onError: (callback) => listen("library:error", callback),
});
