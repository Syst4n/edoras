import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { recognizedCandidate } from "../electron/recognize.js";
import * as metadataSync from "../electron/metadata.js";

// One local server per service, so each can be emptied or broken on its own
// and every request can be counted. Images answer with their own path as
// bytes, so a test can tell which cover or photo was chosen.
async function service(t, routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const path = req.url.split("?")[0];
    if (
      /\.(png|jpg)$/.test(path) ||
      path.includes("/front-") ||
      path.includes("FilePath")
    )
      return res
        .writeHead(200, { "content-type": "image/png" })
        .end(Buffer.from(path));
    for (const [prefix, answer] of Object.entries(routes))
      if (req.url.startsWith(prefix)) {
        const body =
          typeof answer === "function" ? answer(origin, req) : answer;
        if (body === 500) return res.writeHead(500).end();
        if (body === 404) return res.writeHead(404).end();
        return res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
async function catalogs(t, routes) {
  const made = {};
  for (const name of [
    "deezer",
    "itunes",
    "musicbrainz",
    "caa",
    "wikidata",
    "commons",
    "lyrics",
  ])
    made[name] = await service(t, routes[name] || {});
  process.env.EDORAS_DEEZER_ORIGIN = made.deezer.origin;
  process.env.EDORAS_ITUNES_ORIGIN = made.itunes.origin;
  process.env.EDORAS_MUSICBRAINZ_ORIGIN = made.musicbrainz.origin;
  process.env.EDORAS_CAA_ORIGIN = made.caa.origin;
  process.env.EDORAS_WIKIDATA_ORIGIN = made.wikidata.origin;
  process.env.EDORAS_COMMONS_ORIGIN = made.commons.origin;
  process.env.EDORAS_LYRICS_ORIGIN = made.lyrics.origin;
  for (const gap of ["DEEZER", "ITUNES", "MUSICBRAINZ", "WIKIDATA", "LYRICS"])
    process.env[`EDORAS_${gap}_GAP`] = "0";
  // A fresh module per test, so origins and caches are read again.
  const metadata = await import(`../electron/metadata.js?v=${Math.random()}`);
  return { ...made, metadata };
}
const deezerTrack = (origin, over = {}) => ({
  id: 1,
  title: "Lost and Found",
  duration: 339,
  artist: { id: 7, name: "Camel", picture_xl: `${origin}/camel.png` },
  album: { id: 3, title: "Rajaz", cover_xl: `${origin}/rajaz-xl.png` },
  ...over,
});
const appleTrack = (origin) => ({
  trackId: 55,
  trackName: "Lost and Found",
  artistName: "Camel",
  collectionName: "Rajaz",
  releaseDate: "1999-06-01T07:00:00Z",
  primaryGenreName: "Rock",
  trackTimeMillis: 339000,
  trackNumber: 3,
  discNumber: 1,
  artworkUrl100: `${origin}/image/thumb/rajaz/100x100bb.jpg`,
});
const recording = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Lost and Found",
  length: 339500,
  "first-release-date": "1999-06-01",
  "artist-credit": [
    {
      name: "Camel",
      artist: { id: "22222222-2222-2222-2222-222222222222", name: "Camel" },
    },
  ],
  releases: [
    {
      id: "33333333-3333-3333-3333-333333333333",
      title: "Coming of Age",
      status: "Official",
      "release-group": {
        id: "44444444-4444-4444-4444-444444444444",
        "primary-type": "Album",
      },
    },
  ],
  tags: [{ name: "progressive rock", count: 4 }],
};
const track = { title: "Lost and Found", artist: "Camel", duration: 339 };

test("when Deezer has nothing, Apple Music and MusicBrainz still offer the song", async (t) => {
  const { metadata, itunes } = await catalogs(t, {
    deezer: { "/search": { data: [] } },
    itunes: { "/search": (origin) => ({ results: [appleTrack(origin)] }) },
    musicbrainz: { "/ws/2/recording": { recordings: [recording] } },
  });
  const found = await metadata.searchMetadata(track);
  assert.deepEqual(found.map((r) => r.source).sort(), [
    "Apple Music",
    "MusicBrainz",
  ]);
  const apple = found.find((r) => r.source === "Apple Music");
  assert.equal(apple.year, 1999);
  assert.equal(apple.genre, "Rock");
  assert.equal(apple.number, 3);
  assert.equal(
    apple.artworkUrls[0],
    `${itunes.origin}/image/thumb/rajaz/1000x1000bb.jpg`,
    "Apple's thumbnail is asked for at 1000px",
  );
  const brainz = found.find((r) => r.source === "MusicBrainz");
  assert.equal(brainz.album, "Coming of Age");
  assert.equal(brainz.genre, "Progressive Rock");
  assert.match(brainz.artworkUrls[0], /\/release\/3{8}-.*\/front-1200$/);
  const complete = await metadata.completeCandidate(brainz, { track });
  assert.match(complete.artwork.bytes.toString(), /front-1200$/);
});

test("the library fetch asks the fallbacks only when Deezer has no confident match", async (t) => {
  let deezerEmpty = false;
  const { metadata, itunes, musicbrainz } = await catalogs(t, {
    deezer: {
      "/search": (origin) => ({
        data: deezerEmpty ? [] : [deezerTrack(origin)],
      }),
    },
    itunes: { "/search": (origin) => ({ results: [appleTrack(origin)] }) },
    musicbrainz: { "/ws/2/recording": { recordings: [recording] } },
  });
  const first = await metadata.bestMatch(track);
  assert.equal(first.source, "Deezer");
  assert.equal(itunes.seen.length + musicbrainz.seen.length, 0);
  deezerEmpty = true;
  // A different length, so the search is not answered from the cache.
  const second = await metadata.bestMatch({ ...track, duration: 340 });
  assert.equal(second.source, "Apple Music");
  assert.equal(musicbrainz.seen.length, 0, "MusicBrainz is never reached");
});

test("one catalog being down costs only its own results; all down is an error", async (t) => {
  const { metadata } = await catalogs(t, {
    deezer: { "/search": 500 },
    itunes: { "/search": (origin) => ({ results: [appleTrack(origin)] }) },
    musicbrainz: { "/ws/2/recording": 500 },
  });
  const found = await metadata.searchMetadata(track);
  assert.equal(found[0].source, "Apple Music");
  const down = await catalogs(t, {
    deezer: { "/search": 500 },
    itunes: { "/search": 500 },
    musicbrainz: { "/ws/2/recording": 500 },
  });
  await assert.rejects(down.metadata.searchMetadata(track), /unavailable/);
  await assert.rejects(down.metadata.bestMatch(track), /No catalog/);
});

test("an artist without a Deezer photo gets one through MusicBrainz, Wikidata and Commons", async (t) => {
  const { metadata, deezer } = await catalogs(t, {
    deezer: {
      "/search/artist": (origin) => ({
        data: [
          // Deezer's silhouette for an artist it has no photo of.
          {
            id: 7,
            name: "Camel",
            picture_xl: `${origin}/images/artist//1000x1000-000000-80-0-0.jpg`,
          },
        ],
      }),
    },
    musicbrainz: {
      "/ws/2/artist?": {
        artists: [
          {
            id: "55555555-5555-5555-5555-555555555555",
            name: "Camel Toe",
            score: 100,
          },
          {
            id: "22222222-2222-2222-2222-222222222222",
            name: "Camel",
            score: 100,
          },
        ],
      },
      "/ws/2/artist/22222222-2222-2222-2222-222222222222": {
        relations: [
          {
            type: "wikidata",
            url: { resource: "https://www.wikidata.org/wiki/Q369216" },
          },
        ],
      },
    },
    wikidata: {
      "/wiki/Special:EntityData/Q369216.json": {
        entities: {
          Q369216: {
            claims: {
              P18: [
                { mainsnak: { datavalue: { value: "Camel band 1977.jpg" } } },
              ],
            },
          },
        },
      },
    },
  });
  const photo = await metadata.findArtistPhoto("Camel");
  assert.equal(
    photo.bytes.toString(),
    "/wiki/Special:FilePath/Camel_band_1977.jpg",
  );
  assert.ok(
    !deezer.seen.some((url) => url.includes("1000x1000-000000")),
    "the silhouette is never downloaded",
  );
  assert.equal(await metadata.findArtistPhoto("Various Artists"), null);
});

test("identify by sound saves artwork, the catalog's bigger cover and the artist photo", async (t) => {
  const { metadata, deezer } = await catalogs(t, {
    deezer: {
      "/search": (origin) => ({ data: [deezerTrack(origin)] }),
      "/album/3": (origin) => ({
        id: 3,
        release_date: "1999-06-01",
        genres: { data: [{ name: "Rock" }] },
        cover_xl: `${origin}/rajaz-xl.png`,
      }),
    },
    lyrics: { "/api/get": { plainLyrics: "Words", instrumental: false } },
  });
  const heard = recognizedCandidate({
    matches: [{ id: "1" }],
    track: {
      key: "9",
      title: "Lost and Found",
      subtitle: "Camel",
      images: { coverarthq: `${deezer.origin}/shazam-400.jpg` },
      sections: [
        { type: "SONG", metadata: [{ title: "Album", text: "Rajaz" }] },
      ],
    },
  });
  assert.equal(heard.audioMatch, true);
  assert.deepEqual(heard.artworkUrls, [`${deezer.origin}/shazam-400.jpg`]);
  const complete = await metadata.completeCandidate(heard, { track });
  assert.equal(complete.artwork.bytes.toString(), "/rajaz-xl.png");
  assert.equal(complete.artistImage.bytes.toString(), "/camel.png");
  assert.equal(complete.year, 1999);
  assert.equal(complete.lyrics, "Words");
});

test("a sound match with no cover of its own finds one by album", async (t) => {
  const { metadata } = await catalogs(t, {
    deezer: { "/search": { data: [] } },
    itunes: {
      "/search": (origin, req) =>
        req.url.includes("entity=album")
          ? {
              results: [
                {
                  collectionName: "Rajaz",
                  artworkUrl100: `${origin}/a/100x100bb.jpg`,
                },
              ],
            }
          : { results: [] },
    },
  });
  const heard = recognizedCandidate({
    matches: [{ id: "1" }],
    track: {
      title: "Lost and Found",
      subtitle: "Camel",
      sections: [
        { type: "SONG", metadata: [{ title: "Album", text: "Rajaz" }] },
      ],
    },
  });
  const complete = await metadata.completeCandidate(heard, {
    track,
    withArtistPhoto: false,
    withLyrics: false,
  });
  assert.equal(complete.artwork.bytes.toString(), "/a/1000x1000bb.jpg");
});

test("the library fetch takes the first sure result, not only the top one, and ignores remaster tags", async (t) => {
  const { metadata } = await catalogs(t, {
    deezer: {
      "/search": (origin) => ({
        data: [
          // Ranked first (it has the bonus for a close length) but 11
          // seconds long, so it is not sure.
          deezerTrack(origin, {
            id: 9,
            title: "Lost and Found",
            duration: 350,
          }),
          deezerTrack(origin, {
            id: 10,
            title: "Lost and Found - 2021 Remaster",
            duration: 338,
          }),
        ],
      }),
    },
  });
  const best = await metadata.bestMatch(track);
  assert.equal(best.sourceId, "10");
  assert.equal(
    metadata.similarity("Lawrence (Remastered 2009)", "Lawrence"),
    1,
  );
  assert.equal(metadata.similarity("Lawrence (Live)", "Lawrence"), 0.5);
});

test("a long piece may differ by a few percent in length", () => {
  const { confident } = metadataSync;
  const long = { duration: 648 };
  const c = { titleMatch: 1, artistMatch: 1, duration: 664 };
  assert.equal(confident(c, long), true, "16s on 10:48 is under 3%");
  assert.equal(confident({ ...c, duration: 675 }, long), false);
  assert.equal(confident({ ...c, duration: 318 }, { duration: 339 }), false);
});

test("a song its own search misses is found in its album's tracklist", async (t) => {
  const { metadata, deezer } = await catalogs(t, {
    deezer: {
      "/search/album": { data: [{ id: 3, title: "Rajaz" }] },
      "/search": { data: [] },
      "/album/3": (origin) => ({
        id: 3,
        title: "Rajaz",
        cover_xl: `${origin}/rajaz-xl.png`,
        artist: { id: 7, name: "Camel", picture_xl: `${origin}/camel.png` },
        tracks: {
          data: [
            {
              id: 21,
              title: "Sahara",
              duration: 405,
              artist: { id: 7, name: "Camel" },
            },
            {
              id: 22,
              title: "Lawrence",
              duration: 648,
              artist: { id: 7, name: "Camel" },
            },
          ],
        },
      }),
    },
    itunes: { "/search": { results: [] } },
    musicbrainz: { "/ws/2/recording": { recordings: [] } },
  });
  const best = await metadata.bestMatch({
    title: "Lawrence",
    artist: "Camel",
    albumArtist: "Camel",
    album: "Rajaz",
    duration: 650,
  });
  assert.equal(best.sourceId, "22");
  assert.equal(best.album, "Rajaz");
  assert.equal(best.artworkUrls[0], `${deezer.origin}/rajaz-xl.png`);
  assert.equal(best.artistImageUrls[0], `${deezer.origin}/camel.png`);
});

test("a song is only marked as having no match when every catalog answered", async (t) => {
  const { metadata } = await catalogs(t, {
    deezer: { "/search": 500 },
    itunes: { "/search": { results: [] } },
    musicbrainz: { "/ws/2/recording": { recordings: [] } },
  });
  await assert.rejects(metadata.bestMatch(track), /could not be reached/);
  const answered = await catalogs(t, {
    deezer: { "/search": { data: [] } },
    itunes: { "/search": { results: [] } },
    musicbrainz: { "/ws/2/recording": { recordings: [] } },
  });
  assert.equal(await answered.metadata.bestMatch(track), null);
});
