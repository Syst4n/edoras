// End-to-end check of playlists in a disposable Edoras instance.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-playlist-e2e-"));
const source = path.join(temp, "source");
await fs.mkdir(source, { recursive: true });
await fs.mkdir("test-results", { recursive: true });
// Two albums, so the two songs take two different accent colours.
for (const [name, freq, album] of [
  ["Tagged song.flac", 440, "Test Album"],
  ["Other song.flac", 523, "Another Album"],
]) {
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
      `album=${album}`,
      "-y",
      path.join(source, name),
    ],
    { windowsHide: true },
  );
}

const checks = [];
let desktop;
const boot = async () => {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, EDORAS_TEST_HOME: path.join(temp, "app-data") },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => {
    throw new Error(`renderer error: ${e.message}`);
  });
  return { app, page };
};

try {
  ({ app: desktop, page: globalThis.page } = await boot());
  const page = globalThis.page;
  await expect(
    page.getByRole("heading", { name: "Your music.", exact: true }),
  ).toBeVisible();
  checks.push("desktop boots");

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
        window.edoras.getLibrary().then((d) => d.tracks.length),
      ),
    )
    .toBe(2);
  checks.push("import");

  // Create a playlist through the interface, not the API.
  // The + beside the Playlists caption, which is always in reach.
  await page.locator(".caption-add").click();
  await page.locator("#playlist-name").fill("  Late   night  ");
  await page.locator("#playlist-form button[type=submit]").click();
  await expect(page.locator("#playlist-nav .nav-item")).toHaveCount(1);
  await expect(page.locator("#playlist-nav .nav-item")).toContainText(
    "Late night",
  );
  checks.push("create through the UI, name collapsed");

  await expect(page.locator(".empty h2")).toHaveText("An empty playlist.");
  checks.push("empty state");

  // Play a track, then add it from the now playing view.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.locator(".row-track").filter({ hasText: "Tagged song" }).click();
  await expect
    .poll(() => page.locator("#edoras-audio").evaluate((a) => a.currentTime))
    .toBeGreaterThan(0);
  await page
    .locator("#player")
    .getByRole("button", { name: "Open now playing" })
    .click();
  await page.getByRole("button", { name: "Add to a playlist" }).click();
  await page.locator(".add-choice").first().click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.edoras.getLibrary().then((d) => d.playlists[0].trackIds.length),
      ),
    )
    .toBe(1);
  checks.push("add from now playing");

  // Same button again takes it back out.
  await page.locator(".add-choice").first().click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.edoras.getLibrary().then((d) => d.playlists[0].trackIds.length),
      ),
    )
    .toBe(0);
  checks.push("second tap removes");

  await page.locator(".add-choice").first().click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.edoras.getLibrary().then((d) => d.playlists[0].trackIds.length),
      ),
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Close now playing" }).click();
  await page.locator("#playlist-nav .nav-item").click();
  await expect(page.locator(".track-row")).toHaveCount(1);
  await page.screenshot({ path: "test-results/playlist.png" });
  checks.push("playlist view lists the track");

  await desktop.close();
  ({ app: desktop, page: globalThis.page } = await boot());
  const again = globalThis.page;
  await expect(again.locator("#playlist-nav .nav-item")).toContainText(
    "Late night",
  );
  await again.locator("#playlist-nav .nav-item").click();
  await expect(again.locator(".track-row")).toHaveCount(1);
  checks.push("survives restart");

  // Removing from the row leaves the song in the library.
  await again.locator("[data-remove]").click();
  await expect(again.locator(".track-row")).toHaveCount(0);
  await expect
    .poll(() =>
      again.evaluate(() =>
        window.edoras.getLibrary().then((d) => d.tracks.length),
      ),
    )
    .toBe(2);
  checks.push("row removal keeps the song");

  await again.getByRole("button", { name: "Library", exact: true }).click();
  await again.locator("[data-add-track]").first().click();
  await again
    .locator("#add-dialog")
    .getByRole("button", { name: "New playlist", exact: true })
    .click();
  await again.locator("#playlist-name").fill("From the library");
  await again.locator("#playlist-form button").click();
  await expect(again.locator(".track-row")).toHaveCount(1);
  expect(await again.locator("#edoras-audio").evaluate((a) => a.paused)).toBe(
    true,
  );
  checks.push("create and add directly from Library without playing");

  await again.getByRole("button", { name: "Library", exact: true }).click();
  await again
    .getByRole("button", { name: "Add to playlist", exact: true })
    .click();
  await again
    .locator(".add-choice")
    .filter({ hasText: "From the library" })
    .click();
  await again.locator("#add-dialog [data-action=close-add]").click();
  await again
    .locator("#playlist-nav .nav-item")
    .filter({ hasText: "From the library" })
    .click();
  await expect(again.locator(".track-row")).toHaveCount(2);
  const lastTitle = await again.locator(".row-track b").last().textContent();
  await again.locator('[data-move][data-direction="-1"]').last().click();
  await expect(again.locator(".row-track b").first()).toHaveText(lastTitle);
  await again.getByRole("button", { name: "Rename", exact: true }).click();
  await again.locator("#playlist-name").fill("Evening collection");
  await again.locator("#playlist-form button").click();
  await expect(again.locator("h1")).toHaveText("Evening collection");
  checks.push("bulk add, reorder and rename through UI");

  // Artwork-derived surfaces must change with the track in both themes.
  await again.getByRole("button", { name: "Library", exact: true }).click();
  await again.locator(".row-track").first().click();
  await again.getByRole("button", { name: "Settings", exact: true }).click();
  await again.getByRole("button", { name: "Dark", exact: true }).click();
  await again.getByRole("button", { name: "Library", exact: true }).click();
  const settlePlayer = () =>
    again.waitForFunction(() =>
      document
        .querySelector("#player")
        .getAnimations()
        .every((a) => a.playState !== "running"),
    );
  await settlePlayer();
  const controls = () =>
    again.evaluate(() => {
      const style = getComputedStyle(document.querySelector("#player"));
      return {
        background: style.backgroundColor,
        accent: getComputedStyle(document.documentElement)
          .getPropertyValue("--art")
          .trim(),
        button: getComputedStyle(document.querySelector("#player .play-button"))
          .backgroundColor,
      };
    });
  const gold = await controls();
  await again.screenshot({ path: "test-results/library-dark-gold.png" });
  await again.locator('#player [data-action="next"]').click();
  await expect
    .poll(async () => (await controls()).accent)
    .not.toBe(gold.accent);
  await expect
    .poll(async () => (await controls()).background)
    .not.toBe(gold.background);
  await expect
    .poll(async () => (await controls()).button)
    .not.toBe(gold.button);
  const seek = again.locator(".wave-seek input");
  await seek.click({ position: { x: 40, y: 10 } });
  expect(
    await again
      .locator(".wave-seek")
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe("none");
  await again.keyboard.press("Tab");
  await again.keyboard.press("Shift+Tab");
  expect(
    await again
      .locator(".wave-seek")
      .evaluate((el) => getComputedStyle(el, "::after").height),
  ).toBe("2px");
  await seek.evaluate((el) => el.blur());
  await settlePlayer();
  await again.screenshot({ path: "test-results/library-dark-blue.png" });
  await again.getByRole("button", { name: "Settings", exact: true }).click();
  await again.getByRole("button", { name: "Light", exact: true }).click();
  await again.getByRole("button", { name: "Library", exact: true }).click();
  await settlePlayer();
  await again.screenshot({ path: "test-results/library-light.png" });
  checks.push(
    "artwork-tinted surfaces, no waveform box, keyboard focus, both themes",
  );

  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { passed: false, checks, error: String(error).slice(0, 600) },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
}
