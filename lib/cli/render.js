export function colorEnabled(env) {
    return env.NO_COLOR === undefined || env.NO_COLOR === "";
}
export const processStreams = {
    out: (s) => { process.stdout.write(s); },
    err: (s) => { process.stderr.write(s); },
};
