export type Streams = { out: (s: string) => void; err: (s: string) => void };

export function colorEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NO_COLOR === undefined || env.NO_COLOR === "";
}

export const processStreams: Streams = {
  out: (s) => { process.stdout.write(s); },
  err: (s) => { process.stderr.write(s); },
};
