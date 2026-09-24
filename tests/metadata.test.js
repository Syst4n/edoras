import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  cleanTitle,
  searchTerms,
  rankCandidates,
} from "../electron/metadata.js";
import { fingerprint, recognizedCandidate } from "../electron/recognize.js";

test("filename cleanup retains musical versions and splits artist from title", () => {
  assert.equal(
    cleanTitle("01. Eminem - Cold Wind Blows [Official Audio].mp3"),
    "Eminem - Cold Wind Blows",
  );
  assert.equal(cleanTitle("A song (Live) [abcdef1234].flac"), "A song (Live)");
  assert.deepEqual(
    searchTerms({
      title: "Eminem - Cold Wind Blows",
      artist: "Unknown artist",
      album: "Downloads",
    }),
    {
      title: "Cold Wind Blows",
      artist: "Eminem",
      term: "Eminem Cold Wind Blows",
    },
  );
  assert.equal(
    searchTerms({ title: "old", artist: "wrong" }, "فيروز — نسم علينا الهوى")
      .artist,
    "فيروز",
  );
});
test("matching considers artist and duration rather than trusting a provider score", () => {
  const candidates = [
    {
      title: "Cold Wind Blows",
      artist: "A cover band",
      album: "Covers",
      duration: 220,
      score: 100,
    },
    {
      title: "Cold Wind Blows",
      artist: "Eminem",
      album: "Recovery",
      duration: 303,
      score: 75,
    },
    {
      title: "Different song",
      artist: "Eminem",
      album: "Other",
      duration: 303,
    },
  ];
  const ranked = rankCandidates(
    candidates,
    { duration: 303 },
    { title: "Cold Wind Blows", artist: "Eminem" },
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].album, "Recovery");
});
test("one keyless catalog: search, cache, deferred artwork, artist photo and lyrics", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const send = (body) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.url.startsWith("/search")) {
      assert.equal(req.headers.authorization, undefined);
      return send({
        data: [
          {
            id: 77,
            title: "Cold Wind Blows",
            duration: 303,
            rank: 500000,
            artist: {
              id: 9,
              name: "Eminem",
              picture_xl: `${origin}/artist.png`,
            },
            album: {
              id: 5,
              title: "Recovery",
              cover_xl: `${origin}/cover-xl.png`,
            },
          },
        ],
      });
    }
    if (req.url.startsWith("/album/"))
      return send({
        id: 5,
        title: "Recovery",
        release_date: "2010-06-18",
        genres: { data: [{ name: "Hip Hop" }] },
        cover_xl: `${origin}/cover-xl.png`,
      });
    if (req.url.startsWith("/api/get"))
      return send({ plainLyrics: "  Cold wind blows  ", instrumental: false });
    res
      .writeHead(200, { "content-type": "image/png" })
      .end(Buffer.from([137, 80, 78, 71]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.EDORAS_DEEZER_ORIGIN = origin;
  process.env.EDORAS_LYRICS_ORIGIN = origin;
  process.env.EDORAS_DEEZER_GAP = "0";
  process.env.EDORAS_LYRICS_GAP = "0";
  const { searchMetadata, completeCandidate, confident } = await import(
    `../electron/metadata.js?test=${Date.now()}`
  );
  const track = {
    title: "Eminem - Cold Wind Blows (Official Audio)",
    artist: "Unknown artist",
    album: "Downloads",
    duration: 303,
  };
  const found = await searchMetadata(track);
  assert.equal(found[0].artist, "Eminem");
  assert.equal(found[0].source, "Deezer");
  assert.equal(
    requests.every((r) => r.startsWith("/search")),
    true,
    "search fetches nothing but the search",
  );
  assert.equal(confident(found[0], track), true);
  const before = requests.length;
  await searchMetadata(track);
  assert.equal(requests.length, before, "repeat searches use the cache");
  const detailed = await completeCandidate(found[0]);
  assert.equal(detailed.artwork.type, "image/png");
  assert.equal(detailed.artistImage.type, "image/png");
  assert.equal(detailed.lyrics, "Cold wind blows");
  assert.equal(detailed.year, 2010);
  assert.equal(detailed.genre, "Hip Hop");
});
test("a shaky match is never written without the user seeing it", async () => {
  const { confident } = await import("../electron/metadata.js");
  const track = { duration: 303 };
  assert.equal(
    confident({ titleMatch: 0.5, artistMatch: 1, duration: 303 }, track),
    false,
  );
  assert.equal(
    confident({ titleMatch: 1, artistMatch: 0.2, duration: 303 }, track),
    false,
  );
  assert.equal(
    confident({ titleMatch: 1, artistMatch: 1, duration: 200 }, track),
    false,
  );
  assert.equal(
    confident({ titleMatch: 1, artistMatch: 1, duration: 305 }, track),
    true,
  );
});
test("audio signatures are generated locally in a worker and do not contain PCM", async () => {
  const pcm = Buffer.alloc(16000 * 2 * 3);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(
      Math.round(Math.sin((i / 16000) * 440 * Math.PI * 2) * 10000),
      i * 2,
    );
  const signature = await fingerprint(pcm);
  assert.ok(signature.uri.startsWith("data:audio/vnd.shazam.sig;base64,"));
  assert.equal(signature.samplems, 3000);
  assert.ok(signature.uri.length < pcm.length / 4);
});
test("recognition tolerates missing album sections and never invents a match", () => {
  assert.equal(
    recognizedCandidate({ matches: [], track: { title: "Ignored" } }),
    null,
  );
  const result = recognizedCandidate({
    matches: [{ id: "1" }],
    track: { title: "Found", subtitle: "Artist" },
  });
  assert.equal(result.title, "Found");
  assert.equal(result.album, "");
  assert.equal(result.year, null);
});
