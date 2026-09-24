import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyListening,
  cleanStats,
  emptyStats,
  dayKey,
  ListeningStore,
} from "../electron/stats.js";

const id = "a".repeat(64);

test("listening adds up per song, per day and per hour", () => {
  const stats = emptyStats();
  const at = new Date(2026, 8, 23, 21, 15).getTime();
  applyListening(stats, [{ id, seconds: 40, play: true, at }], at);
  applyListening(stats, [{ id, seconds: 20, at }], at);
  assert.equal(stats.tracks[id].plays, 1);
  assert.equal(stats.tracks[id].seconds, 60);
  assert.equal(stats.tracks[id].last, at);
  assert.equal(stats.days[dayKey(at)], 60);
  assert.equal(stats.hours[21], 60);
});

test("a bad message cannot inflate the totals", () => {
  const stats = emptyStats();
  const now = Date.now();
  applyListening(
    stats,
    [
      { id, seconds: 99999, at: now },
      { id: "../../etc", seconds: 10, at: now },
      { id, seconds: -5, at: now },
      { id, seconds: Number.NaN, at: now },
      { id, seconds: 5, at: now + 10 * 86400000 },
    ],
    now,
  );
  // 60 from the first entry, capped, and 5 from the last, whose impossible
  // date is replaced by now.
  assert.equal(stats.tracks[id].seconds, 65);
  assert.equal(Object.keys(stats.tracks).length, 1);
  assert.throws(() => applyListening(stats, "nope"));
  assert.throws(() => applyListening(stats, Array(201).fill({ id })));
});

test("a damaged file loses only its bad entries", () => {
  const stats = cleanStats({
    since: 5,
    tracks: {
      [id]: { plays: "3", seconds: 30, last: 9 },
      nonsense: { plays: 1 },
    },
    days: { "2026-09-23": 30, yesterday: 10, "2026-09-22": -4 },
    hours: [1, 2, 3],
  });
  assert.equal(stats.since, 5);
  assert.deepEqual(Object.keys(stats.tracks), [id]);
  assert.equal(stats.tracks[id].plays, 3);
  assert.deepEqual(stats.days, { "2026-09-23": 30 });
  assert.equal(stats.hours.length, 24);
});

test("the store writes its totals and reads them back", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-stats-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".edoras"));
  const store = await new ListeningStore(root).load();
  store.record([{ id, seconds: 12, play: true, at: Date.now() }]);
  store.flushNow();
  const again = await new ListeningStore(root).load();
  assert.equal(again.stats.tracks[id].seconds, 12);
  assert.equal(again.stats.tracks[id].plays, 1);
});
