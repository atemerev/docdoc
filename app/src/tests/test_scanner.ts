// Exercise the foreground scanner lifecycle without touching physical hardware.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import assert from "node:assert/strict";
import { Api } from "../api/api";
import { clearAbort, finishAbort, requestAbort, run } from "../infra/exec";
import * as scanner from "../services/scanner";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-scanner-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const originalPath = process.env.PATH,
    originalDb = process.env.DOCDOC_DB;
  // The fake SANE command emits one partial source, then waits for Stop.
  fs.writeFileSync(
    path.join(bin, "scanimage"),
    `#!/usr/bin/env python3
import sys,time,pathlib,os
if any(arg.startswith('--formatted-device-list') for arg in sys.argv):
 print('fake:usb|Test USB scanner')
 sys.exit(0)
pattern=next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--batch='))
pathlib.Path(pattern % 1).write_bytes(b'partial source, preserved on stop')
print('captured page',file=sys.stderr,flush=True)
time.sleep(60)
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.DOCDOC_DB = path.join(dir, "docdoc.db");
  const api = new Api();
  await api.initialize();
  try {
    const task = api.scan_now();
    await assert.rejects(api.scan_now(), /current operation/);
    for (let n = 0; n < 100 && !api.label.startsWith("Scanning"); n++)
      await new Promise((r) => setTimeout(r, 30));
    assert(api.busy);
    api.abort_scan();
    await task;
    await finishAbort();
    assert(!api.busy);
    assert.equal(api.status().processing, null);
    const groups = api.get_workbench();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].imports.length, 1);
    const key = (
      api.con.prepare("SELECT source_key FROM imports").get() as {
        source_key: string;
      }
    ).source_key;
    const stored = api.con
      .prepare("SELECT data FROM blobs JOIN assets USING(sha) WHERE key=?")
      .get(key) as { data: Buffer };
    assert.equal(stored.data.toString(), "partial source, preserved on stop");
    assert.equal(
      (
        api.con.prepare("SELECT COUNT(*) n FROM documents").get() as {
          n: number;
        }
      ).n,
      0,
    );
    assert.equal(groups[0].target_id, null);
    assert.equal(groups[0].phase, "pages");
    assert(groups[0].needs_preparation);
    clearAbort();
    await assert.rejects(api.prepare_group({ id: groups[0].id }), /failed/);
    assert.deepEqual(
      api.status(),
      { busy: false, label: "Ready", processing: null, background: null, queue_version: api.queue.version },
      "a failed preparation clears progress and unlocks the app",
    );
    fs.writeFileSync(path.join(bin, "scanimage"), "#!/bin/sh\nexit 127\n", {
      mode: 0o755,
    });
    await assert.rejects(scanner.discover(), /failed/);
    console.log(
      "Concurrent scans rejected; Stop preserves source bytes and leaves a retryable import.",
    );
  } finally {
    await api.shutdown();
    process.env.PATH = originalPath;
    if (originalDb) process.env.DOCDOC_DB = originalDb;
    else delete process.env.DOCDOC_DB;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearAbort();
  const long = run("sh", ["-c", "sleep 60 & wait"]);
  await new Promise((r) => setTimeout(r, 100));
  requestAbort();
  await assert.rejects(long);
  await finishAbort();
  clearAbort();
  console.log("Native process-group cancellation completed.");
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
