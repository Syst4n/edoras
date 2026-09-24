import fs from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";

// Listening history. Kept apart from library.json on purpose: that file holds
// the whole catalog and is rewritten on every change, and this one changes
// every few seconds while music plays. It lives in the library's own
// .edoras folder, so it follows the library the way playlists do.
//
// Only totals are stored: per song (plays, seconds, last played), per day
// and per hour of the day. That is enough for every chart on the Statistics
// page and it stays small however long the app is used: a year of daily
// listening is 365 numbers, and a song adds one entry the first time it
// plays, never more.
const ID = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function dayKey(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function emptyStats() {
  return {
    version: 1,
    since: Date.now(),
    tracks: {},
    days: {},
    hours: Array(24).fill(0),
  };
}

// Anything read from disk is checked field by field, so a hand-edited or
// half-written file costs its bad entries and nothing else.
export function cleanStats(data) {
  const stats = emptyStats();
  if (!data || typeof data !== "object") return stats;
  if (Number.isFinite(data.since)) stats.since = data.since;
  for (const [id, entry] of Object.entries(data.tracks ?? {})) {
    if (!ID.test(id) || !entry || typeof entry !== "object") continue;
    stats.tracks[id] = {
      plays: Math.max(0, Math.floor(Number(entry.plays) || 0)),
      seconds: Math.max(0, Number(entry.seconds) || 0),
      last: Math.max(0, Number(entry.last) || 0),
    };
  }
  for (const [day, seconds] of Object.entries(data.days ?? {}))
    if (DAY.test(day) && Number.isFinite(seconds) && seconds > 0)
      stats.days[day] = seconds;
  if (Array.isArray(data.hours) && data.hours.length === 24)
    stats.hours = data.hours.map((value) =>
      Number.isFinite(value) && value > 0 ? value : 0,
    );
  return stats;
}

// One batch of listening from the renderer. The renderer is trusted to say
// what it heard, not how much: every entry is bounded here, so a bug or a
// bad message can add at most a minute of listening per song per batch.
export function applyListening(stats, entries, now = Date.now()) {
  if (!Array.isArray(entries) || entries.length > 200)
    throw new Error("Invalid listening record");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !ID.test(entry.id)) continue;
    const seconds = Number(entry.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const heard = Math.min(seconds, 60);
    const at =
      Number.isFinite(entry.at) && Math.abs(entry.at - now) < 86400000
        ? entry.at
        : now;
    const track = (stats.tracks[entry.id] ??= {
      plays: 0,
      seconds: 0,
      last: 0,
    });
    track.seconds += heard;
    if (entry.play === true) track.plays++;
    track.last = Math.max(track.last, at);
    if (heard) {
      const day = dayKey(at);
      stats.days[day] = (stats.days[day] ?? 0) + heard;
      stats.hours[new Date(at).getHours()] += heard;
    }
  }
  return stats;
}

export class ListeningStore {
  constructor(root) {
    this.file = path.join(root, ".edoras/listening.json");
    this.stats = emptyStats();
    this.timer = null;
    this.dirty = false;
  }
  async load() {
    try {
      this.stats = cleanStats(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") this.stats = emptyStats();
    }
    return this;
  }
  record(entries) {
    applyListening(this.stats, entries);
    this.dirty = true;
    // Written at most every ten seconds while music plays, rather than on
    // every message.
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 10000);
    return true;
  }
  // A song deleted from the library takes its own counts with it. The days
  // and hours it was heard in keep their totals: that listening happened.
  forget(id) {
    if (!this.stats.tracks[id]) return;
    delete this.stats.tracks[id];
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 10000);
  }
  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.stats));
    await fs.rename(temporary, this.file);
  }
  // Quitting cannot wait for a promise, so the last few seconds are written
  // synchronously.
  flushNow() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.stats));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      /* the next session starts from the last good write */
    }
  }
}
