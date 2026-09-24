import "@fontsource-variable/instrument-sans";
import "@fontsource/instrument-serif/400-italic.css";
import {
  createIcons,
  House,
  Headphones,
  Disc3,
  Library,
  Heart,
  FolderPlus,
  FolderOpen,
  Search,
  Settings2,
  ArrowUpRight,
  Plus,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
  Volume2,
  VolumeX,
  ChevronUp,
  ChevronDown,
  X,
  ListMusic,
  ArrowLeft,
  Music2,
  Check,
  ChevronsLeft,
  Ellipsis,
  Upload,
  ArrowRight,
  UserRound,
  CircleCheck,
  Pencil,
  RotateCcw,
  MicVocal,
  ArrowUp,
  ChartColumn,
  ImagePlus,
  AudioLines,
  Sparkles,
  Trash2,
} from "lucide";
import type {
  Track,
  LibraryData,
  ImportResult,
  MetadataCandidate,
  ListeningStats,
  Playlist,
} from "./types";
import {
  statisticsPage,
  countUp,
  refreshTiles,
  bindCharts,
  addListening,
  emptyStats,
  type Range,
} from "./stats";
import { demos } from "./demo";
import {
  accentFromArtwork,
  accentFromHash,
  applyAccent,
  type Accent,
} from "./palette";
import { cachedPeaks, peaksFor, peaksPending } from "./peaks";
import edorasLogo from "./edoras-logo.svg?raw";
import "./style.css";

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const icon = (name: string, cls = "") =>
  `<i data-lucide="${name}" class="${cls}"></i>`;
const icons = () =>
  createIcons({
    icons: {
      House,
      Headphones,
      Disc3,
      Library,
      Heart,
      FolderPlus,
      FolderOpen,
      Search,
      Settings2,
      ArrowUpRight,
      Plus,
      Play,
      Pause,
      SkipBack,
      SkipForward,
      Repeat,
      Repeat1,
      Shuffle,
      Volume2,
      VolumeX,
      ChevronUp,
      ChevronDown,
      X,
      ListMusic,
      ArrowLeft,
      Music2,
      Check,
      ChevronsLeft,
      Ellipsis,
      Upload,
      ArrowRight,
      UserRound,
      CircleCheck,
      Pencil,
      RotateCcw,
      MicVocal,
      ArrowUp,
      ChartColumn,
      ImagePlus,
      AudioLines,
      Sparkles,
      Trash2,
    },
  });
const time = (seconds: number) =>
  `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, "0")}`;
let library: LibraryData = { root: "", tracks: [], watching: true };
let view = "home",
  search = "",
  selection = "",
  busy = false;
let queue: Track[] = [],
  current: Track | null = null,
  shuffle = false,
  repeat = 0,
  expanded = false;
let loadVersion = 0,
  resumeTime = 0,
  fallback = false,
  identifying = false;
const audio = new Audio();
audio.preload = "metadata";
audio.volume = Number(localStorage.getItem("edoras-volume") ?? 0.75);
audio.id = "edoras-audio";
document.body.appendChild(audio);
let context: AudioContext | undefined, analyser: AnalyserNode | undefined;
let lastFocus: HTMLElement | null = null;
let toastTimeout: ReturnType<typeof setTimeout>;
let addTrackIds: string[] = [],
  pendingPlaylistTracks: string[] = [];
let renamingPlaylistId = "",
  metadataTrackId = "",
  metadataVersion = 0,
  metadataBusy = false;
let lyricsEditing = false,
  lyricsBusy = false,
  libraryFetchBusy = false;
// How the library is read. Remembered, because a collection is usually read
// the same way twice, and applied everywhere a plain list of songs is shown:
// the library, favourites, search results and an artist's songs. An album
// keeps disc-and-track order, which is the order the record was made in, and
// a playlist keeps the order it was arranged in by hand.
type SortKey = "added" | "release" | "artist" | "album" | "title";
const SORTS: { key: SortKey; label: string; descending: boolean }[] = [
  { key: "added", label: "Date added", descending: true },
  { key: "release", label: "Release date", descending: true },
  { key: "artist", label: "Artist", descending: false },
  { key: "album", label: "Album", descending: false },
  { key: "title", label: "Alphabetical", descending: false },
];
let sortKey: SortKey =
  (localStorage.getItem("edoras-sort") as SortKey | null) ?? "added";
if (!SORTS.some((s) => s.key === sortKey)) sortKey = "added";
let sortDescending =
  localStorage.getItem("edoras-sort-direction") === null
    ? SORTS.find((s) => s.key === sortKey)!.descending
    : localStorage.getItem("edoras-sort-direction") === "descending";
// Titles sort the way a person reads them, not the way bytes compare: case
// and accents are folded together and numbers count as numbers, so "Track 2"
// comes before "Track 10".
const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});
function sortTracks(list: Track[]) {
  const direction = sortDescending ? -1 : 1;
  const by = (a: Track, b: Track) => {
    switch (sortKey) {
      case "added":
        return a.addedAt - b.addedAt;
      case "release":
        return (
          (a.year || 0) - (b.year || 0) ||
          collator.compare(a.album, b.album) ||
          a.disc - b.disc ||
          a.number - b.number
        );
      case "artist":
        return (
          collator.compare(
            a.albumArtist || a.artist,
            b.albumArtist || b.artist,
          ) ||
          collator.compare(a.album, b.album) ||
          a.disc - b.disc ||
          a.number - b.number
        );
      case "album":
        return (
          collator.compare(a.album, b.album) ||
          a.disc - b.disc ||
          a.number - b.number
        );
      default:
        return collator.compare(a.title, b.title);
    }
  };
  // Title breaks every tie, so the same library always comes back in the same
  // order rather than shuffling on each render.
  return [...list].sort(
    (a, b) => by(a, b) * direction || collator.compare(a.title, b.title),
  );
}
// "1 minutes of music" was the old wording at every library under ninety
// seconds.
function plural(count: number, word: string) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}
function minutes(list: Track[]) {
  const total = Math.round(list.reduce((n, t) => n + t.duration, 0) / 60);
  return `${total} ${total === 1 ? "minute" : "minutes"} of music`;
}
function sortControl() {
  return `<div class="sort"><select class="sort-field" id="sort-field" aria-label="Sort by">${SORTS.map(
    (s) =>
      `<option value="${s.key}"${s.key === sortKey ? " selected" : ""}>${s.label}</option>`,
  ).join(
    "",
  )}</select><button class="icon-button sort-direction ${sortDescending ? "descending" : ""}" data-action="sort-direction" aria-label="${sortDescending ? "Sorted newest or last first. Reverse it" : "Sorted oldest or first first. Reverse it"}" title="Reverse the order">${icon("arrow-up")}</button></div>`;
}
type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];
let theme: Theme =
  (localStorage.getItem("edoras-theme") as Theme | null) ?? "system";
if (!THEMES.includes(theme)) theme = "system";
// Set before the first paint so the app never flashes the wrong theme.
// "system" leaves the attribute off entirely and lets the media query decide.
function paintTheme() {
  if (theme === "system")
    document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
paintTheme();

// The total time beside the waveform doubles as a countdown: one click shows
// what is left, another the length again. Remembered, because it is a
// matter of taste rather than of the moment.
let showRemaining = localStorage.getItem("edoras-time") === "remaining";
function durationButton() {
  return `<button class="duration time-toggle" data-action="toggle-remaining" aria-label="${showRemaining ? "Showing time remaining. Show the length instead" : "Showing the length. Show time remaining instead"}" title="${showRemaining ? "Show the length" : "Show time remaining"}">0:00</button>`;
}
const APP_VERSION = "1.0";
// Where the lyrics button came from, so pressing it again goes back there.
let lyricsReturn: { view: string; selection: string; scroll: number } | null =
  null;
// Which collection the queue was started from ("album:<key>",
// "playlist:<id>", "artist:<name>"), so that collection's own Play button
// can read Pause while it plays.
let queueSource = "";
let statsRange: Range =
  (localStorage.getItem("edoras-stats-range") as Range | null) ?? "month";
if (!["week", "month", "year"].includes(statsRange)) statsRange = "month";
let listening: ListeningStats = emptyStats();

// The playlist list in the sidebar folds away under its caption, and stays
// the way it was left.
let playlistsFolded = localStorage.getItem("edoras-playlists") === "folded";
const app = $("#app");
app.innerHTML = `
<aside class="sidebar">
  <a href="#home" class="brand" aria-label="Edoras home"><span class="brand-icon" aria-hidden="true">${edorasLogo}</span><span>Edoras<small>YOUR MUSIC, AT HOME.</small></span></a>
  <nav aria-label="Main navigation">
    <button class="nav-item active" data-view="home">${icon("house")}<span>Home</span></button>
    <button class="nav-item" data-view="listen">${icon("library")}<span>Library</span></button>
    <button class="nav-item" data-view="albums">${icon("disc-3")}<span>Albums</span></button>
    <button class="nav-item" data-view="artists">${icon("user-round")}<span>Artists</span></button>
    <button class="nav-item" data-view="lyrics">${icon("mic-vocal")}<span>Lyrics</span></button>
    <div class="nav-divider"></div><p class="nav-caption">YOUR COLLECTION</p>
    <button class="nav-item" data-view="favorites">${icon("heart")}<span>Favorites</span><small id="fav-count">0</small></button>
    <button class="nav-item" data-action="import">${icon("folder-plus")}<span>Import music</span></button>
    <div class="nav-divider"></div><div class="nav-caption playlist-caption"><button class="playlist-toggle" data-action="toggle-playlists" aria-expanded="${!playlistsFolded}" aria-controls="playlist-group">PLAYLISTS <span id="playlist-count"></span>${icon("chevron-down")}</button><button class="caption-add" data-action="new-playlist" aria-label="New playlist" title="New playlist">${icon("plus")}</button></div>
    <div id="playlist-group" class="playlist-group${playlistsFolded ? " is-folded" : ""}"><div id="playlist-nav" class="playlist-nav"></div>
    <button class="nav-item" data-action="new-playlist">${icon("plus")}<span>New playlist</span></button></div>
  </nav>
  <div class="sidebar-bottom">
  <button class="nav-item" data-view="statistics">${icon("chart-column")}<span>Statistics</span></button>
  <button class="nav-item" data-view="settings">${icon("settings-2")}<span>Settings</span></button>
  <button class="nav-item collapse" data-action="collapse">${icon("chevrons-left")}<span>Collapse</span></button></div>
</aside>
<div class="workspace"><header class="topbar"><div class="breadcrumb">YOUR PERSONAL MUSIC SPACE</div><label class="search">${icon("search")}<input id="search" placeholder="Search your music" aria-label="Search your music"><kbd>Ctrl K</kbd></label><button class="button small" data-action="import">${icon("plus")} Import music</button></header><main id="content"></main><footer class="page-footer"><span>Made for the music you keep.</span><span class="footer-mark"><span class="footer-logo" aria-hidden="true">${edorasLogo}</span>EDORAS <span class="footer-dot">·</span> ${APP_VERSION}</span></footer></div>
<section id="player" class="player hidden" aria-label="Music player">
  <button class="mini-record" data-action="expand" aria-label="Open now playing"></button><div class="player-id"><button class="player-meta" data-action="expand"><b id="player-title"></b><small id="player-artist"></small></button><button class="icon-button add-ring" data-action="add-to-playlist" aria-label="Add this song to a playlist" title="Add to playlist">${icon("plus")}</button></div>
  <div class="transport"><button class="icon-button" data-action="previous" aria-label="Previous track">${icon("skip-back")}</button><button class="play-button" data-action="play" aria-label="Play">${icon("play")}</button><button class="icon-button" data-action="next" aria-label="Next track">${icon("skip-forward")}</button></div>
  <div class="mini-seek"><span class="elapsed">0:00</span><div class="wave-seek"><canvas id="mini-wave"></canvas><input class="seek" type="range" min="0" max="1000" value="0" aria-label="Seek track"></div>${durationButton()}</div>
  <div class="player-actions"><button class="icon-button lyrics-toggle" data-action="open-lyrics" aria-label="Show lyrics" aria-pressed="false" title="Lyrics">${icon("mic-vocal")}</button><button class="icon-button like" data-action="like" aria-label="Add to favorites">${icon("heart")}</button><button class="icon-button shuffle" data-action="shuffle" aria-label="Shuffle" aria-pressed="false">${icon("shuffle")}</button><button class="icon-button repeat" data-action="repeat" aria-label="Repeat off">${icon("repeat")}</button><div class="volume"><button class="icon-button mute" data-action="mute" aria-label="Mute">${icon("volume-2")}</button><input class="volume-slider" id="volume" type="range" min="0" max="100" value="${audio.volume * 100}" aria-label="Volume"></div><button class="icon-button" data-action="expand" aria-label="Expand player">${icon("chevron-up")}</button></div>
</section>
<dialog id="now-playing" class="now-playing" aria-label="Now playing"><button class="dialog-close icon-button" data-action="close-player" aria-label="Close now playing">${icon("x")}</button><div class="np-glow"></div>
<div class="np-stage"><p class="eyebrow">NOW PLAYING</p><h2 id="np-title"></h2><p class="np-meta" id="np-meta"></p>
  <div class="turntable"><div class="np-art"></div></div>
  <div class="np-transport"><canvas id="spectrum" aria-label="Live audio spectrum"></canvas><input class="seek" type="range" min="0" max="1000" value="0" aria-label="Seek now playing"><div class="np-times"><span class="elapsed">0:00</span>${durationButton()}</div><div class="np-volume"><button class="icon-button mute" data-action="mute" aria-label="Mute">${icon("volume-2")}</button><input class="volume-slider" type="range" min="0" max="100" value="${audio.volume * 100}" aria-label="Volume"></div><div class="np-buttons"><button class="icon-button" data-action="previous" aria-label="Previous track">${icon("skip-back")}</button><button class="play-button large" data-action="play" aria-label="Play">${icon("play")}</button><button class="icon-button" data-action="next" aria-label="Next track">${icon("skip-forward")}</button></div><div class="np-actions"><button class="icon-button like" data-action="like" aria-label="Add to favorites">${icon("heart")}</button><button class="icon-button shuffle" data-action="shuffle" aria-label="Shuffle">${icon("shuffle")}</button><button class="icon-button repeat" data-action="repeat" aria-label="Repeat off">${icon("repeat")}</button><button class="icon-button" data-action="identify" aria-label="Identify this song and fetch its details">${icon("search")}</button><button class="icon-button" data-action="add-to-playlist" aria-label="Add to a playlist">${icon("list-music")}</button><button class="icon-button" data-action="reveal" aria-label="Show audio file">${icon("folder-open")}</button></div></div>
</div><div class="np-side"><div class="tabs"><button class="selected" data-tab="queue">Up next <span id="queue-count"></span></button><button data-tab="lyrics">Lyrics</button><button data-tab="details">Track details</button></div><div id="np-side-content"></div><div class="np-foot">A little less noise. A little more music.</div></div></dialog>
<dialog id="import-dialog" class="import-dialog" aria-label="Import music"><button class="dialog-close icon-button" data-action="close-import" aria-label="Close import">${icon("x")}</button><div class="import-symbol">${icon("folder-plus")}</div><p class="eyebrow">BRING YOUR COLLECTION</p><h2>Make yourself <em>at home.</em></h2><p>Pick an album, a folder, or your whole music library.<br>We'll give every song a place.</p><div class="import-choices"><button class="button primary" data-action="pick-folder">${icon("folder-plus")} Choose folder</button><button class="button" data-action="pick-files">${icon("music-2")} Choose files</button></div><div class="import-explainer"><span>${icon("check")} Originals stay right where they are</span><span>${icon("check")} Copies organized by artist and album</span><span>${icon("check")} Existing tags and artwork read automatically</span></div><small class="formats">MP3 · FLAC · WAV · M4A · AAC · OGG · OPUS · AIFF · WMA + more</small></dialog>
<dialog id="playlist-dialog" class="import-dialog small-dialog" aria-label="New playlist"><button class="dialog-close icon-button" data-action="close-playlist" aria-label="Close">${icon("x")}</button><div class="import-symbol">${icon("list-music")}</div><p class="eyebrow">A SET OF YOUR OWN</p><h2>Name your <em>playlist.</em></h2><form id="playlist-form"><input id="playlist-name" maxlength="80" placeholder="Late night, Driving, Sunday morning" aria-label="Playlist name" autocomplete="off"><button class="button primary" type="submit">${icon("check")} Create</button></form></dialog>
<dialog id="add-dialog" class="import-dialog small-dialog" aria-label="Add to playlist"><button class="dialog-close icon-button" data-action="close-add" aria-label="Close">${icon("x")}</button><div class="import-symbol">${icon("list-music")}</div><p class="eyebrow">ADD TO A PLAYLIST</p><h2 id="add-title">This song</h2><div id="add-choices" class="add-choices"></div><button class="button" data-action="new-playlist">${icon("plus")} New playlist</button></dialog>
<dialog id="metadata-dialog" class="import-dialog metadata-dialog" aria-label="Fetch metadata"><button class="dialog-close icon-button" data-action="close-metadata" aria-label="Close metadata">${icon("x")}</button><div class="import-symbol">${icon("search")}</div><p class="eyebrow">FIND THE DETAILS</p><h2>Your song, <em>identified.</em></h2><p id="metadata-track"></p><form id="metadata-form"><label for="metadata-query">Song name or artist — title</label><div class="metadata-search"><input id="metadata-query" maxlength="300" autocomplete="off" placeholder="e.g. Eminem — Cold Wind Blows"><button class="button primary" type="submit">${icon("search")} Find matches</button></div></form><button class="button audio-identify" data-action="recognize-audio">${icon("headphones")} Identify by sound</button><p class="metadata-help">No account. No keys. Search only when you choose.<br>Sound identification sends a short acoustic fingerprint, never your audio file.</p><div id="metadata-status" role="status" aria-live="polite"></div><div id="metadata-results"></div></dialog>
<dialog id="confirm-dialog" class="import-dialog small-dialog confirm-dialog" aria-labelledby="confirm-title"><div class="import-symbol" id="confirm-symbol"></div><p class="eyebrow" id="confirm-eyebrow"></p><h2 id="confirm-title"></h2><p id="confirm-body"></p><div class="confirm-actions"><button class="button" data-action="confirm-cancel">Cancel</button><button class="button primary" id="confirm-ok" data-action="confirm-ok"></button></div></dialog>
<div class="drop-veil" aria-hidden="true"><span>Drop your music here</span></div><div id="toast" class="toast" role="status" aria-live="polite"></div><div id="import-progress" class="import-progress hidden" role="status"></div>`;

function notify(message: string) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(
    () => $("#toast").classList.remove("visible"),
    5500,
  );
}
function allTracks() {
  return [...library.tracks, ...demos];
}
const playlists = () => library.playlists ?? [];
// The loading state is a class rather than replacement markup, so the panel
// keeps its shape and the real content fades back into the same place.
function showIdentifying(active: boolean) {
  identifying = active;
  $("#now-playing").classList.toggle("is-identifying", active);
  document
    .querySelectorAll<HTMLButtonElement>('[data-action="identify"]')
    .forEach((el) => {
      el.disabled = active;
      el.setAttribute(
        "aria-label",
        active ? "Identifying…" : "Identify this song and fetch its details",
      );
    });
}
const currentPlaylist = () => playlists().find((p) => p.id === selection);
function renderPlaylistNav() {
  const list = playlists();
  $("#playlist-count").textContent = list.length ? String(list.length) : "";
  $("#playlist-group").classList.toggle("is-folded", playlistsFolded);
  $("#playlist-group").classList.toggle("has-playlists", list.length > 0);
  $(".playlist-toggle").setAttribute("aria-expanded", String(!playlistsFolded));
  $("#playlist-nav").innerHTML = list.length
    ? list
        .map(
          (p) =>
            `<button class="nav-item ${view === "playlist" && selection === p.id ? "active" : ""}" data-playlist="${escape(p.id)}">${p.cover ? `<img class="nav-cover" src="${escape(p.cover)}" alt="">` : `<i class="nav-cover nav-cover-blank" aria-hidden="true">${icon("list-music")}</i>`}<span>${escape(p.name)}</span><small>${p.trackIds.length}</small></button>`,
        )
        .join("")
    : `<p class="nav-empty">Nothing yet.</p>`;
  fitPlaylistNav();
}
// The playlist list takes the height the sidebar has left, down to two
// rows, and scrolls inside it; so however many playlists there are, they
// fit the window and the rest of the navigation does not have to be
// scrolled to reach them. New playlist is the + beside the caption, always
// in reach; the row version is only there while the list is empty, and on
// the collapsed rail, which has no caption.
const PLAYLIST_ROW = 52;
function fitPlaylistNav() {
  const nav = document.querySelector<HTMLElement>(".sidebar nav");
  const list = $("#playlist-nav");
  if (!nav || !list.offsetParent) {
    fadePlaylistNav();
    return;
  }
  const top =
    list.getBoundingClientRect().top -
    nav.getBoundingClientRect().top +
    nav.scrollTop;
  const create = document.querySelector<HTMLElement>(
    '#playlist-group > [data-action="new-playlist"]',
  );
  const below = create?.offsetParent ? create.offsetHeight + 6 : 0;
  const room = nav.clientHeight - top - below - 8;
  list.style.maxHeight = `${Math.max(PLAYLIST_ROW * 2, room)}px`;
  fadePlaylistNav();
}
addEventListener("resize", fitPlaylistNav);
// The caption above the list animates its height when the rail collapses.
document
  .querySelector(".sidebar")
  ?.addEventListener("transitionend", fitPlaylistNav);
// The last visible playlist fades while there are more below it.
function fadePlaylistNav() {
  const nav = $("#playlist-nav");
  nav.classList.toggle(
    "has-more",
    nav.scrollTop + nav.clientHeight < nav.scrollHeight - 2,
  );
}
$("#playlist-nav").addEventListener("scroll", fadePlaylistNav, {
  passive: true,
});
function artwork(track: Track, cls = "") {
  return track.cover
    ? `<img class="${cls}" src="${escape(track.cover)}" alt="${escape(track.album)} artwork" loading="lazy">`
    : `<div class="art-fallback ${cls}" style="--hue:${hash(track.albumArtist + track.album) % 360}">${icon("disc-3")}<span>${escape(track.album)}</span></div>`;
}
function hash(text: string) {
  return [...text].reduce(
    (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );
}
// Whether a card's music is what is playing right now: the song itself for a
// song card, any song from the record for an album card.
function cardPlaying(el: HTMLElement) {
  if (!current || audio.paused) return false;
  if (el.dataset.track) return el.dataset.track === current.id;
  if (el.dataset.album) return el.dataset.album === albumKey(current);
  if (el.dataset.playlist)
    return queueSource === `playlist:${el.dataset.playlist}`;
  return false;
}
function card(track: Track, mode = "track") {
  const album = mode === "album";
  const playing =
    !!current &&
    !audio.paused &&
    (album ? albumKey(current) === albumKey(track) : current.id === track.id);
  // The button on the artwork shows what pressing it will do: play, or pause
  // while this card's music is the music playing. On an album card it plays
  // the record rather than opening it; the rest of the card opens it.
  const play = album
    ? `<span class="cover-play" role="button" tabindex="-1" data-album-play="${escape(albumKey(track))}" aria-label="${playing ? "Pause" : "Play"} ${escape(track.album)}">${icon(playing ? "pause" : "play")}</span>`
    : `<span class="cover-play">${icon(playing ? "pause" : "play")}</span>`;
  return `<button class="music-card${playing ? " is-playing" : ""}" data-${album ? "album" : "track"}="${escape(album ? albumKey(track) : track.id)}"><div class="cover-wrap">${artwork(track)}${play}${track.demo ? '<span class="sample-badge">SOUND STUDY</span>' : `<span class="format-badge">${escape(track.format)}</span>`}</div><b>${escape(mode === "album" ? track.album : track.title)}</b><small>${escape(mode === "album" ? track.albumArtist : track.demo ? track.genre : track.artist)}</small></button>`;
}
// A fetched press photo when we have one, the artist's initials when we do
// not, so the shelf never has a hole in it.
// Tags disagree on case ("CAMEL", "Camel"), and a photo is stored once per
// artist whatever the case, so the lookup folds it too.
let photoSource: Record<string, string> | undefined;
let photoMap = new Map<string, string>();
function artistPhotoUrl(artist: string) {
  if (photoSource !== library.artists) {
    photoSource = library.artists;
    photoMap = new Map(
      Object.entries(library.artists ?? {}).map(([name, url]) => [
        name.trim().toLocaleLowerCase(),
        url,
      ]),
    );
  }
  return photoMap.get(artist.trim().toLocaleLowerCase());
}
function artistAvatar(artist: string, cls = "artist-avatar") {
  const photo = artistPhotoUrl(artist);
  if (photo)
    return `<div class="${cls} has-photo"><img src="${escape(photo)}" alt="" loading="lazy"></div>`;
  return `<div class="${cls}" style="--hue:${hash(artist) % 360}">${escape(
    artist
      .split(" ")
      .map((part) => part[0])
      .slice(0, 2)
      .join(""),
  )}</div>`;
}
function albumKey(track: Track) {
  return `${track.albumArtist}|||${track.album}`;
}
function filteredTracks() {
  const q = search.toLowerCase().trim();
  return library.tracks.filter((t) =>
    `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase().includes(q),
  );
}
// The first n of a list by a score, without sorting the whole list: the home
// page asks for five songs out of what may be forty thousand.
function topBy<T>(list: T[], n: number, score: (item: T) => number) {
  const best: { item: T; value: number }[] = [];
  for (const item of list) {
    const value = score(item);
    if (!(value > 0)) continue;
    if (best.length === n && value <= best[n - 1]!.value) continue;
    best.push({ item, value });
    best.sort((a, b) => b.value - a.value);
    if (best.length > n) best.pop();
  }
  return best.map((b) => b.item);
}
// A playlist's picture: the one the user chose, or the covers of its first
// four songs, or a plain tile. Always square and always the size of its box,
// so no picture can change the layout around it.
function playlistArt(playlist: Playlist, cls = "") {
  if (playlist.cover)
    return `<img class="playlist-art ${cls}" src="${escape(playlist.cover)}" alt="${escape(playlist.name)}" loading="lazy">`;
  const covers: string[] = [];
  for (const id of playlist.trackIds) {
    const cover = trackById.get(id)?.cover;
    if (cover && !covers.includes(cover)) covers.push(cover);
    if (covers.length === 4) break;
  }
  if (covers.length === 4)
    return `<div class="playlist-art mosaic ${cls}">${covers.map((c) => `<img src="${escape(c)}" alt="" loading="lazy">`).join("")}</div>`;
  if (covers.length)
    return `<img class="playlist-art ${cls}" src="${escape(covers[0]!)}" alt="" loading="lazy">`;
  return `<div class="playlist-art art-fallback ${cls}" style="--hue:${hash(playlist.name) % 360}">${icon("list-music")}</div>`;
}
// The playlist's songs in the order they were arranged, skipping any the
// library no longer has.
function playlistTracks(playlist: Playlist | undefined) {
  return (playlist?.trackIds ?? [])
    .map((id) => trackById.get(id))
    .filter((t): t is Track => !!t);
}
// A playlist card plays the playlist from its artwork, like an album card,
// and the rest of the card opens it. An empty playlist has nothing to play,
// so it has no button.
function playlistCard(playlist: Playlist) {
  const playing =
    !!current && !audio.paused && queueSource === `playlist:${playlist.id}`;
  const play = playlist.trackIds.length
    ? `<span class="cover-play" role="button" tabindex="-1" data-playlist-play="${escape(playlist.id)}" aria-label="${playing ? "Pause" : "Play"} ${escape(playlist.name)}">${icon(playing ? "pause" : "play")}</span>`
    : "";
  return `<button class="music-card playlist-card${playing ? " is-playing" : ""}" data-playlist="${escape(playlist.id)}"><div class="cover-wrap">${playlistArt(playlist)}${play}</div><b>${escape(playlist.name)}</b><small>${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? "song" : "songs"}</small></button>`;
}
// A number that stays the same all day and changes the next, so "Try
// listening" offers a steady handful rather than reshuffling on every visit.
function dailySeed(id: string) {
  const now = new Date();
  return hash(`${id}${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`);
}
function homeShelves(tracks: Track[]) {
  const grid = (list: Track[]) =>
    `<div class="music-grid">${list.map((t) => card(t)).join("")}</div>`;
  let html =
    sectionTitle(
      "Recently added",
      "Fresh arrivals in your collection.",
      `<button class="text-button" data-view="listen">View all ${icon("arrow-right")}</button>`,
    ) + grid(topBy(tracks, 5, (t) => t.addedAt));
  // The records most recently added, one card per album, newest first.
  const albums = new Map<string, Track>();
  for (const t of tracks) {
    const key = albumKey(t);
    const seen = albums.get(key);
    if (!seen || t.addedAt > seen.addedAt) albums.set(key, t);
  }
  if (albums.size)
    html +=
      sectionTitle(
        "Albums",
        "Whole records, start to finish.",
        `<button class="text-button" data-view="albums">View all ${icon("arrow-right")}</button>`,
      ) +
      `<div class="music-grid">${topBy(
        [...albums.values()],
        5,
        (t) => t.addedAt,
      )
        .map((t) => card(t, "album"))
        .join("")}</div>`;
  const heard = (id: string) => listening.tracks[id];
  const most = topBy(
    tracks,
    5,
    (t) => (heard(t.id)?.plays ?? 0) * 1e6 + (heard(t.id)?.seconds ?? 0),
  );
  if (most.length)
    html +=
      sectionTitle(
        "Most listened",
        "The songs you keep coming back to.",
        `<button class="text-button" data-view="statistics">Your statistics ${icon("arrow-right")}</button>`,
      ) + grid(most);
  const recent = topBy(tracks, 5, (t) => heard(t.id)?.last ?? 0);
  if (recent.length)
    html += sectionTitle("Jump back in", "Where you left off.") + grid(recent);
  const lists = playlists().filter((p) => p.trackIds.length);
  if (lists.length)
    html +=
      sectionTitle("Your playlists", "Sets of your own, arranged by hand.") +
      `<div class="music-grid">${lists
        .slice(0, 5)
        .map(playlistCard)
        .join("")}</div>`;
  const fresh = topBy(
    tracks.filter((t) => !heard(t.id)?.plays),
    5,
    (t) => dailySeed(t.id) + 1,
  );
  if (fresh.length)
    html +=
      sectionTitle(
        "Try listening",
        "From your library, and not played yet. A new handful every day.",
        `<button class="text-button" data-action="play-fresh">${icon("sparkles")} Play these</button>`,
      ) + grid(fresh);
  freshPicks = fresh;
  return html;
}
let freshPicks: Track[] = [];
// Looked up by id in several places per render; rebuilt only when the
// catalog itself is replaced.
let byIdSource: Track[] | null = null;
let byIdMap = new Map<string, Track>();
const trackById = {
  get(id: string) {
    if (byIdSource !== library.tracks) {
      byIdSource = library.tracks;
      byIdMap = new Map(library.tracks.map((t) => [t.id, t]));
    }
    return byIdMap.get(id);
  },
};
function sectionTitle(title: string, sub: string, right = "") {
  return `<div class="section-heading"><div><h2>${title}</h2><p>${sub}</p></div>${right}</div>`;
}
function empty(title: string, text: string) {
  return `<div class="empty"><div class="empty-disc">${icon("disc-3")}</div><h2>${title}</h2><p>${text}</p><button class="button primary" data-action="import">${icon("folder-plus")} Import your music</button></div>`;
}
// Three states per song, which is what "don't fetch it twice" needs to be
// visible: never looked up, looked up and matched, looked up with nothing
// confident to show for it. The button stays live in every one of them,
// because choosing the details by hand is always allowed.
function metadataState(track: Track) {
  if (!track.metadataFetchedAt) return "";
  return track.metadataSource ? "is-matched" : "is-unmatched";
}
function metadataButton(track: Track) {
  const state = metadataState(track);
  const label =
    state === "is-matched"
      ? `Details from ${track.metadataSource}. Choose different details for ${track.title}`
      : state === "is-unmatched"
        ? `No match was found for ${track.title}. Search again`
        : `Fetch details for ${track.title}`;
  return `<button class="icon-button metadata-button ${state}" data-metadata="${escape(track.id)}" aria-label="${escape(label)}" title="${escape(label)}">${icon(state === "is-matched" ? "circle-check" : "search")}</button>`;
}
// ---- The virtual table ---------------------------------------------------
// The whole library used to be rendered as DOM and left there. Forty
// thousand songs is a quarter of a million elements, which is where the
// memory goes and where the layout starts to give. The table keeps its real
// height, so the scrollbar is honest and every row has a fixed place, and
// only the rows within a screen of the viewport are built. Nothing about how
// the page reads or scrolls changes; the cost simply stops growing.
let virtualTracks: Track[] = [];
let virtualPlaylistId = "";
let painted = { first: -1, last: -1 };
let measuredRowHeight = 0;
function rowHeight() {
  if (!measuredRowHeight)
    measuredRowHeight =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--row-h"),
      ) || 69;
  return measuredRowHeight;
}
// A screen's worth either side, so a fast scroll or a keyboard page never
// reaches ahead of the rows that have been built.
const OVERSCAN_SCREENS = 1;
function paintRows(force = false) {
  const body = document.getElementById("table-body");
  const window_ = document.getElementById("table-window");
  if (!body || !window_) return;
  const height = rowHeight();
  const top = body.getBoundingClientRect().top;
  const screens = innerHeight * OVERSCAN_SCREENS;
  const first = Math.max(0, Math.floor((-top - screens) / height));
  const last = Math.min(
    virtualTracks.length,
    Math.ceil((-top + innerHeight + screens) / height),
  );
  if (!force && first === painted.first && last === painted.last) return;
  painted = { first, last };
  // The rows cascade in when the page arrives and never again: a repaint on
  // scroll would set every row in the new window animating, which is a
  // flicker, not an entrance. Only a fresh render that starts at the top of
  // the list counts as an arrival.
  window_.classList.toggle("is-entering", force && first === 0);
  window_.innerHTML = virtualTracks
    .slice(first, last)
    .map((track, i) => row(track, first + i, virtualPlaylistId))
    .join("");
  icons();
}
// The album and artist shelves are CSS grids, and a grid's own layout is
// what makes them respond to the window, so they are not taken apart and
// positioned by hand the way the table is. They are filled in instead: a
// screenful at a time, as the end of what has been drawn comes into view.
// Ten thousand albums used to be ten thousand cards and a second and a half
// of layout before the page could be touched.
const SHELF_BATCH = 90;
let shelfCards: string[] = [];
let shelfShown = 0;
function shelf(cards: string[], className: string) {
  shelfCards = cards;
  shelfShown = Math.min(SHELF_BATCH, cards.length);
  return `<div class="${className}" id="shelf">${cards.slice(0, shelfShown).join("")}</div>${cards.length > shelfShown ? '<div class="shelf-more" id="shelf-more"></div>' : ""}`;
}
function growShelf() {
  const marker = document.getElementById("shelf-more");
  const grid = document.getElementById("shelf");
  if (!marker || !grid) return;
  if (marker.getBoundingClientRect().top > innerHeight * 2) return;
  const next = Math.min(shelfShown + SHELF_BATCH, shelfCards.length);
  if (next === shelfShown) return;
  grid.insertAdjacentHTML(
    "beforeend",
    shelfCards.slice(shelfShown, next).join(""),
  );
  shelfShown = next;
  icons();
  if (shelfShown >= shelfCards.length) marker.remove();
}
// Scroll fires far more often than the window needs repainting, so the work
// is held to one paint per frame.
let paintQueued = false;
function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paintRows();
    growShelf();
  });
}
addEventListener("scroll", queuePaint, { passive: true });
addEventListener("resize", () => {
  measuredRowHeight = 0;
  const body = document.getElementById("table-body");
  if (body) body.style.height = `${virtualTracks.length * rowHeight()}px`;
  paintRows(true);
});

// The number doubles as the transport. Any row plays on click; the row that
// is already playing pauses instead, and says which it will do, so the icon
// beside the song matches the one in the bar rather than contradicting it.
function rowNumber(track: Track, index: number) {
  const playing = current?.id === track.id && !audio.paused;
  return `<button class="row-number" data-row-play="${escape(track.id)}" data-glyph="${playing ? "pause" : "play"}" aria-label="${playing ? `Pause ${escape(track.title)}` : `Play ${escape(track.title)}`}"><span>${index + 1}</span>${icon(playing ? "pause" : "play")}</button>`;
}
// The buttons at the end of a row. Every row can add to a playlist and
// fetch details; a favourite can be unhearted where it is listed; a playlist
// row can be moved and taken out of the playlist; any other row can delete
// the song from the library. The column is sized from the count, so the
// table never guesses.
function rowButtons(track: Track, playlistId = "") {
  const name = escape(track.title);
  const buttons = [
    `<button class="icon-button" data-add-track="${escape(track.id)}" aria-label="Add ${name} to a playlist" title="Add to playlist">${icon("list-music")}</button>`,
    metadataButton(track),
  ];
  if (playlistId) {
    const ids = currentPlaylist()?.trackIds;
    buttons.push(
      `<button class="icon-button" data-move="${escape(track.id)}" data-direction="-1" aria-label="Move ${name} up" ${ids?.[0] === track.id ? "disabled" : ""}>${icon("chevron-up")}</button>`,
      `<button class="icon-button" data-move="${escape(track.id)}" data-direction="1" aria-label="Move ${name} down" ${ids?.at(-1) === track.id ? "disabled" : ""}>${icon("chevron-down")}</button>`,
      `<button class="icon-button danger" data-remove="${escape(track.id)}" aria-label="Remove ${name} from this playlist" title="Remove from playlist">${icon("x")}</button>`,
    );
    return buttons;
  }
  if (view === "favorites" && !search)
    buttons.push(
      `<button class="icon-button row-unfavorite" data-unfavorite="${escape(track.id)}" aria-label="Remove ${name} from favorites" title="Remove from favorites">${icon("heart")}</button>`,
    );
  buttons.push(
    `<button class="icon-button danger row-delete" data-delete-track="${escape(track.id)}" aria-label="Delete ${name} from your library" title="Delete from library">${icon("trash-2")}</button>`,
  );
  return buttons;
}
function row(track: Track, index: number, playlistId = "") {
  return `<div class="track-row ${current?.id === track.id ? "is-current" : ""}" data-row="${escape(track.id)}" style="top:${index * rowHeight()}px">${rowNumber(track, index)}<button class="row-track" data-track="${escape(track.id)}">${artwork(track)}<span><b>${escape(track.title)}</b><small>${escape(track.artist)}</small></span></button><span class="row-album">${escape(track.album)}</span><span class="codec">${escape(track.format)}</span><span class="row-time">${time(track.duration)}</span><div class="row-actions">${rowButtons(track, playlistId).join("")}</div></div>`;
}
function rows(tracks: Track[], playlistId = "") {
  virtualTracks = tracks;
  virtualPlaylistId = playlistId;
  const buttons = playlistId ? 5 : view === "favorites" && !search ? 4 : 3;
  return `<div class="track-table ${playlistId ? "in-playlist" : ""}" style="--actions-w:${buttons * 30 + 8}px"><div class="table-head"><span>#</span><span>TITLE</span><span>ALBUM</span><span>FORMAT</span><span>TIME</span><span class="row-actions-heading">ACTIONS</span></div><div class="table-body" id="table-body" style="height:${tracks.length * rowHeight()}px"><div class="table-window" id="table-window"></div></div></div>`;
}
function render() {
  const tracks = filteredTracks();
  document
    .querySelectorAll("[data-view]")
    .forEach((el) =>
      el.classList.toggle("active", (el as HTMLElement).dataset.view === view),
    );
  $("#fav-count").textContent = String(
    library.tracks.filter((t) => t.favorite).length,
  );
  let html = "";
  if (view === "home" && !search) {
    const has = library.tracks.length > 0;
    html = `<section class="hero"><div class="hero-copy"><p class="eyebrow">EDORAS</p><h1>Your <em>music.</em></h1><p>The albums you love. The songs you come back to.<br>All together, just a play away.</p><div class="hero-actions">${
      has
        ? `<button class="button primary" data-action="play-all">${icon("play")} Start listening</button><button class="button" data-action="shuffle-all">${icon("shuffle")} Shuffle</button><button class="text-button" data-action="library-folder">Open your library folder ${icon("arrow-up-right")}</button>`
        : `<button class="button primary" data-action="import">${icon("folder-plus")} Import your music</button><button class="text-button" data-action="demo">Take it for a spin ${icon("arrow-up-right")}</button>`
    }</div></div></section>`;
    if (has) html += homeShelves(tracks);
    else
      html += `<div class="library-invitation"><div class="invitation-icon">${icon("library")}</div><div><b>Your collection starts here</b><p>Import a folder, or drop songs into your library folder. We'll take care of the artist and album shelves.</p></div><button class="text-button" data-action="import">Add music ${icon("plus")}</button></div>`;
  } else if (view === "statistics" && !search) {
    html = statisticsPage({
      tracks: library.tracks,
      playlists: playlists(),
      stats: listening,
      range: statsRange,
      artwork,
      avatar: artistAvatar,
      icon,
      escape,
    });
  } else if (view === "lyrics" && !search) {
    html = lyricsPage();
  } else if (view === "settings" && !search) {
    html = `<div class="page-heading"><p class="eyebrow">MAKE IT YOURS</p><h1>Little details.<br><em>Better listening.</em></h1></div><div class="settings-card"><div><h3>Your library folder</h3><p>Songs you import are copied here and sorted by artist and album; the originals stay where they were. Songs you put in this folder yourself, in any folder inside it, join your library where they are.</p><code>${escape(library.root || "Available in the desktop app")}</code></div><div class="settings-actions"><button class="button" data-action="library-folder">${icon("folder-open")} Open library folder</button><button class="button" data-action="choose-library">Choose location</button></div><small>Choosing a new location switches libraries. Your existing library stays in its current folder.</small></div><div class="settings-card setting-row"><div><h3>Appearance</h3><p>Match your system, or pick one and stay there.</p></div><div class="theme-choice" role="group" aria-label="Appearance">${THEMES.map((t) => `<button data-action="theme-${t}" aria-pressed="${theme === t}" class="${theme === t ? "on" : ""}">${t[0]!.toUpperCase()}${t.slice(1)}</button>`).join("")}</div></div><div class="settings-card setting-row"><div><h3>Watch the library folder</h3><p>Songs added to the folder appear in Edoras on their own, and songs deleted from it leave.</p></div><button class="switch ${library.watching ? "on" : ""}" role="switch" aria-checked="${!!library.watching}" aria-label="Watch the library folder" data-action="watch"></button></div><div class="settings-card"><h3>Built for your collection</h3><p>MP3, FLAC, WAV, M4A, AAC, OGG, OPUS, AIFF, WMA, ALAC, APE and WavPack. Older codecs are decoded locally when needed.</p><p>Embedded tags, album art and lyrics are read on import. Song details, artwork and artist photos come from Deezer, with Apple Music and MusicBrainz filling the gaps, and lyrics from LRCLIB. Only when you ask: a row, Now Playing, an artist page, or Fetch Library Metadata. No login or key is needed. Nothing is ever written back into your audio files.</p></div><div class="settings-card"><h3>At your fingertips</h3><div class="shortcut-list"><span><kbd>Space</kbd> Play / pause</span><span><kbd>Ctrl K</kbd> Search</span><span><kbd>Esc</kbd> Close player</span><span><kbd>←</kbd> / <kbd>→</kbd> Seek 5 seconds</span></div></div>`;
  } else {
    let title = search
      ? "Search results"
      : {
          listen: "Your library",
          albums: "Albums",
          artists: "Artists",
          favorites: "Favorites",
          album: selection.split("|||")[1],
        }[view] || "Your library";
    let list = tracks;
    if (view === "favorites") list = tracks.filter((t) => t.favorite);
    if (view === "album")
      list = tracks
        .filter((t) => albumKey(t) === selection)
        .sort((a, b) => a.disc - b.disc || a.number - b.number);
    if (view === "artist") {
      list = tracks.filter((t) => t.albumArtist === selection);
      title = selection;
    }
    // An album keeps the order the record was made in and a playlist keeps
    // the order it was arranged in; everything else takes the chosen sort.
    if (view !== "album" && view !== "playlist") list = sortTracks(list);
    const playlist = view === "playlist" ? currentPlaylist() : undefined;
    if (view === "playlist") {
      title = playlist?.name ?? "Playlist";
      // Ordered by the playlist, not by the library.
      list = (playlist?.trackIds ?? [])
        .map((id) => tracks.find((t) => t.id === id))
        .filter((t): t is Track => !!t);
    }
    // An album, an artist and a playlist each open with their own Play and
    // Shuffle. Play reads Pause while that same collection is what is on.
    const source =
      view === "album"
        ? `album:${selection}`
        : view === "artist"
          ? `artist:${selection}`
          : view === "playlist"
            ? `playlist:${selection}`
            : "";
    const collectionTools =
      source && list.length && !search
        ? `<button class="button primary" data-action="play-collection" data-collection-play="${escape(source)}">${icon("play")} Play</button><button class="button" data-action="shuffle-collection">${icon("shuffle")} Shuffle</button>${
            view === "artist"
              ? `<button class="text-button" data-action="artist-photo">${icon("user-round")} ${artistPhotoUrl(selection) ? "Look for a new photo" : "Find a photo"}</button>`
              : ""
          }`
        : "";
    const back =
      view === "album" || view === "artist"
        ? `<button class="text-button" data-view="${view === "album" ? "albums" : "artists"}">${icon("arrow-left")} Back</button>`
        : "";
    const summary = search
      ? `Results for “${escape(search)}”`
      : view === "playlist"
        ? `${list.length} ${list.length === 1 ? "song" : "songs"} · ${minutes(list)}`
        : `${list.length} ${list.length === 1 ? "track" : "tracks"} · ${plural(new Set(list.map(albumKey)).size, "album")} · Yours to keep.`;
    if (view === "playlist" && playlist)
      html = `<div class="page-heading playlist-heading"><button class="playlist-cover" data-action="playlist-cover" aria-label="Choose a picture for ${escape(playlist.name)}" title="Choose a picture">${playlistArt(playlist)}<span class="playlist-cover-edit">${icon("image-plus")}</span></button><div class="playlist-heading-text"><p class="eyebrow">PLAYLIST</p><h1>${escape(title)}</h1><p>${summary}</p><div class="playlist-tools">${collectionTools}<button class="text-button" data-action="playlist-cover">${icon("image-plus")} ${playlist.cover ? "Change picture" : "Add a picture"}</button>${playlist.cover ? `<button class="text-button" data-action="remove-playlist-cover">${icon("x")} Remove picture</button>` : ""}<button class="text-button" data-action="rename-playlist">${icon("pencil")} Rename</button><button class="text-button danger" data-action="delete-playlist">${icon("trash-2")} Delete playlist</button></div></div></div>`;
    else
      html = `<div class="page-heading">${back}<h1>${escape(title)}</h1><p>${summary}</p>${collectionTools ? `<div class="playlist-tools">${collectionTools}</div>` : ""}</div>`;
    if (view === "playlist" && !list.length)
      html += empty(
        "An empty playlist.",
        "Open Library and use the playlist button beside any song.",
      );
    else if (!list.length)
      html += empty(
        search
          ? "Nothing here yet."
          : view === "favorites"
            ? "Keep your favorites close."
            : "A little quiet in here.",
        search
          ? "Try another title, artist or album."
          : view === "favorites"
            ? "Tap the heart while a song is playing to save it here."
            : "Bring over the music you love to start your collection.",
      );
    else if (view === "albums" && !search)
      html +=
        `<div class="list-actions">${sortControl()}</div>` +
        shelf(
          [...new Map(list.map((t) => [albumKey(t), t])).values()].map((t) =>
            card(t, "album"),
          ),
          "music-grid albums-grid",
        );
    else if (view === "artists" && !search) {
      // One pass for the counts: asking each artist to filter the whole
      // library is fine for twenty artists and quadratic for two thousand.
      const counts = new Map<string, number>();
      for (const t of list)
        counts.set(t.albumArtist, (counts.get(t.albumArtist) ?? 0) + 1);
      html +=
        `<div class="list-actions">${sortControl()}</div>` +
        shelf(
          [...counts.keys()].map(
            (artist) =>
              `<button class="artist-card" data-artist="${escape(artist)}">${artistAvatar(artist)}<h3>${escape(artist)}</h3><p>${counts.get(artist)} ${counts.get(artist) === 1 ? "track" : "tracks"}</p></button>`,
          ),
          "artist-grid",
        );
    } else if (view === "playlist") html += rows(list, playlist?.id ?? "");
    else
      html += `<div class="list-actions">${collectionTools ? "" : `<button class="button primary" data-action="play-all">${icon("play")} Play all</button><button class="button" data-action="shuffle-all">${icon("shuffle")} Shuffle</button>`}<button class="button" data-action="add-shown">${icon("list-music")} Add to playlist</button><button class="button" data-action="fetch-library-metadata">${icon("search")} Fetch Library Metadata</button>${sortControl()}<span>${minutes(list)}</span></div>${rows(list)}`;
  }
  $("#content").innerHTML = html;
  renderPlaylistNav();
  icons();
  if (view === "statistics" && !search) countUp($("#content"));
  const onLyrics = view === "lyrics" && !search;
  document.querySelectorAll(".lyrics-toggle").forEach((el) => {
    el.classList.toggle("selected", onLyrics);
    el.setAttribute("aria-pressed", String(onLyrics));
    el.setAttribute("aria-label", onLyrics ? "Hide lyrics" : "Show lyrics");
  });
  refreshCollectionButtons();
  // The table only writes its own frame; the rows on screen are filled in
  // here, after the frame is in the document and has a position to measure.
  painted = { first: -1, last: -1 };
  paintRows(true);
  // A shelf shorter than the window would otherwise wait for a scroll that
  // never comes.
  growShelf();
}
// Play all, Shuffle and clicking a song all queue what the page is showing,
// so the queue has to be sorted the same way the table is.
function visibleQueue() {
  let list = filteredTracks();
  if (view === "favorites") list = list.filter((t) => t.favorite);
  if (view === "album")
    return list
      .filter((t) => albumKey(t) === selection)
      .sort((a, b) => a.disc - b.disc || a.number - b.number);
  if (view === "artist") list = list.filter((t) => t.albumArtist === selection);
  return sortTracks(list);
}
// The songs of the album, artist or playlist on screen, in the order the page
// shows them.
function collectionList() {
  if (view === "playlist") return playlistTracks(currentPlaylist());
  return visibleQueue();
}
// What a song clicked on this page should be queued with: the playlist in
// its own order on a playlist, the page's list everywhere else.
function pageQueue() {
  return view === "playlist" && !search ? collectionList() : visibleQueue();
}
function pageSource() {
  if (search) return "";
  if (view === "album" || view === "artist" || view === "playlist")
    return `${view}:${selection}`;
  return "";
}
function go(next: string) {
  // Remember the page the lyrics were opened from, however they were opened,
  // so the lyrics button can take the user straight back to it.
  if (next === "lyrics" && view !== "lyrics")
    lyricsReturn = { view, selection, scroll: scrollY };
  view = next;
  search = "";
  $<HTMLInputElement>("#search").value = "";
  render();
  window.scrollTo({ top: 0 });
}
// The lyrics button is a toggle: the first press shows the lyrics, the second
// puts back the page that was open before, scrolled where it was.
function toggleLyrics() {
  if (view !== "lyrics" || search) {
    go("lyrics");
    return;
  }
  const back = lyricsReturn ?? { view: "home", selection: "", scroll: 0 };
  lyricsReturn = null;
  selection = back.selection;
  go(back.view);
  // The table and shelves fill themselves in as they come into view, so the
  // position is restored after they have a frame to lay out in.
  requestAnimationFrame(() => {
    window.scrollTo({ top: back.scroll });
    queuePaint();
  });
}
async function setupAudio() {
  if (!context) {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const source = context.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(context.destination);
  }
  await context.resume();
}
// Colour and waveform are both derived from the track and both resolve late,
// so each is versioned against the load that asked for it. Without that, a
// slow decode from a previous track can repaint the bar for the current one.
async function applyTrackAccent(track: Track, version: number) {
  const seed = hash(track.albumArtist + track.album);
  const accent: Accent = track.cover
    ? await accentFromArtwork(track.cover, seed)
    : accentFromHash(seed);
  if (version !== loadVersion) return;
  applyAccent(accent);
  refreshWaveColors();
}
function loadWaveform(track: Track, source: string, version: number) {
  void peaksFor(track.id, source).then(() => {
    if (version === loadVersion) waveKey = "";
  });
}
async function start(track: Track, list?: Track[], from = "") {
  flushListening();
  loadVersion++;
  current = track;
  fallback = false;
  resumeTime = 0;
  heardThisPlay = 0;
  countedThisPlay = false;
  lastPosition = 0;
  if (list) {
    queue = list;
    queueSource = from;
  } else if (!queue.some((t) => t.id === track.id)) {
    queue = track.demo ? demos : pageQueue();
    queueSource = "";
  }
  const source = track.url || `edoras://app/media/audio/${track.id}`;
  audio.src = source;
  void applyTrackAccent(track, loadVersion);
  loadWaveform(track, source, loadVersion);
  updatePlayer();
  if (expanded) renderSide();
  try {
    await setupAudio();
    await audio.play();
  } catch (error) {
    if ((error as Error).name !== "AbortError") notify("Preparing audio…");
  }
}
async function togglePlay() {
  if (!current) {
    if (library.tracks[0]) await start(library.tracks[0], library.tracks);
    else await start(demos[0], demos);
    return;
  }
  if (audio.paused) {
    await setupAudio();
    try {
      await audio.play();
    } catch {
      notify("This track could not be played. Try reimporting the file.");
    }
  } else audio.pause();
}
function next(direction = 1, ended = false) {
  if (!current || !queue.length) return;
  // Repeat one means this song, whether it ran out or the user pressed next.
  // Previous is left alone: going back is how you leave a song on repeat.
  if (repeat === 2 && (ended || direction > 0)) {
    audio.currentTime = 0;
    void audio.play();
    return;
  }
  if (direction < 0 && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const index = queue.findIndex((t) => t.id === current!.id);
  let dest = index + direction;
  if (shuffle && queue.length > 1) {
    do {
      dest = Math.floor(Math.random() * queue.length);
    } while (dest === index);
  }
  if (ended && dest >= queue.length && repeat === 0) {
    audio.pause();
    updatePlayer();
    return;
  }
  void start(queue[(dest + queue.length) % queue.length]);
}
// The library table is rendered once and left alone while music plays, so
// the row that reads as "playing" has to be moved by hand on every track
// change. Re-rendering instead would throw away the scroll position and any
// open menu, for one class on two elements.
function refreshCurrentRows() {
  document.querySelectorAll<HTMLElement>(".track-row").forEach((element) => {
    const isCurrent = element.dataset.row === current?.id;
    element.classList.toggle("is-current", isCurrent);
    const button = element.querySelector<HTMLElement>(".row-number");
    if (!button) return;
    const playing = isCurrent && !audio.paused;
    const wanted = playing ? "pause" : "play";
    if (button.dataset.glyph === wanted) return;
    button.dataset.glyph = wanted;
    const number = button.querySelector("span")?.outerHTML ?? "";
    button.innerHTML = number + icon(wanted);
    button.setAttribute(
      "aria-label",
      `${playing ? "Pause" : "Play"} ${current && isCurrent ? current.title : (element.querySelector(".row-track b")?.textContent ?? "")}`,
    );
    icons();
  });
  document.querySelectorAll<HTMLElement>(".queue-track").forEach((row) => {
    row.classList.toggle("is-current", row.dataset.track === current?.id);
  });
}
function trackLength() {
  return Number.isFinite(audio.duration) && audio.duration
    ? audio.duration
    : (current?.duration ?? 0);
}
// Length or countdown, whichever the user last chose.
function paintDuration() {
  const length = trackLength();
  const text = showRemaining
    ? `-${time(Math.max(0, length - audio.currentTime))}`
    : time(length);
  document.querySelectorAll<HTMLElement>(".duration").forEach((el) => {
    if (el.textContent !== text) el.textContent = text;
  });
}
// Song and album cards show pause on their artwork while their music plays,
// and only the cards whose state changed are touched.
function refreshCardGlyphs() {
  document
    .querySelectorAll<HTMLElement>(
      ".music-card[data-track], .music-card[data-album], .music-card[data-playlist]",
    )
    .forEach((el) => {
      const playing = cardPlaying(el);
      if (el.classList.contains("is-playing") === playing) return;
      el.classList.toggle("is-playing", playing);
      const button = el.querySelector(".cover-play");
      if (button) {
        button.innerHTML = icon(playing ? "pause" : "play");
        if (button.hasAttribute("aria-label"))
          button.setAttribute(
            "aria-label",
            `${playing ? "Pause" : "Play"} ${el.querySelector("b")?.textContent ?? ""}`,
          );
      }
    });
}
// A collection's Play button reads Pause while that collection is playing.
function refreshCollectionButtons() {
  let changed = false;
  document
    .querySelectorAll<HTMLElement>("[data-collection-play]")
    .forEach((el) => {
      const playing =
        !audio.paused && !!current && queueSource === el.dataset.collectionPlay;
      const wanted = playing ? "pause" : "play";
      if (el.dataset.glyph === wanted) return;
      el.dataset.glyph = wanted;
      el.innerHTML = `${icon(wanted)} ${playing ? "Pause" : "Play"}`;
      changed = true;
    });
  if (changed) icons();
}
function updatePlayer() {
  if (!current) return;
  $("#player").classList.remove("hidden");
  document.body.classList.add("has-player");
  $("#player-title").textContent = current.title;
  $("#player-artist").textContent = current.artist;
  // Plate and label spin; the sheen and tonearm are fixed light and hardware,
  // so they sit outside the rotating element.
  $(".mini-record").innerHTML = artwork(current);
  $("#np-title").textContent = current.title;
  $("#np-meta").textContent =
    `${current.artist} · ${current.album} · ${current.format}`;
  $(".np-art").innerHTML = artwork(current);
  refreshCurrentRows();
  document.body.classList.toggle("is-playing", !audio.paused);
  document.querySelectorAll('[data-action="play"]').forEach((el) => {
    el.innerHTML = icon(audio.paused ? "play" : "pause");
    el.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  });
  document.querySelectorAll(".like").forEach((el) => {
    el.classList.toggle("selected", !!current?.favorite);
    el.setAttribute(
      "aria-label",
      current?.favorite ? "Remove from favorites" : "Add to favorites",
    );
    el.setAttribute("aria-pressed", String(!!current?.favorite));
  });
  document.querySelectorAll(".shuffle").forEach((el) => {
    el.classList.toggle("selected", shuffle);
    el.setAttribute("aria-pressed", String(shuffle));
    el.setAttribute("title", shuffle ? "Shuffle is on" : "Shuffle is off");
  });
  document.querySelectorAll(".repeat").forEach((el) => {
    el.classList.toggle("selected", !!repeat);
    el.innerHTML = icon(repeat === 2 ? "repeat-1" : "repeat");
    const label = ["Repeat off", "Repeat all", "Repeat one"][repeat]!;
    el.setAttribute("aria-label", label);
    el.setAttribute("title", label);
    el.setAttribute("aria-pressed", String(!!repeat));
  });
  paintDuration();
  refreshCardGlyphs();
  refreshCollectionButtons();
  icons();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album,
    });
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  }
}
let sideTab = "queue";
function renderSide() {
  if (!current) return;
  $("#queue-count").textContent = String(queue.length);
  document
    .querySelectorAll("[data-tab]")
    .forEach((el) =>
      el.classList.toggle(
        "selected",
        (el as HTMLElement).dataset.tab === sideTab,
      ),
    );
  let html = "";
  if (sideTab === "queue")
    html = `<p class="queue-label">${current.demo ? "EDORAS SESSIONS · ORIGINAL SOUND STUDIES" : "YOUR LISTENING QUEUE"}</p>${queue.map((t, i) => `<button class="queue-track ${t.id === current?.id ? "is-current" : ""}" data-track="${escape(t.id)}"><span class="queue-number">${t.id === current?.id ? icon("headphones") : String(i + 1).padStart(2, "0")}</span>${artwork(t)}<span><b>${escape(t.title)}</b><small>${escape(t.artist)}</small></span><small>${time(t.duration)}</small></button>`).join("")}<div class="queue-note">${icon("disc-3")}<h3>${current.demo ? "A first spin." : "Stay a little longer."}</h3><p>${current.demo ? "These short, original sound studies are included so you can try the player before importing your collection." : "Your music plays directly from your own library. No connection needed."}</p></div>`;
  else if (sideTab === "lyrics") html = lyricsPanel(current);
  else
    html = `<p class="queue-label">THE DETAILS</p><dl>${[
      ["Artist", current.artist],
      ["Album", current.album],
      ["Album artist", current.albumArtist],
      ["Track", current.number],
      ["Year", current.year || "—"],
      ["Genre", current.genre || "—"],
      ["Format", current.format],
      [
        "Sample rate",
        current.sampleRate ? `${current.sampleRate / 1000} kHz` : "—",
      ],
      ["Bit depth", current.bitDepth ? `${current.bitDepth} bit` : "—"],
      ["Source", current.demo ? "Included sound study" : "Your local library"],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(v)}</dd></div>`)
      .join("")}</dl>`;
  $("#np-side-content").innerHTML = html;
  icons();
}
// Lyrics come from three places and the panel says which: the file's own
// tags, a lookup the user asked for, or the user's own typing. Nothing is
// fetched by opening this tab; a library-wide fetch collects lyrics too, so
// most songs already have theirs by the time anyone looks.
function lyricsPanel(track: Track) {
  if (lyricsEditing)
    return `<p class="queue-label">YOUR OWN WORDS</p><textarea id="lyrics-input" dir="auto" placeholder="Paste the lyrics here." aria-label="Lyrics for ${escape(track.title)}">${escape(track.lyrics)}</textarea><div class="lyrics-tools"><button class="button primary" data-action="save-lyrics">${icon("check")} Save lyrics</button><button class="button" data-action="cancel-lyrics">Cancel</button></div>`;
  if (lyricsBusy)
    return `<div class="side-empty">${icon("search")}<h3>Looking for the words…</h3><p>Checking the lyrics library for this song.</p></div>`;
  if (track.lyrics)
    return `<p class="queue-label">${escape((track.lyricsSource || "EMBEDDED LYRICS").toUpperCase())}</p><div class="lyrics" dir="auto">${escape(track.lyrics)}</div><div class="lyrics-tools"><button class="text-button" data-action="edit-lyrics">${icon("pencil")} Edit</button>${track.demo ? "" : `<button class="text-button" data-action="fetch-lyrics">${icon("rotate-ccw")} Look again</button>`}</div>`;
  return `<div class="side-empty">${icon("music-2")}<h3>Lyrics can't be found.</h3><p>Nothing is stored in this file. Look online, or put the words in yourself.</p><div class="lyrics-tools">${track.demo ? "" : `<button class="button primary" data-action="fetch-lyrics">${icon("search")} Look online</button>`}<button class="button" data-action="edit-lyrics">${icon("pencil")} Paste lyrics</button></div></div>`;
}
// The same three states the Now Playing tab has, given a page of their own:
// the words are the point, so they get the room, and the song they belong to
// sits beside them rather than above them. Reached from the sidebar, from
// the button on the player bar, and from the tab in the popup.
function lyricsPage() {
  const track = current;
  const heading = `<div class="page-heading"><h1>Lyrics</h1><p>${track ? `${escape(track.title)} · ${escape(track.artist)}` : "Play something and its words will be here."}</p></div>`;
  if (!track)
    return `${heading}<div class="empty"><div class="empty-disc">${icon("mic-vocal")}</div><h2>Nothing is playing.</h2><p>Start a song and Edoras will show its lyrics here.</p><button class="button primary" data-view="listen">${icon("library")} Open your library</button></div>`;
  const aside = `<div class="lyrics-aside">${artwork(track)}<h3>${escape(track.title)}</h3><p>${escape(track.artist)}<br>${escape(track.album)}</p></div>`;
  let body;
  if (lyricsEditing)
    body = `<div><p class="lyrics-source">YOUR OWN WORDS</p><textarea id="lyrics-page-input" dir="auto" placeholder="Paste the lyrics here." aria-label="Lyrics for ${escape(track.title)}">${escape(track.lyrics)}</textarea><div class="lyrics-tools"><button class="button primary" data-action="save-lyrics">${icon("check")} Save lyrics</button><button class="button" data-action="cancel-lyrics">Cancel</button></div></div>`;
  else if (lyricsBusy)
    body = `<div class="lyrics-blank">${icon("search")}<h3>Looking for the words…</h3><p>Checking the lyrics library for this song.</p></div>`;
  else if (track.lyrics)
    body = `<div><p class="lyrics-source">${escape((track.lyricsSource || "EMBEDDED LYRICS").toUpperCase())}</p><div class="lyrics-body" dir="auto">${escape(track.lyrics)}</div><div class="lyrics-tools"><button class="text-button" data-action="edit-lyrics">${icon("pencil")} Edit</button>${track.demo ? "" : `<button class="text-button" data-action="fetch-lyrics">${icon("rotate-ccw")} Look again</button>`}</div></div>`;
  else
    body = `<div class="lyrics-blank">${icon("music-2")}<h3>Lyrics can't be found.</h3><p>Nothing is stored in this file. Look online, or put the words in yourself.</p><div class="lyrics-tools">${track.demo ? "" : `<button class="button primary" data-action="fetch-lyrics">${icon("search")} Look online</button>`}<button class="button" data-action="edit-lyrics">${icon("pencil")} Paste lyrics</button></div></div>`;
  return `${heading}<div class="lyrics-page">${aside}${body}</div>`;
}
// The words can be on screen twice at once, so anything that changes them
// refreshes both places rather than whichever one it happens to know about.
function refreshLyrics() {
  if (expanded) renderSide();
  if (view === "lyrics") render();
}
function replaceTrackEverywhere(next: Track) {
  queue = queue.map((t) => (t.id === next.id ? next : t));
  if (current?.id === next.id) current = next;
}
function afterLibraryChange(data: LibraryData) {
  library = data;
  const updated = current && library.tracks.find((t) => t.id === current!.id);
  if (updated) replaceTrackEverywhere(updated);
  queue = queue.map(
    (t) => library.tracks.find((updated) => updated.id === t.id) || t,
  );
  render();
  updatePlayer();
  if (expanded) renderSide();
}
function openPlayer() {
  if (!current) return;
  lastFocus = document.activeElement as HTMLElement;
  expanded = true;
  renderSide();
  $<HTMLDialogElement>("#now-playing").showModal();
}
function closePlayer() {
  expanded = false;
  $<HTMLDialogElement>("#now-playing").close();
  lastFocus?.focus();
}
async function importMusic(kind: string) {
  if (!window.edoras) {
    notify(
      "Folder imports are available in the Edoras desktop app. Try a sound study here.",
    );
    return;
  }
  if (busy) return;
  busy = true;
  $<HTMLDialogElement>("#import-dialog").close();
  try {
    const result = await window.edoras.importMusic(kind);
    if (result) acceptImport(result);
  } catch (error) {
    notify(`Import failed: ${(error as Error).message}`);
  } finally {
    busy = false;
    $("#import-progress").classList.add("hidden");
  }
}
function acceptImport(result: ImportResult) {
  library = { ...library, ...result.library };
  render();
  $("#import-progress").classList.add("hidden");
  if (result.errors.length)
    notify(
      `${result.imported} imported · ${result.duplicates} duplicates · ${result.errors.length} could not be read: ${result.errors[0].file}`,
    );
  else if (result.imported || result.duplicates)
    notify(
      `${result.imported} ${result.imported === 1 ? "track" : "tracks"} added${result.duplicates ? ` · ${result.duplicates} already in your library` : ""}`,
    );
  else notify("No supported audio files found in this folder.");
}
async function desktopAction(fn: () => Promise<unknown>) {
  if (!window.edoras) {
    notify("This feature is available in the Edoras desktop app.");
    return;
  }
  await fn();
}
async function action(name: string) {
  switch (name) {
    case "import":
      $<HTMLDialogElement>("#import-dialog").showModal();
      break;
    case "close-import":
      $<HTMLDialogElement>("#import-dialog").close();
      break;
    case "new-playlist":
      pendingPlaylistTracks = $<HTMLDialogElement>("#add-dialog").open
        ? [...addTrackIds]
        : [];
      renamingPlaylistId = "";
      $<HTMLDialogElement>("#add-dialog").close();
      $("#playlist-dialog h2").innerHTML = "Name your <em>playlist.</em>";
      $("#playlist-form button").innerHTML = `${icon("check")} Create`;
      icons();
      $<HTMLDialogElement>("#playlist-dialog").showModal();
      $<HTMLInputElement>("#playlist-name").value = "";
      $<HTMLInputElement>("#playlist-name").focus();
      break;
    case "close-playlist":
      $<HTMLDialogElement>("#playlist-dialog").close();
      break;
    case "close-add":
      $<HTMLDialogElement>("#add-dialog").close();
      break;
    case "rename-playlist": {
      const playlist = currentPlaylist();
      if (!playlist) break;
      pendingPlaylistTracks = [];
      renamingPlaylistId = playlist.id;
      $("#playlist-dialog h2").innerHTML = "Rename your <em>playlist.</em>";
      $("#playlist-form button").innerHTML = `${icon("check")} Save`;
      $<HTMLInputElement>("#playlist-name").value = playlist.name;
      icons();
      $<HTMLDialogElement>("#playlist-dialog").showModal();
      $<HTMLInputElement>("#playlist-name").select();
      break;
    }
    case "add-shown":
      await openAddDialog(pageQueue().map((t) => t.id));
      break;
    case "add-to-playlist": {
      if (!current) break;
      await openAddDialog([current.id]);
      break;
    }
    case "identify": {
      if (current) await openMetadata(current.id);
      break;
    }
    case "close-metadata":
      $<HTMLDialogElement>("#metadata-dialog").close();
      break;
    case "recognize-audio":
      await findMetadata("audio");
      break;
    case "play-collection":
    case "shuffle-collection": {
      const source =
        view === "playlist" ? `playlist:${selection}` : `${view}:${selection}`;
      // Play on the collection that is already on is pause and resume, the
      // same as the bar's own button.
      if (name === "play-collection" && current && queueSource === source) {
        await togglePlay();
        break;
      }
      const list = collectionList();
      if (!list.length) break;
      shuffle = name === "shuffle-collection";
      await start(
        list[shuffle ? Math.floor(Math.random() * list.length) : 0]!,
        list,
        source,
      );
      break;
    }
    case "play-fresh":
      if (freshPicks[0]) {
        shuffle = false;
        await start(freshPicks[0], [...freshPicks], "fresh");
      }
      break;
    case "playlist-cover":
    case "remove-playlist-cover": {
      const playlist = currentPlaylist();
      if (!playlist) break;
      await desktopAction(async () => {
        const result = await window.edoras!.setPlaylistCover(
          playlist.id,
          name === "remove-playlist-cover",
        );
        if (!result) return;
        library = result;
        render();
        notify(
          name === "remove-playlist-cover"
            ? "Picture removed."
            : "Playlist picture saved.",
        );
      });
      break;
    }
    case "toggle-remaining":
      showRemaining = !showRemaining;
      localStorage.setItem(
        "edoras-time",
        showRemaining ? "remaining" : "total",
      );
      document.querySelectorAll(".time-toggle").forEach((el) => {
        el.setAttribute(
          "aria-label",
          showRemaining
            ? "Showing time remaining. Show the length instead"
            : "Showing the length. Show time remaining instead",
        );
        el.setAttribute(
          "title",
          showRemaining ? "Show the length" : "Show time remaining",
        );
      });
      paintDuration();
      break;
    case "delete-playlist": {
      const playlist = currentPlaylist();
      if (!playlist) break;
      // The tracks themselves are untouched, but the arrangement is gone,
      // and that is the part the user made by hand.
      if (
        !(await ask({
          symbol: "trash-2",
          eyebrow: "DELETE PLAYLIST",
          title: "Delete this <em>playlist?</em>",
          body: `“${playlist.name}” goes, with its order and picture. Your songs stay in your library.`,
          confirm: "Delete playlist",
          danger: true,
        }))
      )
        break;
      await desktopAction(async () => {
        library = await window.edoras!.deletePlaylist(playlist.id);
        selection = "";
        go("home");
        notify(`“${playlist.name}” deleted. Your songs are untouched.`);
      });
      break;
    }
    case "pick-folder":
      await importMusic("folder");
      break;
    case "pick-files":
      await importMusic("files");
      break;
    case "demo":
      await start(demos[0], demos);
      openPlayer();
      break;
    case "play":
      await togglePlay();
      break;
    case "next":
      next();
      break;
    case "previous":
      next(-1);
      break;
    case "expand":
      openPlayer();
      break;
    case "close-player":
      closePlayer();
      break;
    case "shuffle":
      shuffle = !shuffle;
      updatePlayer();
      notify(shuffle ? "Shuffle on" : "Shuffle off");
      break;
    case "repeat":
      repeat = (repeat + 1) % 3;
      updatePlayer();
      notify(["Repeat off", "Repeat all", "Repeat one"][repeat]);
      break;
    case "mute":
      audio.muted = !audio.muted;
      paintVolume();
      break;
    case "like":
      if (current?.demo) {
        current.favorite = !current.favorite;
        updatePlayer();
        notify("Sound study favorite saved for this session.");
      } else if (current)
        await desktopAction(async () => {
          library = {
            ...library,
            ...(await window.edoras!.favorite(current!.id)),
          };
          current = library.tracks.find((t) => t.id === current!.id)!;
          queue = queue.map((t) => (t.id === current!.id ? current! : t));
          updatePlayer();
          render();
        });
      break;
    case "collapse":
      document.body.classList.toggle("collapsed");
      break;
    case "library-folder":
      await desktopAction(() => window.edoras!.openFolder("library"));
      break;
    case "reveal":
      if (current && !current.demo)
        await desktopAction(() => window.edoras!.reveal(current!.id));
      else notify("This is an included Edoras sound study.");
      break;
    case "choose-library":
      await desktopAction(async () => {
        const result = await window.edoras!.chooseLibrary();
        if (result) {
          audio.pause();
          current = null;
          queue = [];
          $("#player").classList.add("hidden");
          document.body.classList.remove("has-player");
          library = result;
          render();
          notify("Library location updated.");
        }
      });
      break;
    case "theme-system":
    case "theme-light":
    case "theme-dark": {
      theme = name.slice(6) as Theme;
      localStorage.setItem("edoras-theme", theme);
      paintTheme();
      // The accent and the waveform greys are theme-dependent, so they have
      // to be re-read before the next frame draws.
      refreshWaveColors();
      render();
      break;
    }
    case "watch":
      await desktopAction(async () => {
        library.watching = await window.edoras!.setWatching(!library.watching);
        render();
      });
      break;
    case "fetch-library-metadata":
      await fetchLibraryMetadata();
      break;
    case "cancel-library-metadata":
      await desktopAction(async () => {
        await window.edoras!.cancelLibraryMetadata();
        notify("Stopping after this song…");
      });
      break;
    case "confirm-ok":
    case "confirm-cancel":
      $<HTMLDialogElement>("#confirm-dialog").close(
        name === "confirm-ok" ? "ok" : "cancel",
      );
      break;
    case "toggle-playlists":
      playlistsFolded = !playlistsFolded;
      try {
        localStorage.setItem(
          "edoras-playlists",
          playlistsFolded ? "folded" : "open",
        );
      } catch {
        /* remembered for this session only */
      }
      renderPlaylistNav();
      break;
    case "restore-metadata": {
      const id = metadataTrackId;
      if (!id) break;
      await desktopAction(async () => {
        afterLibraryChange(await window.edoras!.restoreMetadata(id));
        const track = trackById.get(id);
        if (track && current?.id === id)
          void applyTrackAccent(track, loadVersion);
        $<HTMLDialogElement>("#metadata-dialog").close();
        notify(
          "Fetched details removed. The song is back to its own tags and artwork.",
        );
      });
      break;
    }
    case "artist-photo": {
      const name = selection;
      if (!name || artistPhotoBusy) break;
      await desktopAction(async () => {
        artistPhotoBusy = true;
        notify(`Looking for a photo of ${name}…`);
        try {
          const result = await window.edoras!.findArtistPhoto(name);
          afterLibraryChange(result.library);
          notify(
            result.found
              ? `Photo of ${name} saved.`
              : `No photo of ${name} was found on Deezer or Wikimedia. The initials stay.`,
          );
        } finally {
          artistPhotoBusy = false;
        }
      });
      break;
    }
    case "include-in-library-fetch": {
      const id = metadataTrackId;
      if (!id) break;
      await desktopAction(async () => {
        afterLibraryChange(await window.edoras!.resetMetadata(id));
        notify("This song will be looked up again in the next library fetch.");
        $<HTMLDialogElement>("#metadata-dialog").close();
      });
      break;
    }
    case "open-lyrics":
      toggleLyrics();
      break;
    case "edit-lyrics":
      lyricsEditing = true;
      refreshLyrics();
      (
        document.querySelector<HTMLTextAreaElement>(
          "#lyrics-input, #lyrics-page-input",
        ) ?? null
      )?.focus();
      break;
    case "cancel-lyrics":
      lyricsEditing = false;
      refreshLyrics();
      break;
    case "save-lyrics": {
      // The popup sits over the page, so when both editors exist the one the
      // user is looking at is the popup's.
      const value =
        document.querySelector<HTMLTextAreaElement>(
          expanded ? "#lyrics-input" : "#lyrics-page-input, #lyrics-input",
        )?.value ?? "";
      const id = current?.id;
      if (!id) break;
      await desktopAction(async () => {
        afterLibraryChange(await window.edoras!.setLyrics(id, value));
        lyricsEditing = false;
        refreshLyrics();
        notify(value.trim() ? "Lyrics saved." : "Lyrics cleared.");
      });
      break;
    }
    case "fetch-lyrics": {
      const id = current?.id;
      if (!id || lyricsBusy) break;
      await desktopAction(async () => {
        lyricsBusy = true;
        refreshLyrics();
        try {
          const result = await window.edoras!.fetchLyrics(id);
          afterLibraryChange(result.library);
          if (!result.found)
            notify("Lyrics can't be found for this song. You can paste them.");
        } finally {
          lyricsBusy = false;
          refreshLyrics();
        }
      });
      break;
    }
    // Reversing the order is its own control, so a change of mind does not
    // mean hunting for the opposite entry in a list of ten.
    case "sort-direction":
      sortDescending = !sortDescending;
      localStorage.setItem(
        "edoras-sort-direction",
        sortDescending ? "descending" : "ascending",
      );
      render();
      break;
    case "play-all":
    case "shuffle-all": {
      const list = visibleQueue();
      if (list.length) {
        shuffle = name === "shuffle-all";
        await start(
          list[shuffle ? Math.floor(Math.random() * list.length) : 0],
          list,
        );
      }
      break;
    }
  }
}
// Questions are asked inside the app, in its own dialog, never with the
// system's confirm box. Resolves true only for the confirming button; Esc,
// Cancel and a second question arriving all answer no.
let answer: ((ok: boolean) => void) | null = null;
function ask(options: {
  symbol: string;
  eyebrow: string;
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
}): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("#confirm-dialog");
  answer?.(false);
  if (dialog.open) dialog.close("cancel");
  $("#confirm-symbol").innerHTML = icon(options.symbol);
  $("#confirm-symbol").classList.toggle("danger", !!options.danger);
  $("#confirm-eyebrow").textContent = options.eyebrow;
  // The title carries one serif word in <em>; it is always our own text.
  $("#confirm-title").innerHTML = options.title;
  $("#confirm-body").textContent = options.body;
  const ok = $("#confirm-ok");
  ok.className = `button ${options.danger ? "danger-fill" : "primary"}`;
  ok.innerHTML = `${icon(options.danger ? "trash-2" : "check")} ${escape(options.confirm)}`;
  icons();
  dialog.returnValue = "";
  dialog.showModal();
  $<HTMLButtonElement>('[data-action="confirm-cancel"]').focus();
  return new Promise((resolve) => (answer = resolve));
}
$("#confirm-dialog").addEventListener("close", () => {
  const resolve = answer;
  answer = null;
  resolve?.($<HTMLDialogElement>("#confirm-dialog").returnValue === "ok");
});
let artistPhotoBusy = false;
// Deleting a song from the library sends its file to the Recycle Bin and
// drops everything saved about it. A song that is playing is let go first,
// because Windows will not move a file that is open, and the queue carries
// on with the next song.
async function deleteTrack(id: string) {
  const track = trackById.get(id);
  if (!track) return;
  const ok = await ask({
    symbol: "trash-2",
    eyebrow: "DELETE FROM YOUR LIBRARY",
    title: "Delete this <em>song?</em>",
    body: `“${track.title}” by ${track.artist} goes to the Recycle Bin, and its artwork, lyrics, fetched details and plays go with it. You can still restore the file from the Recycle Bin.`,
    confirm: "Delete song",
    danger: true,
  });
  if (!ok) return;
  await desktopAction(async () => {
    const wasCurrent = current?.id === id;
    const wasPlaying = wasCurrent && !audio.paused;
    const position = audio.currentTime;
    const source = audio.src;
    if (wasCurrent) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    let data: LibraryData;
    try {
      data = await window.edoras!.deleteTrack(id);
    } catch (error) {
      if (wasCurrent) {
        audio.src = source;
        audio.currentTime = position;
        if (wasPlaying) void audio.play().catch(() => {});
      }
      throw error;
    }
    const index = queue.findIndex((t) => t.id === id);
    queue = queue.filter((t) => t.id !== id);
    if (wasCurrent) {
      const following = queue.length
        ? queue[Math.min(Math.max(index, 0), queue.length - 1)]
        : undefined;
      if (following && wasPlaying) {
        library = data;
        void start(following);
      } else {
        current = null;
        if (expanded) closePlayer();
        $("#player").classList.add("hidden");
        document.body.classList.remove("has-player", "is-playing");
      }
    }
    afterLibraryChange(data);
    notify(`“${track.title}” moved to the Recycle Bin.`);
  });
}
// One pass over everything that has never been looked up. Only a match the
// ranking is sure of is written without the user seeing it, so a wrong guess
// cannot quietly rewrite a good tag; everything else keeps its row button.
async function fetchLibraryMetadata() {
  await desktopAction(async () => {
    if (libraryFetchBusy) {
      notify("A library fetch is already running.");
      return;
    }
    if (!library.tracks.length) {
      notify("Import your music first.");
      return;
    }
    // Never looked up, or looked up with nothing confident: both are tried.
    const pending = library.tracks.filter(
      (t) => !t.metadataFetchedAt || !t.metadataSource,
    ).length;
    let redo = false;
    if (!pending) {
      if (
        !(await ask({
          symbol: "search",
          eyebrow: "FETCH LIBRARY METADATA",
          title: "Look them all up <em>again?</em>",
          body: "Every song already has its details. Fetching again replaces the details, artwork and lyrics of every song that matches, and looks for every artist photo again.",
          confirm: "Fetch again",
        }))
      )
        return;
      redo = true;
    }
    libraryFetchBusy = true;
    showProgress(
      `Fetching details for ${redo ? library.tracks.length : pending} ${
        (redo ? library.tracks.length : pending) === 1 ? "song" : "songs"
      }…`,
      true,
    );
    try {
      const result = await window.edoras!.fetchLibraryMetadata({ redo });
      afterLibraryChange(result.library);
      const parts = [`${result.matched} matched`];
      if (result.skipped) parts.push(`${result.skipped} need a look`);
      if (result.photos)
        parts.push(
          `${result.photos} artist ${result.photos === 1 ? "photo" : "photos"}`,
        );
      if (result.failed) parts.push(`${result.failed} could not be reached`);
      notify(
        `${result.cancelled ? "Stopped" : "Done"} · ${parts.join(" · ")}. Use the search button on a row to choose details yourself.`,
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      libraryFetchBusy = false;
      $("#import-progress").classList.add("hidden");
    }
  });
}
function showProgress(text: string, cancellable = false) {
  const el = $("#import-progress");
  el.classList.remove("hidden");
  el.innerHTML = `<span>${escape(text)}</span>${cancellable ? `<button class="text-button" data-action="cancel-library-metadata">Stop</button>` : ""}`;
}
async function openAddDialog(ids: string[]) {
  await desktopAction(async () => {
    const tracks = ids
      .map((id) => library.tracks.find((t) => t.id === id))
      .filter((t): t is Track => !!t);
    if (!tracks.length) {
      notify("Import your music to add songs to a playlist.");
      return;
    }
    addTrackIds = tracks.map((t) => t.id);
    $("#add-title").textContent =
      tracks.length === 1 ? tracks[0].title : `${tracks.length} songs`;
    $("#add-choices").innerHTML = playlists().length
      ? playlists()
          .map((p) => {
            const included = addTrackIds.every((id) => p.trackIds.includes(id));
            return `<button class="add-choice" data-add="${escape(p.id)}" aria-pressed="${included}"><span><b>${escape(p.name)}</b><small>${p.trackIds.length} tracks${included ? " · Already added" : ""}</small></span>${included ? icon("check") : icon("plus")}</button>`;
          })
          .join("")
      : `<p class="add-empty">No playlists yet. Make your first one below.</p>`;
    icons();
    const dialog = $<HTMLDialogElement>("#add-dialog");
    if (!dialog.open) dialog.showModal();
  });
}
async function openMetadata(id: string) {
  await desktopAction(async () => {
    const track = library.tracks.find((t) => t.id === id);
    if (!track) {
      notify("Import a song to look up its metadata.");
      return;
    }
    if (metadataBusy) {
      notify("A lookup is still running. Please wait a moment.");
      return;
    }
    metadataTrackId = id;
    metadataVersion++;
    $("#metadata-track").innerHTML = `${escape(track.title)}${
      track.metadataFetchedAt
        ? `<small class="metadata-state">${
            track.metadataSource
              ? `Details came from ${escape(track.metadataSource)}. A library-wide fetch skips this song from now on.`
              : "Looked up once with no confident match. A library-wide fetch skips this song from now on."
          } <span class="metadata-state-actions"><button class="text-button" data-action="include-in-library-fetch">${icon("rotate-ccw")} Include it again</button>${
            track.metadataSource
              ? `<button class="text-button danger" data-action="restore-metadata">${icon("x")} Remove fetched details</button>`
              : ""
          }</span></small>`
        : ""
    }`;
    $<HTMLInputElement>("#metadata-query").value =
      track.artist && !/^unknown/i.test(track.artist)
        ? `${track.artist} — ${track.title}`
        : track.title;
    $("#metadata-results").innerHTML = "";
    $("#metadata-status").textContent =
      "Choose a search method. Your music stays unchanged until you select a result.";
    $<HTMLDialogElement>("#metadata-dialog").showModal();
  });
}
function metadataLoading(active: boolean, message = "") {
  metadataBusy = active;
  $("#metadata-dialog").classList.toggle("is-searching", active);
  $("#metadata-dialog").setAttribute("aria-busy", String(active));
  document
    .querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "#metadata-form input, #metadata-form button, .audio-identify, [data-use-metadata]",
    )
    .forEach((el) => (el.disabled = active));
  if (message) $("#metadata-status").textContent = message;
  showIdentifying(active && current?.id === metadataTrackId);
}
async function findMetadata(mode: "name" | "audio") {
  if (metadataBusy || !metadataTrackId || !window.edoras) return;
  const id = metadataTrackId,
    version = ++metadataVersion;
  const query = $<HTMLInputElement>("#metadata-query").value.trim();
  if (mode === "name" && !query) {
    $("#metadata-status").textContent =
      "Enter a song name, or try Identify by sound.";
    return;
  }
  $("#metadata-results").innerHTML = "";
  metadataLoading(
    true,
    mode === "audio"
      ? "Listening to a short section of your song…"
      : "Looking for your song…",
  );
  try {
    const results: MetadataCandidate[] = await window.edoras.findMetadata(id, {
      mode,
      query,
      position: current?.id === id ? audio.currentTime : 0,
    });
    if (version !== metadataVersion) return;
    $("#metadata-status").textContent = results.length
      ? "Choose the correct recording to save its details and available artwork."
      : "No match found. Try a different song name or Identify by sound. Nothing was changed.";
    $("#metadata-results").innerHTML = results
      .map(
        (r) =>
          `<button class="metadata-result" data-use-metadata="${escape(r.candidateId)}"><span class="result-symbol">${icon("disc-3")}</span><span><b>${escape(r.title)}</b><span>${escape(r.artist)}</span><small>${escape([r.album, r.year, r.duration ? time(r.duration) : ""].filter(Boolean).join(" · "))}</small><small class="result-source">${escape(r.source)}${r.durationDifference != null && r.durationDifference > 20 ? " · Different track length" : ""}</small></span><span class="use-result">Use details ${icon("arrow-right")}</span></button>`,
      )
      .join("");
    icons();
  } catch (error) {
    if (version === metadataVersion)
      $("#metadata-status").textContent = (error as Error).message;
  } finally {
    metadataLoading(false);
  }
}
async function useMetadata(candidateId: string) {
  if (metadataBusy || !window.edoras) return;
  const id = metadataTrackId,
    root = library.root;
  metadataLoading(true, "Saving song details and fetching available artwork…");
  try {
    const result = await window.edoras.applyMetadata(id, candidateId);
    if (library.root !== root) return;
    library = result.library;
    queue = queue.map(
      (t) => library.tracks.find((updated) => updated.id === t.id) || t,
    );
    if (current?.id === id) {
      current = library.tracks.find((t) => t.id === id) || current;
      updatePlayer();
      void applyTrackAccent(current, loadVersion);
      if (expanded) renderSide();
    }
    render();
    $<HTMLDialogElement>("#metadata-dialog").close();
    notify(
      result.artwork
        ? result.artistPhoto
          ? "Song details, artwork and artist photo saved."
          : "Song details and artwork saved."
        : "Song details saved. No artwork was available.",
    );
  } catch (error) {
    $("#metadata-status").textContent = (error as Error).message;
  } finally {
    metadataLoading(false);
  }
}
$("#metadata-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void findMetadata("name");
});
$("#metadata-dialog").addEventListener("close", () => {
  metadataVersion++;
});

document.addEventListener("click", (event) => {
  const el = (event.target as Element).closest<HTMLElement>(
    "[data-action],[data-view],[data-track],[data-row-play],[data-album-play],[data-playlist-play],[data-album],[data-artist],[data-tab],[data-playlist],[data-add],[data-remove],[data-add-track],[data-metadata],[data-use-metadata],[data-move],[data-stats-range],[data-genre],[data-delete-track],[data-unfavorite],.brand",
  );
  if (!el) return;
  if (el instanceof HTMLButtonElement && el.disabled) return;
  if (el.dataset.addTrack)
    void openAddDialog([el.dataset.addTrack]).catch((err) =>
      notify(err.message),
    );
  if (el.dataset.metadata)
    void openMetadata(el.dataset.metadata).catch((err) => notify(err.message));
  if (el.dataset.useMetadata) void useMetadata(el.dataset.useMetadata);
  if (el.dataset.deleteTrack)
    void deleteTrack(el.dataset.deleteTrack).catch((err) =>
      notify(err.message),
    );
  if (el.dataset.unfavorite) {
    const id = el.dataset.unfavorite;
    void desktopAction(async () => {
      const title = trackById.get(id)?.title ?? "This song";
      afterLibraryChange(await window.edoras!.favorite(id));
      notify(`${title} removed from favorites.`);
    }).catch((err: Error) => notify(err.message));
  }
  if (el.dataset.move && currentPlaylist()) {
    const playlistId = currentPlaylist()!.id,
      trackId = el.dataset.move;
    void desktopAction(async () => {
      library = await window.edoras!.movePlaylistTrack(
        playlistId,
        trackId,
        Number(el.dataset.direction),
      );
      render();
    }).catch((err) => notify(err.message));
  }
  if (el.classList.contains("brand")) {
    event.preventDefault();
    go("home");
  }
  if (el.dataset.view) go(el.dataset.view);
  if (el.dataset.action)
    void action(el.dataset.action).catch((err) => notify(err.message));
  if (el.dataset.statsRange) {
    statsRange = el.dataset.statsRange as Range;
    localStorage.setItem("edoras-stats-range", statsRange);
    const y = scrollY;
    render();
    scrollTo({ top: y });
  }
  // A genre on the Statistics page searches the library for it.
  if (el.dataset.genre) {
    search = el.dataset.genre;
    $<HTMLInputElement>("#search").value = search;
    render();
    scrollTo({ top: 0 });
  }
  if (el.dataset.playlistPlay) {
    const id = el.dataset.playlistPlay;
    const source = `playlist:${id}`;
    if (current && queueSource === source) void togglePlay();
    else {
      const list = playlistTracks(playlists().find((p) => p.id === id));
      if (list[0]) {
        shuffle = false;
        void start(list[0], list, source);
      }
    }
  }
  if (el.dataset.albumPlay) {
    const key = el.dataset.albumPlay;
    if (current && !current.demo && albumKey(current) === key)
      void togglePlay();
    else {
      const list = library.tracks
        .filter((t) => albumKey(t) === key)
        .sort((a, b) => a.disc - b.disc || a.number - b.number);
      if (list[0]) {
        shuffle = false;
        void start(list[0], list, `album:${key}`);
      }
    }
  }
  // A card whose song is already loaded pauses and resumes it rather than
  // starting it again from the top, as its artwork button says it will.
  if (
    el.dataset.track &&
    el.matches(".music-card, .stat-feature") &&
    current?.id === el.dataset.track
  )
    void togglePlay();
  else if (el.dataset.track) {
    const t = allTracks().find((t) => t.id === el.dataset.track);
    if (t)
      void start(
        t,
        el.closest("#now-playing") ? queue : t.demo ? demos : pageQueue(),
        el.closest("#now-playing") ? queueSource : pageSource(),
      );
  }
  // The glyph beside the song does what it shows: it starts any other song,
  // and pauses or resumes the one that is already playing.
  if (el.dataset.rowPlay) {
    const id = el.dataset.rowPlay;
    if (current?.id === id) void togglePlay();
    else {
      const t = allTracks().find((t) => t.id === id);
      if (t) void start(t, t.demo ? demos : pageQueue(), pageSource());
    }
  }
  if (el.dataset.album) {
    selection = el.dataset.album;
    go("album");
  }
  if (el.dataset.artist) {
    selection = el.dataset.artist;
    go("artist");
  }
  if (el.dataset.tab) {
    sideTab = el.dataset.tab;
    lyricsEditing = false;
    renderSide();
  }
  if (el.dataset.playlist) {
    selection = el.dataset.playlist;
    go("playlist");
  }
  if (el.dataset.add) {
    const playlistId = el.dataset.add;
    const ids = [...addTrackIds];
    if (ids.length)
      void desktopAction(async () => {
        const playlist = playlists().find((p) => p.id === playlistId);
        // The same button both adds and takes away, so a second tap undoes
        // a mistaken one without hunting for the track in the playlist.
        const inside =
          ids.length === 1 && !!playlist?.trackIds.includes(ids[0]);
        library = inside
          ? await window.edoras!.removeFromPlaylist(playlistId, ids[0])
          : await window.edoras!.addTracksToPlaylist(playlistId, ids);
        notify(
          inside
            ? `Removed from “${playlist?.name}”.`
            : `Added to “${playlist?.name}”.`,
        );
        render();
        await openAddDialog(ids);
      }).catch((err: Error) => notify(err.message));
  }
  if (el.dataset.remove) {
    const trackId = el.dataset.remove;
    const playlist = currentPlaylist();
    if (playlist)
      void desktopAction(async () => {
        library = await window.edoras!.removeFromPlaylist(playlist.id, trackId);
        render();
      }).catch((err: Error) => notify(err.message));
  }
});
$("#playlist-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("#playlist-name");
  const name = input.value.trim();
  if (!name) return;
  void desktopAction(async () => {
    if (renamingPlaylistId) {
      library = await window.edoras!.renamePlaylist(renamingPlaylistId, name);
      renamingPlaylistId = "";
      $<HTMLDialogElement>("#playlist-dialog").close();
      render();
      notify("Playlist renamed.");
      return;
    }
    // Identify the new playlist by id, not by name: the catalog normalises
    // whitespace, so what comes back may not equal what was typed.
    const before = new Set(playlists().map((p) => p.id));
    library = await window.edoras!.createPlaylist(name);
    $<HTMLDialogElement>("#playlist-dialog").close();
    input.value = "";
    const made = playlists().find((p) => !before.has(p.id));
    if (made) {
      if (pendingPlaylistTracks.length)
        library = await window.edoras!.addTracksToPlaylist(
          made.id,
          pendingPlaylistTracks,
        );
      pendingPlaylistTracks = [];
      selection = made.id;
      go("playlist");
      notify(`“${made.name}” created.`);
    } else render();
  }).catch((err: Error) => notify(err.message));
});
// Drop anywhere on the window. The dragover handler has to cancel the event
// or the browser navigates to the file instead of letting us have it.
let dragDepth = 0;
const hasFiles = (event: DragEvent) =>
  [...(event.dataTransfer?.types ?? [])].includes("Files");
addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  document.body.classList.add("is-dropping");
});
addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("is-dropping");
});
addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("is-dropping");
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  if (!window.edoras) {
    notify("Dropping music in works in the Edoras desktop app.");
    return;
  }
  if (busy) return;
  busy = true;
  showProgress(
    `Reading ${files.length} dropped ${files.length === 1 ? "item" : "items"}…`,
  );
  // Spread it: a FileList does not survive the context bridge, and an array
  // of the same File objects does.
  window.edoras
    .importDropped([...files])
    .then(acceptImport)
    .catch((error: Error) => notify(error.message))
    .finally(() => {
      busy = false;
      $("#import-progress").classList.add("hidden");
    });
});
$("#search").addEventListener("input", (event) => {
  search = (event.target as HTMLInputElement).value;
  render();
});
document.querySelectorAll<HTMLInputElement>(".seek").forEach((el) =>
  el.addEventListener("input", () => {
    if (Number.isFinite(audio.duration))
      audio.currentTime = (Number(el.value) / 1000) * audio.duration;
  }),
);
// The bar and the popup each have a slider and a mute button, and they are
// the same volume. Whichever one is used, all of them are repainted, so the
// popup never opens showing a level the bar disagrees with.
function paintVolume() {
  document
    .querySelectorAll<HTMLInputElement>(".volume-slider")
    .forEach((el) => (el.value = String(audio.muted ? 0 : audio.volume * 100)));
  document.querySelectorAll(".mute").forEach((el) => {
    el.innerHTML = icon(audio.muted ? "volume-x" : "volume-2");
    el.setAttribute("aria-label", audio.muted ? "Unmute" : "Mute");
  });
  icons();
}
document.querySelectorAll<HTMLInputElement>(".volume-slider").forEach((el) =>
  el.addEventListener("input", () => {
    audio.volume = Number(el.value) / 100;
    audio.muted = false;
    localStorage.setItem("edoras-volume", String(audio.volume));
    paintVolume();
  }),
);
// Changing what the library is sorted by re-renders it in place; the table
// paints its own window afterwards, so a long list costs no more than a
// short one.
document.addEventListener("change", (event) => {
  const el = event.target as HTMLElement;
  if (!el.classList.contains("sort-field")) return;
  sortKey = (el as HTMLSelectElement).value as SortKey;
  localStorage.setItem("edoras-sort", sortKey);
  sortDescending = SORTS.find((s) => s.key === sortKey)!.descending;
  localStorage.setItem(
    "edoras-sort-direction",
    sortDescending ? "descending" : "ascending",
  );
  scrollTo({ top: 0 });
  render();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#search").focus();
    return;
  }
  if (
    (event.target as HTMLElement).matches("input,textarea,button") &&
    event.key !== "Escape"
  )
    return;
  if (event.code === "Space") {
    event.preventDefault();
    void togglePlay();
  }
  if (event.key === "ArrowRight" && current)
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  if (event.key === "ArrowLeft" && current)
    audio.currentTime = Math.max(0, audio.currentTime - 5);
});
$("#now-playing").addEventListener("close", () => {
  expanded = false;
});
for (const id of [
  "now-playing",
  "import-dialog",
  "playlist-dialog",
  "add-dialog",
  "metadata-dialog",
])
  $<HTMLDialogElement>(`#${id}`).addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        (event.currentTarget as HTMLDialogElement).close();
    }
  });
audio.addEventListener("play", updatePlayer);
audio.addEventListener("pause", updatePlayer);
audio.addEventListener("ended", () => next(1, true));
audio.addEventListener("loadedmetadata", () => {
  if (resumeTime) {
    audio.currentTime = resumeTime;
    resumeTime = 0;
  }
  updatePlayer();
});
audio.addEventListener("error", () => {
  if (!current) return;
  if (!current.demo && !fallback) {
    fallback = true;
    resumeTime = audio.currentTime;
    const version = loadVersion;
    notify("Preparing this audio format for playback…");
    const converted = `edoras://app/media/converted/${current.id}`;
    audio.src = converted;
    loadWaveform(current, converted, version);
    void audio.play().catch(() => {
      if (version === loadVersion)
        notify("This file could not be decoded. Your original is unchanged.");
    });
  } else notify("Unable to play this file. It may be missing or damaged.");
});
// ---- Listening ----------------------------------------------------------
// Time is counted as it is actually heard: the gap between one playback tick
// and the next, and only a small one, so a seek is never counted as having
// listened to the part it skipped. A song counts as played once it has been
// heard for thirty seconds, or half its length if it is shorter than a
// minute, and once per start. Sound studies are not the user's music and are
// not counted.
let heardThisPlay = 0,
  countedThisPlay = false,
  lastPosition = 0;
const pendingListening = new Map<string, { seconds: number; play: boolean }>();
function hear() {
  if (!current || current.demo || audio.paused || audio.seeking) {
    lastPosition = audio.currentTime;
    return;
  }
  const delta = audio.currentTime - lastPosition;
  lastPosition = audio.currentTime;
  if (!(delta > 0 && delta < 2)) return;
  heardThisPlay += delta;
  let play = false;
  const length = trackLength();
  if (
    !countedThisPlay &&
    heardThisPlay >= Math.min(30, length ? length / 2 : 30)
  ) {
    countedThisPlay = true;
    play = true;
  }
  addListening(listening, current.id, delta, play);
  const pending = pendingListening.get(current.id) ?? {
    seconds: 0,
    play: false,
  };
  pending.seconds += delta;
  pending.play ||= play;
  pendingListening.set(current.id, pending);
  if (view === "statistics" && !search) refreshTiles(listening);
}
// Sent in batches: every fifteen seconds while music plays, and whenever the
// song changes or stops. The main process accepts at most a minute per song
// per entry, so a long stretch is sent as several.
function flushListening() {
  if (!pendingListening.size || !window.edoras) {
    pendingListening.clear();
    return;
  }
  const at = Date.now();
  const entries = [];
  for (const [id, { seconds, play }] of pendingListening) {
    let left = seconds;
    let first = true;
    while (left > 0.01 || first) {
      const part = Math.min(left, 60);
      entries.push({ id, seconds: part, play: first && play, at });
      left -= part;
      first = false;
    }
  }
  pendingListening.clear();
  void window.edoras.recordListening(entries.slice(0, 200)).catch(() => {});
}
setInterval(flushListening, 15000);
addEventListener("pagehide", flushListening);
audio.addEventListener("pause", flushListening);
audio.addEventListener("seeking", () => {
  lastPosition = audio.currentTime;
});
audio.addEventListener("timeupdate", () => {
  hear();
  paintDuration();
  const progress = Number.isFinite(audio.duration)
    ? audio.currentTime / audio.duration
    : 0;
  document.querySelectorAll<HTMLInputElement>(".seek").forEach((el) => {
    el.value = String(progress * 1000);
    el.style.setProperty("--progress", `${progress * 100}%`);
  });
  document
    .querySelectorAll(".elapsed")
    .forEach((el) => (el.textContent = time(audio.currentTime)));
});
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => void togglePlay());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => next(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => next());
}
const frequencies = new Uint8Array(128);
let hoverRatio: number | null = null;
let waveOn = "#6082a9";
let waveOff = "#cbcec9";
let waveKey = "";

// Read once when the theme or the accent changes rather than per frame, so
// the draw loop never forces a style recalculation.
function refreshWaveColors() {
  const styles = getComputedStyle(document.documentElement);
  waveOn = styles.getPropertyValue("--art").trim() || waveOn;
  waveOff = styles.getPropertyValue("--pk-off").trim() || waveOff;
  waveKey = "";
}
function fitCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return null;
  const dpr = devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr),
    height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  return ctx ? { ctx, width, height, dpr } : null;
}
// The whole track, mirrored around the centre line: bars behind the playhead
// carry the song's own colour, the rest stay grey. While the audio is still
// decoding we draw a low pulse in the same geometry; if it cannot be decoded
// at all we draw nothing and leave the bar at rest.
function drawWave(
  canvas: HTMLCanvasElement,
  peaks: Float32Array | null,
  progress: number,
  loading: boolean,
) {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, width, height, dpr } = fit;
  ctx.clearRect(0, 0, width, height);
  if (!peaks && !loading) return;
  const bar = 2 * dpr,
    gap = dpr;
  const bars = Math.max(8, Math.floor(width / (bar + gap)));
  const middle = height / 2;
  for (let i = 0; i < bars; i++) {
    const ratio = i / bars;
    const value = peaks
      ? peaks[Math.min(peaks.length - 1, Math.floor(ratio * peaks.length))]!
      : 0.12 + 0.08 * Math.sin(ratio * 14 - performance.now() / 240);
    const size = Math.max(2 * dpr, value * (height - 2 * dpr));
    const played = ratio <= progress;
    ctx.fillStyle = loading || !played ? waveOff : waveOn;
    // Bars between the playhead and the pointer preview where a click lands.
    ctx.globalAlpha = loading
      ? 0.55
      : hoverRatio !== null && !played && ratio <= hoverRatio
        ? 0.6
        : 1;
    ctx.beginPath();
    ctx.roundRect(i * (bar + gap), middle - size / 2, bar, size, bar / 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawSpectrum(canvas: HTMLCanvasElement) {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, width, height, dpr } = fit;
  ctx.clearRect(0, 0, width, height);
  const bars = 44;
  const step = width / bars;
  for (let i = 0; i < bars; i++) {
    const value = audio.paused
      ? 0
      : frequencies[Math.floor(Math.pow(i / (bars - 1), 2) * 100)]! / 255;
    const size = Math.max(2 * dpr, value * height * 0.88);
    ctx.fillStyle = waveOn;
    ctx.beginPath();
    ctx.roundRect(
      i * step,
      (height - size) / 2,
      Math.max(2, step * 0.65),
      size,
      3 * dpr,
    );
    ctx.fill();
  }
}
function draw() {
  if (expanded) {
    if (analyser) analyser.getByteFrequencyData(frequencies);
    drawSpectrum($<HTMLCanvasElement>("#spectrum"));
  } else {
    const id = current?.id;
    const peaks = id ? cachedPeaks(id) : null;
    const loading = !!id && peaksPending(id);
    const progress =
      Number.isFinite(audio.duration) && audio.duration
        ? audio.currentTime / audio.duration
        : 0;
    const canvas = $<HTMLCanvasElement>("#mini-wave");
    // Static art: redraw only when something it depends on actually moves.
    const key = loading
      ? `loading:${Math.round(performance.now() / 64)}`
      : `${id}:${peaks ? 1 : 0}:${Math.round(progress * 720)}:${hoverRatio ?? -1}:${canvas.width}`;
    if (key !== waveKey) {
      waveKey = key;
      drawWave(canvas, peaks, progress, loading);
    }
  }
  requestAnimationFrame(draw);
}
// Hovering the waveform previews where a click would land.
const waveSeek = $(".wave-seek");
waveSeek.addEventListener("pointermove", (event) => {
  const rect = waveSeek.getBoundingClientRect();
  hoverRatio = Math.min(
    1,
    Math.max(0, ((event as PointerEvent).clientX - rect.left) / rect.width),
  );
});
waveSeek.addEventListener("pointerleave", () => {
  hoverRatio = null;
});
addEventListener("resize", () => {
  waveKey = "";
});
refreshWaveColors();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "system") refreshWaveColors();
});
bindCharts();
render();
draw();
if (window.edoras) {
  Promise.all([
    window.edoras.getLibrary(),
    window.edoras.getStats().catch(() => emptyStats()),
  ])
    .then(([data, stats]) => {
      library = data;
      listening = stats;
      render();
    })
    .catch((err) => notify(err.message));
  // Songs that arrived in, moved within or left the library folder while
  // Edoras was watching it.
  window.edoras.onFolder((data) => {
    afterLibraryChange(data.library);
    const parts = [];
    if (data.imported)
      parts.push(
        `${data.imported} ${data.imported === 1 ? "song" : "songs"} found in your library folder`,
      );
    if (data.removed)
      parts.push(
        `${data.removed} ${data.removed === 1 ? "song" : "songs"} removed from it`,
      );
    if (parts.length) notify(`${parts.join(" · ")}.`);
  });
  window.edoras.onLibrary(acceptImport);
  // A song opened from Explorer is imported and then played, because that is
  // what double-clicking a song has always meant. A song already in the
  // library simply plays; nothing is copied twice.
  window.edoras.onOpened((data) => {
    const track = library.tracks.find((t) => t.id === data.id);
    if (!track) {
      notify(`“${data.name}” could not be added to your library.`);
      return;
    }
    go("listen");
    void start(track, sortTracks(library.tracks));
    notify(
      data.imported
        ? `“${track.title}” added to your library.`
        : `“${track.title}” is already in your library.`,
    );
  });
  window.edoras.onError(notify);
  window.edoras.onProgress((data) => {
    showProgress(`Importing ${data.current} / ${data.total} · ${data.name}`);
  });
  window.edoras.onMetadataProgress((data) => {
    if (data.done) {
      $("#import-progress").classList.add("hidden");
      return;
    }
    showProgress(
      data.artists
        ? `Finding artist photos ${data.current} / ${data.total} · ${data.name}`
        : `Fetching details ${data.current} / ${data.total} · ${data.name}`,
      true,
    );
  });
}
