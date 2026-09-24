// The last round before 1.0, driven in the real app: the Albums shelf,
// playing a playlist from its card, shuffle and repeat that show their state,
// the stand-in art for a playlist without a picture, the player bar's "+",
// the filled buttons without an outline, and songs with no match being tried
// again. Run with `npm run test:final`.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

// One stub for every catalog. Deezer knows the song only once `known` is
// set, which is what a catalog that has since added a record looks like.
let known = false;
const server = http.createServer((req, res) => {
  const json = (body) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  if (req.url.startsWith("/search?term=")) return json({ results: [] });
  if (req.url.startsWith("/search/")) return json({ data: [] });
  if (req.url.startsWith("/ws/2/")) return json({ recordings: [] });
  if (req.url.startsWith("/search"))
    return json({
      data:
        known && decodeURIComponent(req.url).includes("Sahara")
          ? [
              {
                id: 77,
                title: "Sahara - 2021 Remaster",
                duration: 16,
                artist: { id: 7, name: "Camel" },
                album: { id: 3, title: "Rajaz" },
              },
            ]
          : [],
    });
  if (req.url.startsWith("/album/")) return json({ id: 3, title: "Rajaz" });
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-final-test-"));
const home = path.join(temp, "app-data");
const source = path.join(temp, "source");
await fs.mkdir(source, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
const run = (args) =>
  execFileSync(
    ffmpeg,
    ["-v", "error", ...args.slice(0, -1), "-y", args.at(-1)],
    { windowsHide: true },
  );
const cover = (file, colour) =>
  run([
    "-f",
    "lavfi",
    "-i",
    `color=c=${colour}:s=320x320`,
    "-frames:v",
    "1",
    file,
  ]);
cover(path.join(temp, "red.jpg"), "0xc0392b");
cover(path.join(temp, "blue.jpg"), "0x2d6cdf");
const song = (name, title, artist, album, art, frequency) =>
  run([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=16`,
    "-i",
    art,
    "-map",
    "0",
    "-map",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-c:v",
    "copy",
    "-id3v2_version",
    "3",
    "-metadata",
    `title=${title}`,
    "-metadata",
    `artist=${artist}`,
    "-metadata",
    `album=${album}`,
    path.join(source, name),
  ]);
song("a.mp3", "Sahara", "Camel", "Rajaz", path.join(temp, "red.jpg"), 330);
song("b.mp3", "Lawrence", "Camel", "Rajaz", path.join(temp, "red.jpg"), 392);
song(
  "c.mp3",
  "Blue one",
  "Cobalt",
  "Blue Album",
  path.join(temp, "blue.jpg"),
  440,
);

const checks = [];
const errors = [];
let desktop;
const centre = (box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

try {
  desktop = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      EDORAS_TEST_HOME: home,
      EDORAS_DEEZER_ORIGIN: origin,
      EDORAS_LYRICS_ORIGIN: origin,
      EDORAS_ITUNES_ORIGIN: origin,
      EDORAS_MUSICBRAINZ_ORIGIN: origin,
      EDORAS_CAA_ORIGIN: origin,
      EDORAS_WIKIDATA_ORIGIN: origin,
      EDORAS_COMMONS_ORIGIN: origin,
      EDORAS_DEEZER_GAP: "0",
      EDORAS_LYRICS_GAP: "0",
      EDORAS_ITUNES_GAP: "0",
      EDORAS_MUSICBRAINZ_GAP: "0",
      EDORAS_WIKIDATA_GAP: "0",
    },
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.setItem("edoras-theme", "light");
    document.documentElement.setAttribute("data-theme", "light");
  });

  // ---- filled buttons have no outline ----------------------------------------
  const outline = (locator) =>
    locator.evaluate((el) => getComputedStyle(el).borderTopColor);
  const clear = /rgba\(0, 0, 0, 0\)|transparent/;
  expect(await outline(page.locator('.hero [data-action="import"]'))).toMatch(
    clear,
  );

  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, source);
  await page.locator('.topbar [data-action="import"]').click();
  await page.locator('[data-action="pick-folder"]').click();
  await expect(page.locator('.hero [data-action="play-all"]')).toBeVisible();
  expect(await outline(page.locator('.hero [data-action="play-all"]'))).toMatch(
    clear,
  );
  await page.locator('.nav-item[data-view="listen"]').click();
  expect(
    await outline(page.locator('.list-actions [data-action="play-all"]')),
  ).toMatch(clear);
  checks.push(
    "Start listening, Import your music and Play all have no outline",
  );

  // ---- Albums on Home ------------------------------------------------------------
  await page.locator('.nav-item[data-view="home"]').click();
  const albums = page.locator(".section-heading").filter({
    has: page.getByRole("heading", { name: "Albums", exact: true }),
  });
  await expect(albums).toBeVisible();
  const shelf = albums.locator("xpath=following-sibling::div[1]");
  await expect(shelf.locator(".music-card[data-album]")).toHaveCount(2);
  await shelf
    .locator(".music-card[data-album]")
    .filter({ hasText: "Blue Album" })
    .hover();
  await shelf.locator('[data-album-play*="Blue Album"]').click();
  await expect(page.locator("#player-title")).toHaveText("Blue one");
  await albums.getByRole("button", { name: /View all/ }).click();
  await expect(page.locator(".albums-grid")).toBeVisible();
  checks.push("Home has an Albums shelf that plays a record and opens Albums");

  // ---- a playlist plays from its card -------------------------------------------
  const ids = await page.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.tracks.map((t) => t.id)),
  );
  await page.evaluate(() => window.edoras.createPlaylist("Desert"));
  await page.evaluate(() => window.edoras.createPlaylist("Nothing yet"));
  const lists = await page.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.playlists),
  );
  const desert = lists.find((p) => p.name === "Desert");
  const camel = await page.evaluate(() =>
    window.edoras
      .getLibrary()
      .then((d) =>
        d.tracks.filter((t) => t.artist === "Camel").map((t) => t.id),
      ),
  );
  await page.evaluate(
    ([id, tracks]) => window.edoras.addTracksToPlaylist(id, tracks),
    [desert.id, [...camel].reverse()],
  );
  await page.reload();
  const card = page.locator(`.playlist-card[data-playlist="${desert.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  const play = card.locator("[data-playlist-play]");
  await expect(play).toBeVisible();
  await play.click();
  await expect(page.locator("#player-title")).toHaveText(
    await page.evaluate(
      (id) =>
        window.edoras
          .getLibrary()
          .then((d) => d.tracks.find((t) => t.id === id).title),
      [...camel].reverse()[0],
    ),
  );
  await expect(card).toHaveClass(/is-playing/);
  await expect(play.locator("svg")).toHaveClass(/lucide-pause/);
  await expect(page.getByRole("heading", { name: "Desert" })).toHaveCount(0);
  await play.click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("paused", true);
  await expect(card).not.toHaveClass(/is-playing/);
  checks.push(
    "a playlist card plays the playlist in its order, shows Pause, and pauses",
  );

  // ---- a playlist without a picture ---------------------------------------------
  const blank = page.locator(
    `#playlist-nav [data-playlist="${lists.find((p) => p.name === "Nothing yet").id}"] .nav-cover-blank`,
  );
  await expect(blank.locator("svg")).toBeVisible();
  await page.locator('[data-action="collapse"]').click();
  await page.waitForTimeout(450);
  const tile = await blank.boundingBox();
  if (!tile || Math.round(tile.width) !== 20 || Math.round(tile.height) !== 20)
    throw new Error(`the stand-in tile is ${JSON.stringify(tile)} collapsed`);
  await expect(blank.locator("svg")).toBeVisible();
  await page.locator('[data-action="collapse"]').click();
  await page
    .locator(`#playlist-nav [data-playlist]`)
    .filter({ hasText: "Nothing yet" })
    .click();
  const art = await page.locator(".playlist-cover").boundingBox();
  const glyph = await page
    .locator(".playlist-cover .art-fallback svg")
    .boundingBox();
  const off = {
    x: Math.abs(centre(art).x - centre(glyph).x),
    y: Math.abs(centre(art).y - centre(glyph).y),
  };
  if (off.x > 1 || off.y > 1)
    throw new Error(
      `the playlist glyph is off centre by ${JSON.stringify(off)}`,
    );
  checks.push(
    "a playlist without a picture has a stand-in tile, expanded and collapsed, and a centred glyph",
  );

  // ---- the player bar ------------------------------------------------------------
  const plus = page.locator("#player .add-ring");
  const ring = await plus.boundingBox();
  const cross = await plus.locator("svg").boundingBox();
  const name = await page.locator("#player-title").boundingBox();
  if (ring.width > 24) throw new Error(`the + is ${ring.width}px wide`);
  if (ring.x - (name.x + name.width) > 12)
    throw new Error("the + is not beside the song name");
  if (
    Math.abs(centre(ring).x - centre(cross).x) > 0.5 ||
    Math.abs(centre(ring).y - centre(cross).y) > 0.5
  )
    throw new Error("the + is not centred in its ring");
  const transport = () =>
    page
      .locator("#player .transport")
      .boundingBox()
      .then((b) => b.x);
  const before = await transport();
  await page.locator(`#playlist-nav [data-playlist="${desert.id}"]`).click();
  await page.locator(".track-row [data-row-play]").last().click();
  if (Math.abs((await transport()) - before) > 0.5)
    throw new Error("the transport moved when the song name changed");
  checks.push(
    "the + is small, centred and beside the name; the transport stays put",
  );

  const state = (selector) =>
    page.locator(`.player-actions ${selector}`).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        colour: s.color,
        background: s.backgroundColor,
        pressed: el.getAttribute("aria-pressed"),
        dot: getComputedStyle(el, "::after").content,
      };
    });
  await page.mouse.move(700, 200);
  const shuffleOff = await state(".shuffle");
  const repeatOff = await state(".repeat");
  await page.locator(".player-actions .shuffle").click();
  await page.locator(".player-actions .repeat").click();
  await page.mouse.move(700, 200);
  await page.waitForTimeout(300);
  const shuffleOn = await state(".shuffle");
  const repeatOn = await state(".repeat");
  for (const [off, on, label] of [
    [shuffleOff, shuffleOn, "shuffle"],
    [repeatOff, repeatOn, "repeat"],
  ]) {
    if (off.colour === on.colour)
      throw new Error(`${label} looks the same on and off`);
    if (on.background === off.background)
      throw new Error(`${label} has no disc when on`);
    if (on.pressed !== "true" || off.pressed !== "false")
      throw new Error(`${label} does not report its state`);
    if (on.dot === "none") throw new Error(`${label} has no dot when on`);
  }
  await page.locator(".player-actions .repeat").click();
  await expect(page.locator(".player-actions .repeat svg")).toHaveClass(
    /lucide-repeat-1/,
  );
  await page.locator(".player-actions .repeat").click();
  await page.locator(".player-actions .shuffle").click();
  await expect(page.locator(".player-actions .shuffle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.screenshot({
    path: "test-results/final-player.png",
    clip: { x: 230, y: 790, width: 1210, height: 110 },
  });
  checks.push(
    "shuffle and repeat show on and off, and repeat one has its own glyph",
  );

  // ---- the lyrics buttons line up ------------------------------------------------
  await page.locator('.nav-item[data-view="lyrics"]').click();
  for (const action of ["fetch-lyrics", "edit-lyrics"]) {
    const button = page.locator(`.lyrics-blank [data-action="${action}"]`);
    const b = await button.boundingBox();
    const g = await button.locator("svg").boundingBox();
    if (Math.abs(centre(b).y - centre(g).y) > 1)
      throw new Error(`the ${action} icon sits off the button's middle`);
  }
  checks.push("Look online and Paste lyrics have their icons on the text line");

  // ---- songs with no match are tried again ---------------------------------------
  const first = await page.evaluate(() =>
    window.edoras.fetchLibraryMetadata({}),
  );
  expect(first.total).toBe(3);
  expect(first.matched).toBe(0);
  expect(first.skipped).toBe(3);
  known = true;
  const second = await page.evaluate(() =>
    window.edoras.fetchLibraryMetadata({}),
  );
  expect(second.total).toBe(3);
  expect(second.matched).toBe(1);
  const third = await page.evaluate(() =>
    window.edoras.fetchLibraryMetadata({}),
  );
  expect(third.total).toBe(2);
  checks.push(
    "a song with no match is asked about again, a remaster tag still matches, a match is left alone",
  );

  // ---- light mode waveform grey ----------------------------------------------------
  const grey = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--pk-off")
      .trim(),
  );
  expect(grey).toBe("#a9ada6");
  checks.push("the unplayed waveform is a darker grey in light mode");

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.log(
    JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await desktop?.close();
  server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
