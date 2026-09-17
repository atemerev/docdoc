// Match names conservatively: punctuation, accents, spacing and legal suffixes
// vary in OCR. Ambiguous shortened names must not merge distinct organizations.
export interface SenderIdentity {
  id: number;
  key: string;
  name: string;
  uid?: string | null;
  iban?: string | null;
}

export const senderName = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
const compact = (name: string): string => senderName(name).replace(/ /g, "");
const base = (name: string): string =>
  compact(
    senderName(name).replace(
      /\b(ag|sa|sarl|gmbh|ltd|limited|inc|incorporated|llc|corp|corporation)\b/g,
      "",
    ),
  );
const unique = <T>(rows: T[]): T | undefined =>
  rows.length === 1 ? rows[0] : undefined;

export function matchSender<T extends SenderIdentity>(
  senders: T[],
  name: string,
  identity: { uid?: string | null; iban?: string | null } = {},
): T | undefined {
  const exact = senders.filter((s) => compact(s.name) === compact(name));
  // Reuse an existing exact identity even if historical duplicates exist.
  if (exact.length) return exact.sort((a, b) => a.id - b.id)[0];
  const uid = identity.uid?.replace(/\D/g, "");
  if (uid) {
    const found = unique(
      senders.filter((s) => s.uid?.replace(/\D/g, "") === uid),
    );
    if (found) return found;
  }
  const nameBase = base(name);
  if (nameBase.length >= 4) {
    const found = unique(senders.filter((s) => base(s.name) === nameBase));
    if (found) return found;
  }
  const keyed = unique(senders.filter((s) => compact(s.key) === compact(name)));
  if (keyed) return keyed;
  // A shared payment account alone is not enough to identify an organization.
  const iban = identity.iban?.replace(/\s/g, "").toUpperCase();
  if (iban && nameBase.length >= 4)
    return unique(
      senders.filter(
        (s) =>
          s.iban?.replace(/\s/g, "").toUpperCase() === iban &&
          (base(s.name).startsWith(nameBase) ||
            nameBase.startsWith(base(s.name))),
      ),
    );
  return undefined;
}

export function senderFromHeader<T extends SenderIdentity>(
  senders: T[],
  text: string,
): T | undefined {
  // Restrict lookup to the header; a bank or recipient mentioned later is not
  // evidence that it sent the document. Test columns separately for date lines.
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);
  for (const line of lines) {
    if (
      /^(direct print|printed|print.out|page |seite |to:|date:|an:|datum:|dear |sehr geehrte|madame|monsieur)/i.test(
        line,
      )
    )
      continue;
    for (const part of line.split(/\s{3,}/)) {
      const found = matchSender(senders, part.replace(/^[^\p{L}\p{N}]+/u, ""));
      if (found) return found;
    }
  }
  return undefined;
}
