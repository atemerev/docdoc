"use strict";
// docdoc Electron main process.
//
// Architecture: single app, no external services. All data work runs
// in-process (src/api over better-sqlite3); heavy work (OCR, AI,
// scanning) is spawned as child processes by the services. The renderer
// is pure sandboxed UI talking through the preload bridge. App files
// and document bytes are served over the app:// scheme so the renderer
// runs on a proper secure origin (pdf.js workers, fetch, etc.).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const url_1 = require("url");
const api_1 = require("./api/api");
const scanner = __importStar(require("./services/scanner"));
const watcher = __importStar(require("./services/watcher"));
// __dirname is dist/ after compilation; app assets live one level up
const APP_DIR = path.join(__dirname, "..");
let win = null;
let api = null;
let dataRoot = null;
let tray = null;
// ---------------------------------------------------------------- api
async function call(method, params) {
    if (!api)
        throw new Error("api not ready");
    const fn = api[method];
    if (typeof fn !== "function" || method.startsWith("_"))
        throw new Error(`unknown method '${method}'`);
    return fn.call(api, params ?? {});
}
// Push {event:'changed'} to the renderer when any other connection
// commits to the DB (PRAGMA data_version changes on foreign commits --
// the watcher writes on its own connection, and external writers count
// too).
let lastDataVersion = null;
function startChangePoller() {
    setInterval(() => {
        try {
            const v = api.con.pragma("data_version", { simple: true });
            if (lastDataVersion !== null && v !== lastDataVersion)
                sendEvent({ event: "changed" });
            lastDataVersion = v;
        }
        catch { /* db busy */ }
    }, 1000);
}
function sendEvent(msg) {
    if (win && !win.isDestroyed())
        win.webContents.send("docdoc-event", msg);
}
// ---------------------------------------------------------------- app://
electron_1.protocol.registerSchemesAsPrivileged([{
        scheme: "app",
        privileges: { standard: true, secure: true, supportFetchAPI: true,
            stream: true },
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
    const type = MIME[path.extname(resolved).toLowerCase()]
        ?? "application/octet-stream";
    return electron_1.net.fetch((0, url_1.pathToFileURL)(resolved).toString()).then((r) => new Response(r.body, { headers: { "Content-Type": type } }));
}
function registerProtocol() {
    electron_1.protocol.handle("app", async (req) => {
        const url = new URL(req.url);
        const parts = url.pathname.replace(/^\/+/, "").split("/");
        try {
            if (url.host === "ui") {
                if (parts[0] === "pdfjs")
                    return serveFile(path.join(APP_DIR, "node_modules/pdfjs-dist/build", ...parts.slice(1)), path.join(APP_DIR, "node_modules/pdfjs-dist"));
                return serveFile(path.join(APP_DIR, "renderer", ...parts), path.join(APP_DIR, "renderer"));
            }
            if (url.host === "doc") {
                const doc = await call("get_document", { id: parseInt(parts[0], 10) });
                if (!doc.pdf_abs)
                    return new Response("no pdf", { status: 404 });
                const r = await electron_1.net.fetch((0, url_1.pathToFileURL)(doc.pdf_abs).toString());
                return new Response(r.body, {
                    headers: { "Content-Type": "application/pdf" }
                });
            }
            if (url.host === "thumb") {
                const id = String(parseInt(parts[0], 10)).padStart(5, "0");
                return serveFile(path.join(dataRoot, "thumbs", `${id}.jpg`), path.join(dataRoot, "thumbs"));
            }
            return new Response("not found", { status: 404 });
        }
        catch (e) {
            return new Response(String(e), { status: 500 });
        }
    });
}
// ---------------------------------------------------------------- window
async function createWindow() {
    win = new electron_1.BrowserWindow({
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
            win.hide();
        }
    });
    win.webContents.on("console-message", (_e, level, message, line, src) => {
        if (level >= 2)
            console.log(`[renderer:${level}] ${message} (${src}:${line})`);
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => console.log(`[load-fail] ${code} ${desc} ${url}`));
    await win.loadURL("app://ui/index.html");
    if (process.env.DOCDOC_SHOT) {
        setTimeout(() => { void screenshot(); }, parseInt(process.env.DOCDOC_SHOT_DELAY || "5000", 10));
    }
}
async function screenshot() {
    if (!win)
        return;
    if (process.env.DOCDOC_JS) {
        await win.webContents.executeJavaScript(process.env.DOCDOC_JS);
        await new Promise((r) => setTimeout(r, 3500));
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.DOCDOC_SHOT, img.toPNG());
    console.log("screenshot:", process.env.DOCDOC_SHOT);
}
function setupTray() {
    tray = new electron_1.Tray(path.join(APP_DIR, "docdoc.png"));
    tray.setToolTip("docdoc");
    tray.setContextMenu(electron_1.Menu.buildFromTemplate([
        { label: "Open docdoc", click: () => { void showWindow(); } },
        { label: "Scan now", click: () => {
                call("scan_now").catch((e) => new electron_1.Notification({ title: "Scan failed", body: e.message }).show());
            } },
        { type: "separator" },
        { label: "Quit", click: () => { globalThis.isQuitting = true; electron_1.app.quit(); } },
    ]));
    tray.on("click", () => { void showWindow(); });
}
async function showWindow() {
    if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
    }
    else
        await createWindow();
}
/**
 * Start (hidden) at login so button-pushed scans are processed without
 * anyone opening the app -- the single-app replacement for systemd units.
 */
function setupAutostart() {
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
    }
    catch (e) {
        console.log(`autostart: ${e.message}`);
    }
}
electron_1.ipcMain.handle("api", (_e, method, params) => call(method, params));
electron_1.ipcMain.handle("open-external", async (_e, id) => {
    const doc = await call("get_document", { id });
    if (doc.pdf_abs)
        void electron_1.shell.openPath(doc.pdf_abs);
});
electron_1.ipcMain.handle("open-folder", async (_e, id) => {
    const doc = await call("get_document", { id });
    if (doc.pdf_abs)
        electron_1.shell.showItemInFolder(doc.pdf_abs);
});
// single instance: a second launch (autostart + manual, or a debug run)
// must never start a second watcher against the live DB -- it focuses
// the existing instance instead
if (!electron_1.app.requestSingleInstanceLock()) {
    electron_1.app.quit();
}
electron_1.app.on("second-instance", () => { void showWindow(); });
void electron_1.app.whenReady().then(async () => {
    registerProtocol();
    api = new api_1.Api();
    dataRoot = api.cfg.data_root;
    startChangePoller();
    setupTray();
    setupAutostart();
    watcher.start();
    if (!process.argv.includes("--hidden"))
        await createWindow();
    electron_1.app.on("activate", () => { void showWindow(); });
});
electron_1.app.on("before-quit", () => {
    globalThis.isQuitting = true;
    scanner.stop();
    watcher.stop();
});
electron_1.app.on("window-all-closed", () => {
    // stay alive in the tray; Quit lives in the tray menu
});
