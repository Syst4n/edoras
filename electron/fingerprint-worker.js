import { parentPort, workerData } from "node:worker_threads";
import { SignatureGenerator } from "shazam-api/dist/algorithm.js";
import { s16LEToSamplesArray } from "shazam-api";

// CPU work stays off the Electron main thread. Only this compact acoustic
// signature leaves the computer; PCM, filenames and paths never do.
try {
  const signature = new SignatureGenerator().getSignature(
    s16LEToSamplesArray(Buffer.from(workerData)),
  );
  parentPort.postMessage(
    signature
      ? {
          uri: signature.encodeToUri(),
          samplems: Math.round(
            (signature.numberSamples / signature.sampleRateHz) * 1000,
          ),
        }
      : null,
  );
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
