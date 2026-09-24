import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mediaResponse } from "../electron/media.js";

test("media responses support full audio, seeking, suffixes and invalid ranges", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "edoras-range-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, "audio.wav");
  await fs.writeFile(file, Buffer.from("0123456789"));
  const request = (range) =>
    new Request("https://test/audio", { headers: range ? { range } : {} });
  const full = await mediaResponse(file, request());
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("Content-Length"), "10");
  assert.equal(await full.text(), "0123456789");
  const part = await mediaResponse(file, request("bytes=3-6"));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), "bytes 3-6/10");
  assert.equal(await part.text(), "3456");
  const suffix = await mediaResponse(file, request("bytes=-3"));
  assert.equal(await suffix.text(), "789");
  for (const range of ["bytes=15-", "bytes=8-2", "bytes=", "bytes=0-1,4-5"])
    assert.equal((await mediaResponse(file, request(range))).status, 416);
});
