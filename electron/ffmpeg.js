import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// FFmpeg is a separate executable, shipped beside the packaged application.
const packaged = process.resourcesPath && path.join(process.resourcesPath, "ffmpeg.exe");
const development = fileURLToPath(new URL("../node_modules/ffmpeg-static/ffmpeg.exe", import.meta.url));

export default packaged && fs.existsSync(packaged) ? packaged : development;
