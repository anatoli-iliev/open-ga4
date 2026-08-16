import { Ga4Error } from "../ga4/errors.js";

export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  BAD_INPUT: 2,
  SETUP_INCOMPLETE: 3,
  GOOGLE_REFUSED: 4,
} as const;

/**
 * Codes that mean "you have not finished setting this up", not "Google said no".
 *
 * Both CREDENTIALS_MISSING and NO_CREDENTIALS are listed. src/ga4/errors.ts
 * raises CREDENTIALS_MISSING; src/runtime.ts still raises the older
 * NO_CREDENTIALS. A later task collapses them into one, but until then a
 * missing-credentials failure must still land on exit 3, not exit 4.
 */
const SETUP_CODES = new Set([
  "CREDENTIALS_MISSING",
  "NO_CREDENTIALS",
  "CREDENTIALS_REJECTED",
  "CLOCK_SKEW",
  "DATA_API_DISABLED",
  "ADMIN_API_DISABLED",
  "SERVICE_DISABLED",
  "NO_PROPERTY_ACCESS",
  "NO_PROPERTY",
  "PROPERTY_NOT_FOUND",
]);

export function exitCodeFor(error: unknown): number {
  if (error instanceof Ga4Error) {
    if (SETUP_CODES.has(error.code)) return EXIT.SETUP_INCOMPLETE;
    if (error.code === "INVALID_REQUEST") return EXIT.BAD_INPUT;
    return EXIT.GOOGLE_REFUSED;
  }
  return EXIT.UNEXPECTED;
}
