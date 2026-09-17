// Independent foreground and queue jobs own their cancellation and children.
import { AsyncLocalStorage } from "async_hooks";
import { spawn, type ChildProcess } from "child_process";
export class BatchAborted extends Error {}
export class CliError extends Error {}
export class ExecutionScope {
  aborted = false;
  children = new Set<ChildProcess>();
  requests = new Set<AbortController>();
  termination = new Set<Promise<void>>();
}
const contexts = new AsyncLocalStorage<ExecutionScope>();
const fallback = new ExecutionScope();
const current = (): ExecutionScope => contexts.getStore() || fallback;
export const inScope = <T>(scope: ExecutionScope, action: () => T): T => contexts.run(scope, action);
export const trackRequest = (controller: AbortController): void => { current().requests.add(controller); };
export const untrackRequest = (controller: AbortController): void => { current().requests.delete(controller); };
function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
export function requestAbort(scope = current()): void {
  scope.aborted = true;
  for (const request of scope.requests) request.abort();
  for (const child of scope.children) {
    terminate(child, "SIGTERM");
    const pending = new Promise<void>((resolve) =>
      setTimeout(() => {
        if (scope.children.has(child)) terminate(child, "SIGKILL");
        resolve();
      }, 2000),
    );
    scope.termination.add(pending);
    void pending.finally(() => scope.termination.delete(pending));
  }
}
export const finishAbort = async (scope = current()): Promise<void> => {
  await Promise.all(scope.termination);
};
export const aborted = (): boolean => current().aborted;
export const clearAbort = (): void => {
  current().aborted = false;
};
export function checkAbort(): void {
  if (current().aborted)
    throw new BatchAborted("Operation stopped; captured sources are kept.");
}
export const trackChild = (child: ChildProcess): void => {
  current().children.add(child);
};
export const untrackChild = (child: ChildProcess): void => {
  current().children.delete(child);
};
export interface RunResult {
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
    cwd?: string;
    input?: string;
    onStdout?: (chunk: string) => void;
  } = {},
): Promise<RunResult> {
  checkAbort();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(child);
    child.stdin.on("error", () => {
      /* child may stop before consuming input */
    });
    child.stdin.end(opts.input);
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let size = 0,
      failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new CliError(`${cmd} timed out`);
      terminate(child, "SIGKILL");
    }, opts.timeout || 600000);
    const collect = (list: Buffer[], data: Buffer) => {
      size += data.length;
      if (size > (opts.maxBuffer ?? 64 << 20)) {
        failure = new CliError(`${cmd} produced too much output`);
        terminate(child, "SIGKILL");
      } else list.push(data);
    };
    child.stdout.on("data", (data: Buffer) => {
      collect(out, data);
      opts.onStdout?.(data.toString());
    });
    child.stderr.on("data", (data: Buffer) => collect(err, data));
    child.once("error", (error) => {
      clearTimeout(timer);
      untrackChild(child);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      untrackChild(child);
      const stderr = Buffer.concat(err).toString();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new CliError(`${cmd} failed (${code}): ${stderr.trim().slice(-800)}`),
        );
      else resolve({ stdout: Buffer.concat(out).toString(), stderr });
    });
  });
}
export function runBinary(
  cmd: string,
  args: string[],
  opts: { input?: string | Buffer; okCodes?: number[] } = {},
): Promise<Buffer> {
  checkAbort();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    trackChild(child);
    const out: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => terminate(child, "SIGKILL"), 120000);
    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-1000);
    });
    child.stdin.on("error", () => {
      /* child may finish before consuming stdin */
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      untrackChild(child);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      untrackChild(child);
      if (code === 0 || (opts.okCodes || []).includes(code ?? -1))
        resolve(Buffer.concat(out));
      else reject(new CliError(`${cmd} exited ${code}: ${stderr}`));
    });
    child.stdin.end(opts.input);
  });
}
