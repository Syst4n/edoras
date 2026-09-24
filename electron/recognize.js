import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import ffmpeg from "./ffmpeg.js";
import { Endpoint } from "shazam-api";

export function audioSample(file, offset) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-ss",
        String(offset),
        "-i",
        file,
        "-t",
        "12",
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { windowsHide: true },
    );
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error("This song took too long to read. Try searching by name."),
      );
    }, 20000);
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size > 500000) child.kill();
      else chunks.push(c);
    });
    child.stderr.resume();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 && size > 32000
        ? resolve(Buffer.concat(chunks))
        : reject(
            new Error("Couldn't read enough audio to identify this song."),
          );
    });
  });
}
export function fingerprint(pcm) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./fingerprint-worker.js", import.meta.url),
      { workerData: pcm, execArgv: [] },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Audio analysis timed out. Try searching by name."));
    }, 15000);
    worker.once("message", (value) => {
      clearTimeout(timer);
      void worker.terminate();
      value?.error ? reject(new Error(value.error)) : resolve(value);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("Audio analysis stopped. Try again."));
    });
  });
}
export function recognizedCandidate(data) {
  if (!data?.matches?.length || !data.track?.title) return null;
  const t = data.track;
  const values =
    (t.sections || []).find((s) => s.type === "SONG")?.metadata || [];
  const field = (name) => values.find((m) => m.title === name)?.text || "";
  return {
    title: t.title,
    artist: t.subtitle || "",
    albumArtist: t.subtitle || "",
    album: field("Album"),
    year: Number(field("Released").slice(0, 4)) || null,
    genre: t.genres?.primary || "",
    duration: 0,
    source: "Shazam · audio match",
    sourceId: t.key || "",
    // Marks a result that came from the sound rather than a search, so
    // completing it also looks the song up in the catalog for a bigger cover
    // and the artist's photo.
    audioMatch: true,
    artworkUrls: [t.images?.coverarthq, t.images?.coverart].filter(
      (url) => typeof url === "string" && url,
    ),
  };
}
let chain = Promise.resolve();
export function recognizeAudio(file, duration, position = 0) {
  const job = chain.then(async () => {
    const maxStart = Math.max(0, duration - 12);
    const starts = [
      ...new Set(
        [
          position > 0 ? Math.min(position, maxStart) : Math.min(35, maxStart),
          Math.min(duration * 0.5, maxStart),
        ].map((s) => Math.floor(s)),
      ),
    ];
    for (const offset of starts) {
      const signature = await fingerprint(await audioSample(file, offset));
      if (!signature) continue;
      const endpoint = new Endpoint(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      );
      const origin = process.env.EDORAS_RECOGNIZE_ORIGIN;
      const url = new URL(
        origin ? `${origin}/recognize/${randomUUID()}` : endpoint.url(),
      );
      for (const [key, value] of Object.entries(endpoint.params()))
        url.searchParams.set(key, value);
      const response = await fetch(url, {
        method: "POST",
        headers: endpoint.headers(),
        body: JSON.stringify({
          signature,
          timestamp: Date.now(),
          timezone: endpoint.timezone,
          context: {},
          geolocation: {},
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok)
        throw new Error(
          "Audio recognition is unavailable right now. Try searching by name.",
        );
      const match = recognizedCandidate(await response.json());
      if (match) return [match];
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    return [];
  });
  chain = job.catch(() => {});
  return job;
}
