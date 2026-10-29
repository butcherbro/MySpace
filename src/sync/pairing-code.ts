/**
 * Pairing code display and input rules (ADR-0011 amendment 2026-10-29).
 * Codes have 8 digits; builds before SPAKE2 pairing showed and accepted 6.
 */

/**
 * "12 345 678". The 2-3-3 grouping is deliberate: an older build's code input
 * keeps only 7 characters and pairs at 6 digits, and the first 7 characters of
 * this format hold only 5 digits, so pasting it there never yields a
 * 6-digit code an older build would send.
 */
export function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 2)} ${code.slice(2, 5)} ${code.slice(5)}` : code;
}

/**
 * Whether "Pair" can be pressed. 6 digits are let through on purpose: the
 * backend answers them with "update MySpace on the other device".
 */
export function canSubmitCode(raw: string): boolean {
  const digits = raw.replace(/\s/g, "");
  return digits.length === 8 || digits.length === 6;
}
