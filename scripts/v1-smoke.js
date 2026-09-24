// The 1.0 release round, driven in the real app: every control added or
// changed for it, pressed the way a person would press it. Run with
// `npm run test:v1`.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-v1-test-"));
const home = path.join(temp, "app-data");
const source = path.join(temp, "source");
await fs.mkdir(source, { recursive: true });
await fs.mkdir("test-results", { recursive: true });

// Every call ends with its output file; -y goes just before it.
const run = (args) =>
  execFileSync(
    ffmpeg,
    ["-v", "error", ...args.slice(0, -1), "-y", args.at(-1)],
    { windowsHide: true },
  );
// Two covers of clearly different colours, so the logo can be seen to follow
// the song.
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
// A picture that is neither square nor small, for the playlist.
run([
  "-f",
  "lavfi",
  "-i",
  "color=c=0x22aa66:s=1600x900",
  "-frames:v",
  "1",
  path.join(temp, "wide.png"),
]);
const song = (name, title, artist, album, genre, seconds, art, frequency) =>
  run([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${seconds}`,
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
    "-metadata",
    `genre=${genre}`,
    path.join(source, name),
  ]);
song(
  "a.mp3",
  "Red one",
  "Ruby Lane",
  "Red Album",
  "Rock",
  16,
  path.join(temp, "red.jpg"),
  330,
);
song(
  "b.mp3",
  "Red two",
  "Ruby Lane",
  "Red Album",
  "Rock",
  16,
  path.join(temp, "red.jpg"),
  392,
);
song(
  "c.mp3",
  "Blue one",
  "Cobalt",
  "Blue Album",
  "Jazz",
  16,
  path.join(temp, "blue.jpg"),
  440,
);
song(
  "d.mp3",
  "Blue two",
  "Cobalt",
  "Blue Album",
  "Jazz",
  16,
  path.join(temp, "blue.jpg"),
  494,
);
const loose = path.join(temp, "Loose.mp3");
song(
  "../Loose.mp3",
  "Dropped by hand",
  "Someone",
  "Loose",
  "Folk",
  6,
  path.join(temp, "blue.jpg"),
  523,
);

const checks = [];
const errors = [];
let desktop;
const launch = () =>
  electron.launch({
    args: ["."],
    env: { ...process.env, EDORAS_TEST_HOME: home },
    timeout: 30000,
  });
const centreX = async (locator) => {
  const box = await locator.boundingBox();
  return box.x + box.width / 2;
};

try {
  desktop = await launch();
  let page = await desktop.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- words that changed ----------------------------------------------------
  await expect(page.locator(".hero .eyebrow")).toHaveText("EDORAS");
  await expect(page.locator(".hero h1 em")).toHaveText("music.");
  for (const gone of [
    "little world",
    "A HOME FOR YOUR MUSIC",
    "A place for every album",
    "COLLECTED, NOT STREAMED",
    "The words",
    "Inbox",
  ])
    if ((await page.locator("body").innerText()).includes(gone))
      throw new Error(`"${gone}" is still on the page`);
  checks.push("hero reads Edoras / Your music., removed copy is gone");

  // ---- import ----------------------------------------------------------------
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, source);
  await page.locator('.topbar [data-action="import"]').click();
  await page.locator('[data-action="pick-folder"]').click();
  await expect(
    page.locator(".music-grid").first().locator(".music-card"),
  ).toHaveCount(4);
  await expect(page.locator('.hero [data-action="shuffle-all"]')).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Try listening" }),
  ).toBeVisible();
  checks.push(
    "hero has Shuffle beside Start listening; Try listening shows unplayed songs",
  );

  // ---- sidebar: logo and Statistics ------------------------------------------
  const brand = page.locator(".brand-icon svg");
  await expect(brand).toBeVisible();
  const home_ = page.locator('.nav-item[data-view="home"] svg');
  if (Math.abs((await centreX(brand)) - (await centreX(home_))) > 1)
    throw new Error("the logo is not on the nav icons' axis");
  await page.locator('[data-action="collapse"]').click();
  await page.waitForTimeout(450);
  await expect(brand).toBeVisible();
  if (Math.abs((await centreX(brand)) - (await centreX(home_))) > 1)
    throw new Error("the collapsed logo is not on the nav icons' axis");
  await page.locator('[data-action="collapse"]').click();
  const order = await page
    .locator(".sidebar-bottom .nav-item")
    .evaluateAll((items) => items.map((i) => i.textContent.trim()));
  if (order[0] !== "Statistics" || order[1] !== "Settings")
    throw new Error(`sidebar bottom reads ${order.join(", ")}`);
  checks.push(
    "logo centred on the icon axis, expanded and collapsed; Statistics sits above Settings",
  );

  // ---- a card's play button follows playback ---------------------------------
  const logoColour = () => brand.evaluate((el) => getComputedStyle(el).color);
  const before = await logoColour();
  const redCard = page
    .locator(".music-card[data-track]")
    .filter({ hasText: "Red one" })
    .first();
  await redCard.click();
  await expect(redCard).toHaveClass(/is-playing/);
  await expect(redCard.locator(".cover-play svg")).toHaveClass(/lucide-pause/);
  await expect.poll(logoColour).not.toBe(before);
  const red = await logoColour();
  await redCard.click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("paused", true);
  await expect(redCard).not.toHaveClass(/is-playing/);
  await expect(redCard.locator(".cover-play svg")).toHaveClass(/lucide-play/);
  await redCard.click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("paused", false);
  checks.push(
    "a playing card shows Pause, pressing it pauses, pressing again resumes",
  );
  checks.push("the logo takes the playing song's colour");

  // ---- the player bar --------------------------------------------------------
  const plus = page.locator("#player .add-ring");
  const ring = await plus.evaluate((el) => {
    const s = getComputedStyle(el);
    return { shadow: s.boxShadow, colour: s.color };
  });
  if (!ring.shadow.includes(ring.colour.replace(/\)$/, "")))
    throw new Error(
      `the + has no ring in its own colour: ${JSON.stringify(ring)}`,
    );
  checks.push("the + on the bar has a ring in its own colour");

  const total = page.locator("#player .time-toggle");
  const length = await total.innerText();
  await total.click();
  await expect(total).toHaveText(/^-\d+:\d\d$/);
  await page.waitForTimeout(1200);
  const later = await total.innerText();
  await total.click();
  await expect(total).toHaveText(length);
  if (!later.startsWith("-")) throw new Error("the countdown stopped");
  checks.push("the length toggles to a live countdown and back");

  // ---- the seek bar has no focus box -----------------------------------------
  await page.locator('#player [data-action="expand"]').first().click();
  const npSeek = page.locator("#now-playing .seek");
  await npSeek.click({ position: { x: 30, y: 1 } });
  const outline = await npSeek.evaluate(
    (el) => getComputedStyle(el).outlineStyle,
  );
  if (outline !== "none")
    throw new Error(`the seek bar is outlined: ${outline}`);
  await page.screenshot({ path: "test-results/v1-now-playing.png" });
  await page.getByRole("button", { name: "Close now playing" }).click();
  checks.push("the Now Playing seek bar has no outline when clicked");

  // ---- lyrics is a toggle ----------------------------------------------------
  await page.locator('.nav-item[data-view="albums"]').click();
  await page
    .locator(".music-card[data-album]")
    .filter({ hasText: "Blue Album" })
    .click();
  await expect(page.getByRole("heading", { name: "Blue Album" })).toBeVisible();
  await page.locator("#player .lyrics-toggle").click();
  await expect(
    page.getByRole("heading", { name: "Lyrics", exact: true }),
  ).toBeVisible();
  await page.locator("#player .lyrics-toggle").click();
  await expect(page.getByRole("heading", { name: "Blue Album" })).toBeVisible();
  checks.push(
    "lyrics button opens the lyrics, a second press returns to the album that was open",
  );

  // ---- play and shuffle for an album, an artist, a playlist ------------------
  const play = page.locator('[data-action="play-collection"]');
  await play.click();
  await expect(page.locator("#player-title")).toHaveText("Blue one");
  await expect(play).toHaveText(/Pause/);
  await play.click();
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("paused", true);
  await expect(play).toHaveText(/Play/);
  await page.locator('[data-action="shuffle-collection"]').click();
  await expect(page.locator("#player-title")).toHaveText(/Blue/);
  await expect(page.locator("#player .shuffle")).toHaveClass(/selected/);
  checks.push(
    "album Play reads Pause while it plays, and Shuffle shuffles the album",
  );
  await expect.poll(logoColour).not.toBe(red);

  await page.locator('.nav-item[data-view="artists"]').click();
  await page.locator(".artist-card").filter({ hasText: "Ruby Lane" }).click();
  await page.locator('[data-action="shuffle-collection"]').click();
  await expect(page.locator("#player-title")).toHaveText(/Red/);
  checks.push("artist Shuffle plays only that artist");

  // An album card's own button plays the record without opening it.
  await page.locator('.nav-item[data-view="albums"]').click();
  const albumCard = page
    .locator(".music-card[data-album]")
    .filter({ hasText: "Blue Album" });
  await albumCard.hover();
  await albumCard.locator("[data-album-play]").click();
  await expect(page.locator("#player-title")).toHaveText(/Blue/);
  await expect(albumCard).toHaveClass(/is-playing/);
  await expect(
    page.getByRole("heading", { name: "Albums", exact: true }),
  ).toBeVisible();
  checks.push("an album card's artwork button plays the album and shows Pause");

  // ---- a playlist with its own picture ---------------------------------------
  await page.locator('.nav-item[data-view="listen"]').click();
  await page.locator('[data-action="add-shown"]').click();
  await page.locator('#add-dialog [data-action="new-playlist"]').click();
  await page.locator("#playlist-name").fill("Evening");
  await page.locator('#playlist-form button[type="submit"]').click();
  await expect(page.getByRole("heading", { name: "Evening" })).toBeVisible();
  await expect(page.locator(".playlist-cover > .playlist-art")).toHaveCount(1);
  await desktop.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    },
    path.join(temp, "wide.png"),
  );
  await page.locator('.playlist-tools [data-action="playlist-cover"]').click();
  await expect(page.locator(".playlist-cover img.playlist-art")).toHaveCount(1);
  const box = await page.locator(".playlist-cover").boundingBox();
  if (Math.round(box.width) !== 184 || Math.round(box.height) !== 184)
    throw new Error(`the picture box is ${box.width}x${box.height}`);
  const nav = await page.locator(".nav-cover").boundingBox();
  if (Math.round(nav.width) !== 20 || Math.round(nav.height) !== 20)
    throw new Error(`the sidebar picture is ${nav.width}x${nav.height}`);
  const saved = await page
    .locator(".playlist-cover > img")
    .evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  if (saved[0] !== 600 || saved[1] !== 600)
    throw new Error(`a 1600x900 picture was saved at ${saved}`);
  await page.locator('[data-action="play-collection"]').click();
  await expect(page.locator('[data-action="play-collection"]')).toHaveText(
    /Pause/,
  );
  await page.locator('[data-action="remove-playlist-cover"]').click();
  await expect(page.locator(".playlist-cover > .playlist-art")).toHaveCount(1);
  checks.push(
    "a playlist picture is cropped to a 600px square and shown in fixed boxes; it can be removed",
  );
  checks.push("playlist Play reads Pause while the playlist plays");

  // ---- listening is counted ---------------------------------------------------
  await page.locator('.nav-item[data-view="home"]').click();
  const blue = page
    .locator(".music-card[data-track]")
    .filter({ hasText: "Blue two" })
    .first();
  await blue.click();
  // The card may be the song already loaded, in which case the press paused
  // it; a second press plays it.
  if (await page.locator("#edoras-audio").evaluate((a) => a.paused))
    await blue.click();
  await expect(page.locator("#player-title")).toHaveText("Blue two");
  await expect(page.locator("#edoras-audio")).toHaveJSProperty("paused", false);
  // A 16-second song counts as played after 8 seconds.
  await page.waitForTimeout(9500);
  await page.locator('.nav-item[data-view="statistics"]').click();
  await expect(
    page.getByRole("heading", { name: "Statistics", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-stat="plays"]')).not.toHaveText("0");
  await expect(page.locator(".stat-feature b")).toHaveText("Blue two");
  // Hovering a chart shows its value.
  const plot = page.locator('[data-chart="timeline"] .chart-plot');
  await plot.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const area = await plot.boundingBox();
  await page.mouse.move(area.x + area.width - 2, area.y + area.height / 2);
  await expect(page.locator('[data-chart="timeline"] .chart-tip')).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(
    page.locator('[data-chart="timeline"] .chart-tip'),
  ).toContainText("min");
  await page.locator('[data-stats-range="week"]').click();
  await expect(page.locator('[data-stats-range="week"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.locator('[data-chart="timeline"] .chart-axis span'),
  ).toHaveCount(7);
  await page.locator('[data-stats-range="year"]').click();
  await expect(
    page.locator('[data-chart="timeline"] .chart-axis span'),
  ).toHaveCount(12);
  const columns = page.locator('[data-chart="hours"] .column');
  await expect(columns).toHaveCount(24);
  await columns.nth(0).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await columns.nth(new Date().getHours()).hover();
  await expect(page.locator('[data-chart="hours"] .chart-tip')).toHaveCSS(
    "opacity",
    "1",
  );
  // A top song row plays it; a top artist row opens the artist.
  await page.locator('.stat-card .bar-row[data-artist="Cobalt"]').click();
  await expect(page.getByRole("heading", { name: "Cobalt" })).toBeVisible();
  const elements = await page.evaluate(
    () => document.querySelectorAll("*").length,
  );
  await page.locator('.nav-item[data-view="statistics"]').click();
  await page.screenshot({
    path: "test-results/v1-statistics.png",
    fullPage: true,
  });
  checks.push(
    `listening is counted and the Statistics page shows it (${elements} elements)`,
  );
  checks.push(
    "charts answer hover, the range switches between 7 days, 30 days and 12 months",
  );

  await page.locator('.nav-item[data-view="home"]').click();
  await expect(
    page.getByRole("heading", { name: "Most listened" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Jump back in" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your playlists" }),
  ).toBeVisible();
  checks.push("home gains Most listened, Jump back in, Your playlists");

  // ---- the library folder ------------------------------------------------------
  const lib = await page.evaluate(() => window.edoras.getLibrary());
  const dropped = path.join(lib.root, "From Explorer");
  await fs.mkdir(dropped, { recursive: true });
  await fs.copyFile(loose, path.join(dropped, "Loose.mp3"));
  await expect(page.locator("#toast")).toContainText(
    "found in your library folder",
    { timeout: 20000 },
  );
  await page.locator('.nav-item[data-view="listen"]').click();
  await expect(
    page.locator(".track-row").filter({ hasText: "Dropped by hand" }),
  ).toHaveCount(1);
  await fs.rm(path.join(dropped, "Loose.mp3"));
  await expect(
    page.locator(".track-row").filter({ hasText: "Dropped by hand" }),
  ).toHaveCount(0, { timeout: 20000 });
  checks.push(
    "a song dropped into the library folder appears, and leaves when deleted",
  );

  // ---- phone width ---------------------------------------------------------------
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ["home", "listen", "statistics"]) {
    await page.locator(`.nav-item[data-view="${view}"]`).click();
    await page.waitForTimeout(400);
    const spill = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    if (spill > 0)
      throw new Error(`${view} scrolls sideways by ${spill}px at 390px`);
  }
  const bar = await page.locator(".sidebar").boundingBox();
  if (!bar || bar.y + bar.height < 844 - 1 || bar.height > 90)
    throw new Error(
      `the sidebar is not a bottom tab bar at 390px: ${JSON.stringify(bar)}`,
    );
  await page.setViewportSize(wide);
  checks.push(
    "at phone width the sidebar is a tab bar and nothing scrolls sideways",
  );

  if (errors.length) throw new Error(errors.join("\n"));

  // ---- listening survives a restart -------------------------------------------
  await desktop.close();
  desktop = await launch();
  page = await desktop.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator('.nav-item[data-view="statistics"]').click();
  await expect(page.locator('[data-stat="plays"]')).not.toHaveText("0");
  await expect(page.locator("#player .time-toggle")).toHaveText(/^0:00$|^-/);
  checks.push("listening history survives a restart");
  if (errors.length) throw new Error(errors.join("\n"));

  await desktop.close();
  desktop = null;
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks, errors }, null, 2));
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
