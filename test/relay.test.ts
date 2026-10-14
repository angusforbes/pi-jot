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
  expect(ask("Notes/ok.md").ok).toBe(true);
});
