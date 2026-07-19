#!/usr/bin/env node
// Round-trip test for the Swiss QR-bill parser (JS port): synthesize an
// SPC payload, render it as a QR image (qrencode), decode it back
// (zbarimg), parse, verify. Mirrors tests/test_qrbill.py.
// Run: node tests/test_qrbill.js   (or ELECTRON_RUN_AS_NODE=1 electron)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const qrbill = require(path.join(__dirname, "..", "app", "lib", "qrbill.js"));

const failures = [];
function check(name, cond, detail = "") {
  console.log(`  [${cond ? "ok" : "FAIL"}] ${name} ${detail}`);
  if (!cond) failures.push(name);
}

function makeQrr(base26) {
  let carry = 0;
  for (const d of base26)
    carry = qrbill.MOD10_TABLE[(carry + Number(d)) % 10];
  return base26 + String((10 - carry) % 10);
}

async function main() {
  console.log("== validation primitives ==");
  check("IBAN valid", qrbill.ibanValid("CH4431999123000889012"));
  check("IBAN invalid detected", !qrbill.ibanValid("CH4431999123000889013"));
  check("QR-IBAN detected", qrbill.isQrIban("CH4431999123000889012"));
  check("normal IBAN not QR", !qrbill.isQrIban("CH9300762011623852957"));
  // worked example from the SIX IG: 26-digit ref -> check digit 7
  const ig = makeQrr("21000000000313947143000901");
  check("QRR IG example check digit", ig.endsWith("7"), ig);
  check("QRR valid", qrbill.qrrValid(ig));
  check("QRR bad check digit", !qrbill.qrrValid(ig.slice(0, -1) + "5"));
  check("SCOR valid", qrbill.scorValid("RF18539007547034"));
  check("SCOR invalid", !qrbill.scorValid("RF19539007547034"));

  console.log("== swico ==");
  const s = qrbill.parseSwico(
    "//S1/10/10201409/11/190512/20/1400.000-53/30/106017086/32/7.7/40/2:10;0:30");
  check("swico invoice_no", s.invoice_no === "10201409");
  check("swico invoice_date", s.invoice_date === "2019-05-12");
  check("swico uid", s.uid === "106017086");
  check("swico due date (invoice+30d)", s.due_date === "2019-06-11", s.due_date);
  check("swico discounts",
        JSON.stringify(s.discounts) === JSON.stringify([[2.0, 10], [0.0, 30]]));
  const esc = qrbill.parseSwico("//S1/10/X.66711\\/8824/11/200712");
  check("swico escaped slash", esc.invoice_no === "X.66711/8824", esc.invoice_no);

  console.log("== SPC round trip through a real QR image ==");
  const qrr = makeQrr("21000000000313947143000901");
  const payload = [
    "SPC", "0200", "1",
    "CH4431999123000889012",
    "S", "Max Muster & Söhne", "Musterstrasse", "123", "8000", "Seldwyla", "CH",
    "", "", "", "", "", "", "",
    "1949.75", "CHF",
    "S", "Simon Muster", "Musterstrasse", "1", "8000", "Seldwyla", "CH",
    "QRR", qrr,
    "Auftrag vom 15.06.2026",
    "EPD",
    "//S1/10/10201409/11/260615/30/106017086/40/0:30",
  ].join("\r\n");
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "qrtest-"));
  let found = null;
  try {
    const png = path.join(td, "qr.png");
    execFileSync("qrencode",
      ["-l", "M", "-s", "6", "-m", "4", "-o", png, payload]);
    found = await qrbill.findQrbill([png]);
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
  check("QR decoded & parsed", found !== null);
  if (found) {
    check("iban", found.iban === "CH4431999123000889012");
    check("is QR-IBAN", found.is_qr_iban);
    check("creditor name", found.creditor.name === "Max Muster & Söhne",
          JSON.stringify(found.creditor));
    check("amount", found.amount === 1949.75);
    check("currency", found.currency === "CHF");
    check("ref", found.reference === qrr);
    check("debtor", found.debtor.name === "Simon Muster");
    check("swico due date", found.swico.due_date === "2026-07-15",
          String(found.swico.due_date));
    check("no problems", found.problems.length === 0,
          JSON.stringify(found.problems));
    check("not a notification", !found.is_notification);
  }

  console.log("== K-address (v2.2 legacy) and notification bills ==");
  const legacy = payload.replace(
    "S\r\nMax Muster & Söhne\r\nMusterstrasse\r\n123\r\n8000\r\nSeldwyla\r\nCH",
    "K\r\nMax Muster & Söhne\r\nMusterstrasse 123\r\n8000 Seldwyla\r\n\r\n\r\nCH");
  const k = qrbill.parseSpc(legacy);
  check("K address parsed", k && k.creditor.line2 === "8000 Seldwyla",
        JSON.stringify(k && k.creditor));
  const notif = qrbill.parseSpc(payload.replace("1949.75", "0.00"));
  check("0.00 = notification", notif.is_notification);

  console.log("== QR render with Swiss cross (JS-only addition) ==");
  const rendered = await qrbill.renderQrPng(payload);
  check("renders a PNG", rendered.length > 1000 &&
        rendered.subarray(1, 4).toString() === "PNG");

  console.log();
  if (failures.length) {
    console.log(`FAILED: ${failures.length}: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("all tests passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
