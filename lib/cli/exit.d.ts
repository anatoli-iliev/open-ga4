export declare const EXIT: {
    readonly OK: 0;
    readonly UNEXPECTED: 1;
    readonly BAD_INPUT: 2;
    readonly SETUP_INCOMPLETE: 3;
    readonly GOOGLE_REFUSED: 4;
};
export declare function exitCodeFor(error: unknown): number;
