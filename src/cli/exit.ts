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
 * CREDENTIALS_MISSING is the single code for a missing credential: both
 * src/ga4/errors.ts and src/runtime.ts raise it, so there is exactly one
 * branch to reach here, not two.
 */
const SETUP_CODES = new Set([
  "CREDENTIALS_MISSING",
  "CREDENTIALS_REJECTED",
  "CLOCK_SKEW",
  "DATA_API_DISABLED",
  "ADMIN_API_DISABLED",
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
