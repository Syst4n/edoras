// Song identification against MusicBrainz, with artwork from the Cover Art
// Archive. Both are free and need no account, which is why they were chosen:
// nothing here asks the user for an API key.
//
// This runs in the main process. The renderer is sandboxed and must not make
// network calls, so identification is reached over IPC like every other
// privileged operation.

// Overridable so the integration test can exercise the real fetch, parse,
// ranking and throttle paths against a local stub, in the same way
// EDORAS_TEST_HOME redirects the library during the desktop test.
const ENDPOINT = `${process.env.EDORAS_MB_ORIGIN || "https://musicbrainz.org"}/ws/2/recording`;
const COVER = process.env.EDORAS_CAA_ORIGIN || "https://coverartarchive.org";
// MusicBrainz asks for a descriptive agent naming the application and a way
// to make contact. Sending a generic one risks the whole app being blocked.
const AGENT = "Edoras/0.1.0 ( https://github.com/Syst4n/edoras )";
// Their published limit is one request per second, averaged. We leave a
// margin rather than sitting exactly on the line.
const GAP = Number(process.env.EDORAS_MB_GAP ?? 1100);
const TIMEOUT = 12000;
// Below this, MusicBrainz is guessing. A wrong identification that silently
// overwrites good tags is worse than no identification at all.
const MIN_SCORE = 85;

let lastRequest = 0;
let chain = Promise.resolve();

// Serialised rather than merely delayed: two identifications started close
// together must still leave a gap between their requests.
function throttled(work) {
  const result = chain.then(async () => {
    const wait = GAP - (Date.now() - lastRequest);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await work();
    } finally {
      lastRequest = Date.now();
    }
  });
  chain = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (response.status === 503)
    throw new Error("MusicBrainz is busy. Try again shortly.");
  if (!response.ok) throw new Error(`Lookup failed (${response.status})`);
  return response.json();
}

// Lucene special characters would otherwise turn a punctuated title into a
// malformed query.
const escapeQuery = (value) =>
  String(value).replace(/([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");

function buildQuery({ title, artist, album }) {
  const parts = [`recording:"${escapeQuery(title)}"`];
  if (artist && artist !== "Unknown artist")
    parts.push(`artist:"${escapeQuery(artist)}"`);
  if (album && album !== "Unknown album")
    parts.push(`release:"${escapeQuery(album)}"`);
  return parts.join(" AND ");
}

function pickRelease(recording) {
  const releases = recording.releases || [];
  // An official album release carries better artwork and a more useful date
  // than a compilation or a bootleg.
  const ranked = [...releases].sort((a, b) => {
    const score = (r) =>
      (r.status === "Official" ? 2 : 0) +
      (r["release-group"]?.["primary-type"] === "Album" ? 1 : 0);
    return score(b) - score(a);
  });
  return ranked[0];
}

async function artworkFor(release) {
  if (!release) return null;
  const candidates = [
    `${COVER}/release/${release.id}/front-500`,
    release["release-group"]?.id
      ? `${COVER}/release-group/${release["release-group"].id}/front-500`
      : null,
  ].filter(Boolean);
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT),
      });
      // A 404 here is ordinary: it means nobody has chosen a front cover for
      // this release, not that anything went wrong.
      if (!response.ok) continue;
      const type = response.headers.get("content-type") || "";
      if (!/^image\/(jpeg|png|webp)/.test(type)) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) continue;
      return { bytes, type: type.split(";")[0].trim() };
    } catch {
      // Try the next candidate; artwork is optional.
    }
  }
  return null;
}

// Resolves null when nothing is confidently identified. The caller shows
// nothing in that case rather than guessing or surfacing an error, because
// fingerprint-free lookup simply cannot match everything.
export const internals = { buildQuery, escapeQuery, pickRelease, MIN_SCORE };

export async function identify(track) {
  const title = String(track?.title || "").trim();
  if (!title) return null;

  const url = `${ENDPOINT}?query=${encodeURIComponent(buildQuery(track))}&limit=5&fmt=json`;
  const data = await throttled(() => getJSON(url));
  const recordings = (data.recordings || []).filter(
    (r) => (r.score ?? 0) >= MIN_SCORE,
  );
  if (!recordings.length) return null;

  // Where durations are known, prefer a match that actually is the same
  // length: same-titled covers and live versions score identically otherwise.
  const seconds = Number(track.duration) || 0;
  const best = recordings.sort((a, b) => {
    const delta = (r) =>
      seconds && r.length ? Math.abs(r.length / 1000 - seconds) : 999;
    const close = (r) => (delta(r) <= 12 ? 1 : 0);
    return close(b) - close(a) || (b.score ?? 0) - (a.score ?? 0);
  })[0];

  const release = pickRelease(best);
  const credit = best["artist-credit"]?.[0];
  const artwork = await artworkFor(release);
  return {
    title: best.title || title,
    artist: credit?.name || credit?.artist?.name || "",
    albumArtist: credit?.artist?.name || credit?.name || "",
    album: release?.title || "",
    year: Number(String(release?.date || "").slice(0, 4)) || null,
    score: best.score ?? 0,
    mbid: best.id || "",
    artwork,
  };
}
