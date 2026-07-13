// Shells out to scripts/face_count.py (OpenCV Haar cascade) the same way
// job_search shells out to the Typst binary for CV rendering — native tool
// via subprocess rather than a heavyweight JS ML dependency, which matters
// on a Pi with no GPU.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "face_count.py");

export async function countFaces(imagePath) {
  try {
    const { stdout } = await execFileAsync("python3", [SCRIPT, imagePath], { timeout: 15_000 });
    const { faces, avg_face_area_ratio } = JSON.parse(stdout);
    return { faceCount: faces, avgFaceAreaRatio: avg_face_area_ratio };
  } catch {
    // Face detection is a nice-to-have signal, not a hard requirement —
    // degrade gracefully so a single bad frame doesn't fail the whole job.
    return { faceCount: 0, avgFaceAreaRatio: 0 };
  }
}
