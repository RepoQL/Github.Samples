/** What a command's entry point is given in place of the process: where its lines go and the environment it reads. */
export interface Io {
  emit: (line: string) => void;
  environ: NodeJS.ProcessEnv;
}
