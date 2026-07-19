// docdoc Electron main process.
//
// Architecture: single app, no external services. All data work runs
// in-process (src/api over better-sqlite3); heavy work (OCR, AI,
// scanning) is spawned as child processes by the services. The renderer
// is pure sandboxed UI talking through the preload bridge. App files
// and document bytes are served over the app:// scheme so the renderer
// runs on a proper secure origin (pdf.js workers, fetch, etc.).

import { app, BrowserWindow, ipcMain, protocol, net, shell, Notification,
         Tray, Menu } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

import { Api } from "./api/api";
import * as scanner from "./services/scanner";
import * as watcher from "./services/watcher";

// __dirname is dist/ after compilation; app assets live one level up
const APP_DIR = path.join(__dirname, "..");

let win: BrowserWindow | null = null;
let api: Api | null = null;
let dataRoot: string | null = null;
let tray: Tray | null = null;

declare global {
  // eslint-disable-next-line no-var
  var isQuitting: boolean | undefined;
}

// ---------------------------------------------------------------- api
async function call(method: string, params?: unknown): Promise<unknown> {
  if (!api) throw new Error("api not ready");
  const fn = (api as unknown as Record<string, unknown>)[method];
  if (typeof fn !== "function" || method.startsWith("_"))
    throw new Error(`unknown method '${method}'`);
  return (fn as (p: unknown) => unknown).call(api, params ?? {});
}

// Push {event:'changed'} to the renderer when any other connection
// commits to the DB (PRAGMA data_version changes on foreign commits --
// the watcher writes on its own connection, and external writers count
// too).
let lastDataVersion: number | null = null;
function startChangePoller(): void {
  setInterval(() => {
    try {
      const v = api!.con.pragma("data_version", { simple: true }) as number;
      if (lastDataVersion !== null && v !== lastDataVersion)
        sendEvent({ event: "changed" });
      lastDataVersion = v;
    } catch { /* db busy */ }
  }, 1000);
}

function sendEvent(msg: object): void {
  if (win && !win.isDestroyed()) win.webContents.send("docdoc-event", msg);
}

// ---------------------------------------------------------------- app://
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true,
                stream: true },
}]);

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveFile(absPath: string, mustBeUnder: string): Promise<Response> | Response {
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(path.resolve(mustBeUnder) + path.sep))
    return new Response("forbidden", { status: 403 });
  const type = MIME[path.extname(resolved).toLowerCase()]
    ?? "application/octet-stream";
  return net.fetch(pathToFileURL(resolved).toString()).then((r) =>
    new Response(r.body, { headers: { "Content-Type": type } }));
}

function registerProtocol(): void {
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    try {
      if (url.host === "ui") {
        if (parts[0] === "pdfjs")
          return serveFile(
            path.join(APP_DIR, "node_modules/pdfjs-dist/build",
                      ...parts.slice(1)),
            path.join(APP_DIR, "node_modules/pdfjs-dist"));
        return serveFile(path.join(APP_DIR, "renderer", ...parts),
                         path.join(APP_DIR, "renderer"));
      }
      if (url.host === "doc") {
        const doc = await call("get_document",
          { id: parseInt(parts[0], 10) }) as { pdf_abs: string | null };
        if (!doc.pdf_abs) return new Response("no pdf", { status: 404 });
        const r = await net.fetch(pathToFileURL(doc.pdf_abs).toString());
        return new Response(r.body, {
          headers: { "Content-Type": "application/pdf" } });
      }
      if (url.host === "thumb") {
        const id = String(parseInt(parts[0], 10)).padStart(5, "0");
        return serveFile(path.join(dataRoot!, "thumbs", `${id}.jpg`),
                         path.join(dataRoot!, "thumbs"));
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
}

// ---------------------------------------------------------------- window
async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: "#f5f6f8",
    title: "docdoc",
    icon: path.join(APP_DIR, "docdoc.png"),
    webPreferences: {
      preload: path.join(APP_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // close-to-tray: the app keeps scanning/processing with the window shut
  win.on("close", (e) => {
    if (!globalThis.isQuitting) {
      e.preventDefault();
      win!.hide();
    }
  });
  win.webContents.on("console-message",
    (_e, level, message, line, src) => {
      if (level >= 2)
        console.log(`[renderer:${level}] ${message} (${src}:${line})`);
    });
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    console.log(`[load-fail] ${code} ${desc} ${url}`));
  await win.loadURL("app://ui/index.html");
  if (process.env.DOCDOC_SHOT) {
    setTimeout(() => { void screenshot(); },
      parseInt(process.env.DOCDOC_SHOT_DELAY || "5000", 10));
  }
}

async function screenshot(): Promise<void> {
  if (!win) return;
  if (process.env.DOCDOC_JS) {
    await win.webContents.executeJavaScript(process.env.DOCDOC_JS);
    await new Promise((r) => setTimeout(r, 3500));
  }
  const img = await win.webContents.capturePage();
  fs.writeFileSync(process.env.DOCDOC_SHOT!, img.toPNG());
  console.log("screenshot:", process.env.DOCDOC_SHOT);
}

function setupTray(): void {
  tray = new Tray(path.join(APP_DIR, "docdoc.png"));
  tray.setToolTip("docdoc");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open docdoc", click: () => { void showWindow(); } },
    { label: "Scan now", click: () => {
        call("scan_now").catch((e: Error) =>
          new Notification({ title: "Scan failed", body: e.message }).show());
      } },
    { type: "separator" },
    { label: "Quit", click: () => { globalThis.isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => { void showWindow(); });
}

async function showWindow(): Promise<void> {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  else await createWindow();
}

/**
 * Start (hidden) at login so button-pushed scans are processed without
 * anyone opening the app -- the single-app replacement for systemd units.
 */
function setupAutostart(): void {
  const dir = path.join(os.homedir(), ".config", "autostart");
  const file = path.join(dir, "docdoc.desktop");
  const exec = `${process.execPath} ${APP_DIR} --hidden`;
  const content = `[Desktop Entry]
Type=Application
Name=docdoc
Comment=Document scanning and management
Exec=${exec}
Icon=${path.join(APP_DIR, "docdoc.png")}
X-GNOME-Autostart-enabled=true
`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf-8") !== content)
      fs.writeFileSync(file, content);
  } catch (e) {
    console.log(`autostart: ${(e as Error).message}`);
  }
}

ipcMain.handle("api", (_e, method: string, params: unknown) =>
  call(method, params));
ipcMain.handle("open-external", async (_e, id: number) => {
  const doc = await call("get_document", { id }) as { pdf_abs: string | null };
  if (doc.pdf_abs) void shell.openPath(doc.pdf_abs);
});
ipcMain.handle("open-folder", async (_e, id: number) => {
  const doc = await call("get_document", { id }) as { pdf_abs: string | null };
  if (doc.pdf_abs) shell.showItemInFolder(doc.pdf_abs);
});

// single instance: a second launch (autostart + manual, or a debug run)
// must never start a second watcher against the live DB -- it focuses
// the existing instance instead. app.quit() is asynchronous, so the
// whole startup is gated on holding the lock (a denied instance must
// not even create its tray icon).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => { void showWindow(); });
  void app.whenReady().then(async () => {
    registerProtocol();
    api = new Api();
    dataRoot = api.cfg.data_root;
    startChangePoller();
    setupTray();
    setupAutostart();
    watcher.start();
    if (!process.argv.includes("--hidden")) await createWindow();
    app.on("activate", () => { void showWindow(); });
  });
}

app.on("before-quit", () => {
  globalThis.isQuitting = true;
  scanner.stop();
  watcher.stop();
});
app.on("window-all-closed", () => {
  // stay alive in the tray; Quit lives in the tray menu
});
