import type { CaseHandler, ExtractedRef } from "./types";
import { normRef } from "./textsim";

const handlerLabel =
  /(?:^|[ \t]{2,})(?:dossier[ \t]+trait[ée][ \t]+par|(?:dossier|affaire)[ \t]+suivi[e]?[ \t]+par|votre[ \t]+interlocut(?:eur|rice)|personne[ \t]+en[ \t]+charge|gestionnaire|sachbearbeiter(?:in)?|bearbeitet[ \t]+von|handled[ \t]+by|case[ \t]+(?:handler|officer)|contact[ \t]+person)[ \t]*:?[ \t]*/i;
const referenceLabels: RegExp[] = [
  /(?:^|[ \t]{2,})(?:dossier|case|affaire|fall|schadens?)(?=[ \t:#.-]|$)[ \t-]*(?:(?:n[°ºo.]|nr\.?|number|nummer|reference|r[ée]f[ée]rence)[ \t]*)?[:#]?[ \t]*/i,
  /(?:^|[ \t]{2,})(?:aktenzeichen|gesch[äa]ftsnummer)[ \t]*:?[ \t]*/i,
  /(?:^|[ \t]{2,})(?:[vn]\/?[ \t]*r[ée]f\.?|r[ée]f(?:[ée]rences?)?\.?|(?:our|your)[ \t]+ref(?:erence)?\.?|reference)[ \t]*:?[ \t]*/i,
];

function identifier(value: string): string | null {
  // Keep spaces and punctuation within identifiers, but stop at prose or a
  // separate printed column. A dossier handler or a postal box is not an ID.
  const field = value.trim().split(/[ \t]{3,}/)[0];
  const match =
    /^(?:[A-Z]{1,6}[ \t]+)?(?=[A-Z0-9./-]*\d)[A-Z0-9][A-Z0-9./-]*(?:[ \t]+(?=[A-Z0-9./-]*\d)[A-Z0-9][A-Z0-9./-]*)*(?:[ \t]+\/[ \t]+[A-Z]{2,6}\b)?/i.exec(
      field,
    );
  const result = match?.[0].replace(/[.\s]+$/, "");
  return result && normRef(result).length >= 4 ? result : null;
}

export function correspondenceMetadata(
  text: string,
  pursuit = false,
): {
  refs: ExtractedRef[];
  case_handler: CaseHandler | null;
} {
  const refs: ExtractedRef[] = [];
  const handlers: CaseHandler[] = [];
  for (const [pageIndex, page] of text.split("\f").entries()) {
    const lines = page.split("\n");
    for (const [i, line] of lines.entries()) {
      const handler = handlerLabel.exec(line);
      if (handler) {
        let nameLine = i;
        let name = line.slice(handler.index + handler[0].length).trim();
        if (!name) {
          while (nameLine < Math.min(i + 3, lines.length - 1) && !name) {
            nameLine++;
            name = lines[nameLine].trim();
          }
        }
        name = name.split(/[ \t]{3,}/)[0];
        if (
          name &&
          name.length <= 100 &&
          /^[\p{L}\p{M} .’'-]+$/u.test(name) &&
          !referenceLabels.some((rx) => rx.test(name))
        ) {
          const details = [line.trim(), ...(nameLine > i ? [name] : [])];
          let email: string | null = null,
            phone: string | null = null;
          // Only adjacent contact lines belong to this person. Stop before a
          // reference, recipient or body text, even if another email is nearby.
          for (const contact of lines.slice(nameLine + 1, nameLine + 5)) {
            if (
              referenceLabels.some((rx) => rx.test(contact)) ||
              handlerLabel.test(contact)
            )
              break;
            if (!contact.trim()) break;
            const mail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(
              contact,
            )?.[0];
            const tel =
              /^[ \t]*(?:(?:t(?:[ée]l(?:[ée]phone)?)?|phone|direct|telephone)\.?[ \t]*:?[ \t]*)?(\+?\d[\d ()/.-]{6,}\d)[ \t]*$/i.exec(
                contact,
              )?.[1];
            if (!mail && !tel) break;
            email ||= mail || null;
            phone ||= tel || null;
            details.push(contact.trim());
          }
          handlers.push({
            name,
            email,
            phone,
            routing_code: null,
            page: pageIndex + 1,
            evidence: details.join("\n").slice(0, 400),
          });
        }
      }
      for (const [labelIndex, regex] of referenceLabels.entries()) {
        for (const label of line.matchAll(new RegExp(regex.source, "gi"))) {
          let rest = line.slice(label.index + label[0].length);
          // A bare label can place its value on the following line. Follow its
          // column so an adjacent postal address cannot become the reference.
          if (!rest.trim()) {
            const column =
              label.index + (label[0].match(/^[ \t]*/)?.[0].length || 0);
            const next = lines
              .slice(i + 1, i + 4)
              .find((value) => value.trim());
            rest = next?.slice(Math.max(0, column - 2)) || "";
          }
          const value = identifier(rest);
          if (value)
            refs.push({
              kind: labelIndex === 2 && pursuit ? "office_ref" : "case_no",
              value,
              page: pageIndex + 1,
              evidence:
                `${line.trim()}${line.slice(label.index + label[0].length).trim() ? "" : `\n${rest.trim()}`}`.slice(
                  0,
                  240,
                ),
            });
        }
      }
    }
  }
  // Some return slips append the employee's routing code to a reference that
  // is also printed separately. Only split it when that base is corroborated.
  const codes = new Set<string>();
  for (const ref of refs) {
    const suffix = /^(.*?)\s+\/\s+([A-Z]{2,6})$/.exec(ref.value);
    if (
      suffix &&
      refs.some(
        (other) =>
          other.kind === ref.kind &&
          normRef(other.value) === normRef(suffix[1]),
      )
    ) {
      ref.value = suffix[1];
      codes.add(suffix[2]);
    }
  }
  // Conflicting named handlers need review; do not silently choose one.
  const uniqueHandlers = [
    ...new Map(handlers.map((h) => [h.name.toLocaleLowerCase(), h])).values(),
  ];
  const case_handler = uniqueHandlers.length === 1 ? uniqueHandlers[0] : null;
  if (case_handler && codes.size === 1)
    case_handler.routing_code = [...codes][0];
  return {
    case_handler,
    refs: refs.filter(
      (ref, i) =>
        refs.findIndex(
          (other) =>
            other.kind === ref.kind &&
            normRef(other.value) === normRef(ref.value),
        ) === i,
    ),
  };
}
