// docdoc Electron main process.
//
// Architecture: all data work lives in the Python side (docdoc.server,
// spawned here as a child process speaking JSON-lines over stdio); the
// renderer is pure sandboxed UI talking through the preload bridge.
// App files and document bytes are served over the app:// scheme so the
// renderer runs on a proper secure origin (pdf.js workers, fetch, etc.).

const { app, BrowserWindow, ipcMain, protocol, net, shell, Notification } =
  require("electron");
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const { pathToFileURL } = require("url");

const REPO_ROOT = path.resolve(__dirname, "..");
const PYTHON = "/usr/bin/python3";

let win = null;
let server = null;
let dataRoot = null;
const pending = new Map();
let nextId = 1;

// ---------------------------------------------------------------- server
function startServer() {
  server = spawn(PYTHON, ["-m", "docdoc.server"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = readline.createInterface({ input: server.stdout });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
    } else if (msg.event) {
      if (win && !win.isDestroyed()) win.webContents.send("docdoc-event", msg);
    }
  });
  server.on("exit", (code) => {
    for (const { reject } of pending.values())
      reject(new Error("docdoc server exited"));
    pending.clear();
    if (!app.isQuitting) setTimeout(startServer, 2000);
  });
}

function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!server || server.exitCode !== null)
      return reject(new Error("docdoc server not running"));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    server.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 120000);
  });
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
  startServer();
  try {
    const cfg = await call("get_settings", {});
    dataRoot = cfg.data_root;
  } catch (e) {
    dataRoot = "/pool/docdoc";
  }
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => { app.isQuitting = true; });
app.on("window-all-closed", () => {
  app.quit();
  if (server) server.kill();
});
