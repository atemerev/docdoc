// docdoc renderer -- vanilla-TS SPA over the preload bridge.

import * as pdfjsLib from "./pdfjs/pdf.mjs";
import { api, bridge, type BankAccountVM, type DetailVM, type DocRowVM,
         type EventVM, type InvoiceVM, type SenderVM, type SettingsVM,
         type StatsVM, type StatusVM } from "./bridge";
import { $, $$, esc, fmtAmount, fmtDate, ibanCompact, ibanGroup, ibanValid,
         isQrIban, nextWorkingDay } from "./format";

pdfjsLib.GlobalWorkerOptions.workerSrc = "app://ui/pdfjs/pdf.worker.mjs";

interface State {
  view: string;
  filters: { doc_type: string; sender_id: string; year: string };
  invoiceFilter: string;
  searchQ: string;
  detailId: number | null;
  detailPending: string | null;
  pdfToken: number;
}

const state: State = {
  view: "inbox",
  filters: { doc_type: "", sender_id: "", year: "" },
  invoiceFilter: "unpaid",
  searchQ: "",
  detailId: null,
  detailPending: null,
  pdfToken: 0,
};

// ------------------------------------------------------------------ nav
$$("#sidebar .nav").forEach((b) =>
  b.addEventListener("click", () => show(b.dataset.view!)));

function show(view: string): void {
  state.view = view;
  $$("#sidebar .nav").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view));
  void render();
}

// ------------------------------------------------------------------ scan button
$("#scan-btn").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#scan-btn");
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; }, 2000);
  scanError = null;
  try {
    await api("scan_now");
    scanRequestedAt = Date.now();
  } catch (e) {
    scanError = {
      msg: (e as Error).message
        .replace(/^Error invoking remote method '[^']*': (Error: )?/, ""),
      at: Date.now(),
    };
  }
  void pollStatus();
});

// ------------------------------------------------------------------ search
let searchTimer: ReturnType<typeof setTimeout> | null = null;
$<HTMLInputElement>("#search").addEventListener("input", (e) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.searchQ = (e.target as HTMLInputElement).value.trim();
    if (state.searchQ && state.view !== "documents") show("documents");
    else void render();
  }, 180);
});

// ------------------------------------------------------------------ live updates
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
bridge().onEvent((msg) => {
  if (msg.event === "changed") {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void refreshCounts();
      void render();
      if (state.detailId) void openDetail(state.detailId, { keepPdf: true });
    }, 400);
  }
});

async function refreshCounts(): Promise<void> {
  try {
    const s = await api<StatsVM>("stats");
    $("#count-inbox").textContent = s.inbox ? String(s.inbox) : "";
    $("#count-docs").textContent = s.documents ? String(s.documents) : "";
    $("#count-unpaid").textContent = s.unpaid_count ? String(s.unpaid_count) : "";
    $("#sb-stats").innerHTML =
      `<b>${s.documents}</b> document${s.documents === 1 ? "" : "s"}` +
      ` · <b>${s.inbox}</b> in inbox` +
      ` · <b>${s.unpaid_count}</b> unpaid invoice${s.unpaid_count === 1 ? "" : "s"}` +
      (s.unpaid_count ? ` (${fmtAmount(s.unpaid_total)})` : "") +
      (s.overdue ? ` · <span class="sb-bad"><b>${s.overdue}</b> overdue</span>` : "");
  } catch { /* transient */ }
}

// ------------------------------------------------------------------ views
async function render(): Promise<void> {
  const c = $("#content");
  try {
    if (state.view === "inbox") await renderInbox(c);
    else if (state.view === "documents") await renderDocuments(c);
    else if (state.view === "invoices") await renderInvoices(c);
    else if (state.view === "senders") await renderSenders(c);
    else if (state.view === "accounts") await renderAccounts(c);
    else if (state.view === "activity") await renderActivity(c);
    else if (state.view === "settings") await renderSettings(c);
  } catch (e) {
    c.innerHTML = `<div class="error-banner">${esc((e as Error).message)}</div>`;
  }
}

function docRow(d: DocRowVM, { snippet = false } = {}): string {
  const chips: string[] = [];
  if (!d.reviewed) chips.push(`<span class="chip new">new</span>`);
  if (d.pending === "queued")
    chips.push(`<span class="chip processing">reading…</span>`);
  else if (d.pending === "error")
    chips.push(`<span class="chip procfail">processing failed</span>`);
  if (d.doc_type)
    chips.push(`<span class="chip type-${esc(d.doc_type)}">${esc(d.doc_type)}</span>`);
  if (d.duplicate_of)
    chips.push(`<span class="chip dup">duplicate of #${d.duplicate_of}</span>`);
  for (const f of JSON.parse(d.flags || "[]") as string[])
    if (f.startsWith("order-") || f.startsWith("possible-"))
      chips.push(`<span class="chip flag">${esc(f)}</span>`);
  return `
    <div class="doc-row ${d.id === state.detailId ? "selected" : ""}" data-id="${d.id}">
      <img class="doc-thumb" src="app://thumb/${d.id}" loading="lazy"
           onerror="this.style.visibility='hidden'">
      <div class="doc-mid">
        <div class="doc-title">${esc(d.title || "(untitled)")}</div>
        <div class="doc-sub">${esc(d.sender_name || "unknown sender")}
          · ${fmtDate(d.doc_date || d.created_at)} · ${d.pages || "?"} p.</div>
        <div>${chips.join("")}</div>
        ${snippet && d.snip ? `<div class="snip">${d.snip}</div>` : ""}
      </div>
      <div class="doc-side">
        ${d.amount ? `<div class="doc-amount">${fmtAmount(d.amount, d.currency ?? undefined)}</div>` : ""}
        ${d.due_date ? `<div class="small muted">due ${fmtDate(d.due_date)}</div>` : ""}
      </div>
    </div>`;
}

function bindDocRows(c: HTMLElement): void {
  $$(".doc-row", c).forEach((el) =>
    el.addEventListener("click", () =>
      void openDetail(parseInt(el.dataset.id!, 10))));
}

async function renderInbox(c: HTMLElement): Promise<void> {
  const docs = await api<DocRowVM[]>("list_documents", { inbox: true });
  c.innerHTML = `<h2>Inbox — needs review</h2>` +
    (docs.length
      ? docs.map((d) => docRow(d)).join("")
      : `<div class="empty">Inbox zero. Scan something!</div>`);
  bindDocRows(c);
}

async function renderDocuments(c: HTMLElement): Promise<void> {
  let docs: DocRowVM[];
  let heading = "All documents";
  if (state.searchQ) {
    docs = await api<DocRowVM[]>("search", { q: state.searchQ });
    heading = `Search: “${esc(state.searchQ)}”`;
  } else {
    docs = await api<DocRowVM[]>("list_documents", {
      doc_type: state.filters.doc_type || null,
      sender_id: state.filters.sender_id || null,
      year: state.filters.year || null,
    });
  }
  const [senders, years] = await Promise.all([
    api<SenderVM[]>("list_senders"), api<string[]>("years")]);
  const f = state.filters;
  c.innerHTML = `
    <h2>${heading}</h2>
    <div class="filters">
      <select id="f-type">
        <option value="">All types</option>
        ${["invoice","reminder","receipt","letter","contract","policy","statement",
           "return_slip","medical","insurance","tax","other"].map((t) =>
          `<option ${f.doc_type === t ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <select id="f-sender">
        <option value="">All senders</option>
        ${senders.map((s) =>
          `<option value="${s.id}" ${String(f.sender_id) === String(s.id) ? "selected" : ""}>
             ${esc(s.name)} (${s.doc_count})</option>`).join("")}
      </select>
      <select id="f-year">
        <option value="">All years</option>
        ${years.map((y) =>
          `<option ${f.year === y ? "selected" : ""}>${y}</option>`).join("")}
      </select>
      <span class="muted small">${docs.length} document(s)</span>
    </div>
    ${docs.length ? docs.map((d) => docRow(d, { snippet: true })).join("")
                  : `<div class="empty">Nothing found.</div>`}`;
  bindDocRows(c);
  $<HTMLSelectElement>("#f-type").onchange = (e) => {
    f.doc_type = (e.target as HTMLSelectElement).value; void render(); };
  $<HTMLSelectElement>("#f-sender").onchange = (e) => {
    f.sender_id = (e.target as HTMLSelectElement).value; void render(); };
  $<HTMLSelectElement>("#f-year").onchange = (e) => {
    f.year = (e.target as HTMLSelectElement).value; void render(); };
}

async function renderInvoices(c: HTMLElement): Promise<void> {
  const [stats, invs, act] = await Promise.all([
    api<StatsVM>("stats"),
    api<InvoiceVM[]>("list_invoices",
      { status: state.invoiceFilter === "all" ? null : state.invoiceFilter }),
    api<StatusVM>("status"),
  ]);
  // documents still in the pipeline: a just-scanned invoice has no
  // invoices row yet -- say so instead of silently not listing it
  const inflight = act.scanning.length + act.waiting.length
                 + act.queued.length + act.processing.length;
  c.innerHTML = `
    <h2>Invoices</h2>
    <div class="stats">
      <div class="stat warn"><div class="v">${fmtAmount(stats.unpaid_total)}</div>
        <div class="l">${stats.unpaid_count} open invoice(s)</div></div>
      <div class="stat ${stats.overdue ? "bad" : ""}"><div class="v">${stats.overdue}</div>
        <div class="l">overdue</div></div>
    </div>
    ${inflight ? `<div class="processing-note">${inflight} scanned document(s)
      still being processed — an invoice may appear here shortly.</div>` : ""}
    <div class="filters">
      ${["unpaid","overdue","paid","all"].map((s) =>
        `<button class="btn small ${state.invoiceFilter === s ? "primary" : ""}"
                 data-f="${s}">${s}</button>`).join("")}
    </div>
    <table><thead><tr>
      <th>Status</th><th>Sender</th><th>Title</th><th class="num">Amount due</th>
      <th>Due date</th><th>Reminders</th><th></th>
    </tr></thead><tbody>
      ${invs.map((i) => {
        // paid = green, unpaid (incl. overdue/reminded) = red,
        // void ("do not pay", settled elsewhere or notification) = gray,
        // unprocessed (not yet reviewed in the Inbox) = orange
        const st = i.status === "paid" ? "paid"
                 : i.status === "void" ? "void"
                 : !i.reviewed ? "unprocessed"
                 : i.overdue ? "overdue"
                 : (i.max_reminder_level ?? 0) > 0 ? "reminded"
                 : i.status;
        return `<tr class="click inv-${st}" data-doc="${i.document_id}">
          <td><span class="dot ${st}"></span>${st === "void" ? "do not pay" : st}</td>
          <td>${esc(i.sender_name || "?")}</td>
          <td>${esc(i.title || "")}
              ${i.is_notification ? '<span class="chip">notification</span>' : ""}</td>
          <td class="num">${fmtAmount(i.amount_due ?? i.amount, i.currency)}
              ${i.fees ? `<div class="small muted">incl. fees ${fmtAmount(i.fees, i.currency)}</div>` : ""}</td>
          <td>${fmtDate(i.due_date)}</td>
          <td>${i.max_reminder_level
            ? `${i.max_reminder_level}${i.reminder_level > 0
                ? ' <span class="chip" title="the original invoice was never scanned">no original</span>' : ""}`
            : ""}</td>
          <td>${!["paid", "void"].includes(i.status) && !i.is_notification
            ? `<button class="btn small" data-pay="${i.id}">Mark paid</button>` : ""}
             ${i.qr_payload ? `<button class="btn small" data-qr="${i.id}">QR</button>` : ""}</td>
        </tr>`;
      }).join("")}
    </tbody></table>
    ${invs.length ? "" : `<div class="empty">No invoices here.</div>`}`;
  $$("[data-f]", c).forEach((b) =>
    b.addEventListener("click", () => {
      state.invoiceFilter = b.dataset.f!; void render(); }));
  $$("tr.click", c).forEach((tr) =>
    tr.addEventListener("click", () =>
      void openDetail(parseInt(tr.dataset.doc!, 10))));
  $$("[data-pay]", c).forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = parseInt(b.dataset.pay!, 10);
      void showPayDialog(id, invs.find((i) => i.id === id) ?? null,
                         () => { void refreshCounts(); void render(); });
    }));
  $$("[data-qr]", c).forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = parseInt(b.dataset.qr!, 10);
      void showQr(id, invs.find((i) => i.id === id) ?? null);
    }));
}

async function renderSenders(c: HTMLElement): Promise<void> {
  const senders = await api<SenderVM[]>("list_senders");
  c.innerHTML = `<h2>Senders</h2><div class="sender-grid">
    ${senders.map((s) => `
      <div class="sender-card" data-id="${s.id}">
        <div class="n">${esc(s.name)}</div>
        <div class="small muted">${s.doc_count} document(s)
          · last ${fmtDate(s.last_doc)}</div>
        ${s.uid ? `<div class="small muted">UID CHE-${esc(s.uid)}</div>` : ""}
        ${s.iban ? `<div class="small muted ref">${esc(s.iban)}</div>` : ""}
      </div>`).join("")}
  </div>`;
  $$(".sender-card", c).forEach((el) =>
    el.addEventListener("click", () => {
      state.filters = { doc_type: "", sender_id: el.dataset.id!, year: "" };
      state.searchQ = "";
      $<HTMLInputElement>("#search").value = "";
      show("documents");
    }));
}

async function renderAccounts(c: HTMLElement, adding = false): Promise<void> {
  const accounts = await api<BankAccountVM[]>("list_bank_accounts");
  const row = (a: Partial<BankAccountVM>): string => `
    <tr data-aid="${a.id ?? ""}">
      <td><input class="a-holder" value="${esc(a.holder || "")}" placeholder="Account holder"></td>
      <td><input class="a-bank" value="${esc(a.bank || "")}" placeholder="Bank"></td>
      <td class="c-iban">
        <input class="a-iban" value="${esc(ibanGroup(a.iban))}"
               placeholder="CH93 0076 2011 6238 5295 7" maxlength="42"
               spellcheck="false" autocomplete="off">
        <div class="iban-msg"></div>
      </td>
      <td class="a-actions"><button class="btn small primary a-save">Save</button>
          ${a.id ? `<button class="btn small a-del">Delete</button>` : ""}</td>
    </tr>`;
  c.innerHTML = `
    <h2>Bank accounts</h2>
    <div class="muted small" style="margin-bottom:14px">Payments are recorded
      against these accounts. The first one is preselected in the
      “Mark paid” dialog.</div>
    <table class="accounts"><thead><tr>
      <th>Holder</th><th>Bank</th><th>IBAN</th><th></th>
    </tr></thead><tbody>
      ${accounts.map(row).join("")}${adding ? row({}) : ""}
    </tbody></table>
    ${adding ? "" : `<button class="btn" id="a-add" style="margin-top:12px">+ Add account</button>`}`;
  $$<HTMLTableRowElement>("tr[data-aid]", c).forEach((tr) => {
    const ib = $<HTMLInputElement>(".a-iban", tr);
    const msg = $(".iban-msg", tr);
    // valid turns green immediately; complaints only once the IBAN is
    // plausibly complete (>=15 chars, shortest real IBAN) or on blur/save
    const checkIban = (final = false): boolean => {
      const v = ibanCompact(ib.value);
      const ok = !!v && ibanValid(v);
      const settled = final || v.length >= 15;
      ib.classList.toggle("good", ok);
      ib.classList.toggle("bad", !!v && !ok && settled);
      msg.className = "iban-msg " + (ok ? "ok" : "bad");
      msg.textContent = ok ? `✓ valid ${isQrIban(v) ? "QR-IBAN" : "IBAN"}`
        : v && settled ? "✗ not a valid IBAN — check for typos" : "";
      return !v || ok;
    };
    ib.oninput = () => {
      // regroup by 4 while typing, caret restored by significant-char count
      const at = ib.value.slice(0, ib.selectionStart ?? 0)
        .replace(/\s+/g, "").length;
      ib.value = ibanGroup(ib.value);
      let pos = 0, seen = 0;
      while (seen < at && pos < ib.value.length)
        if (ib.value[pos++] !== " ") seen++;
      ib.setSelectionRange(pos, pos);
      checkIban();
    };
    ib.onblur = () => checkIban(true);
    if (ib.value) checkIban(true);
    $<HTMLButtonElement>(".a-save", tr).onclick = async () => {
      if (!checkIban(true)) { ib.focus(); return; }
      try {
        await api("save_bank_account", {
          id: tr.dataset.aid ? parseInt(tr.dataset.aid, 10) : null,
          holder: $<HTMLInputElement>(".a-holder", tr).value,
          bank: $<HTMLInputElement>(".a-bank", tr).value,
          iban: ibanCompact(ib.value),
        });
        void renderAccounts(c);
      } catch (e) { alert("save failed: " + (e as Error).message); }
    };
    const del = tr.querySelector<HTMLButtonElement>(".a-del");
    if (del) del.onclick = async () => {
      if (!confirm("Delete this bank account?")) return;
      await api("delete_bank_account", { id: parseInt(tr.dataset.aid!, 10) });
      void renderAccounts(c);
    };
  });
  const add = c.querySelector<HTMLButtonElement>("#a-add");
  if (add) add.onclick = () => void renderAccounts(c, true);
}

async function renderActivity(c: HTMLElement): Promise<void> {
  const events = await api<EventVM[]>("list_events", { limit: 200 });
  c.innerHTML = `<h2>Activity</h2>` + (events.length
    ? events.map((e) => `
        <div class="event">
          <span class="t">${esc((e.at || "").replace("T", " "))}</span>
          <span class="k ${esc(e.kind)}">${esc(e.kind)}</span>
          <span>${esc(e.message)}
            ${e.document_id ? `<a class="small link"
               data-doc="${e.document_id}">#${e.document_id}</a>` : ""}</span>
        </div>`).join("")
    : `<div class="empty">No activity yet.</div>`);
  $$("[data-doc]", c).forEach((a) =>
    a.addEventListener("click", () =>
      void openDetail(parseInt(a.dataset.doc!, 10))));
}

async function renderSettings(c: HTMLElement): Promise<void> {
  const cfg = await api<SettingsVM>("get_settings");
  const field = (key: string, label: string, opts?: string[]): string => {
    if (typeof cfg[key] === "boolean")
      return `<label class="row"><input type="checkbox" data-k="${key}"
                ${cfg[key] ? "checked" : ""}> ${label}</label>`;
    if (opts)
      return `<label>${label}<select data-k="${key}">
        ${opts.map((o) => `<option ${cfg[key] === o ? "selected" : ""}>${o}</option>`).join("")}
      </select></label>`;
    return `<label>${label}<input data-k="${key}" value="${esc(cfg[key])}"></label>`;
  };
  c.innerHTML = `
    <h2>Settings</h2>
    <div class="settings-form">
      ${field("ai_provider", "AI provider", ["claude-cli", "local-vllm", "none"])}
      ${field("ai_model", "AI model (claude -p --model)", ["sonnet", "opus", "haiku"])}
      ${field("ai_base_url", "Local AI endpoint (OpenAI-compatible)")}
      ${field("ai_send_images", "Send page images to the AI (vision, recommended)")}
      ${field("ocr_languages", "OCR languages (tesseract, e.g. deu+fra+ita+eng)")}
      ${field("scans_dir", "Scans inbox directory (watched)")}
      ${field("keep_originals", "Keep original scan images in originals/")}
      ${field("blank_page_drop", "Drop blank duplex backsides")}
      ${field("default_payment_term_days", "Default payment term (days, Swiss convention)")}
      <label>Archive root (change requires moving data manually)
        <input value="${esc(cfg.data_root)}" disabled></label>
      <div><button class="btn primary" id="save-settings">Save</button>
        <span class="muted small" id="save-msg"></span></div>
    </div>`;
  $<HTMLButtonElement>("#save-settings").onclick = async () => {
    const kv: Record<string, unknown> = {};
    $$<HTMLInputElement>("[data-k]", c).forEach((el) => {
      kv[el.dataset.k!] = el.type === "checkbox" ? el.checked : el.value;
    });
    kv.default_payment_term_days =
      parseInt(String(kv.default_payment_term_days), 10) || 30;
    await api("set_settings", kv);
    $("#save-msg").textContent = "saved ✓";
    setTimeout(() => { $("#save-msg").textContent = ""; }, 2000);
  };
}

// ------------------------------------------------------------------ detail
async function openDetail(id: number, { keepPdf = false } = {}): Promise<void> {
  const d = await api<DetailVM>("get_document", { id });
  // re-render the preview when background processing just finished --
  // the PDF gained its OCR layer and pages may have been dropped/reordered
  const pdfStale = state.detailId === id &&
    state.detailPending === "queued" && d.pending !== "queued";
  state.detailId = id;
  state.detailPending = d.pending;
  // sync list highlighting without a refetch (rows render .selected from
  // state.detailId, which we just changed)
  $$(".doc-row").forEach((el) =>
    el.classList.toggle("selected", parseInt(el.dataset.id!, 10) === id));
  const panel = $("#detail");
  panel.classList.remove("hidden");
  const tags = JSON.parse(d.tags || "[]") as string[];
  const inv = d.invoice;

  panel.innerHTML = `
    <div class="detail-head">
      <input class="detail-title" id="d-title" value="${esc(d.title || "")}">
      <button class="close" id="d-close">×</button>
    </div>
    <div class="small muted">#${d.id} · scanned ${fmtDate(d.created_at)} · batch ${esc(d.batch || "?")}</div>
    ${d.pending === "queued" ? `<div class="pending-banner">
        <span class="spinner"></span> Being read in the background —
        text, title and sender will fill in automatically.</div>` : ""}
    ${d.pending === "error" ? `<div class="error-banner" style="margin-top:10px">
        Background processing failed — the raw scan is preserved.
        See the Activity tab.</div>` : ""}
    ${d.duplicate_of ? `<div class="error-banner" style="margin-top:10px">
        Duplicate of <a class="link" style="text-decoration:underline" data-goto="${d.duplicate_of}">document #${d.duplicate_of}</a>
        (${esc(d.dup_reason || "")})</div>` : ""}
    <div class="meta-grid">
      <label>Sender <input id="d-sender" value="${esc(d.sender_name || "")}"></label>
      <label>Type <select id="d-type">
        ${d.doc_type ? "" : `<option selected value=""></option>`}
        ${["invoice","reminder","receipt","letter","contract","policy","statement",
           "return_slip","medical","insurance","tax","other"].map((t) =>
          `<option ${d.doc_type === t ? "selected" : ""}>${t}</option>`).join("")}
      </select></label>
      <label>Document date <input id="d-date" value="${esc(d.doc_date || "")}" placeholder="YYYY-MM-DD"></label>
      <label>Tags (comma separated) <input id="d-tags" value="${esc(tags.join(", "))}"></label>
    </div>
    ${d.summary ? `<div class="small muted" style="margin-bottom:8px">${esc(d.summary)}</div>` : ""}
    <div class="detail-actions">
      <button class="btn primary" id="d-save">Save</button>
      ${!d.reviewed ? `<button class="btn" id="d-review">Mark reviewed</button>` : ""}
      <button class="btn" id="d-open">Open PDF</button>
      <button class="btn" id="d-folder">Show in folder</button>
      <button class="btn" id="d-trash">🗑</button>
    </div>

    ${inv ? `
    <div class="section"><h3>Invoice</h3>
      <div class="invoice-card">
        <div class="invoice-amount">${fmtAmount(inv.amount_due ?? inv.amount, inv.currency)}
          <span class="chip ${["paid", "void"].includes(inv.status) ? "" : "flag"}">${
            inv.status === "void" ? "do not pay" : esc(inv.status)}</span>
          ${inv.is_notification ? `<span class="chip">notification — do not pay</span>` : ""}
        </div>
        ${inv.fees ? `<div class="invoice-line"><span>incl. reminder fees</span>
            <span>${fmtAmount(inv.fees, inv.currency)}</span></div>` : ""}
        <div class="invoice-line"><span>Due</span><span>${fmtDate(inv.due_date)}</span></div>
        ${inv.invoice_ref ? `<div class="invoice-line"><span>Invoice no.</span>
            <span class="muted">${esc(inv.invoice_ref)}</span></div>` : ""}
        ${inv.qr_iban ? `<div class="invoice-line"><span>IBAN</span>
            <span class="muted">${esc(inv.qr_iban)}</span></div>` : ""}
        ${inv.qr_reference ? `<div class="invoice-line"><span>Reference (${esc(inv.qr_ref_type)})</span>
            <span class="muted">${esc(inv.qr_reference)}</span></div>` : ""}
        ${inv.paid_at ? `<div class="invoice-line">
            <span>${inv.status === "void" ? "Do not pay" : "Paid"}</span>
            <span>${fmtDate(inv.paid_at)}${inv.paid_account
              ? ` · ${esc(inv.paid_account)}` : ""} ${esc(inv.paid_note || "")}</span></div>` : ""}
        <div class="detail-actions">
          ${!["paid", "void"].includes(inv.status) && !inv.is_notification
            ? `<button class="btn primary" id="i-pay">Mark paid</button>` : ""}
          ${inv.status === "paid" || (inv.status === "void" && !inv.is_notification)
            ? `<button class="btn" id="i-reopen">Reopen</button>` : ""}
          ${inv.qr_payload
            ? `<button class="btn" id="i-qr">Pay by QR</button>` : ""}
        </div>
        ${(inv.chain || []).length > 1 ? `<div class="small muted" style="margin-top:6px">
          Chain: ${inv.chain!.map((m) =>
            `<a class="link" data-goto="${m.doc_id}">
              ${m.reminder_level === 0 ? "invoice" : "reminder " + m.reminder_level}</a>`).join(" → ")}
        </div>` : ""}
      </div>
    </div>` : ""}

    ${d.refs.length ? `
    <div class="section"><h3>References</h3>
      <div class="tag-row">${d.refs.map((r) =>
        `<span class="ref"><span class="k">${esc(r.kind)}:</span> ${esc(r.value)}</span>`).join("")}
      </div>
    </div>` : ""}

    ${d.timeline.length > 1 ? `
    <div class="section"><h3>Timeline</h3>
      <div class="timeline">${d.timeline.map((e) => `
        <div class="tl-item ${esc(e.kind)}">
          <span class="d">${esc(e.date)}</span>
          ${e.document_id && e.document_id !== d.id
            ? `<a data-goto="${e.document_id}">${esc(e.label)}</a>`
            : esc(e.label)}
        </div>`).join("")}
      </div>
    </div>` : ""}

    ${d.related.length ? `
    <div class="section"><h3>Related documents</h3>
      ${d.related.map((r) => `
        <div class="tl-item"><span class="d">${fmtDate(r.doc_date || r.created_at)}</span>
          <a data-goto="${r.id}">${esc(r.title || r.doc_type)}</a>
          <span class="small muted">shared ${esc(r.kind)} ${esc(r.value)}</span>
        </div>`).join("")}
    </div>` : ""}

    <div class="section"><h3>Preview</h3><div id="pdf-pages"></div></div>`;

  $<HTMLButtonElement>("#d-close").onclick = () => {
    panel.classList.add("hidden"); state.detailId = null; void render(); };
  $<HTMLButtonElement>("#d-open").onclick = () => bridge().openExternal(id);
  $<HTMLButtonElement>("#d-folder").onclick = () => bridge().openFolder(id);
  $<HTMLButtonElement>("#d-trash").onclick = async () => {
    await api("trash_document", { id });
    panel.classList.add("hidden"); state.detailId = null;
    void refreshCounts(); void render();
  };
  $<HTMLButtonElement>("#d-save").onclick = async () => {
    await api("update_document", {
      id,
      title: $<HTMLInputElement>("#d-title").value,
      sender_name: $<HTMLInputElement>("#d-sender").value,
      doc_type: $<HTMLSelectElement>("#d-type").value || null,
      doc_date: $<HTMLInputElement>("#d-date").value || null,
      tags: $<HTMLInputElement>("#d-tags").value.split(",")
        .map((t) => t.trim()).filter(Boolean),
      reviewed: 1,
    });
    void refreshCounts(); void render();
  };
  const rev = panel.querySelector<HTMLButtonElement>("#d-review");
  if (rev) rev.onclick = async () => {
    await api("update_document", { id, reviewed: 1 });
    void refreshCounts(); void openDetail(id, { keepPdf: true }); void render();
  };
  if (inv) {
    const pay = panel.querySelector<HTMLButtonElement>("#i-pay");
    const reopen = panel.querySelector<HTMLButtonElement>("#i-reopen");
    const qrBtn = panel.querySelector<HTMLButtonElement>("#i-qr");
    if (pay) pay.onclick = () =>
      void showPayDialog(inv.id, { ...inv, sender_name: d.sender_name },
        () => { void refreshCounts(); void render();
                void openDetail(id, { keepPdf: true }); });
    if (reopen) reopen.onclick = async () => {
      await api("invoice_reopen", { id: inv.id });
      void refreshCounts(); void openDetail(id, { keepPdf: true });
    };
    if (qrBtn) qrBtn.onclick = () => void showQr(inv.id, inv);
  }
  $$("[data-goto]", panel).forEach((a) =>
    a.addEventListener("click", () =>
      void openDetail(parseInt(a.dataset.goto!, 10))));

  if (!keepPdf || pdfStale || !panel.querySelector("#pdf-pages canvas"))
    void renderPdf(id);
}

async function renderPdf(id: number): Promise<void> {
  const token = ++state.pdfToken;
  const holder = document.querySelector<HTMLElement>("#pdf-pages");
  if (!holder) return;
  holder.innerHTML = `<div class="muted small">loading preview…</div>`;
  try {
    const pdf = await pdfjsLib.getDocument({ url: `app://doc/${id}` }).promise;
    if (token !== state.pdfToken) return;
    holder.innerHTML = "";
    const max = Math.min(pdf.numPages, 20);
    for (let p = 1; p <= max; p++) {
      const page = await pdf.getPage(p);
      if (token !== state.pdfToken) return;
      const scale = 1.3;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width * devicePixelRatio;
      canvas.height = viewport.height * devicePixelRatio;
      holder.appendChild(canvas);
      await page.render({
        canvasContext: canvas.getContext("2d")!,
        viewport,
        transform: [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0],
      }).promise;
    }
    if (pdf.numPages > max)
      holder.insertAdjacentHTML("beforeend",
        `<div class="muted small">…${pdf.numPages - max} more pages — use “Open PDF”.</div>`);
  } catch (e) {
    holder.innerHTML = `<div class="muted small">preview failed: ${esc((e as Error).message)} —
      use “Open PDF”.</div>`;
  }
}

// ------------------------------------------------------------------ pay dialog
async function showPayDialog(
  invoiceId: number, inv: InvoiceVM | null,
  onDone: (() => void) | null = null,
): Promise<void> {
  const accounts = await api<BankAccountVM[]>("list_bank_accounts");
  const m = $("#modal");
  m.classList.remove("hidden");
  m.innerHTML = `
    <div class="modal-box pay-box">
      <div style="font-weight:700">Mark paid${inv
        ? ` — ${fmtAmount(inv.amount_due ?? inv.amount, inv.currency)}` : ""}</div>
      ${inv?.sender_name ? `<div class="muted small">${esc(inv.sender_name)}</div>` : ""}
      <div id="pay-fields">
        <label>Paid from account
          <select id="pay-account">
            ${accounts.map((a, idx) =>
              `<option value="${a.id}" ${idx === 0 ? "selected" : ""}>
                 ${esc(a.holder)}${a.bank ? `, ${esc(a.bank)}` : ""}</option>`).join("")}
          </select></label>
        <label>Payment date
          <input id="pay-date" type="date" value="${nextWorkingDay()}"></label>
      </div>
      <label class="dnp-row"><input type="checkbox" id="pay-dnp">
        Do not pay — settled elsewhere</label>
      <label id="pay-note-label" class="hidden">Comment — how is it settled?
        <input id="pay-note"
               placeholder="e.g. paid by employer / direct debit / disputed"></label>
      <div class="pay-btns">
        <button class="btn" id="pay-cancel">Cancel</button>
        <button class="btn primary" id="pay-ok">Mark paid</button>
      </div>
    </div>`;
  const close = (): void => m.classList.add("hidden");
  $<HTMLButtonElement>("#pay-cancel").onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  $<HTMLInputElement>("#pay-dnp").onchange = (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    $("#pay-fields").classList.toggle("hidden", checked);
    $("#pay-note-label").classList.toggle("hidden", !checked);
    $("#pay-ok").textContent = checked ? "Do not pay" : "Mark paid";
    if (checked) $<HTMLInputElement>("#pay-note").focus();
  };
  $<HTMLButtonElement>("#pay-ok").onclick = async () => {
    try {
      if ($<HTMLInputElement>("#pay-dnp").checked)
        await api("invoice_do_not_pay", {
          id: invoiceId,
          note: $<HTMLInputElement>("#pay-note").value.trim() || null,
        });
      else
        await api("invoice_paid", {
          id: invoiceId,
          account_id: parseInt($<HTMLSelectElement>("#pay-account").value, 10) || null,
          paid_date: $<HTMLInputElement>("#pay-date").value || null,
        });
      close();
      onDone?.();
    } catch (e) {
      alert("update failed: " + (e as Error).message);
    }
  };
}

// ------------------------------------------------------------------ QR modal
async function showQr(invoiceId: number, inv: InvoiceVM | null): Promise<void> {
  try {
    const dataUri = await api<string>("render_qr", { invoice_id: invoiceId });
    const m = $("#modal");
    m.classList.remove("hidden");
    m.innerHTML = `
      <div class="modal-box">
        <div style="font-weight:700;margin-bottom:6px">Scan with your banking app</div>
        <img src="${dataUri}" alt="Swiss QR code">
        ${inv ? `<div class="pay-info">
          <div><b>${fmtAmount(inv.amount_due ?? inv.amount, inv.currency)}</b></div>
          ${inv.qr_iban ? `<div>IBAN: ${esc(inv.qr_iban)}</div>` : ""}
          ${inv.qr_reference ? `<div>Ref: ${esc(inv.qr_reference)}</div>` : ""}
        </div>` : ""}
        <button class="btn" id="qr-close">Close</button>
      </div>`;
    $<HTMLButtonElement>("#qr-close").onclick = () => m.classList.add("hidden");
    m.onclick = (e) => { if (e.target === m) m.classList.add("hidden"); };
  } catch (e) {
    alert("QR render failed: " + (e as Error).message);
  }
}

// ------------------------------------------------------------------ progress strip
let wasBusy = false;
let scanRequestedAt = 0;            // scan_now sent, .scanning not seen yet
let scanError: { msg: string; at: number } | null = null;
let abortArmedAt = 0;               // first Abort click arms, second fires
let abortRequestedAt = 0;           // abort_scan sent, pipeline still busy
const shownPct: Record<string, number> = {};  // batch -> displayed %

const pill = (html: string, cls = ""): string =>
  `<span class="status-pill ${cls}">${html}</span>`;

function processingPill(p: StatusVM["processing"][number]): string {
  if (p.pct == null)                // no progress file -> indeterminate bar
    return pill(`<span class="bar indet"><span class="fill"></span></span>
      Processing <span class="sub">${esc(p.label || p.batch)}</span>`);
  // creep toward the stage ceiling so the bar keeps moving inside long stages
  const w = Math.min(Math.max(p.pct, (shownPct[p.batch] || 0) + 1), p.ceil ?? 98);
  shownPct[p.batch] = w;
  return pill(`<span class="bar"><span class="fill" style="width:${w}%"></span></span>
    Processing ${Math.round(w)}% <span class="sub">${esc(p.label || p.batch)}</span>`);
}

async function pollStatus(): Promise<void> {
  let s: StatusVM;
  try { s = await api<StatusVM>("status"); } catch { return; }
  const pills: string[] = [];

  if (s.scanning.length) scanRequestedAt = 0;
  else if (scanRequestedAt && Date.now() - scanRequestedAt < 12000)
    pills.push(pill(`<span class="spinner"></span> Scan requested…
      <span class="sub">the feeder should start any moment</span>`));
  if (scanError && Date.now() - scanError.at < 8000)
    pills.push(pill(`⚠ ${esc(scanError.msg)}`, "warn"));

  for (const sc of s.scanning)
    pills.push(pill(`<span class="spinner"></span> Scanning…
      <span class="sub">${sc.pages || 0} page(s) so far</span>`));

  for (const p of s.processing) pills.push(processingPill(p));
  const active = new Set(s.processing.map((p) => p.batch));
  for (const b of Object.keys(shownPct)) if (!active.has(b)) delete shownPct[b];

  for (const b of s.queued)
    pills.push(pill(`⏳ Queued <span class="sub">${esc(b)}</span>`));
  for (const b of s.waiting)
    pills.push(s.watcher_alive
      ? pill(`⏳ Waiting <span class="sub">${esc(b)} — picks up once files settle</span>`)
      : pill(`⚠ ${esc(b)} will not process — the watcher is not running`, "warn"));

  if (s.busy) {
    // first, so a crowded strip can never push it out of view
    if (abortRequestedAt && Date.now() - abortRequestedAt < 20000)
      pills.unshift(pill(`<span class="spinner"></span> Aborting…`, "warn"));
    else {
      const armed = Date.now() - abortArmedAt < 4000;
      pills.unshift(`<button id="abort-btn" class="abort-btn${armed ? " armed" : ""}"
        title="Stop scanning and processing, delete all in-flight scans">
        ${armed ? "Really abort? Click again" : "⏹ Abort"}</button>`);
    }
  } else {
    abortArmedAt = abortRequestedAt = 0;
  }

  $("#status").innerHTML = pills.join("");
  const ab = document.querySelector<HTMLButtonElement>("#abort-btn");
  if (ab) ab.onclick = async () => {
    if (Date.now() - abortArmedAt < 4000) {
      abortArmedAt = 0;
      abortRequestedAt = Date.now();
      scanRequestedAt = 0;
      try {
        await api("abort_scan");
      } catch (e) {
        abortRequestedAt = 0;
        scanError = { msg: (e as Error).message.replace(
          /^Error invoking remote method '[^']*': (Error: )?/, ""),
          at: Date.now() };
      }
    } else {
      abortArmedAt = Date.now();
    }
    void pollStatus();
  };
  setDot("#sb-scanner", !s.scanner_alive ? "bad"
    : !s.scanner_online ? "off"
    : s.scanning.length ? "active" : "ready");
  setDot("#sb-watcher", !s.watcher_alive ? "bad"
    : s.processing.length || s.queued.length ? "active" : "ready");

  if (wasBusy && !s.busy) {         // just finished -> show the result
    void refreshCounts();
    void render();
    if (state.detailId) void openDetail(state.detailId, { keepPdf: true });
  }
  wasBusy = s.busy;
}

const DOT_TITLES: Record<string, Record<string, string>> = {
  "#sb-scanner": {
    bad: "scanner module failed — restart the app",
    off: "scanner not connected — power on / plug in the ADS-4300N",
    ready: "scanner — ready to scan",
    active: "scanner — scanning",
  },
  "#sb-watcher": {
    bad: "watcher is not running — new scans won't be processed",
    ready: "watcher — idle, watching for new scans",
    active: "watcher — processing a batch",
  },
};

function setDot(sel: string, st: string): void {
  const d = $(`${sel} .sb-dot`);
  d.classList.toggle("bad", st === "bad");
  d.classList.toggle("off", st === "off");
  d.classList.toggle("ready", st === "ready");
  d.classList.toggle("ok", st === "active");
  $(sel).title = DOT_TITLES[sel][st];
}

// ------------------------------------------------------------------ boot
void refreshCounts();
show("inbox");
setInterval(() => { void refreshCounts(); }, 30000);
void pollStatus();
setInterval(() => { void pollStatus(); }, 2500);
