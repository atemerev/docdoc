// docdoc Electron main process.
//
// Architecture: single app, no external services. All data work runs
// in-process (lib/api.js over better-sqlite3); heavy work (OCR, AI,
// scanning) is spawned as child processes by the pipeline modules. The
// renderer is pure sandboxed UI talking through the preload bridge.
// App files and document bytes are served over the app:// scheme so the
// renderer runs on a proper secure origin (pdf.js workers, fetch, etc.).

const { app, BrowserWindow, ipcMain, protocol, net, shell, Notification,
        Tray, Menu } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { Api } = require("./lib/api");

let win = null;
let api = null;
let dataRoot = null;
let tray = null;

// ---------------------------------------------------------------- api
async function call(method, params) {
  if (!api) throw new Error("api not ready");
  const fn = api[method];
  if (typeof fn !== "function" || method.startsWith("_"))
    throw new Error(`unknown method '${method}'`);
  return fn.call(api, params || {});
}

// Push {event:'changed'} to the renderer when any process commits to the
// DB (PRAGMA data_version changes on foreign commits -- covers the legacy
// Python daemons during the migration and any external writers after).
let lastDataVersion = null;
function startChangePoller() {
  setInterval(() => {
    try {
      const v = api.con.pragma("data_version", { simple: true });
      if (lastDataVersion !== null && v !== lastDataVersion)
        sendEvent({ event: "changed" });
      lastDataVersion = v;
    } catch {}
  }, 1000);
}

function sendEvent(msg) {
  if (win && !win.isDestroyed()) win.webContents.send("docdoc-event", msg);
}

// ---------------------------------------------------------------- app://
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveFile(absPath, mustBeUnder) {
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(path.resolve(mustBeUnder) + path.sep))
    return new Response("forbidden", { status: 403 });
  const type = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
  return net.fetch(pathToFileURL(resolved).toString()).then((r) =>
    new Response(r.body, { headers: { "Content-Type": type } }));
}

function registerProtocol() {
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/+/, "").split("/");
    try {
      if (url.host === "ui") {
        if (parts[0] === "pdfjs")
          return serveFile(
            path.join(__dirname, "node_modules/pdfjs-dist/build", ...parts.slice(1)),
            path.join(__dirname, "node_modules/pdfjs-dist"));
        return serveFile(path.join(__dirname, "renderer", ...parts),
                         path.join(__dirname, "renderer"));
      }
      if (url.host === "doc") {
        const doc = await call("get_document", { id: parseInt(parts[0], 10) });
        if (!doc.pdf_abs) return new Response("no pdf", { status: 404 });
        const r = await net.fetch(pathToFileURL(doc.pdf_abs).toString());
        return new Response(r.body, {
          headers: { "Content-Type": "application/pdf" } });
      }
      if (url.host === "thumb") {
        const id = String(parseInt(parts[0], 10)).padStart(5, "0");
        return serveFile(path.join(dataRoot, "thumbs", `${id}.jpg`),
                         path.join(dataRoot, "thumbs"));
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
}

// ---------------------------------------------------------------- window
async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: "#f5f6f8",
    title: "docdoc",
    icon: path.join(__dirname, "docdoc.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // close-to-tray: the app keeps scanning/processing with the window shut
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on("console-message", (_e, level, message, line, src) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${src}:${line})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    console.log(`[load-fail] ${code} ${desc} ${url}`));
  await win.loadURL("app://ui/index.html");
  if (process.env.DOCDOC_SHOT) {
    setTimeout(async () => {
      if (process.env.DOCDOC_JS) {
        await win.webContents.executeJavaScript(process.env.DOCDOC_JS);
        await new Promise((r) => setTimeout(r, 3500));
      }
      const img = await win.webContents.capturePage();
      require("fs").writeFileSync(process.env.DOCDOC_SHOT, img.toPNG());
      console.log("screenshot:", process.env.DOCDOC_SHOT);
    }, parseInt(process.env.DOCDOC_SHOT_DELAY || "5000", 10));
  }
}

ipcMain.handle("api", (_e, method, params) => call(method, params));
ipcMain.handle("open-external", async (_e, id) => {
  const doc = await call("get_document", { id });
  if (doc.pdf_abs) shell.openPath(doc.pdf_abs);
});
ipcMain.handle("open-folder", async (_e, id) => {
  const doc = await call("get_document", { id });
  if (doc.pdf_abs) shell.showItemInFolder(doc.pdf_abs);
});

function setupTray() {
  tray = new Tray(path.join(__dirname, "docdoc.png"));
  tray.setToolTip("docdoc");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open docdoc", click: () => showWindow() },
    { label: "Scan now", click: () => call("scan_now").catch((e) =>
        new Notification({ title: "Scan failed", body: e.message }).show()) },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => showWindow());
}

async function showWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  else await createWindow();
}

function setupAutostart() {
  // start (hidden) at login so button-pushed scans are processed without
  // anyone opening the app -- the single-app replacement for systemd units
  const dir = path.join(os.homedir(), ".config", "autostart");
  const file = path.join(dir, "docdoc.desktop");
  const exec = `${process.execPath} ${__dirname} --hidden`;
  const content = `[Desktop Entry]
Type=Application
Name=docdoc
Comment=Document scanning and management
Exec=${exec}
Icon=${path.join(__dirname, "docdoc.png")}
X-GNOME-Autostart-enabled=true
`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf-8") !== content)
      fs.writeFileSync(file, content);
  } catch (e) {
    console.log(`autostart: ${e.message}`);
  }
}

app.whenReady().then(async () => {
  registerProtocol();
  api = new Api();
  dataRoot = api.cfg.data_root;
  startChangePoller();
  setupTray();
  setupAutostart();
  // in-app batch watcher -- unless the legacy Python daemon still runs
  // (migration safety: two watchers would double-process every batch)
  const legacy = await api._pgrep("python.*docdoc\\.watchd");
  if (legacy.length)
    console.log(`watcher: legacy docdocd running (pid ${legacy}), ` +
                "in-app watcher stays off");
  else
    require("./lib/watcher").start();
  if (!process.argv.includes("--hidden")) await createWindow();
  app.on("activate", () => showWindow());
});

app.on("before-quit", () => {
  app.isQuitting = true;
  require("./lib/scanner").stop();
  require("./lib/watcher").stop();
});
app.on("window-all-closed", () => {
  // stay alive in the tray; Quit lives in the tray menu
});
