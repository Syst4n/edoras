// Whole-track waveform data.
//
// The player used to draw a live FFT, which shows what is sounding at this
// instant and so has no shape to colour either side of the playhead. A
// waveform needs the amplitude envelope of the entire track up front, which
// means decoding it once and keeping the result.

const BUCKETS = 320;
// Peaks only need the shape of the track, so we let the decoder resample on
// the way in. Full-rate PCM for a ten-minute lossless file is hundreds of
// megabytes; at 8kHz mono the same track costs a few.
const DECODE_RATE = 8000;
const FLOOR = 0.04;

const cache = new Map<string, Float32Array>();
const pending = new Map<string, Promise<Float32Array | null>>();
const failed = new Set<string>();

export const cachedPeaks = (id: string) => cache.get(id) ?? null;
export const peaksPending = (id: string) => pending.has(id);
export const peaksFailed = (id: string) => failed.has(id);

async function extract(src: string): Promise<Float32Array | null> {
  const response = await fetch(src);
  if (!response.ok) return null;
  const encoded = await response.arrayBuffer();
  if (!encoded.byteLength) return null;
  const decoded = await new OfflineAudioContext(
    1,
    1,
    DECODE_RATE,
  ).decodeAudioData(encoded);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );
  if (!channels.length || !channels[0]!.length) return null;

  const frames = channels[0]!.length;
  const per = Math.max(1, Math.floor(frames / BUCKETS));
  const peaks = new Float32Array(BUCKETS);
  let loudest = 0;
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const start = bucket * per;
    const end = Math.min(frames, start + per);
    let peak = 0;
    for (let i = start; i < end; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i]!;
      const level = Math.abs(sum / channels.length);
      if (level > peak) peak = level;
    }
    peaks[bucket] = peak;
    if (peak > loudest) loudest = peak;
  }
  // Normalise so a quietly mastered track fills the bar like a loud one.
  const gain = loudest ? 1 / loudest : 1;
  for (let i = 0; i < BUCKETS; i++)
    peaks[i] = Math.max(FLOOR, peaks[i]! * gain);
  return peaks;
}

// Resolves null rather than throwing: a track we cannot decode should leave
// the bar in its resting state, not surface an error at the user.
export function peaksFor(id: string, src: string) {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(id);
  if (inflight) return inflight;
  const job = extract(src)
    .catch(() => null)
    .then((peaks) => {
      pending.delete(id);
      if (peaks) cache.set(id, peaks);
      else failed.add(id);
      return peaks;
    });
  pending.set(id, job);
  return job;
}
