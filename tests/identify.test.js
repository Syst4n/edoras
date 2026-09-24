import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

// A stub standing in for MusicBrainz and the Cover Art Archive, so the real
// request, parse, ranking and throttle paths are exercised rather than mocked.
async function stub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url,
      agent: req.headers["user-agent"],
      at: Date.now(),
    });
    handler(req, res, seen);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, seen, close: () => new Promise((r) => server.close(r)) };
}

const recording = (over = {}) => ({
  id: "mbid-1",
  title: "Cold Wind Blows",
  score: 100,
  length: 245000,
  "artist-credit": [{ name: "Eminem", artist: { name: "Eminem" } }],
  releases: [
    {
      id: "rel-official",
      title: "Recovery",
      status: "Official",
      date: "2010-06-18",
      "release-group": { id: "rg-1", "primary-type": "Album" },
    },
  ],
  ...over,
});

async function load(origin, extra = {}) {
  process.env.EDORAS_MB_ORIGIN = origin;
  process.env.EDORAS_CAA_ORIGIN = origin;
  process.env.EDORAS_MB_GAP = extra.gap ?? "0";
  // Fresh module per test so the throttle state and endpoints are re-read.
  return import(`../electron/identify.js?v=${Math.random()}`);
}

test("a confident match returns tidied metadata and artwork", async (t) => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  );
  const server = await stub((req, res) => {
    if (req.url.startsWith("/ws/2/recording")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ recordings: [recording()] }));
    } else if (req.url === "/release/rel-official/front-500") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
    } else {
      res.writeHead(404).end();
    }
  });
  t.after(server.close);
  const { identify } = await load(server.origin);

  const result = await identify({
    title: "cold wind blows",
    artist: "Unknown artist",
    duration: 245,
  });
  assert.equal(result.title, "Cold Wind Blows");
  assert.equal(result.artist, "Eminem");
  assert.equal(result.album, "Recovery");
  assert.equal(result.year, 2010);
  assert.equal(result.artwork.type, "image/png");
  assert.ok(result.artwork.bytes.length > 0);

  const query = decodeURIComponent(server.seen[0].url);
  assert.ok(query.includes('recording:"cold wind blows"'));
  assert.ok(
    !query.includes("Unknown artist"),
    "a placeholder artist must not narrow the search",
  );
  assert.match(
    server.seen[0].agent,
    /^Edoras\/[\d.]+ \(.+\)$/,
    "identifies itself",
  );
});

test("a weak match resolves null so nothing is changed", async (t) => {
  const server = await stub((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ recordings: [recording({ score: 42 })] }));
  });
  t.after(server.close);
  const { identify } = await load(server.origin);
  assert.equal(
    await identify({ title: "Something vague", duration: 100 }),
    null,
  );
});

test("no results at all resolves null rather than throwing", async (t) => {
  const server = await stub((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ recordings: [] }));
  });
  t.after(server.close);
  const { identify } = await load(server.origin);
  assert.equal(await identify({ title: "Nothing here" }), null);
});

test("missing artwork is not an error, it is simply absent", async (t) => {
  const server = await stub((req, res) => {
    if (req.url.startsWith("/ws/2/recording")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ recordings: [recording()] }));
    } else res.writeHead(404).end();
  });
  t.after(server.close);
  const { identify } = await load(server.origin);
  const result = await identify({ title: "Cold Wind Blows", duration: 245 });
  assert.equal(result.artwork, null);
  assert.equal(result.album, "Recovery", "metadata still lands");
});

test("duration decides between equally scored recordings", async (t) => {
  const server = await stub((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        recordings: [
          recording({ id: "live", title: "Live version", length: 402000 }),
          recording({ id: "studio", title: "Studio version", length: 245000 }),
        ],
      }),
    );
  });
  t.after(server.close);
  const { identify } = await load(server.origin);
  const result = await identify({ title: "Cold Wind Blows", duration: 244 });
  assert.equal(result.title, "Studio version");
});

test("an official album release is preferred for artwork and date", async (t) => {
  const server = await stub((req, res) => {
    if (req.url.startsWith("/ws/2/recording")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          recordings: [
            recording({
              releases: [
                {
                  id: "bootleg",
                  title: "Live Bootleg",
                  status: "Bootleg",
                  date: "2011",
                },
                {
                  id: "rel-official",
                  title: "Recovery",
                  status: "Official",
                  date: "2010-06-18",
                  "release-group": { id: "rg-1", "primary-type": "Album" },
                },
              ],
            }),
          ],
        }),
      );
    } else res.writeHead(404).end();
  });
  t.after(server.close);
  const { identify } = await load(server.origin);
  const result = await identify({ title: "Cold Wind Blows", duration: 245 });
  assert.equal(result.album, "Recovery");
  assert.equal(result.year, 2010);
});

test("requests are spaced, so MusicBrainz's one-per-second rule holds", async (t) => {
  const server = await stub((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ recordings: [] }));
  });
  t.after(server.close);
  const { identify } = await load(server.origin, { gap: "300" });
  await Promise.all([
    identify({ title: "One" }),
    identify({ title: "Two" }),
    identify({ title: "Three" }),
  ]);
  assert.equal(server.seen.length, 3);
  for (let i = 1; i < server.seen.length; i++)
    assert.ok(
      server.seen[i].at - server.seen[i - 1].at >= 280,
      `request ${i + 1} came ${server.seen[i].at - server.seen[i - 1].at}ms after the last`,
    );
});

test("special characters cannot break the query", async (t) => {
  const server = await stub((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ recordings: [] }));
  });
  t.after(server.close);
  const { internals } = await load(server.origin);

  const raw = 'Hello: "World" (Live) [2010] +/- ~ ^ ? * AND';
  const escaped = internals.escapeQuery(raw);
  for (const char of [
    ":",
    '"',
    "(",
    ")",
    "[",
    "]",
    "+",
    "/",
    "-",
    "~",
    "^",
    "?",
    "*",
  ])
    assert.ok(
      !new RegExp(`(?<!\\\\)\\${char}`).test(escaped),
      `unescaped ${char} survived escaping: ${escaped}`,
    );

  // The escaped value is what actually reaches the query, wrapped in quotes,
  // and the field separators around it stay unescaped so the query parses.
  const query = internals.buildQuery({ title: raw, artist: "A && B" });
  assert.ok(query.startsWith(`recording:"${escaped}"`));
  assert.ok(query.includes(" AND artist:"));
});

test("a server error surfaces rather than being mistaken for no match", async (t) => {
  const server = await stub((req, res) => res.writeHead(503).end());
  t.after(server.close);
  const { identify } = await load(server.origin);
  await assert.rejects(() => identify({ title: "Anything" }), /busy/i);
});
