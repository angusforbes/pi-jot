// J559: relay mode. A remote pi (PI_JOT_RELAY=1) must write nothing on its own disk: every jot goes through the window's
// `input` request to the laptop, which writes under ITS root. The "laptop" here is hyprpi's real host
// (lib/jot-relay-host.mjs) when it is around, else a minimal stand-in; the remote root is a separate temp folder that must stay
// empty. Exercises core.writeEntry and the extension's /jot-note, /jot-idea (+ jot_save with pending_id), /jot-soliloquy
// (+ jot_plan update / read / tick) through a mock pi.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
// typebox is pi's (a peer dependency): a stand-in that just records the schema
mock.module("typebox", () => ({ Type: new Proxy({}, { get: () => (...a: any[]) => ({ schema: a }) }) }));
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const T = mkdtempSync(join(tmpdir(), "jot-relay-")), REMOTE = join(T, "remote-notes"), LAPTOP = join(T, "laptop-notes");
mkdirSync(REMOTE, { recursive: true }); mkdirSync(LAPTOP, { recursive: true });
const CFG = join(T, "jot.json");
writeFileSync(CFG, JSON.stringify({ root: REMOTE, user: "Angus", kinds: { note: { folder: "Notes", command: "jot-note" }, idea: { folder: "Ideas", command: "jot-idea" }, soliloquy: { folder: "Plans", command: "jot-soliloquy" } } }));
// (Blink: bun runs every test file in ONE process, so whatever this file sets must be put back for the next file)
const ENV_KEYS = ["PI_JOT_CONFIG", "PI_JOT_RELAY", "PI_JOT_RELAY_TIMEOUT_MS", "PI_JOT_RELAY_SOCKET", "PI_JOT_RELAY_LINK"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.PI_JOT_CONFIG = CFG; process.env.PI_JOT_RELAY = "1"; process.env.PI_JOT_RELAY_TIMEOUT_MS = "2000";

const HOST = process.env.JOT_RELAY_HOST || join(homedir(), "Harness/hyprpi/lib/jot-relay-host.mjs");
let answer: (raw: string) => string;
const requests: any[] = [];
beforeAll(async () => {
  if (existsSync(HOST)) { const m = await import(HOST); answer = (raw) => m.jotRelayAnswer(raw, { root: LAPTOP }); }
  else answer = (raw) => { const r = JSON.parse(raw), f = join(LAPTOP, r.path); const fs = require("node:fs"); if (r.op === "exists") return JSON.stringify({ ok: true, value: fs.existsSync(f) }); if (r.op === "read") return JSON.stringify({ ok: true, value: fs.readFileSync(f, "utf8") }); fs.mkdirSync(r.op === "mkdir" ? f : require("node:path").dirname(f), { recursive: true }); if (r.op === "write") fs.writeFileSync(f, r.data); if (r.op === "append") fs.appendFileSync(f, r.data); return JSON.stringify({ ok: true, value: f }); };
});
const notes: string[] = [];
const ui = { input: async (title: string, placeholder?: string) => { requests.push({ title, req: JSON.parse(placeholder!) }); return answer(placeholder!); }, notify: (m: string) => { notes.push(m); } };
const ctx = { ui, cwd: T, isIdle: () => true, model: { name: "Test Model" } };
const listAll = (d: string): string[] => existsSync(d) ? readdirSync(d, { recursive: true }).map(String) : [];

// a mock pi: captures commands, tools and the messages the extension sends to the model
const cmds: Record<string, any> = {}, tools: Record<string, any> = {}, sent: string[] = [];
const handlers: Record<string, any[]> = {};
const pi: any = { registerCommand: (n: string, c: any) => { cmds[n] = c; }, registerTool: (t: any) => { tools[t.name] = t; }, on: (e: string, h: any) => { (handlers[e] ??= []).push(h); }, sendUserMessage: (m: string) => { sent.push(m); }, appendEntry: () => {} };
beforeAll(async () => { const ext = await import("../src/extension.ts"); ext.default(pi); });
afterAll(async () => { // temp files stay for a look if a test failed; the process state is put back
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  const { noteUi } = await import("../src/io.ts"); noteUi({ ui: { input: async () => undefined } }); // no live relay UI left behind (relay mode is off again anyway)
  const { setTimeZone } = await import("../src/core.ts"); setTimeZone(undefined);
});

test("core.writeEntry: the entry lands on the laptop, verbatim; nothing on the remote", async () => {
  const { writeEntry, loadConfig } = await import("../src/core.ts");
  const { noteUi } = await import("../src/io.ts");
  noteUi(ctx);
  const cfg = loadConfig(CFG);
  const f = await writeEntry(cfg, "note", cfg.kinds.note, "Exactly as typed: café, 'quotes' & $HOME", "Relay Test", T);
  expect(f.startsWith(LAPTOP)).toBe(true);
  expect(readFileSync(f, "utf8")).toContain("Exactly as typed: café, 'quotes' & $HOME");
  expect(listAll(REMOTE)).toEqual([]);
  expect(requests.every((r) => r.title === "pi-jot relay" && !r.req.path.startsWith("/") && !r.req.path.includes(".."))).toBe(true);
});

test("/jot-note @Title text (the command itself, no model): saved on the laptop, notify names the laptop path", async () => {
  await cmds["jot-note"].handler("@Groceries buy oat milk, not almond!", ctx);
  expect(readFileSync(join(LAPTOP, "Notes/Groceries.md"), "utf8")).toContain("buy oat milk, not almond!");
  expect(notes.at(-1)).toContain(LAPTOP);
  expect(listAll(REMOTE)).toEqual([]);
});

test("/jot-idea text → the model's jot_save with the pending_id writes the typed words verbatim on the laptop", async () => {
  await cmds["jot-idea"].handler("a radio that only plays songs I've never heard", ctx);
  const id = /pending_id "([^"]+)"/.exec(sent.at(-1)!)?.[1];
  expect(id).toBeTruthy();
  const r = await tools.jot_save.execute("t1", { kind: "idea", title: "NewSongRadio", pending_id: id, summary: "s", discussion: "- d" }, null, null, ctx);
  expect(r.content[0].text).toContain(LAPTOP);
  const idea = readFileSync(join(LAPTOP, "Ideas/NewSongRadio.md"), "utf8");
  expect(idea).toContain("a radio that only plays songs I've never heard");
  expect(listAll(REMOTE)).toEqual([]);
});

test("/jot-soliloquy: the conversation's plan note is written, updated, read and ticked on the laptop only", async () => {
  await cmds["jot-soliloquy"].handler("thinking about the hub: keep it cheap", ctx);
  let r = await tools.jot_plan.execute("p1", { title: "Hub Plan", body: "## Plan\n- T1 do a thing\n\n## Questions\n1. Which box?\n   1a. hub\n   1b. a new one" }, null, null, ctx);
  expect(r.content[0].text).toContain(LAPTOP);
  const f = join(LAPTOP, "Plans/Hub Plan.md");
  expect(readFileSync(f, "utf8")).toContain("thinking about the hub: keep it cheap");
  for (const h of handlers.input ?? []) await h({ source: "rpc", text: "1a — and we're done, close it" }); // what he types next in the remote window (an RPC prompt)
  expect(readFileSync(f, "utf8")).toContain("1a — and we're done, close it");
  r = await tools.jot_plan.execute("p2", { body: "## Plan\n- [ ] T1 do a thing", status: "ready", close: true }, null, null, ctx);
  expect(readFileSync(f, "utf8")).toContain("status: ready");
  r = await tools.jot_plan.execute("p3", { action: "read", file: "Hub Plan" }, null, null, ctx);
  expect(r.content[0].text).toContain("T1 do a thing");
  expect(r.content[0].text.startsWith(LAPTOP)).toBe(true); // (JotRelayCheck) read shows the laptop path
  const laptopPath = r.details.file; expect(laptopPath).toBe(f);
  r = await tools.jot_plan.execute("p3b", { action: "status", file: laptopPath, status: "running" }, null, null, ctx); // the path jot_plan returned works
  expect(readFileSync(f, "utf8")).toContain("status: running");
  r = await tools.jot_plan.execute("p4", { action: "tick", file: "Hub Plan", task: "T1" }, null, null, ctx);
  expect(readFileSync(f, "utf8")).toContain("[x] T1");
  expect(listAll(REMOTE)).toEqual([]);
});

test("no window (the input request is cancelled): an error, and nothing saved anywhere", async () => {
  const { noteUi } = await import("../src/io.ts");
  const before = listAll(LAPTOP).length;
  noteUi({ ui: { input: async () => undefined, notify: (m: string) => { notes.push(m); } } });
  await cmds["jot-note"].handler("@Lost should not be saved", { ...ctx, ui: { input: async () => undefined, notify: (m: string) => { notes.push(m); } } });
  expect(notes.at(-1)).toMatch(/Could not save.*didn't answer/);
  expect(listAll(LAPTOP).length).toBe(before);
  expect(listAll(REMOTE)).toEqual([]);
  noteUi(ctx);
});

test("the laptop host refuses paths outside its root (.., absolute, through a symlink)", async () => {
  if (!existsSync(HOST)) return;
  const m = await import(HOST);
  const ask = (path: string, op = "write") => JSON.parse(m.jotRelayAnswer(JSON.stringify({ v: 1, op, path, data: "x" }), { root: LAPTOP }));
  expect(ask("../escape.md").ok).toBe(false);
  expect(ask("/etc/passwd", "read").ok).toBe(false);
  mkdirSync(join(T, "outside"), { recursive: true }); symlinkSync(join(T, "outside"), join(LAPTOP, "Link"));
  expect(ask("Link/x.md").ok).toBe(false);
  expect(existsSync(join(T, "outside/x.md"))).toBe(false);
  symlinkSync(join(T, "nowhere.txt"), join(LAPTOP, "dangling.md")); // (JotRelayCheck) a dangling link out of the root
  expect(ask("dangling.md", "append").ok).toBe(false); expect(ask("dangling.md", "write").ok).toBe(false);
  expect(existsSync(join(T, "nowhere.txt"))).toBe(false);
  expect(ask("Notes/ok.md").ok).toBe(true);
});

// ---- J561 -------------------------------------------------------------------------------------------------------------------
test("timeZone in jot.json stamps entries in that zone (the laptop's), not the machine's", async () => {
  const { stamp, dateStr, setTimeZone } = await import("../src/core.ts");
  const d = new Date("2026-07-01T03:30:00Z");
  setTimeZone("America/Chicago"); expect(stamp(d)).toBe("22:30 CDT"); expect(dateStr(d)).toBe("2026-06-30");
  setTimeZone("Asia/Tokyo"); expect(stamp(d)).toMatch(/^12:30 GMT\+9$/); expect(dateStr(d)).toBe("2026-07-01");
  setTimeZone("Not/AZone"); expect(stamp(d)).toBe(new Date(d).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).replace(/^24:/, "00:"));
  setTimeZone(undefined);
});

test("jot_file (relay mode, /jot-todo): read, write the whole file, list and find, all on the laptop", async () => {
  expect(tools.jot_file).toBeTruthy();
  mkdirSync(join(LAPTOP, "ThingsToDo"), { recursive: true }); writeFileSync(join(LAPTOP, "ThingsToDo/todo.md"), "## Quick one-offs\n- [ ] a\n");
  let r = await tools.jot_file.execute("f1", { action: "read", path: "ThingsToDo/todo.md" }, null, null, ctx);
  expect(r.content[0].text).toContain("- [ ] a");
  r = await tools.jot_file.execute("f2", { action: "write", path: "ThingsToDo/todo.md", content: "## Quick one-offs\n- [ ] a\n- [ ] b \"q\" & é\n" }, null, null, ctx);
  expect(readFileSync(join(LAPTOP, "ThingsToDo/todo.md"), "utf8")).toContain("- [ ] b \"q\" & é");
  r = await tools.jot_file.execute("f3", { action: "list", path: "ThingsToDo" }, null, null, ctx);
  expect(r.content[0].text).toContain("todo.md");
  r = await tools.jot_file.execute("f4", { action: "find", name: "todo.md" }, null, null, ctx);
  expect(r.content[0].text).toContain("ThingsToDo/todo.md");
  await expect(tools.jot_file.execute("f5", { action: "read", path: "../outside.md" }, null, null, ctx)).rejects.toThrow();
  expect(listAll(REMOTE)).toEqual([]);
});

test("the relay socket (PI_JOT_RELAY_SOCKET) is used first: a windowless agent's jot reaches the laptop", async () => {
  const net = await import("node:net");
  const sock = join(T, "jot.sock"); let seen = 0;
  const srv = net.createServer((c) => { let b = ""; c.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i >= 0) { seen++; c.end(answer(b.slice(0, i)) + "\n"); } }); });
  await new Promise<void>((ok) => srv.listen(sock, ok));
  process.env.PI_JOT_RELAY_SOCKET = sock;
  const { noteUi } = await import("../src/io.ts");
  noteUi({ ui: { input: async () => { throw new Error("the window must not be used when the socket answers"); } } });
  const { writeEntry, loadConfig } = await import("../src/core.ts");
  const cfg = loadConfig(CFG);
  const f = await writeEntry(cfg, "note", cfg.kinds.note, "from a windowless agent", "Windowless", T);
  expect(readFileSync(f, "utf8")).toContain("from a windowless agent");
  expect(seen).toBeGreaterThan(0);
  srv.close(); delete process.env.PI_JOT_RELAY_SOCKET; noteUi(ctx);
  expect(listAll(REMOTE)).toEqual([]);
});

test("(JotAllCheck, J722) a change whose socket answer is lost is NOT repeated: one line, and the check finds it: 'saved (checked…)'", async () => {
  const net = await import("node:net");
  const sock = join(T, "lost.sock");
  const srv = net.createServer((c) => { let b = ""; c.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i >= 0) { answer(b.slice(0, i)); c.destroy(); } }); }); // carries it out, never answers
  await new Promise<void>((ok) => srv.listen(sock, ok));
  process.env.PI_JOT_RELAY_SOCKET = sock;
  const winOps: string[] = [];
  const { noteUi, io, takeCheckNotes } = await import("../src/io.ts");
  noteUi({ ui: { input: async (_t: string, ph?: string) => { winOps.push(JSON.parse(ph!).op); return answer(ph!); } } });
  try {
    const f = join(REMOTE, "Notes/LostAck.md");
    const w = await io(REMOTE).append(f, "exactly once\n");
    expect(w).toBe(join(LAPTOP, "Notes/LostAck.md")); // a plain path (the laptop's, from the check's "where"), nothing added
    expect(takeCheckNotes()).toContain("saved (checked: Notes/LostAck.md has it"); expect(takeCheckNotes()).toBe(""); // (taken once)
    expect(readFileSync(join(LAPTOP, "Notes/LostAck.md"), "utf8")).toBe("exactly once\n");
    expect(winOps.filter((o) => !["exists", "read", "where"].includes(o))).toEqual([]); // the check reads; the change never repeats
  } finally { srv.close(); delete process.env.PI_JOT_RELAY_SOCKET; noteUi(ctx); }
});

// ---- J722 (nss2a): a change that MAY have reached the laptop is checked, never repeated ----------------------------------------
// The window stands in for the laptop: `onChange` decides what happens to a write / append / mkdir (carried out or not, and what
// comes back); reads ("exists", "read", "where") are answered normally unless `reads` says otherwise.
function laptopWindow(onChange: (ph: string) => string | undefined, reads: "answer" | "silent" = "answer") {
  const ops: string[] = [];
  const input = async (_t: string, ph?: string) => { const op = JSON.parse(ph!).op; ops.push(op);
    if (["exists", "read", "where", "list", "find"].includes(op)) return reads === "answer" ? answer(ph!) : undefined;
    return onChange(ph!); };
  return { ops, ui: { input } };
}
test("J722 the window carried out the append but its answer timed out (undefined): checked, 'saved (checked: … has it)', written once", async () => {
  const { noteUi, io, takeCheckNotes } = await import("../src/io.ts");
  const win = laptopWindow((ph) => { answer(ph); return undefined; }); noteUi(win);
  try {
    const w = await io(REMOTE).append(join(REMOTE, "Notes/WinTimeout.md"), "- [10:00 CDT] landed\n");
    expect(w).toBe(join(LAPTOP, "Notes/WinTimeout.md"));
    expect(takeCheckNotes()).toMatch(/saved \(checked: Notes\/WinTimeout\.md has it; the laptop didn't answer/);
    expect(readFileSync(join(LAPTOP, "Notes/WinTimeout.md"), "utf8")).toBe("- [10:00 CDT] landed\n");
    expect(win.ops.filter((o) => o === "append").length).toBe(1);
    expect(listAll(REMOTE)).toEqual([]);
  } finally { noteUi(ctx); }
});
test("J722 an unreadable answer after a whole-file write that landed: checked, 'saved (checked…)'", async () => {
  const { noteUi, io, takeCheckNotes } = await import("../src/io.ts");
  const win = laptopWindow((ph) => { answer(ph); return "<<garbled>>"; }); noteUi(win);
  try {
    const w = await io(REMOTE).write(join(REMOTE, "Notes/Garbled.md"), "whole body\n");
    expect(w).toBe(join(LAPTOP, "Notes/Garbled.md"));
    expect(takeCheckNotes()).toContain("saved (checked: Notes/Garbled.md has it; the laptop sent an unreadable answer");
    expect(win.ops.filter((o) => o === "write").length).toBe(1);
  } finally { noteUi(ctx); }
});
test("J722 the append never landed and the window timed out: checked, 'not saved (checked: … doesn't have it)', nothing written", async () => {
  const { noteUi, io } = await import("../src/io.ts");
  mkdirSync(join(LAPTOP, "Notes"), { recursive: true }); writeFileSync(join(LAPTOP, "Notes/NotLanded.md"), "- [09:00 CDT] older entry\n");
  const win = laptopWindow(() => undefined); noteUi(win);
  try {
    await expect(io(REMOTE).append(join(REMOTE, "Notes/NotLanded.md"), "- [10:00 CDT] lost one\n")).rejects.toThrow(/not saved \(checked at \d\d:\d\d: Notes\/NotLanded\.md doesn't have it; if the laptop was asleep it may still arrive, so check again before re-saving\)/);
    await expect(io(REMOTE).append(join(REMOTE, "Notes/NeverMade.md"), "- [10:00 CDT] x\n")).rejects.toThrow(/not saved \(checked at \d\d:\d\d: Notes\/NeverMade\.md doesn't have it/); // (no file at all)
    expect(readFileSync(join(LAPTOP, "Notes/NotLanded.md"), "utf8")).toBe("- [09:00 CDT] older entry\n");
    expect(win.ops.filter((o) => o === "append").length).toBe(2); // once each, never repeated
  } finally { noteUi(ctx); }
});
test("J722 the answer is lost and the check can't reach the laptop either: 'may or may not … unknown', ask a laptop agent; no repeat", async () => {
  const { noteUi, io } = await import("../src/io.ts");
  const win = laptopWindow((ph) => { answer(ph); return undefined; }, "silent"); noteUi(win);
  try {
    const err = await io(REMOTE).append(join(REMOTE, "Notes/Unknown.md"), "- [10:00 CDT] who knows\n").then(() => "resolved", (e) => String(e.message));
    expect(err).toMatch(/may or may not have been saved.*outcome is unknown: ask an agent on the laptop to check Notes\/Unknown\.md/);
    expect(err).not.toMatch(/nothing was saved|saved \(checked/);
    expect(win.ops.filter((o) => o === "append").length).toBe(1);
  } finally { noteUi(ctx); }
});
test("J722 jot_save and /jot-note after a lost answer: details.file stays a plain path; the text / notify says 'saved (checked…)'", async () => {
  const { noteUi } = await import("../src/io.ts");
  const win = laptopWindow((ph) => { const a = answer(ph); return JSON.parse(ph).op === "append" ? undefined : a; }); // only the entry's answer is lost
  noteUi(win);
  try {
    const r = await tools.jot_save.execute("s1", { kind: "note", title: "Checked Save", text: "kept despite the lost answer" }, null, null, { ...ctx, ui: { ...win.ui, notify: ui.notify } });
    expect(r.details.file).toBe(join(LAPTOP, "Notes/Checked Save.md"));
    expect(r.content[0].text).toBe(`Saved to ${join(LAPTOP, "Notes/Checked Save.md")} — saved (checked: Notes/Checked Save.md has it; the laptop didn't answer (asleep, or no window connected))`);
    await cmds["jot-note"].handler("@CheckedCmd typed words", { ...ctx, ui: { ...win.ui, notify: ui.notify } });
    expect(notes.at(-1)).toMatch(/^Note saved: .*CheckedCmd\.md — saved \(checked: Notes\/CheckedCmd\.md has it/);
    expect(win.ops.filter((o) => o === "append").length).toBe(2);
  } finally { noteUi(ctx); }
});
test("J722 the check itself times out (a socket that takes the request and then hangs): 'unknown', never a guess", async () => {
  const net = await import("node:net"); const sock = join(T, "hang.sock"); const conns: any[] = [];
  const srv = net.createServer((c) => { conns.push(c); let b = ""; c.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i >= 0) { const r = b.slice(0, i); if (JSON.parse(r).op === "append") answer(r); } }); }); // never answers, never closes
  await new Promise<void>((ok) => srv.listen(sock, ok));
  process.env.PI_JOT_RELAY_SOCKET = sock;
  const { noteUi, io } = await import("../src/io.ts"); noteUi({ ui: { input: async () => undefined } });
  try {
    const err = await io(REMOTE).append(join(REMOTE, "Notes/Hang.md"), "- [10:00 CDT] hung\n").then(() => "resolved", (e) => String(e.message));
    expect(err).toMatch(/may or may not have been saved.*outcome is unknown/);
    expect(readFileSync(join(LAPTOP, "Notes/Hang.md"), "utf8")).toBe("- [10:00 CDT] hung\n"); // (it had landed: the check just couldn't say)
  } finally { for (const c of conns) c.destroy(); srv.close(); delete process.env.PI_JOT_RELAY_SOCKET; noteUi(ctx); }
}, 15000);

// ---- J569: the hyprpi link route (link.call op "jot") -------------------------------------------------------------------------
async function fakeDaemon(sock: string, mode: "up" | "nolink" | "lost") {
  const net = await import("node:net"); const seen: any[] = [];
  const srv = net.createServer((c) => { let b = ""; c.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i < 0) return; const m = JSON.parse(b.slice(0, i)); seen.push(m);
    if (mode === "nolink") return c.end(JSON.stringify({ id: m.id, error: "no link to the laptop right now (it is up while one of world H's panels is open there)" }) + "\n");
    const ans = JSON.parse(answer(JSON.stringify(m.params.args)));
    if (mode === "lost") return c.destroy();
    c.end(JSON.stringify({ id: m.id, result: { result: ans } }) + "\n"); }); });
  await new Promise<void>((ok) => srv.listen(sock, ok)); return { srv, seen };
}
test("J569 link route: a windowless agent's jot goes over link.call op jot to the laptop (no socket, no window)", async () => {
  const sock = join(T, "daemon-up.sock"); const { srv, seen } = await fakeDaemon(sock, "up");
  process.env.PI_JOT_RELAY_LINK = sock;
  const { noteUi, io } = await import("../src/io.ts");
  noteUi({ ui: { input: async () => { throw new Error("no window must be used"); } } });
  const w = await io(REMOTE).append(join(REMOTE, "Notes/ViaLink.md"), "over the link\n");
  expect(w.startsWith(LAPTOP)).toBe(true); expect(readFileSync(w, "utf8")).toBe("over the link\n");
  expect(seen.every((m) => m.method === "link.call" && m.params.op === "jot")).toBe(true);
  srv.close(); delete process.env.PI_JOT_RELAY_LINK; noteUi(ctx); expect(listAll(REMOTE)).toEqual([]);
});
test("J569 no H panel open (link down): refused at once, nothing sent, nothing saved, and the message says to open a panel", async () => {
  const sock = join(T, "daemon-nolink.sock"); const { srv } = await fakeDaemon(sock, "nolink");
  process.env.PI_JOT_RELAY_LINK = sock;
  const { noteUi, io } = await import("../src/io.ts");
  noteUi({ ui: { input: async () => undefined } }); // a windowless agent: its window request goes nowhere (pi can't tell that from a timeout)
  const before = listAll(LAPTOP).length;
  await expect(io(REMOTE).append(join(REMOTE, "Notes/NoLink.md"), "x\n")).rejects.toThrow(/panels is open.*may or may not have been saved.*unknown/s); // (J722: the window's silence is no proof it never got it)
  expect(listAll(LAPTOP).length).toBe(before);
  srv.close(); delete process.env.PI_JOT_RELAY_LINK; noteUi(ctx);
});
test("J569 link down but the agent has a window: falls back to the window and saves once", async () => {
  const sock = join(T, "daemon-nolink2.sock"); const { srv } = await fakeDaemon(sock, "nolink");
  process.env.PI_JOT_RELAY_LINK = sock;
  const { noteUi, io } = await import("../src/io.ts"); noteUi(ctx);
  const w = await io(REMOTE).append(join(REMOTE, "Notes/WindowAfterNoLink.md"), "via window\n");
  expect(readFileSync(w, "utf8")).toBe("via window\n");
  srv.close(); delete process.env.PI_JOT_RELAY_LINK;
});
test("J569 a write whose link answer is lost after it was sent is not repeated through the window (J722: checked instead)", async () => {
  const sock = join(T, "daemon-lost.sock"); const { srv } = await fakeDaemon(sock, "lost");
  process.env.PI_JOT_RELAY_LINK = sock; let win = 0;
  const { noteUi, io } = await import("../src/io.ts");
  noteUi({ ui: { input: async (_t: string, ph?: string) => { if (!["exists", "read", "where"].includes(JSON.parse(ph!).op)) win++; return answer(ph!); } } }); // (J722: the check may read through it)
  expect(await io(REMOTE).append(join(REMOTE, "Notes/LinkLost.md"), "once\n")).toBe(join(LAPTOP, "Notes/LinkLost.md"));
  expect((await import("../src/io.ts")).takeCheckNotes()).toContain("saved (checked: Notes/LinkLost.md has it; the laptop's answer over the link was lost");
  expect(readFileSync(join(LAPTOP, "Notes/LinkLost.md"), "utf8")).toBe("once\n"); expect(win).toBe(0);
  srv.close(); delete process.env.PI_JOT_RELAY_LINK; noteUi(ctx);
});
test("J569 (LinkJotCheck) a daemon refusal before sending (args over 1 MB) is 'not sent': the window is tried", async () => {
  const net = await import("node:net"); const sock = join(T, "daemon-big.sock");
  const srv = net.createServer((c) => { let b = ""; c.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i < 0) return; const m = JSON.parse(b.slice(0, i)); c.end(JSON.stringify({ id: m.id, error: "args over 1 MB" }) + "\n"); }); });
  await new Promise<void>((ok) => srv.listen(sock, ok)); process.env.PI_JOT_RELAY_LINK = sock;
  const { noteUi, io } = await import("../src/io.ts"); noteUi(ctx);
  const w = await io(REMOTE).append(join(REMOTE, "Notes/BigViaWindow.md"), "fits the window\n");
  expect(readFileSync(w, "utf8")).toBe("fits the window\n");
  srv.close(); delete process.env.PI_JOT_RELAY_LINK;
});
