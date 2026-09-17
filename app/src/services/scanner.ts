// Discovery and one scan only when requested by the foreground app.
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { checkAbort, run, trackChild, untrackChild } from "../infra/exec";

export async function discover(): Promise<Array<{ id: string; name: string }>> {
  const { stdout } = await run(
    "scanimage",
    ["--formatted-device-list=%d|%v %m%n"],
    { timeout: 20000 },
  );
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const at = line.indexOf("|");
      return { id: line.slice(0, at), name: line.slice(at + 1).trim() };
    });
}
export async function scan(
  dir: string,
  device?: string,
  onPage?: (n: number) => void,
): Promise<{ files: string[]; warning: string | null }> {
  const devices = await discover();
  checkAbort();
  if (device && !devices.some((d) => d.id === device))
    throw new Error(
      "The selected scanner is not connected. Check USB and power, then try again.",
    );
  if (!device && devices.length > 1)
    throw new Error(
      "More than one scanner is connected. Select one in Settings.",
    );
  const chosen = device || devices[0]?.id;
  if (!chosen)
    throw new Error(
      "No scanner detected. Check USB and power, then try again.",
    );
  fs.mkdirSync(dir, { recursive: true });
  const result = await new Promise<{ code: number | null; error: string }>(
    (resolve, reject) => {
      const child = spawn(
        "scanimage",
        [
          "-d",
          chosen,
          "--source",
          "ADF Duplex",
          "--mode",
          "Color",
          "--resolution",
          "300",
          "--format",
          "jpeg",
          "-x",
          "210",
          "-y",
          "297",
          `--batch=${path.join(dir, "page-%04d.jpg")}`,
        ],
        { stdio: ["ignore", "ignore", "pipe"], detached: true },
      );
      trackChild(child);
      let error = "";
      child.stderr.on("data", (data: Buffer) => {
        error = (error + data.toString()).slice(-8000);
        onPage?.(fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length);
      });
      child.once("error", (e) => {
        untrackChild(child);
        reject(e);
      });
      child.once("close", (code) => {
        untrackChild(child);
        resolve({ code, error });
      });
    },
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^page-\d+\.jpg$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  // SANE returns 7 at normal feeder exhaustion. Never restart after a jam/multifeed.
  const normal = result.code === 0 || result.code === 7;
  if (!files.length)
    throw new Error(
      normal
        ? "No pages scanned. Load the feeder and try again."
        : `Scan failed: ${result.error.slice(-600)}`,
    );
  return {
    files,
    warning: normal
      ? null
      : `Scan interrupted. Check for missing or damaged pages. ${result.error.slice(-400)}`,
  };
}
