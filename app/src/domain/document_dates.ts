import type { ExtractedDate } from "./types";

export const validDate = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
};
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const months = [
  "janvier january januar gennaio",
  "fevrier february februar febbraio",
  "mars march marz marzo",
  "avril april aprile",
  "mai may maggio",
  "juin june juni giugno",
  "juillet july juli luglio",
  "aout august agosto",
  "septembre september settembre",
  "octobre october oktober ottobre",
  "novembre november novembre",
  "decembre december dezember dicembre",
];
const datePattern =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}|\d{1,2}(?:er|\.)?\s+[\p{L}]+\s+\d{4})\b/gu;
function parseDate(text: string): string | null {
  if (/^\d{4}-/.test(text)) return validDate(text);
  const parts = fold(text).match(
    /^(\d{1,2})(?:er|\.)?[\s./]+([a-z]+|\d{1,2})[\s./]+(\d{4})$/,
  );
  if (!parts) return null;
  const month = /^\d+$/.test(parts[2])
    ? Number(parts[2])
    : months.findIndex((m) => m.split(" ").includes(parts[2])) + 1;
  return validDate(
    `${parts[3]}-${String(month).padStart(2, "0")}-${parts[1].padStart(2, "0")}`,
  );
}

/** Event time comes from labeled evidence. Birthdays and dates of referenced
 * claims are never fallbacks for the date of a pursuit document. */
export function documentDates(text: string, pursuit = false) {
  const events: ExtractedDate[] = [];
  const candidates: Array<{
    date: string;
    score: number;
    evidence: string;
    page: number;
  }> = [];
  for (const [pageIndex, pageText] of text.split("\f").entries()) {
    const mainAct =
      pursuit &&
      /(?:ADB\s*n|Verlustschein|attestato di carenza)/i.test(pageText) &&
      /(?:montant|betrag|importo)/i.test(pageText);
    const cover = /(?:en annexe|ci.joint|beigefugt|enclosed)/i.test(
      fold(pageText),
    );
    const lines = pageText.split("\n");
    let nonempty = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.trim()) nonempty++;
      for (const match of line.matchAll(datePattern)) {
        const date = parseDate(match[0]);
        if (!date) continue;
        const before = line.slice(0, match.index).trimEnd();
        const prefix = fold(
          before
            .split(/\s{4,}/)
            .filter(Boolean)
            .pop() ||
            lines.slice(Math.max(0, lineIndex - 2), lineIndex).join(" "),
        ).trim();
        const evidence = line
          .trim()
          .replace(/\s{3,}/g, " · ")
          .slice(0, 240);
        let kind: NonNullable<ExtractedDate["kind"]> = "mentioned",
          label = "Mentioned date",
          score = 0;
        if (
          /\b(ne\(e\)|ne|nee|naissance|geburt|geboren|birth|born|nato|nata|enfants?|children)\b/.test(
            prefix,
          ) ||
          /ne\(e\)/.test(prefix)
        ) {
          kind = "birth";
          label = "Birth date";
        } else if (
          /(?:ouverture|introduction|initiation|opened|eroffnung|einleitung|apertura).{0,45}(?:poursuite|procedure|dossier|case|verfahren)?|(?:requisition de poursuite|betreibungsbegehren)\s*(?:du|vom|le)?\s*$/.test(
            prefix,
          )
        ) {
          kind = "case_opened";
          label = "Case initiated";
        } else if (
          /(?:execution|pfandung|saisie|pignoramento)\s*:?\s*$/.test(prefix)
        ) {
          kind = "execution";
          label = "Enforcement / execution";
        } else if (
          pursuit &&
          /(?:facture|rechnung|invoice|creance|claim).{0,30}$/.test(prefix)
        ) {
          kind = "claim";
          label = "Underlying claim / invoice";
        } else if (
          /(?:echeance|payable|due date|fallig|zahlbar|scadenza).{0,25}$/.test(
            prefix,
          )
        ) {
          kind = "due";
          label = "Due date";
        } else if (
          /(?:constat|feststellung|observation).{0,20}$/.test(prefix)
        ) {
          kind = "observation";
          label = "Observation";
        } else if (
          /(?:date (?:du document|d.emission)|document date|issued|ausgestellt|datum|data di emissione)\s*:?\s*$/.test(
            prefix,
          ) ||
          /[\p{L}-]+,\s*(?:le|den|il)?\s*$/u.test(prefix)
        ) {
          kind = cover && !mainAct ? "cover_letter" : "document";
          label =
            kind === "cover_letter" ? "Covering letter" : "Document issued";
          score = mainAct ? 120 : cover ? 80 : 100;
        } else if (
          !pursuit &&
          /(?:facture|rechnung|invoice).{0,20}$/.test(prefix)
        ) {
          kind = "document";
          label = "Invoice issued";
          score = 90;
        } else if (
          !pursuit &&
          pageIndex === 0 &&
          nonempty <= 10 &&
          !prefix &&
          match[0].trim() === line.trim()
        ) {
          kind = "document";
          label = "Header date";
          score = 30;
        }
        events.push({ date, kind, label, page: pageIndex + 1, evidence });
        if (score)
          candidates.push({ date, score, page: pageIndex + 1, evidence });
      }
    }
  }
  const best = Math.max(0, ...candidates.map((c) => c.score));
  const dates = [
    ...new Set(candidates.filter((c) => c.score === best).map((c) => c.date)),
  ];
  const chosen =
    dates.length === 1
      ? candidates.find((c) => c.score === best && c.date === dates[0])
      : null;
  const opened = [
    ...new Set(
      events.filter((e) => e.kind === "case_opened").map((e) => e.date),
    ),
  ];
  return {
    doc_date: chosen?.date || null,
    case_opened_date: opened.length === 1 ? opened[0] : null,
    date_evidence: chosen ? `Page ${chosen.page}: ${chosen.evidence}` : null,
    ref_dates: events.filter(
      (e, i) =>
        events.findIndex(
          (o) => o.date === e.date && o.kind === e.kind && o.page === e.page,
        ) === i,
    ),
  };
}
