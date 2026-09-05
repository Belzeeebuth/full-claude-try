/**
 * Comparaison de versions « noyau / Mesa / pilote » : "6.10" > "6.8" (pas de
 * comparaison lexicale !), "570" > "550", "24.2.1" > "24.2".
 */
export function parseVersion(version: string): number[] {
  return version
    .trim()
    .split(/[.\-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => Number.isFinite(n));
}

/** Négatif si a < b, 0 si égales, positif si a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `actual` satisfait-il `min` ? `undefined` si l'une des deux est inconnue. */
export function satisfiesMin(actual: string | undefined, min: string | undefined): boolean | undefined {
  if (actual === undefined || min === undefined) return undefined;
  return compareVersions(actual, min) >= 0;
}

export function maxVersion(...versions: (string | undefined)[]): string | undefined {
  return versions
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort(compareVersions)
    .at(-1);
}
