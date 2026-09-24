// End-to-end check of the details round in a disposable Edoras instance: deleting
// songs, questions asked inside the app, red destructive buttons, unhearting
// from Favorites, the folding playlist list, the artist photo button and the
// waveform greys in both themes.
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
// Deezer's artist search knows Test Artist; every other service is empty.
const server = http.createServer((req, res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = (body) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  if (req.url.startsWith("/search/artist"))
    return json({
      data: [{ id: 4, name: "Test Artist", picture_xl: `${origin}/face.png` }],
    });
  if (req.url === "/face.png")
    return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  if (req.url.startsWith("/search?term=")) return json({ results: [] });
  if (req.url.startsWith("/ws/2/"))
    return json({ recordings: [], artists: [] });
  if (req.url.startsWith("/search")) return json({ data: [] });
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-details-e2e-"));
const source = path.join(temp, "source");
const home = path.join(temp, "app-data");
await fs.mkdir(source, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
for (const [name, freq] of [
  ["First song.flac", 440],
  ["Second song.flac", 523],
  ["Third song.flac", 659],
])
  execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freq}:duration=6`,
      "-metadata",
      `title=${name.split(".")[0]}`,
      "-metadata",
      "artist=Test Artist",
      "-metadata",
      "album=Test Album",
      "-y",
      path.join(source, name),
    ],
    { windowsHide: true },
  );

const checks = [];
let desktop;
const titles = (page) =>
  page.evaluate(() =>
    window.edoras.getLibrary().then((d) => d.tracks.map((t) => t.title)),
  );
try {
  desktop = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      EDORAS_TEST_HOME: home,
      EDORAS_DEEZER_ORIGIN: origin,
      EDORAS_ITUNES_ORIGIN: origin,
      EDORAS_MUSICBRAINZ_ORIGIN: origin,
      EDORAS_WIKIDATA_ORIGIN: origin,
      EDORAS_COMMONS_ORIGIN: origin,
      EDORAS_DEEZER_GAP: "0",
      EDORAS_MUSICBRAINZ_GAP: "0",
    },
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Any system dialog at all is a failure: every question is asked in-app.
  const native = [];
  page.on("dialog", (dialog) => {
    native.push(dialog.message());
    void dialog.dismiss();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".brand")).toBeVisible();
  await expect(page.getByText("A first listen")).toHaveCount(0);
  await expect(page.locator(".sample-badge")).toHaveCount(0);
  checks.push("the sound studies section is gone from home");

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
  await expect.poll(() => titles(page).then((t) => t.length)).toBe(3);
  const library = await page.evaluate(() =>
    window.edoras.getLibrary().then((d) => d),
  );

  // Delete, from a row, confirmed in the app's own dialog.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".track-row")).toHaveCount(3);
  const third = library.tracks.find((t) => t.title === "Third song");
  // The snapshot never carries file paths, so find the copy on disk.
  const thirdFile = (await fs.readdir(library.root, { recursive: true }))
    .filter((name) => name.includes("Third song"))
    .map((name) => path.join(library.root, name))[0];
  if (!thirdFile) throw new Error("the imported copy was not found");
  await page.locator(`.row-track[data-track="${third.id}"]`).click();
  await expect
    .poll(() => page.locator("#edoras-audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0);
  const row = page.locator(`.track-row[data-row="${third.id}"]`);
  await row.hover();
  const bin = row.locator("[data-delete-track]");
  await expect(bin).toBeVisible();
  expect(await bin.evaluate((el) => getComputedStyle(el).color)).not.toBe(
    await row
      .locator("[data-add-track]")
      .evaluate((el) => getComputedStyle(el).color),
  );
  await bin.click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await expect(page.locator("#confirm-title")).toHaveText("Delete this song?");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/details-delete-dialog.png" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  expect(await titles(page)).toContain("Third song");
  await row.hover();
  await bin.click();
  await page.getByRole("button", { name: "Delete song", exact: true }).click();
  await expect(page.locator(".track-row")).toHaveCount(2);
  await expect.poll(() => titles(page)).not.toContain("Third song");
  await fs
    .access(thirdFile)
    .then(() => {
      throw new Error("the deleted file is still in the library folder");
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  // The watcher must not bring it back.
  await page.evaluate(() => window.edoras.rescan());
  expect(await titles(page)).not.toContain("Third song");
  checks.push(
    "a playing song is deleted after an in-app question, its file leaves the library folder and stays gone",
  );

  // Favorites: a heart on each row takes the song off the list.
  const first = library.tracks.find((t) => t.title === "First song");
  const second = library.tracks.find((t) => t.title === "Second song");
  await page.evaluate(
    async (ids) => {
      for (const id of ids) await window.edoras.favorite(id);
    },
    [first.id, second.id],
  );
  // Changed behind the renderer's back, so it reads the library again.
  await page.reload();
  await page.locator('.nav-item[data-view="favorites"]').click();
  await expect(page.locator(".track-row")).toHaveCount(2);
  await expect(page.locator("[data-unfavorite]")).toHaveCount(2);
  await page.screenshot({ path: "test-results/details-favorites.png" });
  await page.locator(`[data-unfavorite="${first.id}"]`).click();
  await expect(page.locator(".track-row")).toHaveCount(1);
  expect(
    await page.evaluate(
      (id) =>
        window.edoras
          .getLibrary()
          .then((d) => d.tracks.find((t) => t.id === id).favorite),
      first.id,
    ),
  ).toBe(false);
  checks.push("a favourite is unhearted from its row in Favorites");

  // Fifteen playlists: the list scrolls, folds away and stays folded.
  for (let i = 1; i <= 15; i++)
    await page.evaluate(
      (name) => window.edoras.createPlaylist(name),
      `Mix ${i}`,
    );
  await page.reload();
  await expect(page.locator("#playlist-nav .nav-item")).toHaveCount(15);
  await expect(page.locator("#playlist-count")).toHaveText("15");
  const list = page.locator("#playlist-nav");
  const size = await list.evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect(size.scroll).toBeGreaterThan(size.client);
  await expect(list).toHaveClass(/has-more/);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.locator("#playlist-nav .nav-item").last()).toBeInViewport();
  await expect(list).not.toHaveClass(/has-more/);
  await page.screenshot({ path: "test-results/details-playlists.png" });
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  await page.screenshot({ path: "test-results/details-playlists-dark.png" });
  await page.evaluate(() =>
    document.documentElement.removeAttribute("data-theme"),
  );
  await page.locator(".playlist-toggle").click();
  await expect(page.locator("#playlist-group")).toBeHidden();
  await expect(page.locator(".playlist-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.reload();
  await expect(page.locator("#playlist-group")).toBeHidden();
  await page.locator(".playlist-toggle").click();
  await expect(page.locator("#playlist-group")).toBeVisible();
  checks.push("fifteen playlists scroll in a list that folds and remembers");

  // Deleting a playlist asks in-app, and its buttons are red.
  await page.locator("#playlist-nav .nav-item").first().click();
  const deleteButton = page.getByRole("button", {
    name: "Delete playlist",
    exact: true,
  });
  const red = await deleteButton.evaluate((el) => getComputedStyle(el).color);
  const danger = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--danger"),
  );
  expect(red).toBe(
    await page.evaluate((value) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    }, danger.trim()),
  );
  await page.evaluate(
    ([playlist, id]) => window.edoras.addToPlaylist(playlist, id),
    [
      await page.evaluate(() =>
        window.edoras.getLibrary().then((d) => d.playlists[0].id),
      ),
      second.id,
    ],
  );
  await page.reload();
  await page.locator("#playlist-nav .nav-item").first().click();
  const remove = page.locator("[data-remove]");
  await expect(remove).toHaveClass(/danger/);
  expect(await remove.evaluate((el) => getComputedStyle(el).color)).toBe(red);
  await deleteButton.click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await expect(page.locator("#confirm-title")).toHaveText(
    "Delete this playlist?",
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/details-playlist-dialog.png" });
  await page
    .locator("#confirm-dialog")
    .getByRole("button", { name: "Delete playlist", exact: true })
    .click();
  await expect(page.locator("#playlist-nav .nav-item")).toHaveCount(14);
  checks.push("deleting a playlist asks in-app, with red destructive buttons");

  // An artist photo, found on its own from the artist page.
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await page.locator('[data-artist="Test Artist"]').click();
  await page.getByRole("button", { name: "Find a photo", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("Photo of Test Artist");
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await expect(page.locator(".artist-avatar.has-photo img")).toHaveCount(1);
  checks.push("an artist's photo can be found from the artist page");

  // The unplayed part of the waveform is a lighter grey in dark mode only.
  const off = async () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--pk-off")
        .trim(),
    );
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  expect(await off()).toBe("#5d6168");
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "light"),
  );
  expect(await off()).toBe("#a9ada6");
  checks.push(
    "the waveform's unplayed grey: lighter in dark mode, darker in light mode",
  );

  expect(native).toEqual([]);
  expect(errors).toEqual([]);
  checks.push("no system dialog was ever shown");
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
    !path.basename(resolved).startsWith("edoras-details-e2e-")
  )
    throw new Error("Invalid test cleanup path");
  await fs.rm(resolved, { recursive: true, force: true });
}
