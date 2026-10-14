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
afterAll(() => { /* temp files stay for a look if a test failed */ });

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

test("(JotAllCheck) a change whose socket answer is lost is NOT repeated through the window: one line, and 'may or may not' said", async () => {
  const net = await import("node:net");
  const sock = join(T, "lost.sock");
  const srv = net.createServer((c) => { let b = ""; c.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i >= 0) { answer(b.slice(0, i)); c.destroy(); } }); }); // carries it out, never answers
  await new Promise<void>((ok) => srv.listen(sock, ok));
  process.env.PI_JOT_RELAY_SOCKET = sock;
  let windowCalls = 0;
  const { noteUi, io } = await import("../src/io.ts");
  noteUi({ ui: { input: async (_t: string, ph?: string) => { windowCalls++; return answer(ph!); } } });
  const f = join(REMOTE, "Notes/LostAck.md");
  await expect(io(REMOTE).append(f, "exactly once\n")).rejects.toThrow(/may or may not/);
  expect(readFileSync(join(LAPTOP, "Notes/LostAck.md"), "utf8")).toBe("exactly once\n");
  expect(windowCalls).toBe(0);
  srv.close(); delete process.env.PI_JOT_RELAY_SOCKET; noteUi(ctx);
});
