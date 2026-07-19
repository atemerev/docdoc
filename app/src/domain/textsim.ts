// Text normalization and similarity primitives for dedup. Pure.

import { createHash } from "crypto";

export function normalizeText(text: string | null | undefined): string {
  return String(text ?? "").toLowerCase().replace(/ß/g, "ss")
    .replace(/[^a-z0-9äöüéèàâçêîôû]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

export const textHash = (text: string | null | undefined): string =>
  createHash("sha256").update(normalizeText(text)).digest("hex");

export function trigrams(text: string | null | undefined): Set<string> {
  const t = normalizeText(text);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Normalize an internal reference for matching: uppercase alnum only. */
export const normRef = (value: unknown): string =>
  String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Normalize text for indexing/search: ss for ß (unicode61 doesn't fold it). */
export const fold = (text: string | null | undefined): string =>
  (text ?? "").replace(/ß/g, "ss");

export function slugify(name: string | null | undefined): string {
  const s = String(name ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40) || "unknown";
}
