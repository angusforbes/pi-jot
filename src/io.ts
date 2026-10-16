// pi-jot's file access, local or relayed (J559, Angus "15b": a hyprpi remote agent's /jot-* must write to the LAPTOP's notes).
//
// Locally every call is plain node:fs. In relay mode (PI_JOT_RELAY=1, set for hyprpi's remote agents, whose laptop window is a
// pi RPC client) the remote pi never touches its own disk for a jot: each call becomes one extension-UI `input` request whose
// title is RELAY_TITLE and whose placeholder is the JSON request {v, op, path, data}. The laptop window answers it itself (never
// shown) against ITS OWN jot root, and replies with JSON {ok, value | error}. Paths travel RELATIVE to the jot root, so the two
// machines' home folders don't matter; anything outside the root is refused on both sides. No window connected within
// RELAY_TIMEOUT_MS: the call fails, and the tool says so: "nothing was saved" only when the request certainly never left; when it
// may have reached the laptop (an answer lost or unreadable, the window silent), pi-jot checks the file and reports what it found
// (settle, J722).
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createConnection } from "node:net";

export const RELAY_TITLE = "pi-jot relay";
export const RELAY_TIMEOUT_MS = Number(process.env.PI_JOT_RELAY_TIMEOUT_MS) || 30000;
const relayTimeout = () => Number(process.env.PI_JOT_RELAY_TIMEOUT_MS) || 30000; // (read per call, so a test's short wait applies whatever loaded io.ts first)
export const relayWanted = () => process.env.PI_JOT_RELAY === "1";

type Ui = { input?: (title: string, placeholder?: string, opts?: { timeout?: number }) => Promise<string | undefined> };
let ui: Ui | null = null; // the latest UI context pi gave us (commands, tools, session start): how a relay request reaches the window
export function noteUi(ctx: any): void { if (ctx?.ui?.input) ui = ctx.ui; }

/** A path inside the jot root, as the relative path that travels; refuses anything outside it. */
export function relPath(root: string, p: string): string {
  const r = relative(resolve(root), resolve(p));
  if (!r) return "."; // the root itself (list / find)
  if (r === ".." || r.startsWith("../") || isAbsolute(r)) throw new Error(`pi-jot: ${p} is outside the notes folder (${root})`);
  return r;
}

// J561 ("all hits go to laptop obsidian"): the laptop also serves the same requests on a unix socket on this machine
// (PI_JOT_RELAY_SOCKET, forwarded over ssh by the laptop's hyprpi-jot-relay service): one JSON line in, one JSON line out. Used
// first, so agents without a laptop window and the world's Thoughts reach the laptop too; the window is the fallback.
function viaSocket(sock: string, req: string): Promise<{ answer?: string; sent: boolean }> {
  return new Promise((ok) => {
    let buf = "", done = false, sent = false;
    const end = (answer?: string) => { if (!done) { done = true; try { c.destroy(); } catch { /* */ } ok({ answer, sent }); } };
    const c = createConnection(sock);
    c.setTimeout(relayTimeout(), () => end());
    c.on("connect", () => { sent = true; c.write(req + "\n"); });
    c.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) end(buf.slice(0, i)); });
    c.on("error", () => end());
    c.on("close", () => end());
  });
}

// J569: route 2, hyprpi's per-world link (J555): the machine's hyprpi daemon (PI_JOT_RELAY_LINK = its socket) passes a
// "link.call" op "jot" to the laptop, which answers with the same relay host. Up only while one of that world's panels is open on
// the laptop; when it isn't, the daemon refuses at once ("no link …"), nothing was sent, and the next route is tried. Returns the
// answer line, or { sent } when there was none (sent = the request may have reached the laptop).
function viaLink(sock: string, req: string): Promise<{ answer?: string; sent: boolean; why?: string }> {
  return new Promise((ok) => {
    let buf = "", done = false, sent = false;
    const end = (r: { answer?: string; why?: string }) => { if (!done) { done = true; try { c.destroy(); } catch { /* */ } ok({ ...r, sent }); } };
    const c = createConnection(sock);
    c.setTimeout(relayTimeout() + 5000, () => end({ why: "no answer" }));
    c.on("connect", () => { sent = true; c.write(JSON.stringify({ id: 1, method: "link.call", params: { op: "jot", args: JSON.parse(req), timeoutMs: relayTimeout() } }) + "\n"); });
    c.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== 1) continue;
        if (m.error) { if (/^no link to the laptop|^no op |^bad op|^args over |^only on a remote world/.test(String(m.error))) sent = false; return end({ why: String(m.error) }); } // the daemon refused before anything went to the laptop
        return end({ answer: JSON.stringify(m.result?.result ?? m.result) });
      }
    });
    c.on("error", (e: any) => end({ why: e?.message })); // (sent stays as it was: once written, an error never means "not sent")
    c.on("close", () => end({ why: "closed" }));
  });
}

const READS = ["exists", "read", "list", "find", "where"]; // safe to repeat; everything else (write / append / mkdir) is a change

async function call(root: string, op: string, p: string, data?: string): Promise<any> {
  const req = JSON.stringify({ v: 1, op, path: relPath(root, p), ...(data === undefined ? {} : { data }) });
  const change = !READS.includes(op);
  const sock = process.env.PI_JOT_RELAY_SOCKET;
  let answer: string | undefined, linkWhy = "";
  if (sock && existsSync(sock)) {
    const r = await viaSocket(sock, req);
    answer = r.answer;
    // (JotAllCheck) a request that reached the laptop but whose answer was lost may have been carried out: never repeat a change
    // (it would write twice); J722: look whether it landed instead (settle). A read or check is safe to repeat on the next route.
    if (answer === undefined && r.sent && change) return settle(root, op, p, data, "the laptop's answer over the relay socket was lost after the request reached it");
  }
  const link = process.env.PI_JOT_RELAY_LINK;
  if (answer === undefined && link && existsSync(link)) {
    const r = await viaLink(link, req);
    answer = r.answer;
    if (answer === undefined && r.sent && change) return settle(root, op, p, data, `the laptop's answer over the link was lost after the request reached it (${r.why || "?"})`);
    if (answer === undefined) linkWhy = r.why || "";
  }
  if (answer === undefined) {
    if (!ui?.input) throw new Error(`pi-jot: the laptop isn't reachable${linkWhy ? ` (${linkWhy})` : " (no relay socket or link answering, and no laptop window)"}; nothing was saved`); // (never sent: certain)
    answer = await ui.input(RELAY_TITLE, req, { timeout: relayTimeout() });
    // J722: no answer from the window (timed out or cancelled; pi can't tell which) doesn't mean the window never got it
    const why = `the laptop didn't answer (asleep, or no window connected${linkWhy ? `; link: ${linkWhy}` : ""})`;
    if (answer === undefined) { if (change) return settle(root, op, p, data, why); throw new Error(`pi-jot: ${why}; nothing was saved`); }
  }
  let r: any; try { r = JSON.parse(answer); } catch {
    if (change) return settle(root, op, p, data, "the laptop sent an unreadable answer");
    throw new Error("pi-jot: the laptop sent an unreadable answer; nothing was saved");
  }
  if (!r?.ok) throw new Error(`pi-jot (laptop): ${r?.error || "failed"}`);
  return r.value;
}

// J722 (Angus, nss2a: "and then can't you check or ask someone to check"): a change that MAY have reached the laptop is never
// repeated (it could save twice). Instead pi-jot asks the laptop, with the read-only ops through the same routes, whether the
// file now holds it: an append's exact text (pi-jot's "- [HH:MM TZ] <text>" entry, stamped to the minute), a write's whole body,
// a mkdir's folder. Saved: the call succeeds and its result says "saved (checked: …)". Not there: "not saved (checked: …)". The
// check itself fails or times out: "may or may not have been saved … unknown", with the file to ask a laptop agent to look at.
async function settle(root: string, op: string, p: string, data: string | undefined, why: string): Promise<any> {
  const rel = relPath(root, p);
  let has: boolean;
  try {
    const there = (await call(root, "exists", p)) === true;
    if (op === "mkdir" || !there) has = there;
    else { const cur = String(await call(root, "read", p)); has = op === "write" ? cur === data : cur.includes(String(data ?? "")); }
  } catch (e) {
    const msg = `pi-jot: ${why}, so it may or may not have been saved; checking ${rel} couldn't reach the laptop either (${(e as Error).message.replace(/^pi-jot( \(laptop\))?: /, "").replace(/; nothing was saved$/, "")}), so the outcome is unknown: ask an agent on the laptop to check ${rel} before saving it again`;
    console.error(msg);
    throw new Error(msg);
  }
  if (!has) {
    const msg = `pi-jot: not saved (checked: ${rel} doesn't have it; ${why}). Nothing was repeated automatically: save it again if you still want it`;
    console.error(msg);
    throw new Error(msg);
  }
  console.error(`pi-jot: saved (checked: ${rel} has it; ${why})`);
  if (op === "mkdir") return undefined;
  let shown = rel; try { shown = String(await call(root, "where", p)); } catch { /* the relative path will do */ }
  return `${shown} — saved (checked: ${rel} has it; ${why})`;
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
    /** relay mode only (J561, /jot-todo): a folder's entries ("name/" for folders), and files named NAME anywhere under the root */
    list: async (p: string): Promise<string[]> => (relay ? (await call(root, "list", p)) as string[] : []),
    find: async (name: string): Promise<string[]> => (relay ? (await call(root, "find", root + "/.", name)) as string[] : []),
    /** where the file is for the user: the laptop's absolute path in relay mode */
    where: async (p: string): Promise<string> => (relay ? String(await call(root, "where", p)) : p),
    mkdirp: async (p: string): Promise<void> => { if (relay) await call(root, "mkdir", p); else await mkdir(p, { recursive: true }); },
    /** a real path (symlinks resolved) for local checks; in relay mode the laptop resolves and confines it itself */
    real: (p: string): string => { if (relay) return p; try { return realpathSync(p); } catch { return p; } },
  };
}
