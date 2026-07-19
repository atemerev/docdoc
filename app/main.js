// docdoc Electron main process.
//
// Architecture: single app, no external services. All data work runs
// in-process (lib/api.js over better-sqlite3); heavy work (OCR, AI,
// scanning) is spawned as child processes by the pipeline modules. The
// renderer is pure sandboxed UI talking through the preload bridge.
// App files and document bytes are served over the app:// scheme so the
// renderer runs on a proper secure origin (pdf.js workers, fetch, etc.).

const { app, BrowserWindow, ipcMain, protocol, net, shell, Notification } =
  require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const { Api } = require("./lib/api");

let win = null;
let api = null;
let dataRoot = null;

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

app.whenReady().then(async () => {
  registerProtocol();
  api = new Api();
  dataRoot = api.cfg.data_root;
  startChangePoller();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => { app.isQuitting = true; });
app.on("window-all-closed", () => {
  app.quit();
});
