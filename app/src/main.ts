// One visible Electron window owns all work. Closing it cancels children and exits.
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  shell,
  dialog,
} from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { Api } from "./api/api";
import * as storage from "./infra/storage";

const APP_DIR = path.join(__dirname, "..");
let win: BrowserWindow | null = null,
  api: Api | null = null,
  closing = false;
const exportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-exports-"));
if (process.env.DOCDOC_DB)
  app.setPath(
    "userData",
    path.join(path.dirname(process.env.DOCDOC_DB), "electron-profile"),
  );
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
protocol.registerSchemesAsPrivileged([
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
function send(): void {
  if (win && !win.isDestroyed())
    win.webContents.send("docdoc-event", {
      event: "status",
      status: api?.status(),
    });
}
function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (
    event.sender !== win?.webContents ||
    !event.senderFrame?.url.startsWith("app://ui/")
  )
    throw new Error("Untrusted request.");
}
ipcMain.handle("api", async (event, method: string, params: unknown) => {
  if (closing) return null;
  trusted(event);
  if (!api) throw new Error("App is starting.");
  if (
    !readMethods.has(method) &&
    !writeMethods.has(method) &&
    method !== "abort_scan"
  )
    throw new Error("Unknown method.");
  // Draft metadata is a synchronous SQLite edit; it can safely coexist with
  // scanner acquisition and queue processing without taking either job's lock.
  if (writeMethods.has(method) && !["update_group_metadata", "rename_group"].includes(method)) api.assertIdle();
  try {
    return await (api as unknown as Record<string, (p: unknown) => unknown>)[
      method
    ].call(api, params ?? {});
  } finally {
    if (writeMethods.has(method) || method === "abort_scan") send();
  }
});
ipcMain.handle("import-files", async (event, options = {}) => {
  trusted(event);
  api!.assertIdle();
  const result = await dialog.showOpenDialog(win!, {
    title: "Import pages",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Documents and images",
        extensions: ["pdf", "jpg", "jpeg", "png", "tif", "tiff", "pnm"],
      },
    ],
  });
  if (result.canceled) return null;
  return api!.import_files(result.filePaths, options);
});
ipcMain.handle("backup", async (event) => {
  trusted(event);
  api!.assertIdle();
  const result = await dialog.showSaveDialog(win!, {
    title: "Back up docdoc",
    defaultPath: path.join(
      os.homedir(),
      `docdoc-${new Date().toISOString().slice(0, 10)}.db`,
    ),
    filters: [{ name: "SQLite database", extensions: ["db"] }],
  });
  if (result.canceled || !result.filePath) return null;
  await api!.backup_database(result.filePath);
  return result.filePath;
});
ipcMain.handle("export-pdf", async (event, id: number) => {
  trusted(event);
  api!.assertIdle();
  const result = await dialog.showSaveDialog(win!, {
    title: "Save PDF as",
    defaultPath: `document-${id}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!result.canceled && result.filePath)
    await api!.export_pdf({ kind: "document", id }, result.filePath);
  return result.filePath || null;
});
ipcMain.handle("open-external", async (event, id: number) => {
  trusted(event);
  const data = storage.get(api!.con, storage.docKey(id));
  if (!data) throw new Error("PDF not found.");
  const file = path.join(exportsDir, `document-${id}.pdf`);
  fs.writeFileSync(file, data.data);
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
});
function registerProtocol(): void {
  protocol.handle("app", async (req) => {
    const url = new URL(req.url),
      parts = url.pathname.replace(/^\/+/, "").split("/");
    try {
      if (url.host === "ui") {
        const root =
          parts[0] === "pdfjs"
            ? path.join(APP_DIR, "node_modules/pdfjs-dist/build")
            : path.join(APP_DIR, "renderer");
        const file = path.resolve(
          root,
          ...(parts[0] === "pdfjs" ? parts.slice(1) : parts),
        );
        if (!file.startsWith(root + path.sep))
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(file).toString());
      }
      const id = Number(parts[0]);
      if (!Number.isSafeInteger(id) || id < 1)
        return new Response("Not found", { status: 404 });
      const key =
        url.host === "doc"
          ? storage.docKey(id)
          : url.host === "thumb"
            ? storage.docKey(id, "thumb")
            : url.host === "page"
              ? storage.pageKey(id, parts[1] === "thumb" ? "thumb" : "pdf")
              : null;
      const asset = key && api ? storage.get(api.con, key) : null;
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(asset.data), {
        headers: { "Content-Type": asset.mime, "Cache-Control": "no-store" },
      });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
}
async function quit(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await api?.shutdown();
  } finally {
    fs.rmSync(exportsDir, { recursive: true, force: true });
    win?.destroy();
    app.quit();
  }
}
if (!app.requestSingleInstanceLock()) {
  fs.rmSync(exportsDir, { recursive: true, force: true });
  app.exit(0);
} else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  void app.whenReady().then(async () => {
    try {
      api = new Api();
      await api.initialize();
      api.onStatus = send;
      // Remove only the obsolete autostart entry owned by this application.
      if (!process.env.DOCDOC_DB) {
        const startup = path.join(
          os.homedir(),
          ".config/autostart/docdoc.desktop",
        );
        if (
          fs.existsSync(startup) &&
          fs.readFileSync(startup, "utf8").includes(APP_DIR)
        )
          fs.unlinkSync(startup);
      }
      registerProtocol();
      win = new BrowserWindow({
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
        if (level >= 2) console.error(`renderer: ${message}`);
      });
      await win.loadURL("app://ui/index.html");
      if (process.env.DOCDOC_SHOT)
        setTimeout(
          async () => {
            if (process.env.DOCDOC_JS)
              await win!.webContents.executeJavaScript(process.env.DOCDOC_JS);
            fs.writeFileSync(
              process.env.DOCDOC_SHOT!,
              (await win!.webContents.capturePage()).toPNG(),
            );
            if (process.env.DOCDOC_EXIT_AFTER_SHOT) void quit();
          },
          Number(process.env.DOCDOC_SHOT_DELAY || 2000),
        );
    } catch (e) {
      console.error(e);
      dialog.showErrorBox("docdoc could not open", String(e));
      app.exit(1);
    }
  });
}
app.on("before-quit", (event) => {
  if (!closing && api) {
    event.preventDefault();
    void quit();
  }
});
app.on("window-all-closed", () => {
  if (!closing) void quit();
});
