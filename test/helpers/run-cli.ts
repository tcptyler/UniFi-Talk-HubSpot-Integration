import { main } from '../../src/cli.ts';

/** Runs the CLI in-process with extra environment variables and captures what it prints. */
export async function runCli(argv: string[], env: Record<string, string>): Promise<{ code: number; text: string }> {
  const saved = { ...process.env };
  const out: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void out.push(a.join(' '));
  Object.assign(process.env, env);
  try {
    return { code: await main(argv), text: out.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    process.env = saved;
  }
}
