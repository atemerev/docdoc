// Desktop notifications (notify-send; silently a no-op when absent).

import { execFile } from "child_process";

export function notify(summary: string, body = "", appName = "docdoc"): void {
  execFile("notify-send", ["-a", appName, summary, body], () => { /* best effort */ });
}
