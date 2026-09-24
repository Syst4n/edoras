import type { ListeningStats, Playlist, Track } from "./types";

// The Statistics page. Everything here is computed from two things the app
// already holds: the catalog and the listening totals. Every figure is one
// pass over the library at most, and every chart is a few dozen elements
// whatever the size of the collection, so the page costs the same at forty
// songs as at forty thousand.
//
// All charts are single series and take the playing song's colour, the same
// accent every other control uses, so no chart needs a legend or a palette
// of its own. Text stays in the ink tokens; colour is only ever the mark.

export type Range = "week" | "month" | "year";

export interface StatsContext {
  tracks: Track[];
  playlists: Playlist[];
  stats: ListeningStats;
  range: Range;
  artwork(track: Track, cls?: string): string;
  avatar(artist: string, cls?: string): string;
  icon(name: string, cls?: string): string;
  escape(value: unknown): string;
}

export function dayKey(time: number) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function emptyStats(): ListeningStats {
  return { since: Date.now(), tracks: {}, days: {}, hours: Array(24).fill(0) };
}

// The renderer's copy is updated the moment something is heard, so the page
// keeps counting while it is open; the main process gets the same entries in
// batches and keeps its own copy on disk.
export function addListening(
  stats: ListeningStats,
  id: string,
  seconds: number,
  play: boolean,
  at = Date.now(),
) {
  const entry = (stats.tracks[id] ??= { plays: 0, seconds: 0, last: 0 });
  entry.seconds += seconds;
  if (play) entry.plays++;
  entry.last = Math.max(entry.last, at);
  if (seconds) {
    const day = dayKey(at);
    stats.days[day] = (stats.days[day] ?? 0) + seconds;
    stats.hours[new Date(at).getHours()]! += seconds;
  }
}

const number = new Intl.NumberFormat();
export function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${number.format(hours)} h ${minutes % 60} min`;
}

function totals(stats: ListeningStats) {
  let seconds = 0,
    plays = 0,
    songs = 0;
  for (const entry of Object.values(stats.tracks)) {
    seconds += entry.seconds;
    plays += entry.plays;
    if (entry.plays) songs++;
  }
  return { seconds, plays, songs };
}

// Days in a row with any listening, ending today or yesterday, and the
// longest such run on record.
function streaks(stats: ListeningStats) {
  const days = Object.keys(stats.days)
    .filter((d) => stats.days[d]! >= 30)
    .sort();
  let longest = 0,
    run = 0,
    previous = 0;
  for (const day of days) {
    const time = new Date(`${day}T12:00:00`).getTime();
    run =
      previous && Math.round((time - previous) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = time;
  }
  let current = 0;
  const cursor = new Date();
  if (!stats.days[dayKey(cursor.getTime())])
    cursor.setDate(cursor.getDate() - 1);
  while ((stats.days[dayKey(cursor.getTime())] ?? 0) >= 30) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

export interface Point {
  label: string;
  value: number;
  tip: string;
}

function timeline(stats: ListeningStats, range: Range): Point[] {
  const points: Point[] = [];
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  if (range === "year") {
    const months = new Map<string, number>();
    for (const [day, seconds] of Object.entries(stats.days)) {
      const month = day.slice(0, 7);
      months.set(month, (months.get(month) ?? 0) + seconds);
    }
    for (let i = 11; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const value = months.get(key) ?? 0;
      points.push({
        label: date.toLocaleDateString(undefined, { month: "short" }),
        value,
        tip: `${date.toLocaleDateString(undefined, { month: "long", year: "numeric" })} · ${duration(value)}`,
      });
    }
    return points;
  }
  const count = range === "week" ? 7 : 30;
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const value = stats.days[dayKey(date.getTime())] ?? 0;
    points.push({
      label:
        range === "week"
          ? date.toLocaleDateString(undefined, { weekday: "short" })
          : String(date.getDate()),
      value,
      tip: `${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${duration(value)}`,
    });
  }
  return points;
}

// Charts keep their points here, keyed by the chart's id, so the hover layer
// can find the value under the pointer without reading it back out of the
// document.
const chartData = new Map<string, Point[]>();

// A smooth line through the points that never swings past them: monotone
// cubic interpolation (Fritsch-Carlson), so a quiet day between two busy ones
// dips to its real value instead of below zero.
function monotone(points: (readonly [number, number])[]) {
  const n = points.length;
  if (n < 3)
    return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
  const dx: number[] = [],
    slope: number[] = [],
    tangent: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1]![0] - points[i]![0];
    slope[i] = (points[i + 1]![1] - points[i]![1]) / dx[i]!;
  }
  tangent[0] = slope[0]!;
  tangent[n - 1] = slope[n - 2]!;
  for (let i = 1; i < n - 1; i++)
    tangent[i] =
      slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i]! / slope[i]!,
      b = tangent[i + 1]! / slope[i]!,
      h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangent[i] = t * a * slope[i]!;
      tangent[i + 1] = t * b * slope[i]!;
    }
  }
  const f = (v: number) => Math.round(v * 100) / 100;
  let d = `M${f(points[0]![0])} ${f(points[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!,
      [x1, y1] = points[i + 1]!,
      third = dx[i]! / 3;
    d += `C${f(x0 + third)} ${f(y0 + tangent[i]! * third)} ${f(x1 - third)} ${f(y1 - tangent[i + 1]! * third)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}

// An area over time. The shape is SVG stretched to the box, with a stroke
// that does not stretch, so it fills any width without being measured first.
// Labels and the tooltip are ordinary HTML laid over it.
function areaChart(
  id: string,
  points: Point[],
  escape: StatsContext["escape"],
) {
  chartData.set(id, points);
  const max = Math.max(...points.map((p) => p.value), 60);
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const coords = points.map(
    (p, i) => [i * step, 100 - (p.value / max) * 92] as const,
  );
  const line = monotone(coords);
  const area = `${line}L100 100L0 100Z`;
  const every = points.length > 14 ? Math.ceil(points.length / 8) : 1;
  const grid = [0.5, 1]
    .map(
      (f) =>
        `<span class="chart-grid" style="bottom:${f * 92}%"><i>${duration(max * f)}</i></span>`,
    )
    .join("");
  return `<div class="chart area-chart" data-chart="${id}" data-kind="area" role="img" aria-label="${escape(points.map((p) => p.tip).join("; "))}"><div class="chart-plot">${grid}<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--art)" stop-opacity=".32"/><stop offset="1" stop-color="var(--art)" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#${id}-fill)"/><path d="${line}" fill="none" stroke="var(--art)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg><span class="chart-cursor" aria-hidden="true"></span><span class="chart-dot" aria-hidden="true"></span><span class="chart-tip" aria-hidden="true"></span></div><div class="chart-axis">${points
    .map(
      (p, i) =>
        `<span style="left:${i * step}%">${i % every === 0 || i === points.length - 1 ? escape(p.label) : ""}</span>`,
    )
    .join("")}</div></div>`;
}

// Columns for anything counted in buckets: hours of the day, months. Each
// column is a flex child sized in percent, so the chart needs no measuring
// either, and each one is its own hover target, wider than the mark.
function columnChart(
  id: string,
  points: Point[],
  escape: StatsContext["escape"],
  every = 1,
) {
  chartData.set(id, points);
  const max = Math.max(...points.map((p) => p.value), 1);
  return `<div class="chart column-chart" data-chart="${id}" data-kind="column" role="img" aria-label="${escape(points.map((p) => p.tip).join("; "))}"><div class="chart-plot">${points
    .map(
      (p, i) =>
        `<span class="column" data-index="${i}"><i style="height:${p.value ? Math.max(3, (p.value / max) * 100) : 0}%"></i></span>`,
    )
    .join(
      "",
    )}<span class="chart-tip" aria-hidden="true"></span></div><div class="chart-axis columns">${points
    .map(
      (p, i) =>
        // Counted back from the newest, so the latest bucket always has
        // its label.
        `<span>${(points.length - 1 - i) % every === 0 ? escape(p.label) : ""}</span>`,
    )
    .join("")}</div></div>`;
}

interface BarItem {
  label: string;
  sub?: string;
  value: number;
  shown: string;
  media?: string;
  attrs?: string;
}
// A ranked list with a bar under each name: the length compares, the number
// says exactly how much. Rows that lead somewhere are buttons.
function barList(items: BarItem[], ranked = true) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return `<ol class="bar-list ${ranked ? "ranked" : ""}">${items
    .map(
      (item, i) =>
        `<li><${item.attrs ? `button ${item.attrs}` : "div"} class="bar-row">${ranked ? `<span class="bar-rank">${i + 1}</span>` : ""}${item.media ?? ""}<span class="bar-text"><b>${item.label}</b>${item.sub ? `<small>${item.sub}</small>` : ""}<span class="bar-track"><i style="width:${Math.max(2, (item.value / max) * 100)}%"></i></span></span><span class="bar-value">${item.shown}</span></${item.attrs ? "button" : "div"}></li>`,
    )
    .join("")}</ol>`;
}

function card(title: string, sub: string, body: string, extra = "", cls = "") {
  return `<section class="stat-card ${cls}"><header><div><h2>${title}</h2><p>${sub}</p></div>${extra}</header>${body}</section>`;
}

function quiet(text: string, iconHtml: string) {
  return `<div class="stat-quiet">${iconHtml}<p>${text}</p></div>`;
}

export function statisticsPage(ctx: StatsContext) {
  const { tracks, stats, escape, icon } = ctx;
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const total = totals(stats);
  const today = stats.days[dayKey(Date.now())] ?? 0;
  const streak = streaks(stats);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  let addedThisMonth = 0;
  const albums = new Set<string>();
  const artistSongs = new Map<string, number>();
  const genreSongs = new Map<string, number>();
  for (const t of tracks) {
    if (t.addedAt >= monthStart.getTime()) addedThisMonth++;
    albums.add(`${t.albumArtist}|||${t.album}`);
    artistSongs.set(t.albumArtist, (artistSongs.get(t.albumArtist) ?? 0) + 1);
    const genre = t.genre.trim();
    if (genre) genreSongs.set(genre, (genreSongs.get(genre) ?? 0) + 1);
  }

  // What was heard, joined to the catalog. Songs no longer in the library
  // still count toward the minutes, just not toward a ranking.
  const heard = Object.entries(stats.tracks)
    .map(([id, entry]) => ({ track: byId.get(id), ...entry }))
    .filter(
      (e): e is typeof e & { track: Track } => !!e.track && e.seconds > 0,
    );
  const artistTime = new Map<string, number>();
  const genreTime = new Map<string, number>();
  for (const e of heard) {
    const artist = e.track.albumArtist;
    artistTime.set(artist, (artistTime.get(artist) ?? 0) + e.seconds);
    const genre = e.track.genre.trim();
    if (genre) genreTime.set(genre, (genreTime.get(genre) ?? 0) + e.seconds);
  }
  const listened = total.seconds >= 60;

  const topSongs = [...heard]
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds)
    .slice(0, 10);
  const favourite = topSongs[0];

  const since = new Date(stats.since).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const heading = `<div class="page-heading stats-heading"><h1>Statistics</h1><p>${listened ? `Your listening since ${escape(since)}.` : "Your library, counted. Listening fills in the rest."} Counted on this computer and never sent anywhere.</p></div>`;

  const feature = favourite
    ? `<button class="stat-feature" data-track="${escape(favourite.track.id)}"><span class="stat-feature-art">${ctx.artwork(favourite.track)}<span class="cover-play">${icon("play")}</span></span><span class="stat-feature-text"><span class="eyebrow">MOST LISTENED</span><b>${escape(favourite.track.title)}</b><small>${escape(favourite.track.artist)}</small><span class="stat-feature-meta"><span><strong>${number.format(favourite.plays)}</strong> ${favourite.plays === 1 ? "play" : "plays"}</span><span><strong>${duration(favourite.seconds)}</strong> listened</span></span></span></button>`
    : `<div class="stat-feature is-empty"><span class="stat-feature-art">${icon("audio-lines")}</span><span class="stat-feature-text"><span class="eyebrow">MOST LISTENED</span><b>Nothing yet.</b><small>Play a song for half a minute and it starts counting.</small></span></div>`;

  const tile = (
    key: string,
    label: string,
    value: number,
    shown: string,
    sub: string,
  ) =>
    `<div class="stat-tile"><small>${label}</small><b data-stat="${key}" data-count="${value}">${shown}</b><span data-stat-sub="${key}">${sub}</span></div>`;
  const minutes = Math.round(total.seconds / 60);
  const tiles = `<div class="stat-tiles">${tile("minutes", "Minutes listened", minutes, number.format(minutes), `${duration(today)} today`)}${tile("plays", "Songs played", total.plays, number.format(total.plays), `${number.format(total.songs)} different ${total.songs === 1 ? "song" : "songs"}`)}${tile("library", "Songs in your library", tracks.length, number.format(tracks.length), `${number.format(addedThisMonth)} added this month`)}${tile("artists", "Artists", artistSongs.size, number.format(artistSongs.size), `${number.format(albums.size)} ${albums.size === 1 ? "album" : "albums"}`)}${tile("streak", "Day streak", streak.current, number.format(streak.current), `Longest ${number.format(streak.longest)} ${streak.longest === 1 ? "day" : "days"}`)}${tile("playlists", "Playlists", ctx.playlists.length, number.format(ctx.playlists.length), `${number.format(ctx.playlists.reduce((n, p) => n + p.trackIds.length, 0))} songs in them`)}</div>`;

  const ranges: [Range, string][] = [
    ["week", "7 days"],
    ["month", "30 days"],
    ["year", "12 months"],
  ];
  const rangeControl = `<div class="segmented" role="group" aria-label="Time range">${ranges
    .map(
      ([key, label]) =>
        `<button data-stats-range="${key}" aria-pressed="${ctx.range === key}" class="${ctx.range === key ? "on" : ""}">${label}</button>`,
    )
    .join("")}</div>`;
  const points = timeline(stats, ctx.range);
  const rangeTotal = points.reduce((n, p) => n + p.value, 0);
  const over = card(
    "Listening over time",
    `${duration(rangeTotal)} in the last ${ranges.find((r) => r[0] === ctx.range)![1]}`,
    areaChart("timeline", points, escape),
    rangeControl,
    "wide",
  );

  const songs = card(
    "Top songs",
    "By times played.",
    topSongs.length
      ? barList(
          topSongs.map((e) => ({
            label: escape(e.track.title),
            sub: escape(e.track.artist),
            value: e.plays || e.seconds / 600,
            shown: `${number.format(e.plays)} ${e.plays === 1 ? "play" : "plays"}`,
            media: ctx.artwork(e.track, "bar-art"),
            attrs: `data-track="${escape(e.track.id)}" aria-label="Play ${escape(e.track.title)}"`,
          })),
        )
      : quiet("Your most played songs will line up here.", icon("music-2")),
  );

  const artistSource = listened ? artistTime : artistSongs;
  const artists = card(
    "Top artists",
    listened
      ? "By time listened."
      : "By songs in your library, until you've listened a while.",
    artistSource.size
      ? barList(
          [...artistSource]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, value]) => ({
              label: escape(name),
              value,
              shown: listened
                ? duration(value)
                : `${number.format(value)} ${value === 1 ? "song" : "songs"}`,
              media: ctx.avatar(name, "artist-avatar bar-avatar"),
              attrs: `data-artist="${escape(name)}" aria-label="Open ${escape(name)}"`,
            })),
        )
      : quiet(
          "Import some music and your artists appear here.",
          icon("user-round"),
        ),
  );

  const genreSource = listened && genreTime.size ? genreTime : genreSongs;
  const genres = card(
    "Top genres",
    genreSource === genreTime
      ? "By time listened."
      : "By songs in your library.",
    genreSource.size
      ? barList(
          [...genreSource]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, value]) => ({
              label: escape(name),
              value,
              shown:
                genreSource === genreTime
                  ? duration(value)
                  : `${number.format(value)} ${value === 1 ? "song" : "songs"}`,
              attrs: `data-genre="${escape(name)}" aria-label="Search for ${escape(name)}"`,
            })),
        )
      : quiet(
          "No genre tags yet. Fetch Library Metadata fills many of them in.",
          icon("disc-3"),
        ),
  );

  const hourLabel = (h: number) =>
    new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
  const hours = card(
    "When you listen",
    "By hour of the day.",
    columnChart(
      "hours",
      stats.hours.map((value, h) => ({
        label: hourLabel(h),
        value,
        tip: `${hourLabel(h)} · ${duration(value)}`,
      })),
      escape,
      6,
    ),
  );

  const growth: Point[] = [];
  const now = new Date();
  const monthly = new Map<string, number>();
  for (const t of tracks) {
    const d = new Date(t.addedAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    monthly.set(key, (monthly.get(key) ?? 0) + 1);
  }
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = monthly.get(`${d.getFullYear()}-${d.getMonth()}`) ?? 0;
    growth.push({
      label: d.toLocaleDateString(undefined, { month: "short" }),
      value,
      tip: `${d.toLocaleDateString(undefined, { month: "long", year: "numeric" })} · ${number.format(value)} ${value === 1 ? "song" : "songs"} added`,
    });
  }
  const added = card(
    "Songs added",
    `${number.format(tracks.length)} in your library, by the month they arrived.`,
    columnChart("growth", growth, escape, 2),
  );

  const lists = ctx.playlists.map((p) => {
    const length = p.trackIds.reduce(
      (n, id) => n + (byId.get(id)?.duration ?? 0),
      0,
    );
    return { p, length };
  });
  const playlists = card(
    "Playlists",
    "By length.",
    lists.length
      ? barList(
          lists
            .sort((a, b) => b.length - a.length)
            .slice(0, 8)
            .map(({ p, length }) => ({
              label: escape(p.name),
              sub: `${number.format(p.trackIds.length)} ${p.trackIds.length === 1 ? "song" : "songs"}`,
              value: length,
              shown: duration(length),
              attrs: `data-playlist="${escape(p.id)}" aria-label="Open ${escape(p.name)}"`,
            })),
          false,
        )
      : quiet("Make a playlist and its length shows here.", icon("list-music")),
  );

  return `${heading}<div class="stats-page"><div class="stats-top">${feature}${tiles}</div>${over}<div class="stat-columns">${songs}${artists}</div><div class="stat-columns">${genres}${hours}</div><div class="stat-columns">${added}${playlists}</div></div>`;
}

// Tiles count up from zero when the page arrives. Numbers only, capped at
// six elements and under a second, and not at all for anyone who has asked
// the system for less motion.
export function countUp(root: ParentNode) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const targets = [...root.querySelectorAll<HTMLElement>("[data-count]")];
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / 800);
    const eased = 1 - Math.pow(1 - t, 3);
    for (const el of targets) {
      if (!el.isConnected) return;
      el.textContent = number.format(
        Math.round(Number(el.dataset.count) * eased),
      );
    }
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Live figures while the page is open: only the text of a few tiles changes,
// so the charts and the scroll position are left alone.
export function refreshTiles(stats: ListeningStats) {
  const total = totals(stats);
  const set = (key: string, value: string) => {
    const el = document.querySelector<HTMLElement>(`[data-stat="${key}"]`);
    if (el && el.textContent !== value) el.textContent = value;
  };
  const setSub = (key: string, value: string) => {
    const el = document.querySelector<HTMLElement>(`[data-stat-sub="${key}"]`);
    if (el && el.textContent !== value) el.textContent = value;
  };
  const minutes = Math.round(total.seconds / 60);
  set("minutes", number.format(minutes));
  setSub("minutes", `${duration(stats.days[dayKey(Date.now())] ?? 0)} today`);
  set("plays", number.format(total.plays));
  setSub(
    "plays",
    `${number.format(total.songs)} different ${total.songs === 1 ? "song" : "songs"}`,
  );
}

// One hover layer for every chart on the page, delegated from the document,
// so a re-render never leaves listeners behind.
function showTip(chart: HTMLElement, index: number) {
  const points = chartData.get(chart.dataset.chart ?? "");
  const point = points?.[index];
  const tip = chart.querySelector<HTMLElement>(".chart-tip");
  const plot = chart.querySelector<HTMLElement>(".chart-plot");
  if (!points || !point || !tip || !plot) return;
  tip.textContent = point.tip;
  const kind = chart.dataset.kind;
  let x: number;
  if (kind === "area") {
    x = points.length > 1 ? (index / (points.length - 1)) * 100 : 50;
    const max = Math.max(...points.map((p) => p.value), 60);
    const y = 100 - (point.value / max) * 92;
    chart.style.setProperty("--cursor-x", `${x}%`);
    chart.style.setProperty("--cursor-y", `${y}%`);
  } else {
    x = ((index + 0.5) / points.length) * 100;
    chart
      .querySelectorAll(".column")
      .forEach((c, i) => c.classList.toggle("is-hover", i === index));
  }
  tip.style.left = `${Math.min(88, Math.max(12, x))}%`;
  chart.classList.add("is-hovering");
}
function hideTip(chart: HTMLElement) {
  chart.classList.remove("is-hovering");
  chart
    .querySelectorAll(".column.is-hover")
    .forEach((c) => c.classList.remove("is-hover"));
}
export function bindCharts() {
  document.addEventListener("pointermove", (event) => {
    const chart = (event.target as Element).closest?.<HTMLElement>(
      "[data-chart]",
    );
    document
      .querySelectorAll<HTMLElement>("[data-chart].is-hovering")
      .forEach((other) => other !== chart && hideTip(other));
    if (!chart) return;
    const plot = chart.querySelector<HTMLElement>(".chart-plot")!;
    const rect = plot.getBoundingClientRect();
    const points = chartData.get(chart.dataset.chart ?? "");
    if (!points?.length || !rect.width) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    const index =
      chart.dataset.kind === "area"
        ? Math.round(ratio * (points.length - 1))
        : Math.min(points.length - 1, Math.floor(ratio * points.length));
    showTip(chart, index);
  });
  document.addEventListener("pointerleave", () =>
    document
      .querySelectorAll<HTMLElement>("[data-chart].is-hovering")
      .forEach(hideTip),
  );
}
