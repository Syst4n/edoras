// Does the app still hold its shape with a real collection in it?
//
// Everything else in scripts/ tests behaviour with a handful of songs. This
// one builds a library big enough to break a naive list, then checks three
// things the eye would check: that nothing overlaps or overflows, that every
// page still draws, and that the cost of drawing does not grow with the
// library. It also reports the renderer's heap, which is the number the
// "will it run on a low-spec machine" question actually turns on.
//
// The library is written straight into a disposable catalog rather than
// imported, because importing forty thousand real files would take longer
// than the test is worth and would measure ffmpeg, not the interface.
import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const SONGS = Number(process.env.EDORAS_SCALE_SONGS || 40000);
const ARTISTS = Number(process.env.EDORAS_SCALE_ARTISTS || 1200);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-scale-test-"));
const home = path.join(temp, "app-data");
const root = path.join(temp, "Edoras Library");
await fs.mkdir(path.join(root, ".edoras"), { recursive: true });
await fs.mkdir(home, { recursive: true });
await fs.mkdir("test-results", { recursive: true });

// A catalog of the shape library.js writes, with ids that look like the real
// ones so nothing downstream has to treat these as special.
const tracks = [];
for (let i = 0; i < SONGS; i++) {
  const artist = `Artist ${String(i % ARTISTS).padStart(4, "0")}`;
  const album = `${artist} — Album ${Math.floor(i / ARTISTS) % 9}`;
  tracks.push({
    id: createHash("sha256").update(`scale-${i}`).digest("hex"),
    title: `Song ${String(i).padStart(6, "0")}`,
    artist,
    albumArtist: artist,
    album,
    number: (i % 14) + 1,
    disc: 1,
    year: 1970 + (i % 55),
    genre: ["Ambient", "Jazz", "Rock", "Hip hop"][i % 4],
    duration: 120 + (i % 240),
    format: ["MP3", "FLAC", "M4A", "WAV"][i % 4],
    sampleRate: 44100,
    bitDepth: 16,
    file: path.join("Artists", artist, album, `song-${i}.mp3`),
    coverFile: "",
    lyrics: "",
    favorite: i % 97 === 0,
    addedAt: 1700000000000 + i * 1000,
  });
}
await fs.writeFile(
  path.join(root, ".edoras", "library.json"),
  JSON.stringify({ tracks, playlists: [], artists: {} }),
);
// A listening history of the shape stats.js writes: five thousand songs
// heard over a year, and a dozen playlists, so the Statistics page and the
// home shelves have real work to do.
const listening = {
  version: 1,
  since: Date.now() - 365 * 86400000,
  tracks: {},
  days: {},
  hours: Array(24).fill(0),
};
for (let i = 0; i < 5000; i++) {
  const plays = 1 + ((i * 7919) % 60);
  listening.tracks[tracks[(i * 8) % SONGS].id] = {
    plays,
    seconds: plays * 200,
    last: Date.now() - (i % 300) * 86400000,
  };
}
for (let d = 0; d < 365; d++) {
  const date = new Date(Date.now() - d * 86400000);
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  listening.days[key] = 600 + ((d * 37) % 5400);
}
listening.hours = listening.hours.map((_, h) => 1000 * (1 + ((h * 5) % 11)));
await fs.writeFile(
  path.join(root, ".edoras", "listening.json"),
  JSON.stringify(listening),
);
const playlists = Array.from({ length: 12 }, (_, p) => ({
  id: `pl-scale-${p}`,
  name: `Playlist ${p + 1}`,
  createdAt: Date.now(),
  trackIds: tracks.slice(p * 500, p * 500 + 100 + p * 150).map((t) => t.id),
}));
await fs.writeFile(
  path.join(root, ".edoras", "library.json"),
  JSON.stringify({ tracks, playlists, artists: {} }),
);
await fs.writeFile(
  path.join(home, "settings.json"),
  JSON.stringify({ root, watching: false }),
);

const checks = [];
const numbers = {};
let desktop;
try {
  desktop = await electron.launch({
    args: ["."],
    env: { ...process.env, EDORAS_TEST_HOME: home },
    timeout: 60000,
  });
  const page = await desktop.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(
    page.getByRole("heading", { name: "Your music.", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  const loaded = await page.evaluate(() =>
    window.edoras.getLibrary().then((data) => data.tracks.length),
  );
  if (loaded !== SONGS)
    throw new Error(`Library holds ${loaded} songs, expected ${SONGS}`);
  checks.push(`home page draws with ${SONGS} songs in the catalog`);

  // ---- the library table ---------------------------------------------------
  const openedAt = Date.now();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".track-row").first()).toBeVisible();
  numbers.libraryOpenMs = Date.now() - openedAt;
  const rendered = await page.locator(".track-row").count();
  if (rendered > 200)
    throw new Error(
      `${rendered} rows in the document; the table is not windowing`,
    );
  checks.push(
    `library opens in ${numbers.libraryOpenMs}ms with ${rendered} rows in the document, not ${SONGS}`,
  );

  // The entrance is capped, whatever the library's size: the first ten rows
  // cascade in and nothing else animates. Uncapped, forty thousand rows or
  // ten thousand album cards would schedule that many animations in one
  // frame, which is what used to cost seconds.
  const entering = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) => a.animationName === "appear" && a.playState !== "finished",
        ).length,
  );
  if (entering > 10)
    throw new Error(`${entering} animations running at once on the library`);
  checks.push(
    `the entrance is capped at ten rows (${entering} animating on arrival)`,
  );

  // The scrollbar has to describe the whole collection, or scrolling lies.
  const body = page.locator(".table-body");
  const height = await body.evaluate((el) => el.getBoundingClientRect().height);
  const rowHeight = await page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--row-h"),
    ),
  );
  if (Math.abs(height - SONGS * rowHeight) > 2)
    throw new Error(
      `table is ${height}px tall, expected ${SONGS * rowHeight}px`,
    );
  checks.push("the table reserves the full height of the collection");

  // ---- rows land where they belong, at the top, the middle and the end -----
  const misplaced = async (label) => {
    const report = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".track-row")];
      if (rows.length < 2) return { gaps: 0, overlaps: 0, rows: rows.length };
      const boxes = rows
        .map((r) => r.getBoundingClientRect())
        .sort((a, b) => a.top - b.top);
      let gaps = 0,
        overlaps = 0,
        overflow = 0;
      const table = document
        .querySelector(".track-table")
        .getBoundingClientRect();
      for (let i = 1; i < boxes.length; i++) {
        const delta = boxes[i].top - boxes[i - 1].bottom;
        if (delta > 1) gaps++;
        if (delta < -1) overlaps++;
      }
      for (const box of boxes)
        if (box.left < table.left - 1 || box.right > table.right + 1)
          overflow++;
      return {
        gaps,
        overlaps,
        overflow,
        rows: boxes.length,
        pageOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    if (report.gaps || report.overlaps || report.overflow)
      throw new Error(`rows broke ${label}: ${JSON.stringify(report)}`);
    if (report.pageOverflow > 0)
      throw new Error(`the page scrolls sideways ${label}`);
    return report;
  };
  // The entrance slides rows in, so geometry is only meaningful once it has
  // finished. `animation-fill-mode: both` holds the resting state afterwards.
  const settled = () =>
    page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.animationName === "appear")
          .map((a) => a.finished.catch(() => {})),
      ).then(() => {}),
    );
  await settled();
  await misplaced("at the top");
  const jumpTo = async (ratio) => {
    await page.evaluate((r) => {
      scrollTo({ top: document.documentElement.scrollHeight * r });
    }, ratio);
    await page.waitForTimeout(250);
  };
  await jumpTo(0.5);
  await misplaced("halfway down");
  await jumpTo(1);
  await misplaced("at the end");
  // The last row is the collection's last song whatever it is called, which
  // is the point: the window really did reach the end of forty thousand.
  const lastNumber = await page
    .locator(".track-row .row-number span")
    .last()
    .innerText();
  if (Number(lastNumber) !== SONGS)
    throw new Error(`the last row is number ${lastNumber}, expected ${SONGS}`);
  checks.push(
    "rows stay flush and on the page at the top, the middle and the end",
  );
  const atEnd = await page.locator(".track-row").count();
  if (atEnd > 200) throw new Error(`${atEnd} rows after scrolling to the end`);
  checks.push(`scrolling the whole library leaves ${atEnd} rows behind`);
  // Scrolling repaints the window; if the entrance were not gated to a fresh
  // render, every one of those rows would animate and the list would flicker.
  const whileScrolling = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) => a.animationName === "appear" && a.playState === "running",
        ).length,
  );
  if (whileScrolling)
    throw new Error(`${whileScrolling} animations running while scrolling`);
  checks.push("scrolling sets nothing animating");
  await page.screenshot({ path: "test-results/scale-library.png" });

  // ---- sorting -------------------------------------------------------------
  await jumpTo(0);
  const firstTitle = () =>
    page.locator(".track-row .row-track b").first().innerText();
  await page.selectOption(".sort-field", "title");
  await page.waitForTimeout(200);
  if ((await firstTitle()) !== "Song 000000")
    throw new Error(`alphabetical put ${await firstTitle()} first`);
  await page
    .getByRole("button", { name: /Reverse it/ })
    .first()
    .click();
  await page.waitForTimeout(200);
  if ((await firstTitle()) !== `Song ${String(SONGS - 1).padStart(6, "0")}`)
    throw new Error(`reversed put ${await firstTitle()} first`);
  await page.selectOption(".sort-field", "added");
  await page.waitForTimeout(200);
  if ((await firstTitle()) !== `Song ${String(SONGS - 1).padStart(6, "0")}`)
    throw new Error(`newest first put ${await firstTitle()} first`);
  // A new order arrives like a new page, so it cascades in too.
  await settled();
  await misplaced("after sorting");
  checks.push("sorting reorders the whole library and the rows still line up");

  // ---- the shelves ---------------------------------------------------------
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await expect(page.locator(".music-card").first()).toBeVisible();
  const albumOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  if (albumOverflow > 0) throw new Error("the albums shelf overflows sideways");
  await page.screenshot({ path: "test-results/scale-albums.png" });

  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await expect(page.locator(".artist-card").first()).toBeVisible();
  const shelf = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".artist-card")].slice(0, 12);
    const boxes = cards.map((c) => c.getBoundingClientRect());
    const row = boxes.filter((b) => Math.abs(b.top - boxes[0].top) < 2);
    return {
      perRow: row.length,
      gap: row.length > 1 ? Math.round(row[1].left - row[0].right) : 0,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      artists: document.querySelectorAll(".artist-card").length,
    };
  });
  if (shelf.overflow > 0)
    throw new Error("the artists shelf overflows sideways");
  const shelfAnimations = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) => a.animationName === "appear" && a.playState !== "finished",
        ).length,
  );
  if (shelfAnimations > 10)
    throw new Error(
      `${shelfAnimations} animations running at once on the artists shelf`,
    );
  if (shelf.gap > 40)
    throw new Error(`${shelf.gap}px between artists is still too much`);
  numbers.artistsPerRow = shelf.perRow;
  numbers.artistGap = shelf.gap;
  checks.push(
    `${shelf.artists} artists sit ${shelf.perRow} to a row with a ${shelf.gap}px gap`,
  );
  await page.screenshot({ path: "test-results/scale-artists.png" });

  // ---- the collapsed rail --------------------------------------------------
  await page.getByRole("button", { name: "Collapse" }).click();
  await page.waitForTimeout(500);
  const rail = await page.evaluate(() => {
    const centres = [...document.querySelectorAll(".nav-item")].map((item) => {
      const svg = item.querySelector("svg");
      const box = svg.getBoundingClientRect();
      return Math.round(box.left + box.width / 2);
    });
    return { centres, spread: Math.max(...centres) - Math.min(...centres) };
  });
  if (rail.spread > 1)
    throw new Error(
      `collapsed icons are ${rail.spread}px apart: ${rail.centres.join(", ")}`,
    );
  numbers.railSpread = rail.spread;
  checks.push(
    `every icon in the collapsed rail sits on one axis (${rail.spread}px apart)`,
  );
  await page.screenshot({ path: "test-results/scale-rail.png" });
  await page.getByRole("button", { name: "Collapse" }).click();
  await page.waitForTimeout(500);

  // ---- the Statistics page ---------------------------------------------------
  // Every figure is a pass over the library and every chart is a few dozen
  // elements, so the page should cost about the same at any size.
  const statsAt = Date.now();
  await page.locator('.nav-item[data-view="statistics"]').click();
  await expect(page.locator(".stat-feature")).toBeVisible();
  numbers.statisticsOpenMs = Date.now() - statsAt;
  for (const range of ["week", "year", "month"])
    await page.locator(`[data-stats-range="${range}"]`).click();
  const statsCost = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 400));
    return {
      used: performance.memory?.usedJSHeapSize ?? 0,
      nodes: document.getElementsByTagName("*").length,
    };
  });
  numbers.statisticsHeapMB = Math.round((statsCost.used / 1048576) * 10) / 10;
  numbers.statisticsElements = statsCost.nodes;
  if (statsCost.nodes > 2500)
    throw new Error(`the Statistics page built ${statsCost.nodes} elements`);
  checks.push(
    `Statistics opens in ${numbers.statisticsOpenMs}ms with ${statsCost.nodes} elements and ${numbers.statisticsHeapMB} MB of heap`,
  );
  await page.screenshot({ path: "test-results/scale-statistics.png" });
  const homeAt = Date.now();
  await page.locator('.nav-item[data-view="home"]').click();
  await expect(
    page.getByRole("heading", { name: "Most listened" }),
  ).toBeVisible();
  numbers.homeOpenMs = Date.now() - homeAt;
  numbers.homeElements = await page.evaluate(
    () => document.getElementsByTagName("*").length,
  );
  checks.push(
    `home with its new shelves opens in ${numbers.homeOpenMs}ms with ${numbers.homeElements} elements`,
  );

  // ---- what it costs -------------------------------------------------------
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".track-row").first()).toBeVisible();
  await page.waitForTimeout(600);
  const heap = await page.evaluate(async () => {
    // Give the collector a chance so the number is the resting cost, not a
    // high-water mark left over from building the page.
    await new Promise((r) => setTimeout(r, 400));
    return {
      used: performance.memory?.usedJSHeapSize ?? 0,
      nodes: document.getElementsByTagName("*").length,
    };
  });
  // The whole app, every Electron process, as the operating system counts it.
  numbers.appWorkingSetMB = await desktop.evaluate(({ app }) =>
    Math.round(
      app
        .getAppMetrics()
        .reduce((n, p) => n + (p.memory?.workingSetSize ?? 0), 0) / 1024,
    ),
  );
  numbers.heapMB = Math.round((heap.used / 1048576) * 10) / 10;
  numbers.domNodes = heap.nodes;
  checks.push(
    `${numbers.heapMB} MB of renderer heap and ${heap.nodes} elements with the library open; ${numbers.appWorkingSetMB} MB for the whole app`,
  );

  if (errors.length) throw new Error(errors.join("\n"));
  await desktop.close();
  desktop = null;
  console.log(
    JSON.stringify(
      { passed: true, songs: SONGS, artists: ARTISTS, checks, numbers },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks, numbers }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
}
