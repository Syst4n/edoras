// Exercise the real desktop bridge and UI against local metadata services.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
let mode = "none";
const requests = [];
const server = http.createServer(async (req, res) => {
  requests.push(req.url);
  await new Promise((r) => setTimeout(r, 120));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = (body) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  // The fallbacks share this stub: Apple's search and MusicBrainz find
  // nothing, so every result in this run is Deezer's or the sound match's.
  if (req.url.startsWith("/search?term=")) return json({ results: [] });
  if (req.url.startsWith("/search/")) return json({ data: [] });
  if (req.url.startsWith("/ws/2/"))
    return json({ recordings: [], artists: [] });
  if (req.url.startsWith("/search"))
    return json({
      data:
        mode === "none"
          ? []
          : [
              {
                id: 101,
                title: "A Proper Title",
                duration: 12,
                rank: 400000,
                artist: {
                  id: 9,
                  name: "A Real Artist",
                  picture_xl: `${origin}/artist.png`,
                },
                album: {
                  id: 5,
                  title: "A Real Album",
                  cover_xl: `${origin}/cover.png`,
                },
              },
            ],
    });
  if (req.url.startsWith("/album/"))
    return json({
      id: 5,
      title: "A Real Album",
      release_date: "1999-05-04",
      genres: { data: [{ name: "Test Genre" }] },
      cover_xl: `${origin}/cover.png`,
    });
  if (req.url.startsWith("/api/get") || req.url.startsWith("/api/search"))
    return mode === "none"
      ? res.writeHead(404).end()
      : json({ plainLyrics: "A line of words", instrumental: false });
  if (req.url.startsWith("/recognize/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const packet = JSON.parse(body);
    if (!packet.signature?.uri?.startsWith("data:audio/vnd.shazam.sig;base64,"))
      return res.writeHead(400).end();
    if (req.headers.authorization || body.includes("source"))
      return res.writeHead(400).end();
    return json({
      matches: [{ id: "recognized" }],
      track: {
        key: "42",
        title: "Acoustic Match",
        subtitle: "The Sound Artist",
        images: { coverarthq: `${origin}/shazam.png` },
        sections: [
          {
            type: "SONG",
            metadata: [
              { title: "Album", text: "Sound Album" },
              { title: "Released", text: "2001" },
            ],
          },
        ],
      },
    });
  }
  if (
    req.url === "/cover.png" ||
    req.url === "/artist.png" ||
    req.url === "/shazam.png"
  )
    return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-identify-e2e-"));
const source = path.join(temp, "source");
await fs.mkdir(source);
await fs.mkdir("test-results", { recursive: true });
execFileSync(
  ffmpeg,
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=12",
    "-y",
    path.join(source, "untitled track 01.flac"),
  ],
  { windowsHide: true },
);
const env = {
  ...process.env,
  EDORAS_TEST_HOME: path.join(temp, "app-data"),
  EDORAS_DEEZER_ORIGIN: origin,
  EDORAS_LYRICS_ORIGIN: origin,
  EDORAS_RECOGNIZE_ORIGIN: origin,
  EDORAS_ITUNES_ORIGIN: origin,
  EDORAS_MUSICBRAINZ_ORIGIN: origin,
  EDORAS_CAA_ORIGIN: origin,
  EDORAS_WIKIDATA_ORIGIN: origin,
  EDORAS_COMMONS_ORIGIN: origin,
  EDORAS_DEEZER_GAP: "0",
  EDORAS_LYRICS_GAP: "0",
  EDORAS_ITUNES_GAP: "0",
  EDORAS_MUSICBRAINZ_GAP: "0",
};
let desktop;
const checks = [];
const launchOptions = process.env.EDORAS_BINARY
  ? { executablePath: process.env.EDORAS_BINARY, args: [] }
  : { args: ["."] };
try {
  desktop = await electron.launch({ ...launchOptions, env, timeout: 30000 });
  const page = await desktop.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".brand")).toBeVisible();
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, source);
  await page.locator('.topbar [data-action="import"]').click();
  await page
    .getByRole("button", { name: "Choose folder", exact: true })
    .click();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".track-row")).toHaveCount(1);
  await page.locator(".row-track").click();
  await expect
    .poll(() => page.locator("#edoras-audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0);
  expect(requests).toHaveLength(0);
  checks.push("startup, import and playback make no metadata requests");
  await page.locator("[data-metadata]").click();
  expect(requests).toHaveLength(0);
  checks.push("opening metadata makes no requests");
  await page.locator("#metadata-query").fill("Nothing here");
  await page.locator("#metadata-form button").click();
  await expect(page.locator("#metadata-dialog")).toHaveClass(/is-searching/);
  await expect(page.locator("#metadata-status")).toContainText(
    "No match found",
  );
  expect(
    await page.evaluate(() =>
      window.edoras.getLibrary().then((d) => d.tracks[0].title),
    ),
  ).toBe("untitled track 01");
  checks.push("no-match leaves catalog unchanged");
  mode = "match";
  await page.locator("#metadata-query").fill("A Real Artist — A Proper Title");
  await page.locator("#metadata-form button").click();
  await expect(page.locator(".metadata-result")).toHaveCount(1);
  expect(requests.some((r) => r.includes("cover.png"))).toBe(false);
  expect(
    await page.evaluate(() =>
      window.edoras.getLibrary().then((d) => d.tracks[0].title),
    ),
  ).toBe("untitled track 01");
  checks.push("preview before mutation, cover not downloaded yet");
  await page.screenshot({ path: "test-results/metadata-results.png" });
  await page.locator("[data-use-metadata]").click();
  await expect(page.locator("#metadata-dialog")).not.toBeVisible();
  await expect(page.locator(".row-track b")).toHaveText("A Proper Title");
  const track = await page.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.tracks[0]),
  );
  expect(track.year).toBe(1999);
  expect(track.cover).toMatch(/\?v=\d+/);
  expect(track.metadataSource).toBe("Deezer");
  expect(track.lyrics).toBe("A line of words");
  checks.push("chosen details, artwork, lyrics and fetch state saved");
  const artists = await page.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.artists),
  );
  expect(artists["A Real Artist"]).toMatch(/^edoras:\/\/app\/media\/artist\//);
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await expect(page.locator(".artist-avatar.has-photo img")).toHaveCount(1);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  checks.push("artist photo stored once and shown on the artist shelf");
  await expect(page.locator(".metadata-button.is-matched")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Fetch Library Metadata", exact: true }),
  ).toBeVisible();
  const before = requests.length;
  const swept = await page.evaluate(() =>
    window.edoras.fetchLibraryMetadata({}),
  );
  expect(swept.total).toBe(0);
  expect(requests.length).toBe(before);
  checks.push("a song already fetched is never fetched again");
  await page.evaluate((id) => window.edoras.resetMetadata(id), track.id);
  const redone = await page.evaluate(() =>
    window.edoras.fetchLibraryMetadata({}),
  );
  expect(redone.matched).toBe(1);
  expect(requests.length).toBeGreaterThan(before);
  checks.push("clearing a song's state puts it back in the library sweep");
  // Forged choices cannot inject catalog values or arbitrary artwork URLs.
  const forged = await page.evaluate(async (id) => {
    try {
      await window.edoras.applyMetadata(id, "forged");
      return false;
    } catch {
      return true;
    }
  }, track.id);
  expect(forged).toBe(true);
  checks.push("main process rejects forged candidate");
  await desktop.close();
  desktop = await electron.launch({ ...launchOptions, env, timeout: 30000 });
  const again = await desktop.firstWindow();
  await again.getByRole("button", { name: "Library", exact: true }).click();
  await expect(again.locator(".row-track b")).toHaveText("A Proper Title");
  checks.push("metadata survives restart");
  await again.locator("[data-metadata]").click();
  await again
    .getByRole("button", { name: "Identify by sound", exact: true })
    .click();
  await expect(again.locator(".metadata-result")).toContainText(
    "Acoustic Match",
    { timeout: 20000 },
  );
  expect(
    await again.evaluate(() =>
      window.edoras.getLibrary().then((d) => d.tracks[0].title),
    ),
  ).toBe("A Proper Title");
  const beforeSound = await again.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.tracks[0]),
  );
  await again.locator("[data-use-metadata]").click();
  await expect(again.locator(".row-track b")).toHaveText("Acoustic Match");
  checks.push(
    "real decoding and fingerprint worker through desktop, no key, explicit apply",
  );
  const heard = await again.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.tracks[0]),
  );
  expect(requests).toContain("/shazam.png");
  expect(heard.cover).toMatch(/\?v=\d+/);
  expect(heard.cover).not.toBe(beforeSound.cover);
  // Everything the Deezer match wrote is replaced, not only what the sound
  // match happened to carry.
  expect(heard.album).toBe("Sound Album");
  expect(heard.year).toBe(2001);
  expect(heard.genre).not.toBe("Test Genre");
  expect(heard.metadataSource).toBe("Shazam · audio match");
  checks.push("identify by sound saves its artwork and replaces every detail");
  await again.locator("[data-metadata]").click();
  await again
    .getByRole("button", { name: "Remove fetched details", exact: true })
    .click();
  await expect(again.locator(".row-track b")).toHaveText("untitled track 01");
  const restored = await again.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.tracks[0]),
  );
  expect(restored.cover).toBe("");
  expect(restored.metadataSource).toBeUndefined();
  expect(restored.album).not.toBe("Sound Album");
  checks.push("fetched details can be removed, back to the file's own");
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  server.close();
  const resolved = path.resolve(temp);
  if (
    !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(resolved).startsWith("edoras-identify-e2e-")
  )
    throw new Error("Invalid test cleanup path");
  await fs.rm(resolved, { recursive: true, force: true });
}
