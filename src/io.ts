// pi-jot's file access, local or relayed (J559, Angus "15b": a hyprpi remote agent's /jot-* must write to the LAPTOP's notes).
//
// Locally every call is plain node:fs. In relay mode (PI_JOT_RELAY=1, set for hyprpi's remote agents, whose laptop window is a
// pi RPC client) the remote pi never touches its own disk for a jot: each call becomes one extension-UI `input` request whose
// title is RELAY_TITLE and whose placeholder is the JSON request {v, op, path, data}. The laptop window answers it itself (never
// shown) against ITS OWN jot root, and replies with JSON {ok, value | error}. Paths travel RELATIVE to the jot root, so the two
// machines' home folders don't matter; anything outside the root is refused on both sides. No window connected within
// RELAY_TIMEOUT_MS: the call fails, so nothing is saved anywhere and the tool says so.
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const RELAY_TITLE = "pi-jot relay";
export const RELAY_TIMEOUT_MS = Number(process.env.PI_JOT_RELAY_TIMEOUT_MS) || 30000;
export const relayWanted = () => process.env.PI_JOT_RELAY === "1";

type Ui = { input?: (title: string, placeholder?: string, opts?: { timeout?: number }) => Promise<string | undefined> };
let ui: Ui | null = null; // the latest UI context pi gave us (commands, tools, session start): how a relay request reaches the window
export function noteUi(ctx: any): void { if (ctx?.ui?.input) ui = ctx.ui; }

/** A path inside the jot root, as the relative path that travels; refuses anything outside it. */
export function relPath(root: string, p: string): string {
  const r = relative(resolve(root), resolve(p));
  if (!r || r === ".." || r.startsWith("../") || isAbsolute(r)) throw new Error(`pi-jot: ${p} is outside the notes folder (${root})`);
  return r;
}

async function call(root: string, op: string, p: string, data?: string): Promise<any> {
  if (!ui?.input) throw new Error("pi-jot: no laptop window is connected to save through (relay mode); nothing was saved");
  const answer = await ui.input(RELAY_TITLE, JSON.stringify({ v: 1, op, path: relPath(root, p), ...(data === undefined ? {} : { data }) }), { timeout: RELAY_TIMEOUT_MS });
  if (answer === undefined) throw new Error("pi-jot: the laptop window didn't answer (closed or disconnected); nothing was saved");
  let r: any; try { r = JSON.parse(answer); } catch { throw new Error("pi-jot: the laptop window sent an unreadable answer; nothing was saved"); }
  if (!r?.ok) throw new Error(`pi-jot (laptop): ${r?.error || "failed"}`);
  return r.value;
}

/** File access for one jot root. Writes return where the file really is (the laptop's path in relay mode). */
export function io(root: string) {
  const relay = relayWanted();
  return {
    relay,
    exists: async (p: string): Promise<boolean> => (relay ? (await call(root, "exists", p)) === true : existsSync(p)),
    read: async (p: string): Promise<string> => (relay ? String(await call(root, "read", p)) : readFile(p, "utf8")),
    write: async (p: string, data: string): Promise<string> => { if (relay) return String(await call(root, "write", p, data)); await writeFile(p, data, "utf8"); return p; },
    append: async (p: string, data: string): Promise<string> => { if (relay) return String(await call(root, "append", p, data)); await appendFile(p, data, "utf8"); return p; },
    mkdirp: async (p: string): Promise<void> => { if (relay) await call(root, "mkdir", p); else await mkdir(p, { recursive: true }); },
    /** a real path (symlinks resolved) for local checks; in relay mode the laptop resolves and confines it itself */
    real: (p: string): string => { if (relay) return p; try { return realpathSync(p); } catch { return p; } },
  };
}
