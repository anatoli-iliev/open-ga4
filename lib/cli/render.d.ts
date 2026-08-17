export type Streams = {
    out: (s: string) => void;
    err: (s: string) => void;
};
export declare function colorEnabled(env: NodeJS.ProcessEnv): boolean;
export declare const processStreams: Streams;
