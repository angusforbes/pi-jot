// pi-jot core: config, titles, timestamps, entry templates and the writer.
// No Pi imports here, so it can be tested with plain `bun test`.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export type Kind = {
  /** Command name (default: the kind's key). */
  command?: string;
  description?: string;
  /** "append": save an entry to a file. "list": the agent manages a list (todo). */
  mode: "append" | "list";
  /** Overrides the top-level root for this kind. "." = the session's working directory. */
  root?: string;
  folder: string;
  /** File name template: {title}, {date}. */
  file: string;
  /** Entry template: {text}, {time}, {date}, {title}. Continuation lines of a "- " entry are indented. */
  entry?: string;
  /** How a typed entry gets its title: "auto" (from its first words, no agent) or "agent" (agent picks one). */
  title?: "auto" | "agent";
  /** Title shape shown to the agent, e.g. "PascalCase, 1-3 words" or "short and human-readable". */
  titleStyle?: string;
  /** Instruction used when the command is run with no text. */
  bare?: string;
  /** The agent writes the entry: typed text is its direction (topic, subject), not the entry itself. */
  compose?: boolean;
  /** With compose: also keep the typed text, exactly as typed, before the agent's entry (Angus, 2026-10-07:
   *  "If my poem command has a poem, then include that verbatim … along with your poem"). */
  keepTyped?: boolean;
  /** Instruction for composing from typed direction ({user} allowed); used when compose is true. */
  directed?: string;
  /** Never append to an existing file: pick "Title 2.md", "Title 3.md", … instead. */
  newFile?: boolean;
  /** Optional external command instead of appending to the file: argv, entry on stdin,
   *  placeholders {file} {title} {kind}; env JOT_FILE, JOT_TITLE, JOT_KIND. */
  handler?: string[];
  enabled?: boolean;
};

export type JotConfig = { root: string; user: string; kinds: Record<string, Kind> };

export const CONFIG_PATH = process.env.PI_JOT_CONFIG || join(homedir(), ".pi", "agent", "jot.json");

export const DEFAULTS: JotConfig = {
  root: "~/Obsidian",
  user: "the user",
  kinds: {
    note: {
      mode: "append",
      folder: "Notes",
      file: "{title}.md",
      entry: "- [{time}] {text}",
      title: "auto",
      titleStyle: "1-3 PascalCase words for the main topic",
      description: "Save a note exactly as typed (/note @Title text picks the file; bare /note = summarise)",
      bare: "Write ONE short note summarising the most useful point from the last few exchanges (a decision, a reminder, or where things stand).",
    },
    idea: {
      mode: "append",
      folder: "Ideas",
      file: "{title}.md",
      entry: "- [{time}] {text}",
      title: "agent",
      titleStyle: 'short and human-readable, naming the main concept (e.g. "my idea is to build a tractor to automate garden soil prep" -> "Tractor")',
      description: "Save an idea exactly as typed; the agent picks a title (bare /idea = from the conversation)",
      bare: "Look at the recent conversation for an idea or proposal worth keeping and write it up clearly in a few sentences. If there is no clear idea, ask {user} what to save instead of inventing one (and do not call jot_save).",
    },
    poem: {
      mode: "append",
      folder: "Poems",
      file: "{title}.md",
      entry: "---\ntitle: {title}\nauthor: {author}\ncreated: {date}\ntags:\n  - poem\n---\n# {title}\n\n{text}\n",
      title: "agent",
      compose: true,
      newFile: true,
      titleStyle: "the poem's title",
      description: "Write a poem into its own file (optional direction: topic, subject; bare /poem = from the conversation)",
      directed: "Write a short, original poem following {user}'s direction between the markers (topic, subject or anything else it asks for). Choose whatever style, form, rhythm and tone suit it unless the direction says otherwise. No need to force rhyme. Write it yourself; do not delegate.",
      bare: "Write a short, original poem inspired by what {user} and you have been discussing most recently. Choose whatever style, form, rhythm and tone suit it. Draw on specific images, questions or tensions from the conversation rather than summarising the task. No need to force rhyme. Write it yourself; do not delegate.",
    },
    todo: {
      mode: "list",
      folder: "ThingsToDo",
      file: "todo.md",
      description: "Todo lists: summary | <focus> | add <item> (kept exactly as typed) | done <item>",
    },
  },
};

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Defaults, with ~/.pi/agent/jot.json merged over them (per kind, per field). Read on every use. */
export function loadConfig(path = CONFIG_PATH): JotConfig {
  let user: Partial<JotConfig> = {};
  if (existsSync(path)) {
    try { user = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { throw new Error(`pi-jot: cannot parse ${path}: ${(err as Error).message}`); }
  }
  const kinds: Record<string, Kind> = {};
  for (const [k, v] of Object.entries(DEFAULTS.kinds)) kinds[k] = { ...v };
  for (const [k, v] of Object.entries(user.kinds ?? {})) kinds[k] = { ...(kinds[k] ?? { mode: "append", folder: k, file: "{title}.md", entry: "- [{time}] {text}", title: "agent" }), ...v };
  return { root: user.root ?? DEFAULTS.root, user: user.user ?? DEFAULTS.user, kinds };
}

// words skipped at the start when making a title ("remember to buy eggs" -> BuyEggs)
const FILLER = new Set([
  "i", "im", "i'm", "am", "we", "were", "we're", "you", "is", "are", "making", "remember", "to", "dont", "don't",
  "do", "not", "forget", "note", "that", "please", "the", "a", "an", "need", "should", "must", "just", "so", "ok", "okay",
]);

/** Title from the first few meaningful words, PascalCase: "remember to buy eggs!" -> "BuyEggs". */
export function titleFrom(text: string, fallback = "Note"): string {
  const firstClause = text.split(/[.,;:!?\n]/)[0] ?? text;
  const words = firstClause.split(/\s+/).map((w) => w.replace(/[’]/g, "'")).filter(Boolean);
  let i = 0;
  while (i < words.length - 1 && FILLER.has(words[i].toLowerCase())) i++;
  const title = words.slice(i, i + 3)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("")
    .slice(0, 48);
  return title || fallback;
}

/** A title safe to use as a file name: no path separators, no leading dots, no control characters. */
export function safeTitle(t: string, fallback = "Untitled"): string {
  const s = t.replace(/\.md$/i, "").replace(/[\/\\\x00-\x1f]/g, " ").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return s || fallback;
}

/** "22:17 CDT" in local time. */
export function stamp(d = new Date()): string {
  const t = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
  return t.replace(/^24:/, "00:");
}

/** Local "YYYY-MM-DD". */
export function dateStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Split raw input into an optional "@Title" and the text (kept exactly as typed, outer whitespace trimmed). */
export function parseInput(raw: string): { title?: string; text: string } {
  const text = raw.replace(/^\s+|\s+$/g, "");
  const m = text.match(/^@([^\s/\\]+)\s+([\s\S]+)$/);
  return m ? { title: m[1].replace(/\.md$/i, ""), text: m[2] } : { text };
}

/** Fill a template. The text is inserted as-is (no $-pattern expansion). */
export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all));
}

/** The entry for a file: continuation lines of a "- " bullet are indented so they stay inside it. */
export function renderEntry(kind: Kind, text: string, title: string, d = new Date(), extra: Record<string, string> = {}): string {
  const tpl = kind.entry ?? "- [{time}] {text}";
  const body = text.replace(/\r\n?/g, "\n");
  const indented = tpl.trimStart().startsWith("- ") ? body.split("\n").join("\n  ") : body;
  const out = fill(tpl, { author: "", ...extra, text: indented, time: stamp(d), date: dateStr(d), title });
  return out.endsWith("\n") ? out : out + "\n";
}

/** Absolute folder and file for a kind; refuses anything that would escape the folder. */
export function resolvePaths(cfg: JotConfig, kind: Kind, title: string, d = new Date(), cwd = process.cwd()) {
  const rootRaw = kind.root ?? cfg.root;
  const root = rootRaw === "." ? cwd : resolve(cwd, expandHome(rootRaw));
  const folder = resolve(root, kind.folder);
  const file = resolve(folder, fill(kind.file, { title: safeTitle(title), date: dateStr(d) }));
  if (!(file + sep).startsWith(folder + sep) || file === folder) throw new Error(`pi-jot: refusing path outside ${folder}`);
  return { root, folder, file };
}

/** Append the entry (or hand it to the kind's handler). Returns the file path. */
export async function writeEntry(cfg: JotConfig, kindName: string, kind: Kind, text: string, title: string, cwd = process.cwd(), extra: Record<string, string> = {}): Promise<string> {
  const d = new Date();
  let { file } = resolvePaths(cfg, kind, title, d, cwd);
  if (kind.newFile) {
    for (let n = 2; existsSync(file) && n < 1000; n++) file = resolvePaths(cfg, kind, `${safeTitle(title)} ${n}`, d, cwd).file;
  }
  const entry = renderEntry(kind, text, safeTitle(title), d, extra);
  if (kind.handler?.length) {
    const vars = { file, title: safeTitle(title), kind: kindName };
    const [cmd, ...args] = kind.handler.map((a) => fill(a, vars));
    await new Promise<void>((ok, fail) => {
      const p = spawn(expandHome(cmd), args, { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, JOT_FILE: file, JOT_TITLE: vars.title, JOT_KIND: kindName } });
      let err = "";
      p.stderr.on("data", (b) => { err += b; });
      p.on("error", fail);
      p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`handler exited ${code}: ${err.trim()}`))));
      p.stdin.end(entry);
    });
    return file;
  }
  await mkdir(dirname(file), { recursive: true });
  let prefix = "";
  try {
    const cur = await readFile(file, "utf8");
    if (cur.length && !cur.endsWith("\n")) prefix = "\n";
  } catch { /* new file */ }
  await appendFile(file, prefix + entry, "utf8");
  return file;
}
