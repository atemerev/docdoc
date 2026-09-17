import { pageMarker } from "./pageorder";
export interface CheckPage {
  id: number;
  text: string;
  blank: number;
  excluded: number;
  issue: string | null;
}
/** Show concrete problems without turning ordinary scans into warnings. */
export function checkPages(pages: CheckPage[]): string[] {
  const kept = pages.filter((p) => !p.excluded),
    warnings: string[] = [];
  if (!kept.length) warnings.push("No pages are included.");
  if (kept.some((p) => p.issue?.startsWith("Scan interrupted")))
    warnings.push(
      "The scan was interrupted; check for missing or damaged pages.",
    );
  if (kept.some((p) => p.issue && !p.issue.startsWith("Scan interrupted")))
    warnings.push(
      "Some pages have not been read successfully. Check their previews.",
    );
  const markers = kept.map((p) => pageMarker(p.text)).filter((m) => m !== null);
  const totals = [...new Set(markers.map((m) => m[1]))];
  if (totals.length > 1)
    warnings.push(
      "Different printed page totals: these may be separate documents.",
    );
  for (const total of totals) {
    const numbers = markers.filter((m) => m[1] === total).map((m) => m[0]);
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter(
      (n) => !numbers.includes(n),
    );
    if (missing.length)
      warnings.push(
        `Possible missing pages: ${missing.join(", ")} (of ${total}).`,
      );
    if (new Set(numbers).size !== numbers.length)
      warnings.push(
        `Repeated page numbers (of ${total}): check for duplicates or mixed documents.`,
      );
    if (numbers.some((n, i) => i > 0 && n < numbers[i - 1]))
      warnings.push("Printed page numbers are out of order.");
  }
  return [...new Set(warnings)];
}
