// src/renderer/bridge.ts
var api = (method, params) => window.docdoc.call(method, params);
var bridge = () => window.docdoc;

// src/domain/types.ts
var DOC_TYPES = [
  "pursuit",
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
];

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

// src/renderer/app.ts
var view = "review";
var groups = [];
var activeReview = null;
var senders = [];
var selected = null;
var query = "";
var renderVersion = 0;
var previewVersion = 0;
var pdf = null;
var pageLabel = (n) => `${n} page${n === 1 ? "" : "s"}`;
var referenceLabel = (kind) => ({
  pursuit_no: "Pursuit number",
  debt_certificate_no: "ADB / debt certificate",
  office_ref: "Office reference",
  claim_no: "Claim reference",
  case_no: "Case reference",
  invoice_no: "Invoice number",
  customer_no: "Customer number",
  policy_no: "Policy number",
  contract_no: "Contract number",
  qr_reference: "Payment reference"
})[kind] || kind.replace(/_/g, " ");
var titleWrite = Promise.resolve();
var modal = $("#modal");
function message(text, success = false) {
  for (const el of [
    $("#message"),
    document.querySelector("#modal-message")
  ]) {
    if (!el) continue;
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle("success", success);
  }
}
var err = (e) => String(e instanceof Error ? e.message : e).replace(
  /^Error invoking remote method '[^']*': (Error: )?/,
  ""
);
async function act(action, success) {
  message("");
  try {
    await titleWrite;
    await action();
    if (success) message(success, true);
  } catch (e) {
    message(err(e));
  }
  await render();
}
function navigate(next) {
  view = next;
  void render();
}
$$("[data-view]").forEach((b) => b.onclick = () => navigate(b.dataset.view));
$("#settings-btn").onclick = () => navigate("settings");
var importFiles = (options) => act(async () => {
  const id = await bridge().importFiles(options);
  if (id) {
    selected = id;
    view = "review";
  }
});
var scan = (options) => act(async () => {
  view = "review";
  selected = await api("scan_now", options);
});
$("#import-btn").onclick = () => void importFiles();
$("#scan-btn").onclick = () => void scan();
$("#stop-btn").onclick = () => void api("abort_scan");
var queueVersion = -1;
var reviewRefreshPending = false;
var latestStatus = null;
var queueStages = ["prepare", "recognize", "check", "split", "details"];
var queueStageNames = { prepare: "Prepare", recognize: "Read text", check: "Check pages", split: "Separate documents", details: "Extract details" };
function queueProgressShell(id, groupId) {
  return `<section id="${id}" class="queue-progress" ${groupId ? `data-job="${groupId}"` : ""} hidden aria-label="Queue processing progress"><div class="row between"><strong data-progress-title></strong><small data-elapsed></small></div><p data-progress-label role="status" aria-live="polite"></p><progress aria-label="Current processing stage"></progress><div class="row between"><small data-progress-count></small><small data-queue-count></small></div><ol class="queue-stages">${queueStages.map((stage) => `<li data-queue-stage="${stage}">${queueStageNames[stage]}</li>`).join("")}</ol></section>`;
}
function updateQueueProgress() {
  const job = latestStatus?.background;
  const included = job?.pages.filter((p) => p.state !== "excluded") || [];
  const read = included.filter((p) => ["read", "checking", "done"].includes(p.state)).length;
  const waiting = groups.filter((g) => g.phase === "queued").length;
  const ready = groups.filter((g) => g.phase === "ready").length;
  const summary = document.querySelector("#queue-summary");
  if (summary) summary.textContent = `${job ? "1 processing \xB7 " : ""}${waiting} waiting \xB7 ${ready} ready`;
  $$(".queue-progress").forEach((panel) => {
    panel.hidden = !job || !!panel.dataset.job && Number(panel.dataset.job) !== job.id;
    if (!job || panel.hidden) return;
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 1e3));
    $("[data-progress-title]", panel).textContent = "Processing pages";
    $("[data-progress-label]", panel).textContent = job.label;
    $("[data-elapsed]", panel).textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    $("[data-progress-count]", panel).textContent = `${read} of ${included.length} pages read`;
    $("[data-queue-count]", panel).textContent = waiting ? `${waiting} waiting` : "";
    const bar = $("progress", panel), p = job.progress;
    if (p?.total && p.completed !== void 0 && p.completed > 0) {
      bar.max = p.total;
      bar.value = p.completed;
    } else bar.removeAttribute("value");
    const at = queueStages.indexOf(p?.stage);
    $$("[data-queue-stage]", panel).forEach((step) => {
      const index = queueStages.indexOf(step.dataset.queueStage);
      step.classList.toggle("active", index === at);
      step.classList.toggle("done", index < at);
      if (index === at) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  });
  $$("[data-queue-item-progress]").forEach((el) => {
    const active = job?.id === Number(el.dataset.queueItemProgress);
    el.hidden = !active;
    if (active) el.textContent = `${job.label} \xB7 ${read}/${included.length} pages read`;
  });
  $$("[data-page-work]").forEach((el) => {
    const page = job?.pages.find((p) => p.id === Number(el.dataset.pageWork));
    const state = page?.state || el.dataset.initialState || "waiting";
    el.dataset.state = state;
    el.textContent = { waiting: job?.progress?.stage === "recognize" && page ? "In OCR queue" : "Waiting for OCR", reading: "Reading text\u2026", read: "Text read", checking: "Checking page\u2026", done: "Text ready", excluded: "Removed" }[state];
  });
}
setInterval(updateQueueProgress, 1e3);
var queueRefresh = null;
bridge().onEvent((msg) => {
  void updateStatus(msg.status);
  if (msg.status && msg.status.queue_version !== queueVersion) {
    queueVersion = msg.status.queue_version;
    if (queueRefresh) clearTimeout(queueRefresh);
    queueRefresh = setTimeout(async () => {
      try {
        groups = await api("get_workbench");
        renderSidebar();
        if (view === "review" && !document.activeElement?.matches("input,select,textarea")) {
          renderReview();
          void updateStatus();
        } else {
          reviewRefreshPending = view === "review";
          const latest = groups.find((g) => g.id === activeReview?.id);
          if (reviewRefreshPending && latest && activeReview) {
            Object.assign(activeReview, latest);
            const save = document.querySelector("#save-document");
            if (save) {
              save.textContent = latest.phase === "pages" ? "Done" : latest.phase === "error" ? "Retry processing" : "Save to Library";
              save.dataset.unavailable = String(latest.needs_preparation || !latest.pages.some((p) => !p.excluded) || ["queued", "processing"].includes(latest.phase));
            }
            void updateStatus();
          }
        }
      } catch (e) {
        message(err(e));
      }
    }, 80);
  }
});
document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (reviewRefreshPending && !document.activeElement?.matches("input,select,textarea")) {
      reviewRefreshPending = false;
      void titleWrite.catch(() => {
      }).then(() => render());
    }
  }, 0);
});
async function updateStatus(current) {
  const s = current || await api("status");
  if (!s) return;
  latestStatus = s;
  updateQueueProgress();
  $("#operation").textContent = s.busy ? s.label : s.background ? `Processing queue \xB7 ${s.background.label}` : "Ready";
  $("#stop-btn").hidden = !s.busy;
  $("#processing-panel").hidden = !s.busy;
  $("#processing-label").textContent = s.label;
  $("#content").setAttribute("aria-busy", String(s.busy));
  const bar = $("#processing-bar");
  const p = s.processing;
  if (p?.total && p.completed !== void 0) {
    bar.max = p.total;
    bar.value = p.completed;
  } else bar.removeAttribute("value");
  $("#processing-stages").hidden = !p;
  const stages = ["prepare", "blank", "recognize", "check", "details"];
  $$("[data-stage]").forEach((el) => {
    el.classList.toggle("active", el.dataset.stage === p?.stage);
    el.classList.toggle(
      "done",
      !!p && stages.indexOf(el.dataset.stage) < stages.indexOf(p.stage)
    );
  });
  $$("button[data-work],#scan-btn,#import-btn").forEach(
    (b) => {
      b.disabled = s.busy || b.dataset.unavailable === "true";
    }
  );
  $$(
    "[data-move],#merge-group,#insert-after"
  ).forEach((el) => el.disabled = s.busy);
}
async function render() {
  const version = ++renderVersion;
  try {
    const result = await Promise.all([
      api("get_workbench"),
      api("list_senders")
    ]);
    if (version !== renderVersion) return;
    [groups, senders] = result;
    renderSidebar();
    $("#review-count").textContent = groups.length ? String(groups.length) : "";
    $$("[data-view]").forEach(
      (b) => b.classList.toggle("active", b.dataset.view === view)
    );
    if (view === "review") renderReview();
    else if (view === "library") await renderLibrary(version);
    else await renderSettings();
    await updateStatus();
  } catch (e) {
    message(err(e));
  }
}
var phaseLabel = (phase) => ({ pages: "Review pages", queued: "Waiting", processing: "Processing", ready: "Ready to review", error: "Needs attention" })[phase];
function renderSidebar() {
  const section = (label, items) => `<div class="eyebrow">${label}</div>${items.map((o) => `<button class="group ${o.id === selected && view === "review" ? "active" : ""}" data-group="${o.id}"><strong>${esc(o.title)}</strong><small>${pageLabel(o.pages.filter((p) => !p.excluded).length)} \xB7 ${phaseLabel(o.phase)}</small><small class="queue-item-progress" data-queue-item-progress="${o.id}" hidden></small></button>`).join("")}`;
  $("#queue-sidebar").innerHTML = section("Page review", groups.filter((g) => g.phase === "pages")) + '<button class="new-group" id="new-group" data-work>+ New scanned set</button><div class="queue-divider"></div><div class="eyebrow">Processing queue</div><p id="queue-summary" class="muted"></p>' + queueProgressShell("queue-live-progress") + section("Documents", groups.filter((g) => g.phase !== "pages")) + '<p class="muted">Queue work continues while you scan or review. Unfinished work resumes when docdoc reopens.</p>';
  $$("[data-group]").forEach((button) => button.onclick = () => {
    selected = Number(button.dataset.group);
    view = "review";
    void render();
  });
  $("#new-group").onclick = () => void act(async () => {
    selected = await api("new_group");
    view = "review";
  });
  updateQueueProgress();
}
function renderReview() {
  if (selected !== 0 && !groups.some((g2) => g2.id === selected)) selected = groups.find((g2) => g2.phase === "pages")?.id ?? groups[0]?.id ?? null;
  const g = groups.find((g2) => g2.id === selected);
  activeReview = g || null;
  renderSidebar();
  $("#content").innerHTML = `<section class="work">${g ? groupHtml(g) : `<div class="empty"><div class="icon">\u25A4</div><div class="eyebrow">A place for your paperwork</div><h1>Start with the pages.</h1><p>Scan, remove blanks and review the pages. Press Done to send them to the processing queue.</p><div class="row"><button class="primary" id="empty-scan" data-work>Scan pages</button><button id="empty-import" data-work>Import files</button></div></div>`}</section>`;
  if (!g) {
    $("#empty-scan").onclick = () => void scan();
    $("#empty-import").onclick = () => void importFiles();
    return;
  }
  const title = $("#group-title");
  const writeMetadata = (values) => {
    titleWrite = titleWrite.catch(() => {
    }).then(async () => {
      const saved = await api("update_group_metadata", {
        id: g.id,
        values
      });
      Object.assign(g, saved);
      if (title.isConnected && document.activeElement !== title)
        title.value = g.title;
      const sender = document.querySelector("#file-sender");
      if (title.isConnected && sender && document.activeElement !== sender)
        sender.value = g.metadata.sender_name || "";
      const label = document.querySelector(`[data-group="${g.id}"] strong`);
      if (label) label.textContent = g.title;
    });
    void titleWrite.catch((error) => message(err(error)));
  };
  title.onchange = () => writeMetadata({ title: title.value });
  const retry = document.querySelector("#read-pages");
  if (retry)
    retry.onclick = () => void act(() => api(g.phase === "pages" ? "prepare_group" : "read_group", { id: g.id }));
  const details = document.querySelector("#recognize-details");
  if (details)
    details.onclick = () => void act(() => api("recognize_group_details", { id: g.id }));
  for (const [selector, field] of [
    ["#file-sender", "sender_name"],
    ["#file-date", "doc_date"],
    ["#file-type", "doc_type"],
    ["#case-opened", "case_opened_date"]
  ]) {
    const input = $(selector);
    if (input)
      input.onchange = () => writeMetadata({ [field]: input.value || null });
  }
  $$("[data-reference]").forEach(
    (input) => input.onchange = () => {
      const refs = g.metadata.refs.map(
        (ref, index) => index === Number(input.dataset.reference) ? {
          ...ref,
          value: input.value.trim(),
          page: void 0,
          evidence: "Manually corrected"
        } : ref
      ).filter((ref) => ref.value);
      writeMetadata({ refs });
    }
  );
  $("#save-scan-as").onclick = () => void act(async () => {
    if (g.target_id) {
      const file = await bridge().exportPdf(g.target_id);
      if (file) message(`Saved PDF to ${file}`, true);
    }
  });
  $("#delete-scan").onclick = () => void act(() => api("delete_review", { id: g.id }), "Document deleted.");
  $("#save-document").onclick = () => void act(async () => {
    if (g.phase === "pages" || g.phase === "error") {
      await api("enqueue_group", { id: g.id });
      selected = 0;
      return;
    }
    const meta = g.metadata;
    await api("file_group", {
      id: g.id,
      revision: g.revision,
      title: title.value || g.title,
      sender_name: meta.sender_name,
      doc_type: meta.doc_type,
      doc_date: meta.doc_date,
      case_opened_date: meta.case_opened_date,
      refs: meta.refs
    });
  }, ["pages", "error"].includes(g.phase) ? "Queued. You can scan the next set." : "Saved to Library.");
  const addScan = document.querySelector("#insert-scan");
  const addImport = document.querySelector("#insert-import");
  const insertion = () => ({ group_id: g.id, after_page_id: Number($("#insert-after").value) });
  if (addScan) addScan.onclick = () => void scan(insertion());
  if (addImport) addImport.onclick = () => void importFiles(insertion());
  const editPages = document.querySelector("#edit-pages");
  if (editPages) editPages.onclick = () => void act(() => api("edit_group_pages", { id: g.id }));
  const remove = document.querySelector("#remove-empty");
  if (remove)
    remove.onclick = () => void act(() => api("remove_empty_group", { id: g.id }));
  $$("[data-preview-page]").forEach(
    (b) => b.onclick = () => void pagePreview(g, Number(b.dataset.previewPage))
  );
  $$("[data-exclude]").forEach(
    (b) => b.onclick = () => void act(() => {
      const p = g.pages.find((p2) => p2.id === Number(b.dataset.exclude));
      return api("edit_page", {
        id: p.id,
        group_id: g.id,
        excluded: !p.excluded
      });
    })
  );
  $$("[data-up],[data-down]").forEach(
    (b) => b.onclick = () => void act(() => {
      const id = Number(b.dataset.up || b.dataset.down), ids = g.pages.filter((p) => !p.excluded).map((p) => p.id), at = ids.indexOf(id), to = at + (b.dataset.up ? -1 : 1);
      if (to < 0 || to >= ids.length) return Promise.resolve();
      [ids[at], ids[to]] = [ids[to], ids[at]];
      return api("reorder_pages", {
        id: g.id,
        pages: [
          ...ids,
          ...g.pages.filter((p) => p.excluded).map((p) => p.id)
        ]
      });
    })
  );
  $$("[data-move]").forEach(
    (el) => el.onchange = () => void act(
      () => api("edit_page", {
        id: Number(el.dataset.move),
        group_id: Number(el.value)
      })
    )
  );
  const merge = document.querySelector("#merge-group");
  if (merge)
    merge.onchange = () => {
      if (merge.value)
        void act(async () => {
          const target = Number(merge.value);
          for (const p of g.pages)
            await api("edit_page", { id: p.id, group_id: target });
          selected = target;
        });
    };
  $$("[data-related]").forEach(
    (b) => b.onclick = () => void documentDetail(Number(b.dataset.related))
  );
  $$("[data-other]").forEach(
    (b) => b.onclick = () => {
      selected = Number(b.dataset.other);
      renderReview();
      void updateStatus();
    }
  );
}
function groupHtml(g) {
  const included = g.pages.filter((p) => !p.excluded);
  const excluded = g.pages.filter((p) => p.excluded);
  const blanks = excluded.filter((p) => p.blank).length;
  const meta = g.metadata;
  const needsReading = g.imports.length || g.pages.some((p) => p.issue);
  const pageReview = g.phase === "pages";
  const processing = ["queued", "processing"].includes(g.phase);
  const duplicateId = g.duplicate.id || Number(g.duplicate.reason?.match(/^similar:(\d+)$/)?.[1]) || null;
  return `<div class="eyebrow">${phaseLabel(g.phase)}</div><h1>${pageReview ? "Scanned pages" : "Document review"}</h1>
    <div class="toolbar"><label class="sr" for="group-title">Document title</label><input id="group-title" value="${esc(g.title)}" placeholder="Document title">
      <button class="primary" id="save-document" data-work data-unavailable="${!included.length || g.needs_preparation || ["queued", "processing"].includes(g.phase)}">${pageReview ? "Done" : g.phase === "error" ? "Retry processing" : "Save to Library"}</button><button id="save-scan-as" data-work data-unavailable="${!g.target_id || !included.length || g.imports.length > 0}">Save PDF as\u2026</button><button id="delete-scan" class="small" data-work>Delete</button></div>
    ${queueProgressShell("selected-queue-progress", g.id)}
    ${g.queue_error ? `<div class="notice error">${esc(g.queue_error)}</div>` : ""}
    ${g.queue_note ? `<div class="notice">${esc(g.queue_note)}</div>` : ""}
    ${!pageReview ? `<p class="muted">${phaseLabel(g.phase)}. You can edit metadata while processing continues. <button id="edit-pages" class="small" data-work>Edit pages / add scans</button></p>` : `<p class="muted">Check the pages, arrange them, or scan more. Done sends this set to the background queue.</p><div class="row wrap insert-pages"><label>Insert new pages<select id="insert-after"><option value="0">At the beginning</option>${included.map((p, i) => `<option value="${p.id}" ${i === included.length - 1 ? "selected" : ""}>After page ${i + 1}</option>`).join("")}</select></label><button id="insert-scan" data-work>Scan more pages</button><button id="insert-import" data-work>Insert files</button></div>`}
    <div class="document-details metadata-row" ${pageReview ? "hidden" : ""}>
      <label>Sender<input id="file-sender" list="known-senders" value="${esc(meta.sender_name || "")}" placeholder="Sender"><datalist id="known-senders">${senders.map((sender) => `<option value="${esc(sender.name)}"></option>`).join("")}</datalist></label>
      <label>Type<select id="file-type">${DOC_TYPES.map((t) => `<option value="${t}" ${t === (meta.doc_type || "other") ? "selected" : ""}>${t === "pursuit" ? "Pursuit" : t.replace(/_/g, " ")}</option>`).join("")}</select></label>
      <label>Document date<input id="file-date" type="date" value="${esc(meta.doc_date || "")}"></label>
    </div>
    <p class="muted scan-date">Scanned / imported: ${fmtDate(g.scanned_at)}${!meta.doc_date ? " \xB7 Document date not established" : ""}</p>
    <div ${pageReview ? "hidden" : ""}>${meta.refs.length || meta.doc_type === "pursuit" ? `<details class="reference-details" ${meta.doc_type === "pursuit" || g.recognition.case_handler || g.recognition.warning ? "open" : ""}><summary>References and case details (${meta.refs.length})</summary><div class="reference-grid">${meta.refs.map((ref, index) => `<label>${esc(referenceLabel(ref.kind))}<input data-reference="${index}" value="${esc(ref.value)}" title="${esc(ref.evidence || "")}"></label>`).join("")}<label>Case initiated<input id="case-opened" type="date" value="${esc(meta.case_opened_date || "")}"><small>Only when stated in the document</small></label></div>${recognitionHtml(g.recognition)}</details>` : recognitionHtml(g.recognition)}</div>
    ${g.warnings.length ? `<div class="notice"><ul>${g.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
      ${g.imports.map((i) => `<details><summary>${esc(i.name)}</summary>${esc(i.issue || "Waiting to read this file.")}</details>`).join("")}</div>` : ""}
    <div class="row between"><span class="muted">${pageLabel(included.length)}${blanks ? ` \xB7 ${blanks} blank ${blanks === 1 ? "page" : "pages"} removed` : ""}</span>
      ${processing ? "" : pageReview ? g.needs_preparation ? '<button id="read-pages" class="small" data-work>Prepare pages / retry</button>' : "" : needsReading ? '<button id="read-pages" class="small" data-work>Retry reading</button>' : '<span><button id="read-pages" class="small" data-work>Read pages again</button> <button id="recognize-details" class="small" data-work>Recognize details again</button></span>'}
      ${groups.length > 1 ? `<label class="sr" for="merge-group">Move all pages</label><select id="merge-group"><option value="">Move all pages to\u2026</option>${groups.filter((o) => o.id !== g.id).map((o) => `<option value="${o.id}">${esc(o.title)}</option>`).join("")}</select>` : ""}</div>
    <div class="pages">${included.map((p, i) => pageCard(g, p, i, included.length)).join("")}</div>
    ${!included.length && excluded.length ? '<p class="muted">No pages to save. Restore a page below if you want to keep it.</p>' : ""}
    ${excluded.length ? `<details id="excluded-pages"><summary>${excluded.length === blanks ? "Show removed blank pages" : "Show removed pages"} (${excluded.length})</summary><div class="pages">${excluded.map((p, i) => pageCard(g, p, i, excluded.length)).join("")}</div></details>` : ""}
    ${!g.pages.length && !g.imports.length ? '<p class="muted">Move pages here from another scan.</p><button id="remove-empty" class="small" data-work>Remove empty group</button>' : ""}
    ${g.related.length || g.other_groups.length || g.queue_duplicates.length || duplicateId && duplicateId !== g.target_id ? `<div class="relations"><h3>Related scans</h3>${g.other_groups.map((o) => `<p><button class="small" data-other="${o.id}">${esc(o.title)}</button> shares a reference</p>`).join("")}${g.related.map((d) => `<p><button class="small" data-related="${d.id}">${esc(d.title || d.sender_name || `Document ${d.id}`)}</button> \xB7 ${esc(d.value)}</p>`).join("")}${g.queue_duplicates.map((o) => `<p>Possible duplicate of queued document <button class="small" data-other="${o.id}">${esc(o.title)}</button></p>`).join("")}${duplicateId && duplicateId !== g.target_id ? `<p>Possible duplicate of <button class="small" data-related="${duplicateId}">document #${duplicateId}</button></p>` : ""}</div>` : ""}`;
}
function recognitionHtml(recognition) {
  const p = recognition.pursuit;
  const handler = recognition.case_handler;
  return `<p class="muted metadata-source">${esc(recognition.source)}${recognition.warning ? ` \xB7 ${esc(recognition.warning)}` : ""}</p>${handler ? `<dl class="case-handler" title="${esc(handler.evidence)}"><div><dt>Handled by</dt><dd>${esc(handler.name)}</dd></div>${handler.email ? `<div><dt>Direct email</dt><dd>${esc(handler.email)}</dd></div>` : ""}${handler.phone ? `<div><dt>Direct phone</dt><dd>${esc(handler.phone)}</dd></div>` : ""}${handler.routing_code ? `<div><dt>Contact code</dt><dd>${esc(handler.routing_code)}</dd></div>` : ""}</dl>` : ""}
  ${p ? `<div class="recognized-parties">${p.parties.map((party) => `<span><strong>${esc(party.role)}</strong> ${esc(party.name)}</span>`).join("")}<span><strong>Claim</strong> ${fmtAmount(p.claim_amount, p.currency || "CHF")}</span><span><strong>Interest</strong> ${fmtAmount(p.interest, p.currency || "CHF")}</span><span><strong>Fees</strong> ${fmtAmount(p.fees, p.currency || "CHF")}</span><span><strong>Outstanding</strong> ${fmtAmount(p.outstanding_amount, p.currency || "CHF")}</span></div>` : ""}
  ${recognition.dates.length ? `<details class="recognized-dates"><summary>Dates found in the document (${recognition.dates.length})</summary>${recognition.date_evidence ? `<p class="muted">Recognition evidence: ${esc(recognition.date_evidence)}</p>` : '<p class="muted">No unambiguous document date found.</p>'}<dl>${recognition.dates.map((date) => `<div title="${esc(date.evidence || "")}"><dt>${esc(date.label)}${date.page ? ` \xB7 page ${date.page}` : ""}</dt><dd>${fmtDate(date.date)}</dd></div>`).join("")}</dl></details>` : ""}`;
}
function pageCard(g, p, i, count) {
  return `<article class="page ${p.excluded ? "excluded" : ""}" data-page="${p.id}"><button class="page-image" data-preview-page="${p.id}" aria-label="Inspect page ${i + 1}"><img src="app://page/${p.id}/thumb?v=${g.revision}" loading="lazy" alt="Preview of page ${i + 1}"></button>
    <div class="page-meta"><div class="row"><strong>${p.excluded ? p.blank ? "Blank page" : "Removed page" : `Page ${i + 1}`}</strong>${p.marker ? `<span class="badge">${esc(p.marker)}</span>` : ""}</div>
    ${!p.excluded && g.phase !== "pages" ? `<span class="page-work" data-page-work="${p.id}" data-initial-state="${p.ocr_source ? "done" : "waiting"}">${p.ocr_source ? "Text ready" : "Waiting for OCR"}</span>` : ""}
    <small title="${esc(p.batch)}">${esc(p.batch)}</small>${p.issue && !(["pages", "queued", "processing"].includes(g.phase) && p.issue === "Not read yet") ? `<small title="${esc(p.issue)}">${esc(p.issue)}</small>` : ""}
    ${!p.excluded && groups.length > 1 ? `<label class="sr" for="move-${p.id}">Document for page ${i + 1}</label><select id="move-${p.id}" data-move="${p.id}">${groups.map((o) => `<option value="${o.id}" ${o.id === g.id ? "selected" : ""}>${esc(o.title)}</option>`).join("")}</select>` : ""}
    <div class="page-actions">${!p.excluded && count > 1 ? `<button class="small" data-up="${p.id}" data-work data-unavailable="${i === 0}" aria-label="Move page ${i + 1} earlier">\u2191</button><button class="small" data-down="${p.id}" data-work data-unavailable="${i === count - 1}" aria-label="Move page ${i + 1} later">\u2193</button>` : ""}<button class="small" data-exclude="${p.id}" data-work>${p.excluded ? "Restore page" : "Remove"}</button></div></div></article>`;
}
function openModal(html, preview = false) {
  ++previewVersion;
  modal.className = preview ? "preview" : "";
  modal.innerHTML = html;
  if (!modal.open) modal.showModal();
  $$("[data-close]", modal).forEach((b) => b.onclick = () => modal.close());
}
modal.addEventListener("close", () => {
  ++previewVersion;
  pdf = null;
  modal.innerHTML = "";
});
async function loadPdf(url) {
  const token = ++previewVersion;
  try {
    const lib = await import("./pdfjs/pdf.mjs");
    lib.GlobalWorkerOptions.workerSrc = "app://ui/pdfjs/pdf.worker.mjs";
    const loaded = await lib.getDocument({ url }).promise;
    if (token !== previewVersion) return;
    pdf = loaded;
    await drawPdf(1);
  } catch (e) {
    if (token === previewVersion) {
      const el = document.querySelector("#pdf-error");
      if (el) el.textContent = err(e);
    }
  }
}
async function drawPdf(n) {
  const token = ++previewVersion;
  if (!pdf) return;
  const total = pdf.numPages;
  const page = await pdf.getPage(n);
  if (token !== previewVersion) return;
  const canvas = $("#pdf-canvas"), viewport = page.getViewport({ scale: 1.3 });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: [1, 0, 0, 1, 0, 0]
  }).promise;
  if (token !== previewVersion) return;
  $("#pdf-position").textContent = `${n} / ${total}`;
  const prev = $("#pdf-prev"), next = $("#pdf-next");
  prev.disabled = n <= 1;
  next.disabled = n >= total;
  prev.onclick = () => void drawPdf(n - 1);
  next.onclick = () => void drawPdf(n + 1);
}
var pdfShell = () => '<div class="row"><button id="pdf-prev" class="small" aria-label="Previous PDF page">\u2190</button><span id="pdf-position" class="muted"></span><button id="pdf-next" class="small" aria-label="Next PDF page">\u2192</button></div><p id="pdf-error" class="error"></p><canvas id="pdf-canvas"></canvas>';
async function pagePreview(g, id) {
  const p = g.pages.find((p2) => p2.id === id), at = g.pages.indexOf(p);
  openModal(
    `<div class="preview-head row between"><h2>Page ${at + 1} \xB7 ${esc(g.title)}</h2><button class="close" data-close aria-label="Close">\xD7</button></div><div class="row between"><span class="muted">${esc(p.batch)} \xB7 original page ${p.source_page}</span><div class="row"><button id="review-prev" class="small" ${at === 0 ? "disabled" : ""}>Previous scan page</button><button id="review-next" class="small" ${at === g.pages.length - 1 ? "disabled" : ""}>Next scan page</button></div></div>${p.issue ? `<div class="notice">${esc(p.issue)}</div>` : ""}<details><summary class="muted">Recognized text</summary><p style="white-space:pre-wrap">${esc(p.text || "No text recognized.")}</p></details>${pdfShell()}`,
    true
  );
  $("#review-prev").onclick = () => void pagePreview(g, g.pages[at - 1].id);
  $("#review-next").onclick = () => void pagePreview(g, g.pages[at + 1].id);
  await loadPdf(`app://page/${id}?v=${g.revision}`);
}
var searchTimer;
var libraryGrouped = false;
var librarySort = "document";
async function renderLibrary(version) {
  const focus = document.activeElement?.id === "search";
  const params = { q: query, sort: librarySort, limit: 500 };
  const clusters = libraryGrouped ? await api("library_groups", params) : [{ id: 0, documents: await api("list_documents", params), relationships: [] }];
  if (version !== renderVersion) return;
  const docs = clusters.flatMap((c) => c.documents);
  const card = (d) => `<button class="document" data-doc="${d.id}"><img src="app://thumb/${d.id}" alt="" loading="lazy"><div><strong>${esc(d.title || d.batch || "Untitled document")}</strong><span class="muted">${esc(d.sender_name || "Unknown sender")} \xB7 ${pageLabel(d.pages || 0)}${d.duplicate_of ? " \xB7 possible duplicate" : ""}</span></div><div class="right">${librarySort === "scan" ? `Scanned ${fmtDate(d.scanned_at || d.created_at)}` : d.doc_date ? fmtDate(d.doc_date) : `Scanned ${fmtDate(d.scanned_at || d.created_at)}`}<p class="muted" style="margin:6px 0 0">${esc(d.doc_type || "document")}</p></div></button>`;
  $("#content").innerHTML = `<div class="library"><div class="library-head row between"><div><div class="eyebrow">Your archive</div><h1>Library</h1><span class="muted">${docs.length} documents${docs.length === 500 ? " \xB7 showing first 500" : ""}</span></div><label class="sr" for="search">Search library</label><input id="search" type="search" placeholder="Search title, sender, text, reference\u2026" value="${esc(query)}"></div>
    <div class="row wrap library-controls"><button id="group-library" class="${libraryGrouped ? "active" : ""}" aria-pressed="${libraryGrouped}">${libraryGrouped ? "Flat view" : "Group related documents"}</button><label>Sort by <select id="library-sort"><option value="document" ${librarySort === "document" ? "selected" : ""}>Document date</option><option value="scan" ${librarySort === "scan" ? "selected" : ""}>Scan date</option></select></label></div>
    ${clusters.map((c) => `<section class="document-list ${libraryGrouped ? "relationship-group" : ""}">${libraryGrouped ? `<h3>${c.documents.length > 1 ? `${c.documents.length} related documents` : "Document"}</h3>${c.relationships.length ? `<details class="relationship-reasons"><summary>Show relationships</summary>${c.relationships.map((e) => `<p><button class="small" data-doc="${e.a}">#${e.a}</button> \u2194 <button class="small" data-doc="${e.b}">#${e.b}</button> \xB7 ${esc(e.reason)}</p>`).join("")}</details>` : ""}` : ""}${c.documents.map(card).join("")}</section>`).join("")}
    ${!docs.length ? '<div class="empty"><h2>No documents here yet.</h2><p>Save a ready document from the queue to add it to Library.</p></div>' : ""}</div>`;
  $("#group-library").onclick = () => {
    libraryGrouped = !libraryGrouped;
    void render();
  };
  $("#library-sort").onchange = (e) => {
    librarySort = e.target.value;
    void render();
  };
  const search = $("#search");
  if (focus) {
    search.focus();
    search.setSelectionRange(query.length, query.length);
  }
  search.oninput = (e) => {
    query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void render(), 250);
  };
  $$("[data-doc]").forEach((b) => b.onclick = () => void documentDetail(Number(b.dataset.doc)));
}
async function documentDetail(id) {
  try {
    const d = await api("get_document", { id }), inv = d.invoice;
    openModal(
      `<div class="preview-head row between"><h2>${esc(d.title || "Document")}</h2><button class="close" data-close aria-label="Close">\xD7</button></div><p id="modal-message" role="status" hidden></p><div class="detail-metadata row wrap"><span>${esc(d.sender_name || "Unknown sender")} \xB7 ${fmtDate(d.doc_date)} \xB7 ${pageLabel(d.pages || 0)}</span><span class="spacer"></span><button id="revise" class="small" data-work>Review / add pages</button><button id="export-as" class="small" data-work data-unavailable="${!d.has_pdf}">Save PDF as\u2026</button><button id="open" class="small" data-work data-unavailable="${!d.has_pdf}">Open PDF</button></div>${d.duplicate_of ? `<div class="notice">Duplicate of document #${d.duplicate_of}.</div>` : ""}${d.flags && JSON.parse(d.flags).length ? `<details><summary>Recorded page warnings</summary><ul>${JSON.parse(d.flags).map((f) => `<li>${esc(f)}</li>`).join("")}</ul></details>` : ""}${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
    <details id="library-edit"><summary>Edit metadata</summary><form id="library-metadata-form"><div class="document-details metadata-row"><label>Title<input id="library-title" required value="${esc(d.title || "")}"></label><label>Sender<input id="library-sender" value="${esc(d.sender_name || "")}"></label><label>Type<select id="library-type">${DOC_TYPES.map((t) => `<option value="${t}" ${t === d.doc_type ? "selected" : ""}>${esc(t.replace(/_/g, " "))}</option>`).join("")}</select></label><label>Document date<input id="library-date" type="date" value="${esc(d.doc_date || "")}"></label></div><button class="small" type="submit" data-work>Save metadata</button></form></details>
    ${savedMetadataHtml(d)}
    ${inv ? `<div class="invoice-box row wrap"><strong>${fmtAmount(inv.amount_due ?? inv.amount, inv.currency)}</strong><span>${esc(inv.status)} \xB7 due ${fmtDate(inv.due_date)}</span><span class="spacer"></span>${!["paid", "void"].includes(inv.status) && !inv.is_notification ? '<button id="paid" class="small" data-work>Mark paid</button>' : ""}${["paid", "void"].includes(inv.status) ? '<button id="reopen-invoice" class="small" data-work>Reopen invoice</button>' : ""}${inv.qr_payload ? '<button id="qr" class="small">Payment QR</button>' : ""}</div>` : ""}
    ${d.related.length ? `<details><summary>Related documents</summary>${d.related.map((r) => `<button class="small" data-related-doc="${r.id}">${esc(r.title || `Document ${r.id}`)}</button>`).join(" ")}</details>` : ""}${d.sources.length ? `<details><summary>Original scans and previous versions (${d.sources.length})</summary><p class="muted">Recover an original into Review to retrieve excluded or missing pages.</p>${d.sources.map((source, i) => `<p><button class="small" data-source="${i}" data-work>Review original</button> ${esc(source.key.startsWith("revision/") ? "Previous PDF version" : source.key.split("/").pop())} \xB7 ${(source.bytes / 1024).toFixed(0)} KB</p>`).join("")}</details>` : ""}
    ${d.review_history.length ? `<details><summary>Review notes</summary>${d.review_history.map((r) => `<p><small>${fmtDate(r.at)}</small> ${esc(r.note || "Document saved.")}</p>`).join("")}</details>` : ""}
    ${d.has_pdf ? pdfShell() : '<p class="notice">Saved in Library. Open Review to finish reading the captured pages.</p>'}`,
      true
    );
    $("#library-metadata-form").onsubmit = (event) => {
      event.preventDefault();
      const values = {
        id,
        title: $("#library-title").value,
        sender_name: $("#library-sender").value,
        doc_type: $("#library-type").value,
        doc_date: $("#library-date").value || null
      };
      void act(async () => {
        await api("update_document", values);
        await documentDetail(id);
      }, "Metadata saved.");
    };
    $("#refresh-metadata").onclick = () => void act(async () => {
      await api("refresh_document_metadata", { id });
      await documentDetail(id);
    });
    $$("[data-source]", modal).forEach(
      (button) => button.onclick = () => {
        const key = d.sources[Number(button.dataset.source)].key;
        modal.close();
        void act(async () => {
          selected = await api("recover_source", { id, key });
          view = "review";
        });
      }
    );
    $("#revise").onclick = () => {
      modal.close();
      void act(async () => {
        selected = await api("reopen_document", { id });
        view = "review";
      });
    };
    $("#export-as").onclick = () => void act(async () => {
      const file = await bridge().exportPdf(id);
      if (file) message(`Saved PDF to ${file}`, true);
    });
    $("#open").onclick = () => void act(() => bridge().openExternal(id));
    $$("[data-related-doc]", modal).forEach(
      (b) => b.onclick = () => void documentDetail(Number(b.dataset.relatedDoc))
    );
    if (inv) {
      const paid = document.querySelector("#paid");
      if (paid) paid.onclick = () => void payDialog(inv.id, id);
      const reopen = document.querySelector("#reopen-invoice");
      if (reopen)
        reopen.onclick = () => void act(async () => {
          await api("invoice_reopen", { id: inv.id });
          await documentDetail(id);
        });
      const qr = document.querySelector("#qr");
      if (qr)
        qr.onclick = () => void act(async () => {
          const url = await api("render_qr", { invoice_id: inv.id });
          openModal(
            `<div class="row between"><h2>Payment QR</h2><button class="close" data-close>\xD7</button></div><p>${esc(d.sender_name || "")} \xB7 ${fmtAmount(inv.amount_due ?? inv.amount, inv.currency)}</p><img src="${esc(url)}" alt="Swiss payment QR code" style="display:block;max-width:100%;margin:auto">`
          );
        });
    }
    if (d.has_pdf) await loadPdf(`app://doc/${id}`);
    await updateStatus();
  } catch (e) {
    message(err(e));
  }
}
function savedMetadataHtml(d) {
  return `<div class="saved-dates"><span><strong>Document date</strong> ${fmtDate(d.doc_date)}</span><span><strong>${d.scan_date_source === "legacy_recorded_at" ? "Scan recorded (legacy)" : "Scanned / imported"}</strong> ${fmtDate(d.scanned_at || d.created_at)}</span>${d.doc_type === "pursuit" || d.case_opened_date ? `<span><strong>Case initiated</strong> ${d.case_opened_date ? fmtDate(d.case_opened_date) : "Not stated"}</span>` : ""}</div>
  <details class="reference-details" ${d.doc_type === "pursuit" || d.recognition.case_handler || d.recognition.warning ? "open" : ""}><summary>Document metadata${d.refs.length ? ` \xB7 ${d.refs.length} references` : ""}</summary><dl>${d.refs.map((ref) => `<div title="${esc(ref.evidence || "")}"><dt>${esc(referenceLabel(ref.kind))}</dt><dd>${esc(ref.value)}</dd></div>`).join("")}</dl>${recognitionHtml(d.recognition)}<p><button class="small" id="refresh-metadata" data-work>Recognize details again</button></p></details>
  ${d.metadata_history.length ? `<details><summary>Metadata history (${d.metadata_history.length})</summary><p class="muted">Document dates describe when the document applies. Recorded times show when the app knew each interpretation.</p>${d.metadata_history.map((version) => {
    const metadata = JSON.parse(version.snapshot);
    return `<p><strong>${esc(new Date(version.recorded_from).toLocaleString())}</strong> \xB7 ${esc(version.source)}<br>${esc(metadata.title)} \xB7 document date ${fmtDate(version.valid_from)}${metadata.case_opened_date ? ` \xB7 case initiated ${fmtDate(metadata.case_opened_date)}` : ""}${version.recorded_to ? `<br><small>Superseded ${esc(new Date(version.recorded_to).toLocaleString())}</small>` : ""}</p>`;
  }).join("")}</details>` : ""}`;
}
async function payDialog(invoiceId, documentId) {
  const accounts = await api("list_bank_accounts");
  openModal(
    `<h2>Record payment</h2><form id="payment-form"><div class="fields"><label>Account<select id="pay-account"><option value="">Unspecified</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.holder)} \xB7 ${esc(a.bank || "")}</option>`).join("")}</select></label><label>Payment date<input id="pay-date" type="date" required value="${nextWorkingDay()}"></label></div><label>Note<input id="pay-note"></label><div class="actions"><button type="button" data-close>Cancel</button><button class="primary" type="submit" data-work>Record paid</button></div></form>`
  );
  $("#payment-form").onsubmit = (e) => {
    e.preventDefault();
    void act(async () => {
      await api("invoice_paid", {
        id: invoiceId,
        account_id: Number($("#pay-account").value) || null,
        paid_date: $("#pay-date").value,
        note: $("#pay-note").value
      });
      await documentDetail(documentId);
    });
  };
}
async function renderSettings() {
  const cfg = await api("get_settings"), info = await api("storage_info");
  $("#content").innerHTML = `<div class="settings"><div class="eyebrow">A small, local app</div><h1>Settings</h1><section><h2>One file to keep</h2><p class="muted">Documents, original scans, excluded pages, previews, review work, and settings are stored together. Back up safely while the app is open, or close it and copy this file.</p><code>${esc(info.path)}</code><div class="row between"><span class="muted">${(info.size / 1024 / 1024).toFixed(1)} MB \xB7 SQLite with full-text search</span><button id="backup-btn" data-work>Back up database\u2026</button></div><p class="muted" style="margin-top:16px;margin-bottom:0">Restore: close docdoc and replace this database with your backup. Keep a copy of the current file first.</p></section><section><h2>Scanner & reading</h2><p class="muted">No folder watcher, login autostart, or tray process. USB scanning uses the installed SANE driver when you press Scan pages.</p><div class="row"><select id="scanner-device" aria-label="Scanner"><option value="${esc(String(cfg.scanner_device || ""))}">${esc(String(cfg.scanner_device || "Auto-select a single connected scanner"))}</option></select><button id="detect-scanner" data-work>Find scanner</button></div><label>Text recognition<select id="ocr-engine"><option value="paddleocr-vl" ${cfg.ocr_engine === "paddleocr-vl" ? "selected" : ""}>PaddleOCR-VL 1.6 \xB7 local, high accuracy</option><option value="tesseract" ${cfg.ocr_engine !== "paddleocr-vl" ? "selected" : ""}>Tesseract \xB7 lightweight</option></select></label><details><summary>OCR runtime</summary><label>Python executable<input id="ocr-python" value="${esc(String(cfg.ocr_python || "/pool/docdoc/ocr-venv/bin/python"))}"></label><label>Device<input id="ocr-device" value="${esc(String(cfg.ocr_device || "gpu:2"))}" placeholder="gpu:2 or cpu"></label><p class="muted">PaddleOCR loads only while reading pages and exits afterwards. Models are cached locally.</p><label>Tesseract languages<input id="ocr-languages" value="${esc(String(cfg.ocr_languages))}"></label></details><label>Document understanding<select id="metadata-provider"><option value="local-server" ${cfg.metadata_provider === "local-server" ? "selected" : ""}>Local model server</option><option value="claude-cli" ${cfg.metadata_provider === "claude-cli" ? "selected" : ""}>Claude Haiku</option><option value="local" ${cfg.metadata_provider === "local" ? "selected" : ""}>Local OCR only</option></select></label><div id="local-model-settings" ${cfg.metadata_provider !== "local-server" ? "hidden" : ""}><label>Server address<input id="model-server" type="url" value="${esc(String(cfg.metadata_base_url || "http://127.0.0.1:8080/v1"))}"></label><div class="row"><label>Model<input id="model-name" list="server-models" placeholder="Auto-select when only one is served" value="${esc(String(cfg.metadata_model || ""))}"><datalist id="server-models"></datalist></label><button id="connect-model" class="small" data-work>Find models</button></div><p id="model-connection" class="muted">Works with llama.cpp, Ollama and compatible model servers. OCR text stays on the server you choose; no automatic cloud fallback.</p></div><p id="claude-model-note" class="muted" ${cfg.metadata_provider !== "claude-cli" ? "hidden" : ""}>Haiku receives the included pages\u2019 OCR text through your Claude sign-in. It runs only during recognition; the result is saved in your database.</p><button id="save-settings" data-work>Save settings</button></section><section><h2>Review first</h2><p class="muted">Blank pages are removed automatically and can be restored. You can move or reorder the remaining pages before saving. Possible missing pages and related scans appear as helpful hints.</p></section></div>`;
  $("#backup-btn").onclick = () => void act(async () => {
    const file = await bridge().backup();
    if (file) message(`Backup saved: ${file}`, true);
  });
  $("#detect-scanner").onclick = () => void (async () => {
    try {
      const devices = await api("discover_scanners");
      $("#scanner-device").innerHTML = '<option value="">Auto-select a single connected scanner</option>' + devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("");
      message(
        devices.length ? `${devices.length} scanner(s) detected.` : "No scanner detected. Check USB and power.",
        Boolean(devices.length)
      );
    } catch (e) {
      message(err(e));
    }
  })();
  $("#metadata-provider").onchange = () => {
    const provider = $("#metadata-provider").value;
    $("#local-model-settings").hidden = provider !== "local-server";
    $("#claude-model-note").hidden = provider !== "claude-cli";
  };
  $("#connect-model").onclick = () => void (async () => {
    try {
      const models = await api("list_metadata_models", {
        base_url: $("#model-server").value
      });
      $("#server-models").innerHTML = models.map((model) => `<option value="${esc(model)}"></option>`).join("");
      if (models.length === 1)
        $("#model-name").value = models[0];
      $("#model-connection").textContent = models.length ? `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available.` : "Connected, but no models are loaded on this server.";
    } catch (error) {
      $("#model-connection").textContent = err(error);
    }
  })();
  $("#save-settings").onclick = () => void act(
    () => api("set_settings", {
      ocr_languages: $("#ocr-languages").value,
      scanner_device: $("#scanner-device").value,
      metadata_provider: $("#metadata-provider").value,
      metadata_base_url: $("#model-server").value,
      metadata_model: $("#model-name").value,
      ocr_engine: $("#ocr-engine").value,
      ocr_python: $("#ocr-python").value,
      ocr_device: $("#ocr-device").value
    }),
    "Settings saved."
  );
}
void render();
