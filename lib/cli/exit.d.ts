export declare const EXIT: {
    readonly OK: 0;
    readonly UNEXPECTED: 1;
    readonly BAD_INPUT: 2;
    readonly SETUP_INCOMPLETE: 3;
    readonly GOOGLE_REFUSED: 4;
};
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
export declare function exitCodeFor(error: unknown): number;
