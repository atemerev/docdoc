// src/renderer/app.ts
import * as pdfjsLib from "./pdfjs/pdf.mjs";

// src/renderer/bridge.ts
var api = (method, params) => window.docdoc.call(method, params);
var bridge = () => window.docdoc;

// src/renderer/format.ts
var $ = (sel, el = document) => el.querySelector(sel);
var $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[c]);
var fmtAmount = (v, cur = "CHF") => v == null ? "" : `${cur} ${Number(v).toLocaleString("de-CH", { minimumFractionDigits: 2 })}`;
var fmtDate = (d) => d ? String(d).slice(0, 10) : "\u2014";
function nextWorkingDay() {
  const d = /* @__PURE__ */ new Date();
  do
    d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
var ibanCompact = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
var ibanGroup = (s) => ibanCompact(s ?? "").replace(/(.{4})/g, "$1 ").trim();
function ibanValid(iban) {
  const s = ibanCompact(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}
var isQrIban = (iban) => {
  const iid = parseInt(ibanCompact(iban).slice(4, 9), 10);
  return iid >= 3e4 && iid <= 31999;
};

// src/renderer/app.ts
pdfjsLib.GlobalWorkerOptions.workerSrc = "app://ui/pdfjs/pdf.worker.mjs";
var state = {
  view: "inbox",
  filters: { doc_type: "", sender_id: "", year: "" },
  invoiceFilter: "unpaid",
  searchQ: "",
  detailId: null,
  detailPending: null,
  pdfToken: 0
};
$$("#sidebar .nav").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
function show(view) {
  state.view = view;
  $$("#sidebar .nav").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  void render();
}
$("#scan-btn").addEventListener("click", async () => {
  const btn = $("#scan-btn");
  btn.disabled = true;
  setTimeout(() => {
    btn.disabled = false;
  }, 2e3);
  scanError = null;
  try {
    await api("scan_now");
    scanRequestedAt = Date.now();
  } catch (e) {
    scanError = {
      msg: e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ""),
      at: Date.now()
    };
  }
  void pollStatus();
});
var searchTimer = null;
$("#search").addEventListener("input", (e) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.searchQ = e.target.value.trim();
    if (state.searchQ && state.view !== "documents") show("documents");
    else void render();
  }, 180);
});
var refreshTimer = null;
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
async function refreshCounts() {
  try {
    const s = await api("stats");
    $("#count-inbox").textContent = s.inbox ? String(s.inbox) : "";
    $("#count-docs").textContent = s.documents ? String(s.documents) : "";
    $("#count-unpaid").textContent = s.unpaid_count ? String(s.unpaid_count) : "";
    $("#sb-stats").innerHTML = `<b>${s.documents}</b> document${s.documents === 1 ? "" : "s"} \xB7 <b>${s.inbox}</b> in inbox \xB7 <b>${s.unpaid_count}</b> unpaid invoice${s.unpaid_count === 1 ? "" : "s"}` + (s.unpaid_count ? ` (${fmtAmount(s.unpaid_total)})` : "") + (s.overdue ? ` \xB7 <span class="sb-bad"><b>${s.overdue}</b> overdue</span>` : "");
  } catch {
  }
}
async function render() {
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
    c.innerHTML = `<div class="error-banner">${esc(e.message)}</div>`;
  }
}
function docRow(d, { snippet = false } = {}) {
  const chips = [];
  if (!d.reviewed) chips.push(`<span class="chip new">new</span>`);
  if (d.pending === "queued")
    chips.push(`<span class="chip processing">reading\u2026</span>`);
  else if (d.pending === "error")
    chips.push(`<span class="chip procfail">processing failed</span>`);
  if (d.doc_type)
    chips.push(`<span class="chip type-${esc(d.doc_type)}">${esc(d.doc_type)}</span>`);
  if (d.duplicate_of)
    chips.push(`<span class="chip dup">duplicate of #${d.duplicate_of}</span>`);
  for (const f of JSON.parse(d.flags || "[]"))
    if (f.startsWith("order-") || f.startsWith("possible-"))
      chips.push(`<span class="chip flag">${esc(f)}</span>`);
  return `
    <div class="doc-row ${d.id === state.detailId ? "selected" : ""}" data-id="${d.id}">
      <img class="doc-thumb" src="app://thumb/${d.id}" loading="lazy"
           onerror="this.style.visibility='hidden'">
      <div class="doc-mid">
        <div class="doc-title">${esc(d.title || "(untitled)")}</div>
        <div class="doc-sub">${esc(d.sender_name || "unknown sender")}
          \xB7 ${fmtDate(d.doc_date || d.created_at)} \xB7 ${d.pages || "?"} p.</div>
        <div>${chips.join("")}</div>
        ${snippet && d.snip ? `<div class="snip">${d.snip}</div>` : ""}
      </div>
      <div class="doc-side">
        ${d.amount ? `<div class="doc-amount">${fmtAmount(d.amount, d.currency ?? void 0)}</div>` : ""}
        ${d.due_date ? `<div class="small muted">due ${fmtDate(d.due_date)}</div>` : ""}
      </div>
    </div>`;
}
function bindDocRows(c) {
  $$(".doc-row", c).forEach((el) => el.addEventListener("click", () => void openDetail(parseInt(el.dataset.id, 10))));
}
async function renderInbox(c) {
  const docs = await api("list_documents", { inbox: true });
  c.innerHTML = `<h2>Inbox \u2014 needs review</h2>` + (docs.length ? docs.map((d) => docRow(d)).join("") : `<div class="empty">Inbox zero. Scan something!</div>`);
  bindDocRows(c);
}
async function renderDocuments(c) {
  let docs;
  let heading = "All documents";
  if (state.searchQ) {
    docs = await api("search", { q: state.searchQ });
    heading = `Search: \u201C${esc(state.searchQ)}\u201D`;
  } else {
    docs = await api("list_documents", {
      doc_type: state.filters.doc_type || null,
      sender_id: state.filters.sender_id || null,
      year: state.filters.year || null
    });
  }
  const [senders, years] = await Promise.all([
    api("list_senders"),
    api("years")
  ]);
  const f = state.filters;
  c.innerHTML = `
    <h2>${heading}</h2>
    <div class="filters">
      <select id="f-type">
        <option value="">All types</option>
        ${[
    "invoice",
    "reminder",
    "receipt",
    "letter",
    "contract",
    "policy",
    "statement",
    "return_slip",
    "medical",
    "insurance",
    "tax",
    "other"
  ].map((t) => `<option ${f.doc_type === t ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <select id="f-sender">
        <option value="">All senders</option>
        ${senders.map((s) => `<option value="${s.id}" ${String(f.sender_id) === String(s.id) ? "selected" : ""}>
             ${esc(s.name)} (${s.doc_count})</option>`).join("")}
      </select>
      <select id="f-year">
        <option value="">All years</option>
        ${years.map((y) => `<option ${f.year === y ? "selected" : ""}>${y}</option>`).join("")}
      </select>
      <span class="muted small">${docs.length} document(s)</span>
    </div>
    ${docs.length ? docs.map((d) => docRow(d, { snippet: true })).join("") : `<div class="empty">Nothing found.</div>`}`;
  bindDocRows(c);
  $("#f-type").onchange = (e) => {
    f.doc_type = e.target.value;
    void render();
  };
  $("#f-sender").onchange = (e) => {
    f.sender_id = e.target.value;
    void render();
  };
  $("#f-year").onchange = (e) => {
    f.year = e.target.value;
    void render();
  };
}
async function renderInvoices(c) {
  const [stats, invs, act] = await Promise.all([
    api("stats"),
    api(
      "list_invoices",
      { status: state.invoiceFilter === "all" ? null : state.invoiceFilter }
    ),
    api("status")
  ]);
  const inflight = act.scanning.length + act.waiting.length + act.queued.length + act.processing.length;
  c.innerHTML = `
    <h2>Invoices</h2>
    <div class="stats">
      <div class="stat warn"><div class="v">${fmtAmount(stats.unpaid_total)}</div>
        <div class="l">${stats.unpaid_count} open invoice(s)</div></div>
      <div class="stat ${stats.overdue ? "bad" : ""}"><div class="v">${stats.overdue}</div>
        <div class="l">overdue</div></div>
    </div>
    ${inflight ? `<div class="processing-note">${inflight} scanned document(s)
      still being processed \u2014 an invoice may appear here shortly.</div>` : ""}
    <div class="filters">
      ${["unpaid", "overdue", "paid", "all"].map((s) => `<button class="btn small ${state.invoiceFilter === s ? "primary" : ""}"
                 data-f="${s}">${s}</button>`).join("")}
    </div>
    <table><thead><tr>
      <th>Status</th><th>Sender</th><th>Title</th><th class="num">Amount due</th>
      <th>Due date</th><th>Reminders</th><th></th>
    </tr></thead><tbody>
      ${invs.map((i) => {
    const st = i.status === "paid" ? "paid" : i.status === "void" ? "void" : !i.reviewed ? "unprocessed" : i.overdue ? "overdue" : (i.max_reminder_level ?? 0) > 0 ? "reminded" : i.status;
    return `<tr class="click inv-${st}" data-doc="${i.document_id}">
          <td><span class="dot ${st}"></span>${st === "void" ? "do not pay" : st}</td>
          <td>${esc(i.sender_name || "?")}</td>
          <td>${esc(i.title || "")}
              ${i.is_notification ? '<span class="chip">notification</span>' : ""}</td>
          <td class="num">${fmtAmount(i.amount_due ?? i.amount, i.currency)}
              ${i.fees ? `<div class="small muted">incl. fees ${fmtAmount(i.fees, i.currency)}</div>` : ""}</td>
          <td>${fmtDate(i.due_date)}</td>
          <td>${i.max_reminder_level ? `${i.max_reminder_level}${i.reminder_level > 0 ? ' <span class="chip" title="the original invoice was never scanned">no original</span>' : ""}` : ""}</td>
          <td>${!["paid", "void"].includes(i.status) && !i.is_notification ? `<button class="btn small" data-pay="${i.id}">Mark paid</button>` : ""}
             ${i.qr_payload ? `<button class="btn small" data-qr="${i.id}">QR</button>` : ""}</td>
        </tr>`;
  }).join("")}
    </tbody></table>
    ${invs.length ? "" : `<div class="empty">No invoices here.</div>`}`;
  $$("[data-f]", c).forEach((b) => b.addEventListener("click", () => {
    state.invoiceFilter = b.dataset.f;
    void render();
  }));
  $$("tr.click", c).forEach((tr) => tr.addEventListener("click", () => void openDetail(parseInt(tr.dataset.doc, 10))));
  $$("[data-pay]", c).forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = parseInt(b.dataset.pay, 10);
    void showPayDialog(
      id,
      invs.find((i) => i.id === id) ?? null,
      () => {
        void refreshCounts();
        void render();
      }
    );
  }));
  $$("[data-qr]", c).forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = parseInt(b.dataset.qr, 10);
    void showQr(id, invs.find((i) => i.id === id) ?? null);
  }));
}
async function renderSenders(c) {
  const senders = await api("list_senders");
  c.innerHTML = `<h2>Senders</h2><div class="sender-grid">
    ${senders.map((s) => `
      <div class="sender-card" data-id="${s.id}">
        <div class="n">${esc(s.name)}</div>
        <div class="small muted">${s.doc_count} document(s)
          \xB7 last ${fmtDate(s.last_doc)}</div>
        ${s.uid ? `<div class="small muted">UID CHE-${esc(s.uid)}</div>` : ""}
        ${s.iban ? `<div class="small muted ref">${esc(s.iban)}</div>` : ""}
      </div>`).join("")}
  </div>`;
  $$(".sender-card", c).forEach((el) => el.addEventListener("click", () => {
    state.filters = { doc_type: "", sender_id: el.dataset.id, year: "" };
    state.searchQ = "";
    $("#search").value = "";
    show("documents");
  }));
}
async function renderAccounts(c, adding = false) {
  const accounts = await api("list_bank_accounts");
  const row = (a) => `
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
      \u201CMark paid\u201D dialog.</div>
    <table class="accounts"><thead><tr>
      <th>Holder</th><th>Bank</th><th>IBAN</th><th></th>
    </tr></thead><tbody>
      ${accounts.map(row).join("")}${adding ? row({}) : ""}
    </tbody></table>
    ${adding ? "" : `<button class="btn" id="a-add" style="margin-top:12px">+ Add account</button>`}`;
  $$("tr[data-aid]", c).forEach((tr) => {
    const ib = $(".a-iban", tr);
    const msg = $(".iban-msg", tr);
    const checkIban = (final = false) => {
      const v = ibanCompact(ib.value);
      const ok = !!v && ibanValid(v);
      const settled = final || v.length >= 15;
      ib.classList.toggle("good", ok);
      ib.classList.toggle("bad", !!v && !ok && settled);
      msg.className = "iban-msg " + (ok ? "ok" : "bad");
      msg.textContent = ok ? `\u2713 valid ${isQrIban(v) ? "QR-IBAN" : "IBAN"}` : v && settled ? "\u2717 not a valid IBAN \u2014 check for typos" : "";
      return !v || ok;
    };
    ib.oninput = () => {
      const at = ib.value.slice(0, ib.selectionStart ?? 0).replace(/\s+/g, "").length;
      ib.value = ibanGroup(ib.value);
      let pos = 0, seen = 0;
      while (seen < at && pos < ib.value.length)
        if (ib.value[pos++] !== " ") seen++;
      ib.setSelectionRange(pos, pos);
      checkIban();
    };
    ib.onblur = () => checkIban(true);
    if (ib.value) checkIban(true);
    $(".a-save", tr).onclick = async () => {
      if (!checkIban(true)) {
        ib.focus();
        return;
      }
      try {
        await api("save_bank_account", {
          id: tr.dataset.aid ? parseInt(tr.dataset.aid, 10) : null,
          holder: $(".a-holder", tr).value,
          bank: $(".a-bank", tr).value,
          iban: ibanCompact(ib.value)
        });
        void renderAccounts(c);
      } catch (e) {
        alert("save failed: " + e.message);
      }
    };
    const del = tr.querySelector(".a-del");
    if (del) del.onclick = async () => {
      if (!confirm("Delete this bank account?")) return;
      await api("delete_bank_account", { id: parseInt(tr.dataset.aid, 10) });
      void renderAccounts(c);
    };
  });
  const add = c.querySelector("#a-add");
  if (add) add.onclick = () => void renderAccounts(c, true);
}
async function renderActivity(c) {
  const events = await api("list_events", { limit: 200 });
  c.innerHTML = `<h2>Activity</h2>` + (events.length ? events.map((e) => `
        <div class="event">
          <span class="t">${esc((e.at || "").replace("T", " "))}</span>
          <span class="k ${esc(e.kind)}">${esc(e.kind)}</span>
          <span>${esc(e.message)}
            ${e.document_id ? `<a class="small link"
               data-doc="${e.document_id}">#${e.document_id}</a>` : ""}</span>
        </div>`).join("") : `<div class="empty">No activity yet.</div>`);
  $$("[data-doc]", c).forEach((a) => a.addEventListener("click", () => void openDetail(parseInt(a.dataset.doc, 10))));
}
async function renderSettings(c) {
  const cfg = await api("get_settings");
  const field = (key, label, opts) => {
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
  $("#save-settings").onclick = async () => {
    const kv = {};
    $$("[data-k]", c).forEach((el) => {
      kv[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value;
    });
    kv.default_payment_term_days = parseInt(String(kv.default_payment_term_days), 10) || 30;
    await api("set_settings", kv);
    $("#save-msg").textContent = "saved \u2713";
    setTimeout(() => {
      $("#save-msg").textContent = "";
    }, 2e3);
  };
}
async function openDetail(id, { keepPdf = false } = {}) {
  const d = await api("get_document", { id });
  const pdfStale = state.detailId === id && state.detailPending === "queued" && d.pending !== "queued";
  state.detailId = id;
  state.detailPending = d.pending;
  $$(".doc-row").forEach((el) => el.classList.toggle("selected", parseInt(el.dataset.id, 10) === id));
  const panel = $("#detail");
  panel.classList.remove("hidden");
  const tags = JSON.parse(d.tags || "[]");
  const inv = d.invoice;
  panel.innerHTML = `
    <div class="detail-head">
      <input class="detail-title" id="d-title" value="${esc(d.title || "")}">
      <button class="close" id="d-close">\xD7</button>
    </div>
    <div class="small muted">#${d.id} \xB7 scanned ${fmtDate(d.created_at)} \xB7 batch ${esc(d.batch || "?")}</div>
    ${d.pending === "queued" ? `<div class="pending-banner">
        <span class="spinner"></span> Being read in the background \u2014
        text, title and sender will fill in automatically.</div>` : ""}
    ${d.pending === "error" ? `<div class="error-banner" style="margin-top:10px">
        Background processing failed \u2014 the raw scan is preserved.
        See the Activity tab.</div>` : ""}
    ${d.duplicate_of ? `<div class="error-banner" style="margin-top:10px">
        Duplicate of <a class="link" style="text-decoration:underline" data-goto="${d.duplicate_of}">document #${d.duplicate_of}</a>
        (${esc(d.dup_reason || "")})</div>` : ""}
    <div class="meta-grid">
      <label>Sender <input id="d-sender" value="${esc(d.sender_name || "")}"></label>
      <label>Type <select id="d-type">
        ${d.doc_type ? "" : `<option selected value=""></option>`}
        ${[
    "invoice",
    "reminder",
    "receipt",
    "letter",
    "contract",
    "policy",
    "statement",
    "return_slip",
    "medical",
    "insurance",
    "tax",
    "other"
  ].map((t) => `<option ${d.doc_type === t ? "selected" : ""}>${t}</option>`).join("")}
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
      <button class="btn" id="d-trash">\u{1F5D1}</button>
    </div>

    ${inv ? `
    <div class="section"><h3>Invoice</h3>
      <div class="invoice-card">
        <div class="invoice-amount">${fmtAmount(inv.amount_due ?? inv.amount, inv.currency)}
          <span class="chip ${["paid", "void"].includes(inv.status) ? "" : "flag"}">${inv.status === "void" ? "do not pay" : esc(inv.status)}</span>
          ${inv.is_notification ? `<span class="chip">notification \u2014 do not pay</span>` : ""}
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
            <span>${fmtDate(inv.paid_at)}${inv.paid_account ? ` \xB7 ${esc(inv.paid_account)}` : ""} ${esc(inv.paid_note || "")}</span></div>` : ""}
        <div class="detail-actions">
          ${!["paid", "void"].includes(inv.status) && !inv.is_notification ? `<button class="btn primary" id="i-pay">Mark paid</button>` : ""}
          ${inv.status === "paid" || inv.status === "void" && !inv.is_notification ? `<button class="btn" id="i-reopen">Reopen</button>` : ""}
          ${inv.qr_payload ? `<button class="btn" id="i-qr">Pay by QR</button>` : ""}
        </div>
        ${(inv.chain || []).length > 1 ? `<div class="small muted" style="margin-top:6px">
          Chain: ${inv.chain.map((m) => `<a class="link" data-goto="${m.doc_id}">
              ${m.reminder_level === 0 ? "invoice" : "reminder " + m.reminder_level}</a>`).join(" \u2192 ")}
        </div>` : ""}
      </div>
    </div>` : ""}

    ${d.refs.length ? `
    <div class="section"><h3>References</h3>
      <div class="tag-row">${d.refs.map((r) => `<span class="ref"><span class="k">${esc(r.kind)}:</span> ${esc(r.value)}</span>`).join("")}
      </div>
    </div>` : ""}

    ${d.timeline.length > 1 ? `
    <div class="section"><h3>Timeline</h3>
      <div class="timeline">${d.timeline.map((e) => `
        <div class="tl-item ${esc(e.kind)}">
          <span class="d">${esc(e.date)}</span>
          ${e.document_id && e.document_id !== d.id ? `<a data-goto="${e.document_id}">${esc(e.label)}</a>` : esc(e.label)}
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
  $("#d-close").onclick = () => {
    panel.classList.add("hidden");
    state.detailId = null;
    void render();
  };
  $("#d-open").onclick = () => bridge().openExternal(id);
  $("#d-folder").onclick = () => bridge().openFolder(id);
  $("#d-trash").onclick = async () => {
    await api("trash_document", { id });
    panel.classList.add("hidden");
    state.detailId = null;
    void refreshCounts();
    void render();
  };
  $("#d-save").onclick = async () => {
    await api("update_document", {
      id,
      title: $("#d-title").value,
      sender_name: $("#d-sender").value,
      doc_type: $("#d-type").value || null,
      doc_date: $("#d-date").value || null,
      tags: $("#d-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      reviewed: 1
    });
    void refreshCounts();
    void render();
  };
  const rev = panel.querySelector("#d-review");
  if (rev) rev.onclick = async () => {
    await api("update_document", { id, reviewed: 1 });
    void refreshCounts();
    void openDetail(id, { keepPdf: true });
    void render();
  };
  if (inv) {
    const pay = panel.querySelector("#i-pay");
    const reopen = panel.querySelector("#i-reopen");
    const qrBtn = panel.querySelector("#i-qr");
    if (pay) pay.onclick = () => void showPayDialog(
      inv.id,
      { ...inv, sender_name: d.sender_name },
      () => {
        void refreshCounts();
        void render();
        void openDetail(id, { keepPdf: true });
      }
    );
    if (reopen) reopen.onclick = async () => {
      await api("invoice_reopen", { id: inv.id });
      void refreshCounts();
      void openDetail(id, { keepPdf: true });
    };
    if (qrBtn) qrBtn.onclick = () => void showQr(inv.id, inv);
  }
  $$("[data-goto]", panel).forEach((a) => a.addEventListener("click", () => void openDetail(parseInt(a.dataset.goto, 10))));
  if (!keepPdf || pdfStale || !panel.querySelector("#pdf-pages canvas"))
    void renderPdf(id);
}
async function renderPdf(id) {
  const token = ++state.pdfToken;
  const holder = document.querySelector("#pdf-pages");
  if (!holder) return;
  holder.innerHTML = `<div class="muted small">loading preview\u2026</div>`;
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
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0]
      }).promise;
    }
    if (pdf.numPages > max)
      holder.insertAdjacentHTML(
        "beforeend",
        `<div class="muted small">\u2026${pdf.numPages - max} more pages \u2014 use \u201COpen PDF\u201D.</div>`
      );
  } catch (e) {
    holder.innerHTML = `<div class="muted small">preview failed: ${esc(e.message)} \u2014
      use \u201COpen PDF\u201D.</div>`;
  }
}
async function showPayDialog(invoiceId, inv, onDone = null) {
  const accounts = await api("list_bank_accounts");
  const m = $("#modal");
  m.classList.remove("hidden");
  m.innerHTML = `
    <div class="modal-box pay-box">
      <div style="font-weight:700">Mark paid${inv ? ` \u2014 ${fmtAmount(inv.amount_due ?? inv.amount, inv.currency)}` : ""}</div>
      ${inv?.sender_name ? `<div class="muted small">${esc(inv.sender_name)}</div>` : ""}
      <div id="pay-fields">
        <label>Paid from account
          <select id="pay-account">
            ${accounts.map((a, idx) => `<option value="${a.id}" ${idx === 0 ? "selected" : ""}>
                 ${esc(a.holder)}${a.bank ? `, ${esc(a.bank)}` : ""}</option>`).join("")}
          </select></label>
        <label>Payment date
          <input id="pay-date" type="date" value="${nextWorkingDay()}"></label>
      </div>
      <label class="dnp-row"><input type="checkbox" id="pay-dnp">
        Do not pay \u2014 settled elsewhere</label>
      <label id="pay-note-label" class="hidden">Comment \u2014 how is it settled?
        <input id="pay-note"
               placeholder="e.g. paid by employer / direct debit / disputed"></label>
      <div class="pay-btns">
        <button class="btn" id="pay-cancel">Cancel</button>
        <button class="btn primary" id="pay-ok">Mark paid</button>
      </div>
    </div>`;
  const close = () => m.classList.add("hidden");
  $("#pay-cancel").onclick = close;
  m.onclick = (e) => {
    if (e.target === m) close();
  };
  $("#pay-dnp").onchange = (e) => {
    const checked = e.target.checked;
    $("#pay-fields").classList.toggle("hidden", checked);
    $("#pay-note-label").classList.toggle("hidden", !checked);
    $("#pay-ok").textContent = checked ? "Do not pay" : "Mark paid";
    if (checked) $("#pay-note").focus();
  };
  $("#pay-ok").onclick = async () => {
    try {
      if ($("#pay-dnp").checked)
        await api("invoice_do_not_pay", {
          id: invoiceId,
          note: $("#pay-note").value.trim() || null
        });
      else
        await api("invoice_paid", {
          id: invoiceId,
          account_id: parseInt($("#pay-account").value, 10) || null,
          paid_date: $("#pay-date").value || null
        });
      close();
      onDone?.();
    } catch (e) {
      alert("update failed: " + e.message);
    }
  };
}
async function showQr(invoiceId, inv) {
  try {
    const dataUri = await api("render_qr", { invoice_id: invoiceId });
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
    $("#qr-close").onclick = () => m.classList.add("hidden");
    m.onclick = (e) => {
      if (e.target === m) m.classList.add("hidden");
    };
  } catch (e) {
    alert("QR render failed: " + e.message);
  }
}
var wasBusy = false;
var scanRequestedAt = 0;
var scanError = null;
var abortArmedAt = 0;
var abortRequestedAt = 0;
var shownPct = {};
var pill = (html, cls = "") => `<span class="status-pill ${cls}">${html}</span>`;
function processingPill(p) {
  if (p.pct == null)
    return pill(`<span class="bar indet"><span class="fill"></span></span>
      Processing <span class="sub">${esc(p.label || p.batch)}</span>`);
  const w = Math.min(Math.max(p.pct, (shownPct[p.batch] || 0) + 1), p.ceil ?? 98);
  shownPct[p.batch] = w;
  return pill(`<span class="bar"><span class="fill" style="width:${w}%"></span></span>
    Processing ${Math.round(w)}% <span class="sub">${esc(p.label || p.batch)}</span>`);
}
async function pollStatus() {
  let s;
  try {
    s = await api("status");
  } catch {
    return;
  }
  const pills = [];
  if (s.scanning.length) scanRequestedAt = 0;
  else if (scanRequestedAt && Date.now() - scanRequestedAt < 12e3)
    pills.push(pill(`<span class="spinner"></span> Scan requested\u2026
      <span class="sub">the feeder should start any moment</span>`));
  if (scanError && Date.now() - scanError.at < 8e3)
    pills.push(pill(`\u26A0 ${esc(scanError.msg)}`, "warn"));
  for (const sc of s.scanning)
    pills.push(pill(`<span class="spinner"></span> Scanning\u2026
      <span class="sub">${sc.pages || 0} page(s) so far</span>`));
  for (const p of s.processing) pills.push(processingPill(p));
  const active = new Set(s.processing.map((p) => p.batch));
  for (const b of Object.keys(shownPct)) if (!active.has(b)) delete shownPct[b];
  for (const b of s.queued)
    pills.push(pill(`\u23F3 Queued <span class="sub">${esc(b)}</span>`));
  for (const b of s.waiting)
    pills.push(s.watcher_alive ? pill(`\u23F3 Waiting <span class="sub">${esc(b)} \u2014 picks up once files settle</span>`) : pill(`\u26A0 ${esc(b)} will not process \u2014 the watcher is not running`, "warn"));
  if (s.busy) {
    if (abortRequestedAt && Date.now() - abortRequestedAt < 2e4)
      pills.unshift(pill(`<span class="spinner"></span> Aborting\u2026`, "warn"));
    else {
      const armed = Date.now() - abortArmedAt < 4e3;
      pills.unshift(`<button id="abort-btn" class="abort-btn${armed ? " armed" : ""}"
        title="Stop scanning and processing, delete all in-flight scans">
        ${armed ? "Really abort? Click again" : "\u23F9 Abort"}</button>`);
    }
  } else {
    abortArmedAt = abortRequestedAt = 0;
  }
  $("#status").innerHTML = pills.join("");
  const ab = document.querySelector("#abort-btn");
  if (ab) ab.onclick = async () => {
    if (Date.now() - abortArmedAt < 4e3) {
      abortArmedAt = 0;
      abortRequestedAt = Date.now();
      scanRequestedAt = 0;
      try {
        await api("abort_scan");
      } catch (e) {
        abortRequestedAt = 0;
        scanError = {
          msg: e.message.replace(
            /^Error invoking remote method '[^']*': (Error: )?/,
            ""
          ),
          at: Date.now()
        };
      }
    } else {
      abortArmedAt = Date.now();
    }
    void pollStatus();
  };
  setDot("#sb-scanner", !s.scanner_alive ? "bad" : !s.scanner_online ? "off" : s.scanning.length ? "active" : "ready");
  setDot("#sb-watcher", !s.watcher_alive ? "bad" : s.processing.length || s.queued.length ? "active" : "ready");
  if (wasBusy && !s.busy) {
    void refreshCounts();
    void render();
    if (state.detailId) void openDetail(state.detailId, { keepPdf: true });
  }
  wasBusy = s.busy;
}
var DOT_TITLES = {
  "#sb-scanner": {
    bad: "scanner module failed \u2014 restart the app",
    off: "scanner not connected \u2014 power on / plug in the ADS-4300N",
    ready: "scanner \u2014 ready to scan",
    active: "scanner \u2014 scanning"
  },
  "#sb-watcher": {
    bad: "watcher is not running \u2014 new scans won't be processed",
    ready: "watcher \u2014 idle, watching for new scans",
    active: "watcher \u2014 processing a batch"
  }
};
function setDot(sel, st) {
  const d = $(`${sel} .sb-dot`);
  d.classList.toggle("bad", st === "bad");
  d.classList.toggle("off", st === "off");
  d.classList.toggle("ready", st === "ready");
  d.classList.toggle("ok", st === "active");
  $(sel).title = DOT_TITLES[sel][st];
}
void refreshCounts();
show("inbox");
setInterval(() => {
  void refreshCounts();
}, 3e4);
void pollStatus();
setInterval(() => {
  void pollStatus();
}, 2500);
