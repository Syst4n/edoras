// Song details, artwork, artist photos and lyrics.
//
// Deezer's public API is the primary catalog. It needs no account, no
// application registration and no key; it returns 1000×1000 album covers and
// a press photo for the artist from the same lookup; and its rate limit is
// loose enough to fetch a whole library in one pass.
//
// Two keyless catalogs back it up for what Deezer does not carry:
//  - Apple Music, through the public iTunes Search API. Good covers (the
//    100px thumbnail URL serves 1000px when asked), release dates, genres and
//    track numbers, but no artist images and roughly twenty calls a minute.
//  - MusicBrainz, with covers from the Cover Art Archive. The widest catalog
//    of bootlegs, live records and small labels, one call a second.
// Picking a result by hand searches all three at once, so the choices
// include whatever Deezer lacks. The library-wide fetch asks them in order
// and stops at the first confident match.
//
// Artist photos come from Deezer. When Deezer has none, the artist's
// MusicBrainz entry points at Wikidata, whose image lives on Wikimedia
// Commons; all three are keyless too.
//
// Lyrics are a different kind of data and come from LRCLIB, which is also
// keyless and also serves timed lyrics, so syncing can be added later without
// changing where the words come from.
//
// This all runs in the main process. The renderer is sandboxed and never
// makes network calls.

const AGENT = "Edoras/1.0.0 ( https://github.com/Syst4n/edoras )";
const origin = (name, fallback) => process.env[name] || fallback;
const DEEZER = origin("EDORAS_DEEZER_ORIGIN", "https://api.deezer.com");
const LYRICS = origin("EDORAS_LYRICS_ORIGIN", "https://lrclib.net");
const ITUNES = origin("EDORAS_ITUNES_ORIGIN", "https://itunes.apple.com");
const MUSICBRAINZ = origin(
  "EDORAS_MUSICBRAINZ_ORIGIN",
  "https://musicbrainz.org",
);
const CAA = origin("EDORAS_CAA_ORIGIN", "https://coverartarchive.org");
const WIKIDATA = origin("EDORAS_WIKIDATA_ORIGIN", "https://www.wikidata.org");
const COMMONS = origin(
  "EDORAS_COMMONS_ORIGIN",
  "https://commons.wikimedia.org",
);
export const CATALOG = "Deezer";
export const SOURCES = {
  deezer: "Deezer",
  itunes: "Apple Music",
  musicbrainz: "MusicBrainz",
};
// The order the library-wide fetch asks them in, and the order equal results
// are listed in.
const ORDER = ["deezer", "itunes", "musicbrainz"];
const gap = (name, fallback) => Number(process.env[name] ?? fallback);
// Deezer publishes 50 requests per 5 seconds. A quarter of a second between
// calls leaves plenty of margin and still fetches a large library quickly.
const DEEZER_GAP = gap("EDORAS_DEEZER_GAP", 250);
const LYRICS_GAP = gap("EDORAS_LYRICS_GAP", 350);
// Apple allows about twenty searches a minute; MusicBrainz asks for one a
// second and blocks clients that go faster.
const ITUNES_GAP = gap("EDORAS_ITUNES_GAP", 3000);
const MUSICBRAINZ_GAP = gap("EDORAS_MUSICBRAINZ_GAP", 1100);
const WIKIDATA_GAP = gap("EDORAS_WIKIDATA_GAP", 250);

const queues = new Map();
const cache = new Map();
const cleanString = (value) =>
  String(value || "")
    .trim()
    .slice(0, 300);
const unknown = (value) =>
  !value ||
  /^(?:unknown(?: artist| title| album)?|untitled(?: track)?(?:\s*\d+)?|(?:track|audio)\s*\d+)$/i.test(
    value.trim(),
  );
export function cleanTitle(value) {
  return cleanString(value)
    .replace(/\.(mp3|flac|wav|m4a|aac|ogg|opus|wma|aiff?)$/i, "")
    .replace(/\s*\[[a-f\d]{10}\]\s*$/i, "")
    .replace(/^\d{1,3}[\s._-]+/, "")
    .replace(/[_]+/g, " ")
    .replace(
      /\s*[[(](?:official\s*(?:music\s*)?(?:audio|video|visuali[sz]er)?|lyrics?(?:\s+video)?|hd|hq|4k|\d{2,3}\s*kbps)[\])]/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}
export function searchTerms(track, override = "") {
  let title = cleanTitle(withoutVersion(override || track.title));
  let artist = override
    ? ""
    : unknown(track.artist)
      ? ""
      : cleanString(track.artist);
  const parts = title.split(/\s+[–—-]\s+/);
  if (
    parts.length > 1 &&
    (!artist || parts[0].toLowerCase() === artist.toLowerCase())
  ) {
    artist = parts.shift().trim();
    title = parts.join(" - ").trim();
  }
  return { title, artist, term: `${artist} ${title}`.trim() };
}
function rateLimited(service, gap, work) {
  const state = queues.get(service) || { tail: Promise.resolve(), last: 0 };
  const job = state.tail.then(async () => {
    const wait = gap - (Date.now() - state.last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    state.last = Date.now();
    return work();
  });
  state.tail = job.catch(() => {});
  queues.set(service, state);
  return job;
}
async function json(url, { allow404 = false, service = CATALOG } = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `${service} is unavailable right now (${response.status}). Try again shortly.`,
    );
  const data = await response.json();
  // Deezer answers its own quota and lookup failures with HTTP 200 and an
  // error object, so a successful status is not a successful response.
  if (data && data.error && Object.keys(data.error).length)
    throw new Error(
      data.error.message
        ? `${service}: ${data.error.message}`
        : `${service} refused that request. Try again shortly.`,
    );
  return data;
}
const deezer = (path) =>
  rateLimited("deezer", DEEZER_GAP, () => json(`${DEEZER}${path}`));
const itunes = (path) =>
  rateLimited("itunes", ITUNES_GAP, () =>
    json(`${ITUNES}${path}`, { service: SOURCES.itunes }),
  );
const musicbrainz = (path) =>
  rateLimited("musicbrainz", MUSICBRAINZ_GAP, () =>
    json(`${MUSICBRAINZ}${path}`, { service: SOURCES.musicbrainz }),
  );
const wikidata = (path) =>
  rateLimited("wikidata", WIKIDATA_GAP, () =>
    json(`${WIKIDATA}${path}`, { service: "Wikidata" }),
  );
// Catalogs tag the same recording differently: "Lawrence", "Lawrence -
// 2021 Remaster", "Lawrence (Remastered)". A remaster or an album version is
// still the song, so those tags are ignored when titles are compared. A live
// or edited cut is not, and keeps its tag; its length tells it apart anyway.
const VERSION_TAG =
  /\s*(?:[-–—]\s*|[[(]\s*)(?:\d{4}\s+)?(?:(?:digital(?:ly)?\s+)?remaster(?:ed)?|album version|bonus track|explicit)(?:\s+(?:version|\d{4}))?(?:\s+(?:version|\d{4}))?\s*[\])]?\s*$/i;
export function withoutVersion(value) {
  let text = String(value || "");
  for (let i = 0; i < 3 && VERSION_TAG.test(text); i++)
    text = text.replace(VERSION_TAG, "");
  return text;
}
const normal = (s) =>
  cleanTitle(withoutVersion(s))
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export function similarity(a, b) {
  const one = new Set(normal(a).split(" ").filter(Boolean));
  const two = new Set(normal(b).split(" ").filter(Boolean));
  return one.size && two.size
    ? [...one].filter((s) => two.has(s)).length / Math.max(one.size, two.size)
    : 0;
}

// Deezer's image fields come in fixed sizes; xl is 1000×1000 and is what a
// desktop player wants. The smaller ones are only ever a fallback.
export function imageChain(entry, prefix) {
  return [
    entry?.[`${prefix}_xl`],
    entry?.[`${prefix}_big`],
    entry?.[`${prefix}_medium`],
    entry?.[prefix],
  ].filter((value) => typeof value === "string" && value);
}
function fromDeezerTrack(entry) {
  const artist = cleanString(entry.artist?.name);
  return {
    title: cleanString(entry.title_short || entry.title),
    artist,
    albumArtist: cleanString(entry.album?.artist?.name) || artist,
    album: cleanString(entry.album?.title),
    year: null,
    duration: Number(entry.duration) || 0,
    genre: "",
    source: SOURCES.deezer,
    sourceId: String(entry.id || ""),
    albumId: entry.album?.id ? String(entry.album.id) : "",
    artistId: entry.artist?.id ? String(entry.artist.id) : "",
    score: Number(entry.rank) || 0,
    artworkUrls: imageChain(entry.album, "cover"),
    artistImageUrls: imageChain(entry.artist, "picture"),
  };
}
// Deezer's advanced syntax scopes the words to the right fields, which stops
// an artist's name in a title pulling in their whole discography. Plain terms
// are the fallback when we only have a title to go on.
function searchQuery(terms) {
  const escape = (value) => value.replace(/["\\]/g, " ").trim();
  if (terms.artist && terms.title)
    return `artist:"${escape(terms.artist)}" track:"${escape(terms.title)}"`;
  return terms.term;
}
async function fromDeezer(terms) {
  const query = searchQuery(terms);
  if (!query) return [];
  const data = await deezer(`/search?q=${encodeURIComponent(query)}&limit=12`);
  return (data?.data || [])
    .filter((entry) => entry?.title && entry?.artist?.name)
    .map(fromDeezerTrack);
}
// Apple's artwork URLs name their size in the path, and the same image is
// served at any size up to the original when a bigger one is asked for.
export function appleArtwork(url) {
  if (typeof url !== "string" || !url) return [];
  const large = url.replace(
    /\/\d+x\d+(bb)?\.(jpg|png|webp)$/i,
    "/1000x1000bb.jpg",
  );
  return large === url ? [url] : [large, url];
}
export function fromItunesTrack(entry) {
  const artist = cleanString(entry.artistName);
  return {
    title: cleanString(entry.trackName),
    artist,
    albumArtist: cleanString(entry.collectionArtistName) || artist,
    album: cleanString(entry.collectionName),
    year: Number(String(entry.releaseDate || "").slice(0, 4)) || null,
    duration: Math.round(Number(entry.trackTimeMillis) / 1000) || 0,
    genre: cleanString(entry.primaryGenreName),
    number: Number(entry.trackNumber) || 0,
    disc: Number(entry.discNumber) || 0,
    source: SOURCES.itunes,
    sourceId: String(entry.trackId || ""),
    artworkUrls: appleArtwork(entry.artworkUrl100),
    artistImageUrls: [],
  };
}
async function fromItunes(terms) {
  if (!terms.term) return [];
  const query = new URLSearchParams({
    term: terms.term,
    media: "music",
    entity: "song",
    limit: "10",
  });
  const data = await itunes(`/search?${query}`);
  return (data?.results || [])
    .filter((entry) => entry?.trackName && entry?.artistName)
    .map(fromItunesTrack);
}
const lucene = (value) => value.replace(/["\\]/g, " ").trim();
export function fromMusicBrainzRecording(entry) {
  const credit = Array.isArray(entry["artist-credit"])
    ? entry["artist-credit"]
    : [];
  const artist = cleanString(
    credit
      .map((c) => `${c.name || c.artist?.name || ""}${c.joinphrase || ""}`)
      .join(""),
  );
  const releases = Array.isArray(entry.releases) ? entry.releases : [];
  // The first official album is the record most people mean; a single or a
  // compilation is the fallback.
  const release =
    releases.find(
      (r) =>
        r.status === "Official" &&
        r["release-group"]?.["primary-type"] === "Album" &&
        !r["release-group"]?.["secondary-types"]?.length,
    ) ||
    releases.find((r) => r.status === "Official") ||
    releases[0];
  const group = release?.["release-group"];
  const releaseArtist = Array.isArray(release?.["artist-credit"])
    ? release["artist-credit"].map((c) => c.name || "").join("")
    : "";
  const tags = Array.isArray(entry.tags) ? [...entry.tags] : [];
  tags.sort((a, b) => (b.count || 0) - (a.count || 0));
  const art = [];
  if (release?.id)
    art.push(
      `${CAA}/release/${release.id}/front-1200`,
      `${CAA}/release/${release.id}/front-500`,
    );
  if (group?.id) art.push(`${CAA}/release-group/${group.id}/front-1200`);
  return {
    title: cleanString(entry.title),
    artist,
    albumArtist: cleanString(releaseArtist) || artist,
    album: cleanString(release?.title),
    year:
      Number(
        String(entry["first-release-date"] || release?.date || "").slice(0, 4),
      ) || null,
    duration: Math.round(Number(entry.length) / 1000) || 0,
    genre: cleanString(tags[0]?.name).replace(
      /(^|[\s-])(\p{L})/gu,
      (_, before, letter) => before + letter.toLocaleUpperCase(),
    ),
    source: SOURCES.musicbrainz,
    sourceId: String(entry.id || ""),
    artistMbid: String(credit[0]?.artist?.id || ""),
    artworkUrls: art,
    artistImageUrls: [],
  };
}
async function fromMusicBrainz(terms) {
  if (!terms.title) return [];
  const query = terms.artist
    ? `recording:"${lucene(terms.title)}" AND artist:"${lucene(terms.artist)}"`
    : `recording:"${lucene(terms.title)}"`;
  const data = await musicbrainz(
    `/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`,
  );
  return (data?.recordings || [])
    .filter((entry) => entry?.title && entry?.["artist-credit"]?.length)
    .map(fromMusicBrainzRecording);
}
const SEARCHERS = {
  deezer: fromDeezer,
  itunes: fromItunes,
  musicbrainz: fromMusicBrainz,
};
export function rankCandidates(candidates, track, terms) {
  const priority = (source) => {
    const index = ORDER.findIndex((key) => SOURCES[key] === source);
    return index < 0 ? 0 : ORDER.length - index;
  };
  const ranked = candidates
    .map((c) => {
      const title = similarity(c.title, terms.title);
      const artist = terms.artist ? similarity(c.artist, terms.artist) : 0;
      const delta =
        c.duration && track.duration
          ? Math.abs(c.duration - track.duration)
          : null;
      return {
        ...c,
        titleMatch: title,
        artistMatch: artist,
        // The source only breaks ties: an equal match from Deezer is listed
        // before the same match from a fallback.
        rank:
          title * 60 +
          artist * 25 +
          (delta !== null && delta < 12 ? 15 : 0) +
          priority(c.source) * 0.5,
        durationDifference: delta,
      };
    })
    .filter((c) => similarity(c.title, terms.title) >= 0.35);
  // The same song from two catalogs is listed once. The same title on the
  // same record at a clearly different length is a different cut (a live
  // take, an edit) and is kept, so the right one can still be chosen.
  const seen = new Map();
  const close = (one, two) =>
    !one.duration || !two.duration || Math.abs(one.duration - two.duration) < 5;
  return ranked
    .sort((a, b) => b.rank - a.rank)
    .filter((c) => {
      const key = `${normal(c.title)}|${normal(c.artist)}|${normal(c.album)}`;
      const kept = seen.get(key) || [];
      const previous = kept.find((k) => close(k, c));
      if (previous) {
        if (!previous.artworkUrls?.length && c.artworkUrls?.length)
          previous.artworkUrls = c.artworkUrls;
        return false;
      }
      seen.set(key, [...kept, c]);
      return true;
    })
    .slice(0, 12);
}
async function searchSource(source, terms) {
  let found = await SEARCHERS[source](terms);
  // A scoped query that finds nothing usually means the artist tag is wrong
  // rather than that the song is missing, so widen once before giving up.
  if (!found.length && terms.artist)
    found = await SEARCHERS[source]({ ...terms, artist: "" });
  return found;
}
// Every source asked at once. One being down or empty costs only its own
// results; the search fails only when none of them could be reached.
export async function searchMetadata(track, query = "", options = {}) {
  const sources = (options.sources || ORDER).filter((s) => SEARCHERS[s]);
  const terms = searchTerms(track, query);
  if (unknown(terms.title)) return [];
  const cacheKey = `${sources.join(",")}|${terms.term}|${Math.round(track.duration || 0)}`;
  // A library sweep asks afresh: an answer cached from an earlier sweep
  // would only repeat the miss it is there to retry.
  const saved = options.fresh ? null : cache.get(cacheKey);
  if (saved && Date.now() - saved.at < 300000) return saved.value;
  const settled = await Promise.allSettled(
    sources.map((source) => searchSource(source, terms)),
  );
  if (settled.length && settled.every((r) => r.status === "rejected"))
    throw settled[0].reason;
  const candidates = settled.flatMap((r) =>
    r.status === "fulfilled" ? r.value : [],
  );
  const value = rankCandidates(candidates, track, terms);
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
// The songs of the song's own album on Deezer, ranked against the song.
// Null when the song has no album to go on or Deezer does not have it.
async function fromDeezerAlbum(track) {
  const artist = cleanString(
    unknown(track.albumArtist) ? track.artist : track.albumArtist,
  );
  const album = cleanString(track.album);
  if (!artist || unknown(artist) || !album || unknown(album)) return null;
  const quote = (value) => value.replace(/["\\]/g, " ").trim();
  const found = await deezer(
    `/search/album?q=${encodeURIComponent(`artist:"${quote(artist)}" album:"${quote(album)}"`)}&limit=5`,
  );
  const hit = (found?.data || []).find(
    (entry) =>
      entry?.id &&
      (normal(entry.title) === normal(album) ||
        similarity(entry.title, album) >= 0.8),
  );
  if (!hit) return null;
  const record = await deezer(`/album/${encodeURIComponent(hit.id)}`);
  const songs = (record?.tracks?.data || []).filter(
    (entry) => entry?.title && entry?.artist?.name,
  );
  if (!songs.length) return null;
  const candidates = songs.map((entry) =>
    fromDeezerTrack({
      ...entry,
      album: { ...record, tracks: undefined },
      artist:
        record.artist && String(record.artist.id) === String(entry.artist.id)
          ? { ...record.artist, ...entry.artist, ...pictures(record.artist) }
          : entry.artist,
    }),
  );
  return rankCandidates(candidates, track, searchTerms(track));
}
const pictures = (artist) =>
  Object.fromEntries(
    Object.entries(artist || {}).filter(([key]) => key.startsWith("picture")),
  );
// For the library-wide fetch: Deezer first, then each fallback only when the
// one before it had nothing confident, so a song Deezer knows costs one
// request. Throws only when no source could be reached at all, which is what
// lets the caller retry that song next time instead of marking it done.
//
// Every ranked result is weighed, not only the first: the top one can be a
// live cut a few seconds too long while the studio take sits just below it.
// And a song is only called a miss when every catalog answered. If one of
// them failed (a quota, a timeout), that is not a "no", so this throws and
// the song is left to be tried again rather than marked as having nothing.
export async function bestMatch(track) {
  let reached = false;
  let failed = false;
  for (const source of ORDER) {
    try {
      const results = await searchMetadata(track, "", {
        sources: [source],
        fresh: true,
      });
      reached = true;
      const sure = results.find((c) => confident(c, track));
      if (sure) return sure;
    } catch {
      failed = true;
    }
  }
  // Last, the record itself: when the song's own search finds nothing sure
  // but its album is on Deezer, the song is looked for in that tracklist.
  try {
    const listed = await fromDeezerAlbum(track);
    if (listed) reached = true;
    const sure = (listed || []).find((c) => confident(c, track));
    if (sure) return sure;
  } catch {
    failed = true;
  }
  if (!reached) throw new Error("No catalog could be reached.");
  if (failed) throw new Error("A catalog could not be reached.");
  return null;
}
// A match good enough to write onto a song without the user looking at it.
// Bulk fetching uses this; picking a result by hand never does.
// The length may differ by 8 seconds, or by 3% on a long piece, where a
// remaster's silence at either end runs longer.
export function confident(candidate, track) {
  if (!candidate) return false;
  if (candidate.titleMatch < 0.8) return false;
  if (candidate.artistMatch && candidate.artistMatch < 0.6) return false;
  if (
    track?.duration &&
    candidate.duration &&
    Math.abs(candidate.duration - track.duration) >
      Math.max(8, track.duration * 0.03)
  )
    return false;
  return true;
}
const ALLOWED_IMAGE_HOSTS =
  /(^|\.)(dzcdn\.net|deezer\.com|mzstatic\.com|shazam\.com|coverartarchive\.org|archive\.org|wikimedia\.org)$/;
export async function downloadImage(url) {
  if (!url) return null;
  try {
    const target = new URL(url);
    const localTest = [
      process.env.EDORAS_DEEZER_ORIGIN,
      process.env.EDORAS_LYRICS_ORIGIN,
      process.env.EDORAS_ITUNES_ORIGIN,
      process.env.EDORAS_MUSICBRAINZ_ORIGIN,
      process.env.EDORAS_CAA_ORIGIN,
      process.env.EDORAS_COMMONS_ORIGIN,
      process.env.EDORAS_RECOGNIZE_ORIGIN,
    ].some((s) => s && new URL(s).origin === target.origin);
    if (
      !localTest &&
      (target.protocol !== "https:" ||
        !ALLOWED_IMAGE_HOSTS.test(target.hostname))
    )
      return null;
    const response = await fetch(target, {
      headers: { "User-Agent": AGENT },
      signal: AbortSignal.timeout(12000),
    });
    const type = (response.headers.get("content-type") || "").split(";")[0];
    if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(type)) {
      await response.body?.cancel();
      return null;
    }
    const max = 10 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > max) {
      await response.body?.cancel();
      return null;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > max) return null;
      chunks.push(chunk);
    }
    return length ? { type, bytes: Buffer.concat(chunks) } : null;
  } catch {
    return null;
  }
}
// Kept under the old name because the desktop smoke test and the identifier
// still reach for it.
export const downloadArtwork = downloadImage;
async function firstImage(urls) {
  for (const url of urls || []) {
    const image = await downloadImage(url);
    if (image) return image;
  }
  return null;
}
// The album is a separate lookup because the search response carries neither
// the release year nor the genre, and both belong on a track.
async function albumDetail(albumId) {
  if (!albumId) return null;
  try {
    return await deezer(`/album/${encodeURIComponent(albumId)}`);
  } catch {
    return null;
  }
}
// Deezer serves a generic silhouette for artists it has no photo for; it is
// always the same file, so a zero-width name in the path gives it away.
const SILHOUETTE = /\/artist\/\/?\d+x\d+/;
async function deezerArtistPhoto(name) {
  const data = await deezer(
    `/search/artist?q=${encodeURIComponent(name)}&limit=5`,
  );
  const want = normal(name);
  const hit = (data?.data || []).find((entry) => normal(entry?.name) === want);
  return hit ? imageChain(hit, "picture") : [];
}
// MusicBrainz → Wikidata → Wikimedia Commons. Only an exact name match with a
// high score is trusted, because a photo of the wrong person is worse than
// the initials.
async function commonsArtistPhoto(name, mbid = "") {
  let id = mbid;
  if (!id) {
    const found = await musicbrainz(
      `/ws/2/artist?query=${encodeURIComponent(`artist:"${lucene(name)}"`)}&fmt=json&limit=5`,
    );
    const want = normal(name);
    id =
      (found?.artists || []).find(
        (a) => normal(a?.name) === want && (a.score ?? 100) >= 90,
      )?.id || "";
  }
  if (!/^[a-f0-9-]{36}$/.test(id)) return [];
  const detail = await musicbrainz(`/ws/2/artist/${id}?inc=url-rels&fmt=json`);
  const link = (detail?.relations || []).find((r) => r?.type === "wikidata")
    ?.url?.resource;
  const qid = String(link || "").match(/(Q\d+)$/)?.[1];
  if (!qid) return [];
  const entity = await wikidata(`/wiki/Special:EntityData/${qid}.json`);
  const file =
    entity?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (typeof file !== "string" || !file) return [];
  return [
    `${COMMONS}/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=1000`,
  ];
}
// The photo for an artist, from the best place that has one. `hint` carries
// what a chosen result already knows (Deezer's picture and id, the
// MusicBrainz id) so the common case costs no extra request.
export async function findArtistPhoto(name, hint = {}) {
  const clean = cleanString(name);
  if (!clean || /^various artists$/i.test(clean) || unknown(clean)) return null;
  const attempts = [
    async () => hint.urls || [],
    async () =>
      hint.deezerId
        ? imageChain(
            await deezer(`/artist/${encodeURIComponent(hint.deezerId)}`),
            "picture",
          )
        : [],
    () => deezerArtistPhoto(clean),
    () => commonsArtistPhoto(clean, hint.mbid),
  ];
  for (const attempt of attempts) {
    try {
      const urls = (await attempt()).filter((url) => !SILHOUETTE.test(url));
      const image = await firstImage(urls);
      if (image) return image;
    } catch {
      /* try the next place */
    }
  }
  return null;
}
export function artistPhoto(candidate) {
  const name = candidate.albumArtist || candidate.artist;
  // A result's own picture belongs to the song's artist. On a compilation
  // that is not the name the photo is stored under, so it is not used.
  const same = normal(name) === normal(candidate.artist);
  return findArtistPhoto(name, {
    urls: same ? candidate.artistImageUrls : [],
    deezerId: same ? candidate.artistId : "",
    mbid: same ? candidate.artistMbid : "",
  });
}
// A cover for a record when the chosen result came without one: a sound
// match with no image, or a MusicBrainz release the Cover Art Archive has no
// scan of.
export async function findArtwork({ artist, album }) {
  if (!artist || !album || unknown(album)) return null;
  const want = normal(album);
  const close = (title) =>
    normal(title) === want || similarity(title, album) >= 0.8;
  try {
    const data = await deezer(
      `/search/album?q=${encodeURIComponent(`artist:"${artist.replace(/["\\]/g, " ")}" album:"${album.replace(/["\\]/g, " ")}"`)}&limit=5`,
    );
    const hit = (data?.data || []).find((entry) => close(entry?.title));
    const image = hit ? await firstImage(imageChain(hit, "cover")) : null;
    if (image) return image;
  } catch {
    /* Apple may have it */
  }
  try {
    const query = new URLSearchParams({
      term: `${artist} ${album}`,
      media: "music",
      entity: "album",
      limit: "5",
    });
    const data = await itunes(`/search?${query}`);
    const hit = (data?.results || []).find((entry) =>
      close(entry?.collectionName),
    );
    return hit ? await firstImage(appleArtwork(hit.artworkUrl100)) : null;
  } catch {
    return null;
  }
}
export function pickLyrics(entry) {
  if (!entry || entry.instrumental) return "";
  const plain = cleanLyrics(entry.plainLyrics);
  if (plain) return plain;
  // A timed file is still readable once the timestamps are taken off, and it
  // is what LRCLIB has most of.
  return cleanLyrics(
    String(entry.syncedLyrics || "").replace(/^\s*\[\d[^\]]*\]\s?/gm, ""),
  );
}
function cleanLyrics(value) {
  const text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text;
}
export async function findLyrics({ title, artist, album, duration }) {
  if (!title || !artist) return "";
  const lyricsJson = (path) =>
    rateLimited("lyrics", LYRICS_GAP, () =>
      json(`${LYRICS}${path}`, { allow404: true }),
    );
  const query = new URLSearchParams({
    artist_name: artist,
    track_name: title,
  });
  if (album) query.set("album_name", album);
  if (duration) query.set("duration", String(Math.round(duration)));
  try {
    const exact = await lyricsJson(`/api/get?${query}`);
    const found = pickLyrics(exact);
    if (found) return found;
  } catch {
    /* fall through to the looser search */
  }
  try {
    const results = await lyricsJson(
      `/api/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`,
    );
    for (const entry of Array.isArray(results) ? results.slice(0, 5) : []) {
      const found = pickLyrics(entry);
      if (found) return found;
    }
  } catch {
    /* no lyrics is a normal answer, not an error */
  }
  return "";
}
// A sound match names the recording but carries a small cover and nothing
// about the artist. The same song in the catalog fills that in: its artist's
// photo always, and its 1000px cover and album details when it is the same
// record.
async function catalogTwin(candidate, track) {
  try {
    const results = await searchMetadata(
      {
        title: candidate.title,
        artist: candidate.artist,
        duration: track?.duration || 0,
      },
      "",
      { sources: ["deezer"] },
    );
    return (
      results.find(
        (r) => r.titleMatch >= 0.8 && (!r.artistMatch || r.artistMatch >= 0.6),
      ) || null
    );
  } catch {
    return null;
  }
}
// Everything a chosen result adds to a track: the big cover, the artist's
// photo and the words. Each part is optional and a failure in one never
// costs the others. `track` is the song being described, used for the
// length when the result has none.
export async function completeCandidate(candidate, options = {}) {
  const { withArtistPhoto = true, withLyrics = true, track = null } = options;
  let base = { ...candidate, artworkUrls: [...(candidate.artworkUrls || [])] };
  if (candidate.audioMatch) {
    const twin = await catalogTwin(candidate, track);
    if (twin) {
      const sameRecord =
        !base.album || normal(base.album) === normal(twin.album);
      base = {
        ...base,
        artistId: twin.artistId,
        artistImageUrls: twin.artistImageUrls,
        duration: base.duration || twin.duration,
        ...(sameRecord
          ? {
              album: twin.album,
              albumArtist: twin.albumArtist || base.albumArtist,
              albumId: twin.albumId,
              artworkUrls: [...twin.artworkUrls, ...base.artworkUrls],
            }
          : { artworkUrls: [...base.artworkUrls, ...twin.artworkUrls] }),
      };
    }
  }
  const detail =
    base.albumId && (base.source === SOURCES.deezer || base.audioMatch)
      ? await albumDetail(base.albumId)
      : null;
  const complete = {
    ...base,
    year:
      base.year ||
      Number(String(detail?.release_date || "").slice(0, 4)) ||
      null,
    genre: base.genre || cleanString(detail?.genres?.data?.[0]?.name),
  };
  const [artwork, artistImage, lyrics] = await Promise.all([
    (async () =>
      (await firstImage([
        ...imageChain(detail, "cover"),
        ...complete.artworkUrls,
      ])) ||
      (await findArtwork({
        artist: complete.albumArtist || complete.artist,
        album: complete.album,
      })))(),
    withArtistPhoto ? artistPhoto(complete) : Promise.resolve(null),
    withLyrics
      ? findLyrics({
          title: complete.title,
          artist: complete.artist,
          album: complete.album,
          duration: complete.duration || track?.duration || 0,
        })
      : Promise.resolve(""),
  ]);
  return { ...complete, artwork, artistImage, lyrics };
}
