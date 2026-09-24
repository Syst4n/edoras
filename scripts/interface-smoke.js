// The interface work from the screenshot round, driven in the real app.
//
// Everything here is something a person would do with a mouse: press the
// glyph beside a song, sort the library, open the lyrics page, change the
// volume from the popup, and hand the app an mp3 from outside. Run with
// `npm run test:interface`.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import ffmpeg from "ffmpeg-static";

const require = createRequire(import.meta.url);
// Outside Electron, the electron package resolves to the path of its own
// binary, which is what launching a second instance needs.
const electronBinary = require("electron");

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-interface-test-"));
const home = path.join(temp, "app-data");
const source = path.join(temp, "source");
await fs.mkdir(source, { recursive: true });
await fs.mkdir(home, { recursive: true });
await fs.mkdir("test-results", { recursive: true });

const encode = (file, title, artist, album, year, frequency) =>
  execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=20`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-metadata",
      `title=${title}`,
      "-metadata",
      `artist=${artist}`,
      "-metadata",
      `album=${album}`,
      "-metadata",
      `date=${year}`,
      "-y",
      file,
    ],
    { windowsHide: true },
  );

// Three songs whose tags disagree in every direction, so each sort puts a
// different one at the top and a sort that quietly does nothing is caught.
encode(
  path.join(source, "zebra.mp3"),
  "Zebra crossing",
  "Aaron Blake",
  "Last album",
  2024,
  330,
);
encode(
  path.join(source, "apple.mp3"),
  "Apple orchard",
  "Mona Vale",
  "First album",
  1998,
  392,
);
encode(
  path.join(source, "mango.mp3"),
  "Mango season",
  "Kit Weller",
  "Middle album",
  2011,
  440,
);
// A folder to drop on the window, and a fourth song kept out of the library
// to hand over the way Explorer does.
const dropped = path.join(temp, "dropped folder");
await fs.mkdir(dropped, { recursive: true });
encode(
  path.join(dropped, "dragged.mp3"),
  "Dragged in",
  "Drag Artist",
  "Drag album",
  2005,
  600,
);
// A fourth, kept out of the library, to hand over the way Explorer does.
const outsider = path.join(temp, "Opened from Explorer.mp3");
encode(
  outsider,
  "Opened from Explorer",
  "Outside Artist",
  "Outside Album",
  2020,
  520,
);

// Electron refuses to start as root without this, which is how continuous
// runs in a container get there. Playwright adds it for the launches it
// makes; a launch of our own has to add it too. It also proves the argument
// filter works: a switch is not a file.
const secondInstanceArgs =
  process.getuid?.() === 0 ? ["--no-sandbox", "."] : ["."];
const first = (locator) => locator.first();
const checks = [];
let desktop;
const launch = () =>
  electron.launch({
    args: ["."],
    env: { ...process.env, EDORAS_TEST_HOME: home },
    timeout: 30000,
  });

try {
  desktop = await launch();
  let page = await desktop.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("heading", { name: "Your music.", exact: true }),
  ).toBeVisible();

  // ---- the hero -------------------------------------------------------------
  if (await page.locator(".hero-art, .hero-record, .hero-sleeve").count())
    throw new Error("the hero still has the record and sleeve mockup");
  checks.push("the hero has no record or sleeve");

  // ---- import ---------------------------------------------------------------
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
    .toBe(3);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".track-row")).toHaveCount(3);

  // ---- the glyph beside the song is the transport ---------------------------
  const rowTitles = () =>
    page.locator(".track-row .row-track b").allInnerTexts();
  const rowFor = (title) =>
    page.locator(".track-row").filter({ hasText: title });
  await rowFor("Mango season").locator(".row-number").click();
  await expect
    .poll(() =>
      page.locator("#edoras-audio").evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThan(0);
  await expect(
    rowFor("Mango season").getByRole("button", { name: "Pause Mango season" }),
  ).toBeVisible();
  await rowFor("Mango season").locator(".row-number").click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("paused", true);
  await expect(
    rowFor("Mango season").getByRole("button", { name: "Play Mango season" }),
  ).toBeVisible();
  await rowFor("Mango season").locator(".row-number").click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("paused", false);
  // Another row still starts its own song rather than toggling this one.
  await rowFor("Apple orchard").locator(".row-number").click();
  await expect(page.locator("#player-title")).toHaveText("Apple orchard");
  await expect(
    rowFor("Mango season").getByRole("button", { name: "Play Mango season" }),
  ).toBeVisible();
  checks.push("the row glyph plays, pauses and resumes, and only its own song");
  await page.screenshot({ path: "test-results/interface-rows.png" });

  // ---- the player bar ----------------------------------------------------------
  const bar = await page.evaluate(() => {
    const player = document.getElementById("player");
    const adds = player.querySelectorAll('[data-action="add-to-playlist"]');
    const name = player.querySelector(".player-meta").getBoundingClientRect();
    const transport = player
      .querySelector(".transport")
      .getBoundingClientRect();
    const add = adds[0]?.getBoundingClientRect();
    return {
      count: adds.length,
      afterName: add ? add.left >= name.right - 1 : false,
      beforeTransport: add ? add.right <= transport.left + 1 : false,
    };
  });
  if (bar.count !== 1)
    throw new Error(`${bar.count} add-to-playlist buttons on the bar`);
  if (!bar.afterName || !bar.beforeTransport)
    throw new Error("the add button is not beside the song name");
  checks.push("one add button on the bar, beside the song name");

  // A favourite is one solid shape: the fill is the outline's own colour.
  await page.locator('#player [data-action="like"]').click();
  await expect(page.locator("#player .like")).toHaveClass(/selected/);
  const heart = await page.evaluate(() => {
    const svg = document.querySelector("#player .like svg");
    const style = getComputedStyle(svg);
    return { fill: style.fill, stroke: style.color };
  });
  if (heart.fill !== heart.stroke)
    throw new Error(
      `the heart is filled ${heart.fill} but drawn ${heart.stroke}`,
    );
  checks.push(`the favourite heart is filled solid in its own red`);
  await page.locator('#player [data-action="like"]').click();

  // ---- sorting ---------------------------------------------------------------
  const sortTo = async (value) => {
    await page.selectOption(".sort-field", value);
    await page.waitForTimeout(150);
    return rowTitles();
  };
  const alphabetical = await sortTo("title");
  if (alphabetical[0] !== "Apple orchard")
    throw new Error(`alphabetical put ${alphabetical[0]} first`);
  const byArtist = await sortTo("artist");
  if (byArtist[0] !== "Zebra crossing")
    throw new Error(
      `by artist put ${byArtist[0]} first, expected Aaron Blake's`,
    );
  const byAlbum = await sortTo("album");
  if (byAlbum[0] !== "Apple orchard")
    throw new Error(`by album put ${byAlbum[0]} first, expected First album`);
  const byRelease = await sortTo("release");
  if (byRelease[0] !== "Zebra crossing")
    throw new Error(`newest release put ${byRelease[0]} first, expected 2024`);
  await page
    .getByRole("button", { name: /Reverse it/ })
    .first()
    .click();
  await page.waitForTimeout(150);
  const oldestFirst = await rowTitles();
  if (oldestFirst[0] !== "Apple orchard")
    throw new Error(
      `oldest release put ${oldestFirst[0]} first, expected 1998`,
    );
  checks.push("all five sorts reorder the library, and the order reverses");

  // Play all follows what the page is showing, not the order on disk.
  await page.getByRole("button", { name: "Play all", exact: true }).click();
  await expect(page.locator("#player-title")).toHaveText("Apple orchard");
  checks.push("Play all starts at the top of the sort on screen");

  // ---- the lyrics page --------------------------------------------------------
  await page.locator('.nav-item[data-view="lyrics"]').click();
  await expect(
    page.getByRole("heading", { name: "Lyrics", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Lyrics can't be found.")).toBeVisible();
  await page.getByRole("button", { name: "Paste lyrics" }).click();
  const words = "First line of the song\nSecond line of the song";
  await page.locator("#lyrics-page-input").fill(words);
  await page.getByRole("button", { name: "Save lyrics" }).click();
  await expect(page.locator(".lyrics-body")).toContainText("Second line");
  checks.push("the lyrics page takes pasted words and shows them back");
  await page.screenshot({ path: "test-results/interface-lyrics.png" });

  // The same words, from the popup's tab: one store, two places to read it.
  await page.getByRole("button", { name: "Expand player" }).click();
  await page.locator('[data-tab="lyrics"]').click();
  await expect(page.locator("#np-side-content .lyrics")).toContainText(
    "First line of the song",
  );
  checks.push("the popup tab and the page show the same words");

  // ---- volume, from the popup ------------------------------------------------
  const npVolume = page.locator(".np-volume .volume-slider");
  await npVolume.fill("30");
  await expect
    .poll(() =>
      page
        .locator("#edoras-audio")
        .evaluate((audio) => Math.round(audio.volume * 100)),
    )
    .toBe(30);
  const barValue = await page.locator("#volume").inputValue();
  if (Number(barValue) !== 30)
    throw new Error(
      `the bar's slider says ${barValue} while the popup says 30`,
    );
  await page.locator(".np-volume .mute").click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("muted", true);
  await page.locator(".np-volume .mute").click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("muted", false);
  checks.push(
    "the popup's volume moves the audio and the bar's slider with it",
  );
  await page.screenshot({ path: "test-results/interface-now-playing.png" });
  await page.getByRole("button", { name: "Close now playing" }).click();

  // The button on the bar goes to the page rather than the popup.
  await page.locator('.nav-item[data-view="listen"]').click();
  await page.locator('#player [data-action="open-lyrics"]').click();
  await expect(
    page.getByRole("heading", { name: "Lyrics", exact: true }),
  ).toBeVisible();
  checks.push("the lyrics button on the player bar opens the page");
  // And a second press puts back the page it was opened from.
  await expect(page.locator("#player .lyrics-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator('#player [data-action="open-lyrics"]').click();
  await expect(
    page.getByRole("heading", { name: "Your library", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#player .lyrics-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  checks.push("pressing the lyrics button again goes back to the page before");

  if (errors.length) throw new Error(errors.join("\n"));

  // ---- opened from outside ----------------------------------------------------
  // Windows sends the file as an argument to a second launch, which the
  // single-instance lock hands to the running app. The file association
  // itself is a Windows registry entry made by the installer and cannot be
  // exercised here; this is everything downstream of it.
  const second = spawn(electronBinary, [...secondInstanceArgs, outsider], {
    env: { ...process.env, EDORAS_TEST_HOME: home },
    stdio: "ignore",
  });
  await new Promise((resolve) => second.on("exit", resolve));
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.edoras.getLibrary().then((data) => data.tracks.length),
        ),
      { timeout: 20000 },
    )
    .toBe(4);
  await expect(page.locator("#player-title")).toHaveText(
    "Opened from Explorer",
  );
  checks.push("a file handed to a second launch is imported and played");

  // The same file again is not copied twice; it just plays.
  await page.locator('.nav-item[data-view="albums"]').click();
  const again = spawn(electronBinary, [...secondInstanceArgs, outsider], {
    env: { ...process.env, EDORAS_TEST_HOME: home },
    stdio: "ignore",
  });
  await new Promise((resolve) => again.on("exit", resolve));
  await expect(page.locator("#player-title")).toHaveText(
    "Opened from Explorer",
  );
  const total = await page.evaluate(() =>
    window.edoras.getLibrary().then((data) => data.tracks.length),
  );
  if (total !== 4)
    throw new Error(`opening the same file again made the library ${total}`);
  checks.push("opening the same file again plays it without a second copy");

  // ---- dropped on the window ---------------------------------------------------
  // A real drag carrying a path, which is the only kind the app can do
  // anything with: a File made in the page has no file behind it. This drop
  // used to fail with "Nothing usable was dropped" every time, because a
  // FileList does not survive the context bridge — it reaches the preload as
  // a plain object with no length, so the list of paths came out empty.
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["dragEnter", "dragOver", "drop"])
    await cdp.send("Input.dispatchDragEvent", {
      type,
      x: 700,
      y: 400,
      modifiers: 0,
      data: { items: [], files: [dropped], dragOperationsMask: 1 },
    });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.edoras.getLibrary().then((data) => data.tracks.length),
        ),
      { timeout: 20000 },
    )
    .toBe(5);
  await expect(
    page.locator(".track-row").filter({ hasText: "Dragged in" }),
  ).toHaveCount(1);
  checks.push("a folder dropped on the window is imported");

  // ---- the sort is remembered --------------------------------------------------
  await desktop.close();
  desktop = await launch();
  page = await desktop.firstWindow();
  await expect(
    page.getByRole("button", { name: "Library", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(first(page.locator(".sort-field"))).toHaveValue("release");
  const afterRestart = await page
    .locator(".track-row .row-track b")
    .allInnerTexts();
  if (afterRestart[0] !== "Apple orchard")
    throw new Error(`after restart the order started at ${afterRestart[0]}`);
  checks.push("the chosen sort and its direction survive a restart");

  await desktop.close();
  desktop = null;
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await fs.rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300,
  });
}
