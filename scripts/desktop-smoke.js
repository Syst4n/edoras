// Integration test of a disposable Edoras instance, never the user's library.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-desktop-test-"));
const launchOptions = process.env.EDORAS_BINARY
  ? { executablePath: process.env.EDORAS_BINARY, args: [] }
  : { args: ["."] };
await fs.mkdir("test-results", { recursive: true });
const source = path.join(temp, "source");
await fs.mkdir(source);
for (const [name, codec] of [
  ["Tagged song.flac", "flac"],
  ["Legacy song.wma", "wmav2"],
]) {
  execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=12",
      "-c:a",
      codec,
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
}
let desktop;
try {
  desktop = await electron.launch({
    ...launchOptions,
    env: { ...process.env, EDORAS_TEST_HOME: path.join(temp, "app-data") },
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "Your music.", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/home.png", fullPage: true });
  await page.getByRole("button", { name: "Take it for a spin" }).click();
  await expect(page.locator("#np-title")).toHaveText("Golden hour");
  await expect
    .poll(() =>
      page.locator("#edoras-audio").evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThan(0);
  await expect(
    page
      .locator("#now-playing")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/now-playing.png" });
  await page
    .locator("#now-playing")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.getByRole("button", { name: "Close now playing" }).click();
  // Replace only the native picker in this disposable test process.
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
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.edoras.getLibrary().then((data) => data.tracks.length),
      ),
    )
    .toBe(2);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".track-row")).toHaveCount(2);
  await page.locator(".row-track").filter({ hasText: "Tagged song" }).click();
  await expect
    .poll(() =>
      page.locator("#edoras-audio").evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThan(0);
  await page
    .locator("#player")
    .getByRole("button", { name: "Add to favorites", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.edoras
          .getLibrary()
          .then((data) => data.tracks.filter((t) => t.favorite).length),
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await expect(page.locator(".music-card")).toHaveCount(1);
  await page.locator(".music-card").click();
  await expect(page.locator(".track-row")).toHaveCount(2);
  await page.locator(".row-track").filter({ hasText: "Legacy song" }).click();
  await expect
    .poll(
      () =>
        page.locator("#edoras-audio").evaluate((audio) => audio.currentTime),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
  const audioInfo = await page.locator("#edoras-audio").evaluate((audio) => ({
    source: audio.src,
    duration: audio.duration,
    error: audio.error?.message,
  }));
  if (!audioInfo.source.includes("/converted/"))
    throw new Error("Legacy codec did not exercise FFmpeg fallback");
  await expect
    .poll(
      () =>
        page
          .locator("#edoras-audio")
          .evaluate((audio) => Number.isFinite(audio.duration)),
      { timeout: 10000 },
    )
    .toBe(true);
  await page.locator("#player .seek").fill("500");
  await expect
    .poll(() =>
      page.locator("#edoras-audio").evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThan(5);
  const lib = await page.evaluate(() => window.edoras.getLibrary());
  await page.getByLabel("Search your music").fill("Tagged");
  await expect(page.locator(".track-row")).toHaveCount(1);
  await page.getByLabel("Search your music").fill("");
  // A song put straight into the library folder, the way someone would with
  // Explorer, joins the library where it is.
  const watchedFile = path.join(lib.root, "Watched.mp3");
  await fs.copyFile("public/demo/golden.mp3", watchedFile);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.edoras.getLibrary().then((data) => data.tracks.length),
        ),
      { timeout: 15000 },
    )
    .toBe(3);
  const security = await page.evaluate(() => ({
    node: typeof window.require,
    process: typeof window.process,
  }));
  if (security.node !== "undefined" || security.process !== "undefined")
    throw new Error("Renderer is not isolated");
  if (errors.length) throw new Error(errors.join("\n"));
  await desktop.close();
  desktop = null;
  desktop = await electron.launch({
    ...launchOptions,
    env: { ...process.env, EDORAS_TEST_HOME: path.join(temp, "app-data") },
    timeout: 30000,
  });
  const reloaded = await desktop.firstWindow();
  await expect(
    reloaded.getByRole("button", { name: "Library", exact: true }),
  ).toBeVisible();
  const saved = await reloaded.evaluate(() => window.edoras.getLibrary());
  if (
    saved.tracks.length !== 3 ||
    saved.tracks.filter((t) => t.favorite).length !== 1
  )
    throw new Error("Catalog did not persist across restart");
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "desktop boots",
          "renderer isolation",
          "demo playback",
          "folder import via IPC",
          "FLAC playback",
          "WMA fallback playback",
          "favorites",
          "album grouping",
          "search",
          "library folder watcher",
          "restart persistence",
        ],
        audioInfo,
        tracks: saved.tracks.length,
      },
      null,
      2,
    ),
  );
} finally {
  await desktop?.close();
  await fs.rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  });
}
