// Child-process execution with a global abort registry.
//
// requestAbort() sets the flag consulted between pipeline stages and
// kills every tracked child (ocrmypdf, claude, scanimage, ...) so the
// running stage ends promptly. The watcher turns BatchAborted into
// deletion of the in-flight documents.

import { execFile, type ChildProcess } from "child_process";

export class BatchAborted extends Error {}

let ABORT = false;
const children = new Set<ChildProcess>();

export function requestAbort(): void {
  ABORT = true;
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

export const aborted = (): boolean => ABORT;
export const clearAbort = (): void => { ABORT = false; };
export function checkAbort(): void {
  if (ABORT) throw new BatchAborted();
}
export const trackChild = (c: ChildProcess): void => { children.add(c); };
export const untrackChild = (c: ChildProcess): void => { children.delete(c); };

export class CliError extends Error {}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run a CLI tool, tracked for abort. Rejects with CliError on non-zero. */
export function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args,
      { maxBuffer: 64 << 20, ...opts },
      (err, stdout, stderr) => {
        untrackChild(child);
        if (err)
          reject(new CliError(
            `${cmd} failed (${err.code ?? (err as { signal?: string }).signal}): `
            + String(stderr || err.message).trim().slice(-800)));
        else resolve({ stdout, stderr });
      });
    trackChild(child);
  });
}

/** Like run(), but with binary stdout and optional stdin payload. */
export function runBinary(
  cmd: string,
  args: string[],
  opts: { input?: string | Buffer; okCodes?: number[] } = {},
): Promise<Buffer> {
  const { spawn } = require("child_process") as typeof import("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    trackChild(child);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (e) => { untrackChild(child); reject(e); });
    child.on("close", (code) => {
      untrackChild(child);
      if (code === 0 || (opts.okCodes ?? []).includes(code ?? -1))
        resolve(Buffer.concat(chunks));
      else reject(new CliError(`${cmd} exited ${code}`));
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
