// Small DOM/formatting helpers shared by the renderer views.

export const $ = <E extends Element = HTMLElement>(
  sel: string, el: ParentNode = document,
): E => el.querySelector(sel) as E;

export const $$ = <E extends Element = HTMLElement>(
  sel: string, el: ParentNode = document,
): E[] => [...el.querySelectorAll(sel)] as E[];

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
       "'": "&#39;" }[c] as string));

export const fmtAmount = (v: number | null | undefined, cur = "CHF"): string =>
  v == null ? "" :
  `${cur} ${Number(v).toLocaleString("de-CH", { minimumFractionDigits: 2 })}`;

export const fmtDate = (d: string | null | undefined): string =>
  d ? String(d).slice(0, 10) : "—";

/** Next working day (weekends skipped), local time, ISO date. */
export function nextWorkingDay(): string {
  const d = new Date();
  do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// IBAN: ISO 13616 -- shown grouped by 4, stored compact; mod-97 check
// mirrors domain/qrbill.ts on the main side.
export const ibanCompact = (s: string): string =>
  String(s || "").replace(/\s+/g, "").toUpperCase();

export const ibanGroup = (s: string | null | undefined): string =>
  ibanCompact(s ?? "").replace(/(.{4})/g, "$1 ").trim();

export function ibanValid(iban: string): boolean {
  const s = ibanCompact(iban);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const digits = (s.slice(4) + s.slice(0, 4))
    .replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

export const isQrIban = (iban: string): boolean => {
  const iid = parseInt(ibanCompact(iban).slice(4, 9), 10);
  return iid >= 30000 && iid <= 31999;
};
