import { Ga4Error } from "../ga4/errors.js";
export const EXIT = {
    OK: 0,
    UNEXPECTED: 1,
    BAD_INPUT: 2,
    SETUP_INCOMPLETE: 3,
    GOOGLE_REFUSED: 4,
};
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
/**
 * Exit 4 means Google refused, and only codes that came from Google get it.
 *
 * "UNEXPECTED" is diagnose()'s catch-all for a failure it could not name, so
 * it is the one Ga4Error code that is not a statement about Google's answer.
 * It used to land on exit 4 anyway, which meant exit 1 was documented in
 * SKILL.md and unreachable in code (every error is converted to a Ga4Error
 * before it gets here, so the `instanceof` fallback below never fires in
 * practice), while a genuinely internal failure was reported to the user as a
 * refusal from Google. Now the two are separate: 1 is "something broke and
 * nobody can say what", 4 is "Google said no, and here is its reason".
 */
export function exitCodeFor(error) {
    if (error instanceof Ga4Error) {
        if (SETUP_CODES.has(error.code))
            return EXIT.SETUP_INCOMPLETE;
        if (error.code === "INVALID_REQUEST")
            return EXIT.BAD_INPUT;
        if (error.code === "UNEXPECTED")
            return EXIT.UNEXPECTED;
        return EXIT.GOOGLE_REFUSED;
    }
    return EXIT.UNEXPECTED;
}
