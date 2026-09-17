"use strict";
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
// One visible Electron window owns all work. Closing it cancels children and exits.
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const url_1 = require("url");
const api_1 = require("./api/api");
const storage = __importStar(require("./infra/storage"));
const APP_DIR = path.join(__dirname, "..");
let win = null, api = null, closing = false;
const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-exports-"));
if (process.env.DOCDOC_DB)
    electron_1.app.setPath("userData", path.join(path.dirname(process.env.DOCDOC_DB), "electron-profile"));
const readMethods = new Set([
    "get_workbench",
    "get_document",
    "document_sources",
    "list_documents",
    "library_groups",
    "search",
    "list_invoices",
    "list_senders",
    "list_bank_accounts",
    "list_events",
    "stats",
    "get_settings",
    "list_metadata_models",
    "years",
    "status",
    "metadata_history",
    "metadata_as_of",
    "storage_info",
    "timeline",
]);
const writeMethods = new Set([
    "render_qr",
    "new_group",
    "rename_group",
    "update_group_metadata",
    "refresh_document_metadata",
    "remove_empty_group",
    "edit_page",
    "reorder_pages",
    "read_group",
    "enqueue_group",
    "prepare_group",
    "edit_group_pages",
    "recognize_group_details",
    "file_group",
    "reopen_document",
    "recover_source",
    "scan_now",
    "discover_scanners",
    "update_document",
    "trash_document",
    "invoice_paid",
    "invoice_do_not_pay",
    "invoice_reopen",
    "save_bank_account",
    "delete_bank_account",
    "set_settings",
    "delete_review",
]);
electron_1.protocol.registerSchemesAsPrivileged([
    {
        scheme: "app",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
        },
    },
]);
function send() {
    if (win && !win.isDestroyed())
        win.webContents.send("docdoc-event", {
            event: "status",
            status: api?.status(),
        });
}
function trusted(event) {
    if (event.sender !== win?.webContents ||
        !event.senderFrame?.url.startsWith("app://ui/"))
        throw new Error("Untrusted request.");
}
electron_1.ipcMain.handle("api", async (event, method, params) => {
    if (closing)
        return null;
    trusted(event);
    if (!api)
        throw new Error("App is starting.");
    if (!readMethods.has(method) &&
        !writeMethods.has(method) &&
        method !== "abort_scan")
        throw new Error("Unknown method.");
    // Draft metadata is a synchronous SQLite edit; it can safely coexist with
    // scanner acquisition and queue processing without taking either job's lock.
    if (writeMethods.has(method) && !["update_group_metadata", "rename_group"].includes(method))
        api.assertIdle();
    try {
        return await api[method].call(api, params ?? {});
    }
    finally {
        if (writeMethods.has(method) || method === "abort_scan")
            send();
    }
});
electron_1.ipcMain.handle("import-files", async (event, options = {}) => {
    trusted(event);
    api.assertIdle();
    const result = await electron_1.dialog.showOpenDialog(win, {
        title: "Import pages",
        properties: ["openFile", "multiSelections"],
        filters: [
            {
                name: "Documents and images",
                extensions: ["pdf", "jpg", "jpeg", "png", "tif", "tiff", "pnm"],
            },
        ],
    });
    if (result.canceled)
        return null;
    return api.import_files(result.filePaths, options);
});
electron_1.ipcMain.handle("backup", async (event) => {
    trusted(event);
    api.assertIdle();
    const result = await electron_1.dialog.showSaveDialog(win, {
        title: "Back up docdoc",
        defaultPath: path.join(os.homedir(), `docdoc-${new Date().toISOString().slice(0, 10)}.db`),
        filters: [{ name: "SQLite database", extensions: ["db"] }],
    });
    if (result.canceled || !result.filePath)
        return null;
    await api.backup_database(result.filePath);
    return result.filePath;
});
electron_1.ipcMain.handle("export-pdf", async (event, id) => {
    trusted(event);
    api.assertIdle();
    const result = await electron_1.dialog.showSaveDialog(win, {
        title: "Save PDF as",
        defaultPath: `document-${id}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!result.canceled && result.filePath)
        await api.export_pdf({ kind: "document", id }, result.filePath);
    return result.filePath || null;
});
electron_1.ipcMain.handle("open-external", async (event, id) => {
    trusted(event);
    const data = storage.get(api.con, storage.docKey(id));
    if (!data)
        throw new Error("PDF not found.");
    const file = path.join(exportsDir, `document-${id}.pdf`);
    fs.writeFileSync(file, data.data);
    const error = await electron_1.shell.openPath(file);
    if (error)
        throw new Error(error);
});
function registerProtocol() {
    electron_1.protocol.handle("app", async (req) => {
        const url = new URL(req.url), parts = url.pathname.replace(/^\/+/, "").split("/");
        try {
            if (url.host === "ui") {
                const root = parts[0] === "pdfjs"
                    ? path.join(APP_DIR, "node_modules/pdfjs-dist/build")
                    : path.join(APP_DIR, "renderer");
                const file = path.resolve(root, ...(parts[0] === "pdfjs" ? parts.slice(1) : parts));
                if (!file.startsWith(root + path.sep))
                    return new Response("Forbidden", { status: 403 });
                return electron_1.net.fetch((0, url_1.pathToFileURL)(file).toString());
            }
            const id = Number(parts[0]);
            if (!Number.isSafeInteger(id) || id < 1)
                return new Response("Not found", { status: 404 });
            const key = url.host === "doc"
                ? storage.docKey(id)
                : url.host === "thumb"
                    ? storage.docKey(id, "thumb")
                    : url.host === "page"
                        ? storage.pageKey(id, parts[1] === "thumb" ? "thumb" : "pdf")
                        : null;
            const asset = key && api ? storage.get(api.con, key) : null;
            if (!asset)
                return new Response("Not found", { status: 404 });
            return new Response(new Uint8Array(asset.data), {
                headers: { "Content-Type": asset.mime, "Cache-Control": "no-store" },
            });
        }
        catch (e) {
            return new Response(String(e), { status: 500 });
        }
    });
}
async function quit() {
    if (closing)
        return;
    closing = true;
    try {
        await api?.shutdown();
    }
    finally {
        fs.rmSync(exportsDir, { recursive: true, force: true });
        win?.destroy();
        electron_1.app.quit();
    }
}
if (!electron_1.app.requestSingleInstanceLock()) {
    fs.rmSync(exportsDir, { recursive: true, force: true });
    electron_1.app.exit(0);
}
else {
    electron_1.app.on("second-instance", () => {
        win?.show();
        win?.focus();
    });
    void electron_1.app.whenReady().then(async () => {
        try {
            api = new api_1.Api();
            await api.initialize();
            api.onStatus = send;
            // Remove only the obsolete autostart entry owned by this application.
            if (!process.env.DOCDOC_DB) {
                const startup = path.join(os.homedir(), ".config/autostart/docdoc.desktop");
                if (fs.existsSync(startup) &&
                    fs.readFileSync(startup, "utf8").includes(APP_DIR))
                    fs.unlinkSync(startup);
            }
            registerProtocol();
            win = new electron_1.BrowserWindow({
                width: 1280,
                height: 900,
                minWidth: 850,
                minHeight: 620,
                title: "docdoc",
                backgroundColor: "#f8f8f6",
                webPreferences: {
                    preload: path.join(APP_DIR, "preload.js"),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            });
            win.setMenuBarVisibility(false);
            win.on("close", (event) => {
                if (!closing) {
                    event.preventDefault();
                    void quit();
                }
            });
            win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            win.webContents.on("will-navigate", (event) => event.preventDefault());
            win.webContents.on("console-message", (_e, level, message) => {
                if (level >= 2)
                    console.error(`renderer: ${message}`);
            });
            await win.loadURL("app://ui/index.html");
            if (process.env.DOCDOC_SHOT)
                setTimeout(async () => {
                    if (process.env.DOCDOC_JS)
                        await win.webContents.executeJavaScript(process.env.DOCDOC_JS);
                    fs.writeFileSync(process.env.DOCDOC_SHOT, (await win.webContents.capturePage()).toPNG());
                    if (process.env.DOCDOC_EXIT_AFTER_SHOT)
                        void quit();
                }, Number(process.env.DOCDOC_SHOT_DELAY || 2000));
        }
        catch (e) {
            console.error(e);
            electron_1.dialog.showErrorBox("docdoc could not open", String(e));
            electron_1.app.exit(1);
        }
    });
}
electron_1.app.on("before-quit", (event) => {
    if (!closing && api) {
        event.preventDefault();
        void quit();
    }
});
electron_1.app.on("window-all-closed", () => {
    if (!closing)
        void quit();
});
