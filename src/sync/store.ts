// What the sync has done, kept in DATA_DIR so a restart neither repeats nor misses calls.
// A small JSON file is enough here (a business makes hundreds of calls a day, not millions).
import fs from 'node:fs';
import path from 'node:path';
import { readSessionToken } from '../talk/client.ts';

export interface CallState {
  result: 'logged' | 'already logged' | 'skipped' | 'failed';
  at: string;
  reason?: string;
  callId?: string | null;
  taskId?: string | null;
  attempts?: number;
}

interface StoreData {
  version: 1;
  /** Calls are fetched from here on (epoch ms), minus an overlap. */
  cursorMs: number | null;
  calls: Record<string, CallState>;
  /** Dry runs are tracked separately, so switching to write mode later still logs those calls. */
  dryRunCalls: Record<string, CallState>;
}

const KEEP_MS = 14 * 24 * 60 * 60_000;

/** Writes a file so it is either fully old or fully new, readable only by its owner. */
export function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class Store {
  readonly file: string;
  #data: StoreData;

  private constructor(file: string, data: StoreData) {
    this.file = file;
    this.#data = data;
  }

  static open(dataDir: string): Store {
    const file = path.join(dataDir, 'state.json');
    let data: StoreData = { version: 1, cursorMs: null, calls: {}, dryRunCalls: {} };
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreData>;
      if (parsed.version !== 1) throw new Error(`${file} was written by a newer version of this integration`);
      data = { ...data, ...parsed };
    }
    return new Store(file, data);
  }

  get cursorMs(): number | null {
    return this.#data.cursorMs;
  }

  set cursorMs(value: number | null) {
    this.#data.cursorMs = value;
  }

  get(uuid: string, dryRun: boolean): CallState | undefined {
    return (dryRun ? this.#data.dryRunCalls : this.#data.calls)[uuid];
  }

  set(uuid: string, state: CallState, dryRun: boolean): void {
    (dryRun ? this.#data.dryRunCalls : this.#data.calls)[uuid] = state;
  }

  /** Saves, dropping entries older than two weeks (the call log is never read that far back). */
  save(now = Date.now()): void {
    for (const map of [this.#data.calls, this.#data.dryRunCalls]) {
      for (const [uuid, s] of Object.entries(map)) if (now - Date.parse(s.at) > KEEP_MS) delete map[uuid];
    }
    writePrivate(this.file, JSON.stringify(this.#data, null, 1));
  }
}

// ---------------------------------------------------------------- browser session kept across restarts

const sessionFile = (dataDir: string) => path.join(dataDir, 'talk-session');

export function saveSessionToken(dataDir: string, token: string): void {
  writePrivate(sessionFile(dataDir), token);
}

/**
 * The browser session to start with: the one the console renewed most recently (saved in DATA_DIR), unless
 * the configured one expires later (someone signed in again and put a fresh token in the settings).
 */
export function pickSessionToken(dataDir: string, configured: string): string {
  let saved: string | null = null;
  try {
    saved = fs.readFileSync(sessionFile(dataDir), 'utf8').trim() || null;
  } catch {
    return configured;
  }
  if (!saved) return configured;
  const exp = (t: string) => readSessionToken(t.replace(/^TOKEN=/, '')).expiresAt?.getTime() ?? 0;
  return exp(saved) > exp(configured) ? saved : configured;
}
