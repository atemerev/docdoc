import type { ExtractedRef, PursuitDetails } from "./types";
import { normRef } from "./textsim";

export const PURSUIT_WORDS =
  /acte de d[ée]faut de biens|commandement de payer|proc[eè]s.verbal de saisie|avis de saisie|(?:poursuite|betreibung|esecuzione)\s*(?:n[°ºo.]|nr\.?|nummer|\n\s*\d)|Verlustschein|Zahlungsbefehl|Pf[äa]ndungs(?:urkunde|ank[üu]ndigung)|attestato di carenza di beni|precetto esecutivo/i;
const identifier =
  "([A-Z0-9][A-Z0-9./-]*(?:[ \\t]+[0-9]+)*(?:[ \\t]+[A-Z](?![a-zA-Z]))?)";
const patterns: Array<[ExtractedRef["kind"], RegExp]> = [
  [
    "pursuit_no",
    new RegExp(
      "(?:poursuite|betreibung|esecuzione)[ \\t]*(?:n[°ºo.]|nr\\.?|nummer)[ \\t]*:?[ \\t]*" +
        identifier,
      "gi",
    ),
  ],
  [
    "debt_certificate_no",
    new RegExp(
      "(?:ADB|Verlustschein|attestato)[ \\t]*(?:n[°ºo.]|nr\\.?|nummer)[ \\t]*:?[ \\t]*" +
        identifier,
      "gi",
    ),
  ],
];
export function pursuitMetadata(text: string): {
  pursuit: PursuitDetails;
  refs: ExtractedRef[];
} {
  const refs: ExtractedRef[] = [];
  const parties: PursuitDetails["parties"] = [];
  const add = (
    kind: ExtractedRef["kind"],
    value: string,
    page: number,
    evidence: string,
  ) => {
    value = value.replace(/[.\s]+$/, "").trim();
    if (
      !/\d/.test(value) ||
      normRef(value).length < 4 ||
      refs.some((r) => r.kind === kind && normRef(r.value) === normRef(value))
    )
      return;
    refs.push({ kind, value, page, evidence: evidence.trim().slice(0, 240) });
  };
  for (const [pageIndex, page] of text.split("\f").entries()) {
    for (const [kind, regex] of patterns)
      for (const match of page.matchAll(regex))
        add(kind, match[1], pageIndex + 1, match[0]);
    const rawLines = page.split("\n");
    for (const [index, line] of rawLines.entries()) {
      const label = /\b(?:Poursuite|Betreibung|Esecuzione)\s*:?\s*$/i.exec(
        line,
      );
      if (!label) continue;
      // Follow the label's column, not the next postal address in OCR order.
      for (const next of rawLines.slice(index + 1, index + 5)) {
        const match = new RegExp("^[ \\t]*" + identifier).exec(
          next.slice(Math.max(0, label.index - 8)),
        );
        if (match && normRef(match[1]).length >= 7) {
          add("pursuit_no", match[1], pageIndex + 1, `Poursuite ${match[1]}`);
          break;
        }
      }
    }
    const lines = page
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const label = lines[i].split(/\s{3,}/)[0];
      const role =
        /^(?:repr[ée]sentant du cr[ée]ancier|gl[aä]ubigervertreter)\s*:?$/i.test(
          label,
        )
          ? "representative"
          : /^(?:cr[ée]ancier|gl[aä]ubiger|creditore)\s*:?$/i.test(label)
            ? "creditor"
            : /^(?:d[ée]biteur|schuldner|debitore)\s*:?$/i.test(label)
              ? "debtor"
              : null;
      if (role && lines[i + 1])
        parties.push({
          role,
          name: lines[i + 1].split(/\s{3,}/)[0],
          page: pageIndex + 1,
        });
      const claim =
        /^\[\d+\]\s*([A-Z0-9-]{4,})\s*,\s*(?:Facture|Rechnung|Invoice)\s+du\s+\d{2}[./]\d{2}[./]\d{4}\s*,\s*([A-Z0-9-]{4,})/i.exec(
          lines[i],
        );
      if (claim) {
        add("claim_no", claim[1], pageIndex + 1, lines[i]);
        add("invoice_no", claim[2], pageIndex + 1, lines[i]);
      }
    }
  }
  const amount = (label: string): number | null => {
    const match = new RegExp(
      "(?:^|\\n)[ \\t]*" + label + "[^\\d\\n]*([\\d'’ ]+\\d[.,]\\d{2})",
      "i",
    ).exec(text);
    return match
      ? Number(match[1].replace(/['’ ]/g, "").replace(",", "."))
      : null;
  };
  const subtype =
    /acte de d[ée]faut de biens|Verlustschein|attestato di carenza/i.test(text)
      ? "Acte de défaut de biens"
      : /commandement de payer|Zahlungsbefehl|precetto esecutivo/i.test(text)
        ? "Commandement de payer"
        : /avis de saisie|Pf[äa]ndungsank/i.test(text)
          ? "Avis de saisie"
          : "Poursuite";
  return {
    refs,
    pursuit: {
      subtype,
      parties,
      claim_amount: amount("Montant de la cr[ée]ance"),
      interest: amount("Int[ée]r[êe]ts"),
      fees: amount("Frais"),
      outstanding_amount: amount("Montant total du d[ée]couvert"),
      currency: /CHF|francs|Fr\./.test(text) ? "CHF" : null,
    },
  };
}
