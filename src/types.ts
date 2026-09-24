export interface Track {
  id: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  duration: number;
  number: number;
  disc: number;
  format: string;
  genre: string;
  year: number | null;
  sampleRate: number;
  bitDepth: number;
  cover: string;
  favorite: boolean;
  addedAt: number;
  lyrics: string;
  lyricsSource?: string;
  /** When this song was last looked up. Set for a match and for a miss
   *  alike, so a library-wide fetch never spends requests twice. */
  metadataFetchedAt?: number;
  /** The catalog a match came from, or "" when the lookup found nothing. */
  metadataSource?: string;
  url?: string;
  demo?: boolean;
}
export interface IdentifyResult {
  matched: boolean;
  name?: string;
  artwork?: boolean;
  library: LibraryData;
}
export interface MetadataCandidate {
  candidateId: string;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  duration: number;
  genre: string;
  source: string;
  durationDifference?: number | null;
}
export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
  /** The playlist's own picture, always a 600px square, or "". */
  cover?: string;
}
/** Listening history, as totals: per song, per day and per hour of day. */
export interface ListeningStats {
  since: number;
  tracks: Record<string, { plays: number; seconds: number; last: number }>;
  days: Record<string, number>;
  hours: number[];
}
export interface ListeningEntry {
  id: string;
  seconds: number;
  play?: boolean;
  at: number;
}
export interface FolderChange extends ImportResult {
  moved: number;
  removed: number;
}
export interface LibraryData {
  root: string;
  tracks: Track[];
  playlists?: Playlist[];
  /** Artist display name to a photo URL, for every artist we have one for. */
  artists?: Record<string, string>;
  watching?: boolean;
}
export interface ImportResult {
  imported: number;
  duplicates: number;
  errors: { file: string; message: string }[];
  library: LibraryData;
}
export interface LibraryMetadataResult {
  total: number;
  matched: number;
  skipped: number;
  failed: number;
  /** Artist photos found after the songs, for artists that had none. */
  photos?: number;
  cancelled: boolean;
  library: LibraryData;
}
export interface MetadataProgress {
  current?: number;
  total?: number;
  name?: string;
  matched?: number;
  skipped?: number;
  /** True while the fetch is looking for artist photos, after the songs. */
  artists?: boolean;
  done?: boolean;
}
export interface Bridge {
  getLibrary(): Promise<LibraryData>;
  importMusic(kind: string): Promise<ImportResult | null>;
  favorite(id: string): Promise<LibraryData>;
  importDropped(files: FileList | File[]): Promise<ImportResult>;
  identify(id: string): Promise<IdentifyResult>;
  findMetadata(
    id: string,
    options: { mode: "name" | "audio"; query?: string; position?: number },
  ): Promise<MetadataCandidate[]>;
  applyMetadata(
    id: string,
    candidateId: string,
  ): Promise<{ library: LibraryData; artwork: boolean; artistPhoto?: boolean }>;
  fetchLibraryMetadata(options?: {
    redo?: boolean;
  }): Promise<LibraryMetadataResult>;
  cancelLibraryMetadata(): Promise<boolean>;
  resetMetadata(id: string): Promise<LibraryData>;
  restoreMetadata(id: string): Promise<LibraryData>;
  deleteTrack(id: string): Promise<LibraryData>;
  findArtistPhoto(
    name: string,
  ): Promise<{ found: boolean; library: LibraryData }>;
  fetchLyrics(id: string): Promise<{ found: boolean; library: LibraryData }>;
  setLyrics(id: string, text: string): Promise<LibraryData>;
  createPlaylist(name: string): Promise<LibraryData>;
  renamePlaylist(id: string, name: string): Promise<LibraryData>;
  deletePlaylist(id: string): Promise<LibraryData>;
  addToPlaylist(playlistId: string, trackId: string): Promise<LibraryData>;
  removeFromPlaylist(playlistId: string, trackId: string): Promise<LibraryData>;
  addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
  ): Promise<LibraryData>;
  movePlaylistTrack(
    playlistId: string,
    trackId: string,
    direction: number,
  ): Promise<LibraryData>;
  openFolder(kind: string): Promise<void>;
  reveal(id: string): Promise<void>;
  chooseLibrary(): Promise<LibraryData | null>;
  setWatching(value: boolean): Promise<boolean>;
  rescan(): Promise<ImportResult>;
  setPlaylistCover(id: string, clear?: boolean): Promise<LibraryData | null>;
  getStats(): Promise<ListeningStats>;
  recordListening(entries: ListeningEntry[]): Promise<boolean>;
  onFolder(fn: (data: FolderChange) => void): () => void;
  onProgress(
    fn: (data: { current: number; total: number; name: string }) => void,
  ): () => void;
  onMetadataProgress(fn: (data: MetadataProgress) => void): () => void;
  onLibrary(fn: (data: ImportResult) => void): () => void;
  onOpened(fn: (data: OpenedFile) => void): () => void;
  onError(fn: (message: string) => void): () => void;
}
// A file handed to Edoras from outside: Explorer's "Open with", or the
// app's icon. `id` is empty when the file could not be read at all.
export interface OpenedFile {
  id: string;
  imported: number;
  duplicates: number;
  name: string;
}
declare global {
  interface Window {
    edoras?: Bridge;
  }
}
