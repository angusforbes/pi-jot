import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, parseInput, renderEntry, resolvePaths, safeTitle, titleFrom, writeEntry } from "../src/core.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-jot-"));

describe("titles and input", () => {
  test("auto title skips filler", () => expect(titleFrom("remember to buy eggs!")).toBe("BuyEggs"));
  test("@Title picks the file, text kept exactly", () =>
    expect(parseInput("  @Shopping eggs, don't \"forget\" milk ")).toEqual({ title: "Shopping", text: "eggs, don't \"forget\" milk" }));
  test("no path tricks in titles", () => {
    expect(safeTitle("../../etc/passwd")).toBe("etc passwd");
    expect(safeTitle("..")).toBe("Untitled");
  });
});

describe("entries", () => {
  test("verbatim text, $ patterns untouched, continuation lines indented", () => {
    const e = renderEntry(DEFAULTS.kinds.note, "cost $& and $1\nsecond line", "T", new Date(2026, 8, 26, 9, 5));
    expect(e).toMatch(/^- \[09:05 \w+\] cost \$& and \$1\n  second line\n$/);
  });
  test("custom template", () =>
    expect(renderEntry({ mode: "append", folder: "Q", file: "{date}.md", entry: "> {text}\n" }, "hi", "x")).toBe("> hi\n"));
});

describe("paths and config", () => {
  test("root '.' is the working directory; escape refused", () => {
    const cfg = { root: ".", user: "u", kinds: {} };
    expect(resolvePaths(cfg, { mode: "append", folder: "notes", file: "{title}.md" }, "A", new Date(), "/w").file).toBe("/w/notes/A.md");
    expect(() => resolvePaths(cfg, { mode: "append", folder: "notes", file: "../x.md" }, "A", new Date(), "/w")).toThrow();
  });
  test("user config merges over defaults per kind", () => {
    const d = tmp(), p = join(d, "jot.json");
    writeFileSync(p, JSON.stringify({ root: "~/x", user: "Angus", kinds: { note: { folder: "N" }, quote: { title: "auto" } } }));
    const c = loadConfig(p);
    expect(c.kinds.note.folder).toBe("N");
    expect(c.kinds.note.entry).toBe("- [{time}] {text}");
    expect(c.kinds.idea.folder).toBe("Ideas");
    expect(c.kinds.quote.mode).toBe("append");
    expect(c.user).toBe("Angus");
  });
});

describe("writing", () => {
  test("appends, adding a newline if the file lacks one", async () => {
    const d = tmp();
    const cfg = { root: d, user: "u", kinds: DEFAULTS.kinds };
    writeFileSync(join(d, "x"), "");
    const f1 = await writeEntry(cfg, "note", cfg.kinds.note, "one", "Buy");
    writeFileSync(f1, readFileSync(f1, "utf8").trimEnd());
    await writeEntry(cfg, "note", cfg.kinds.note, "two", "Buy");
    const lines = readFileSync(f1, "utf8").split("\n");
    expect(f1).toBe(join(d, "Notes", "Buy.md"));
    expect(lines[0]).toMatch(/one$/);
    expect(lines[1]).toMatch(/two$/);
  });
  test("handler gets the entry on stdin", async () => {
    const d = tmp(), out = join(d, "out.txt");
    const kind = { mode: "append" as const, folder: "F", file: "{title}.md", handler: ["sh", "-c", `cat > ${out}; echo "$JOT_KIND {title}" >> ${out}`] };
    await writeEntry({ root: d, user: "u", kinds: {} }, "idea", kind, "hello", "Big Idea");
    expect(readFileSync(out, "utf8")).toMatch(/hello\nidea Big Idea\n$/);
  });
});

describe("poem", () => {
  test("own file with frontmatter; a second poem with the same title gets 'Title 2.md'", async () => {
    const d = tmp();
    const cfg = { root: d, user: "u", kinds: DEFAULTS.kinds };
    const poem = "first line  \nsecond line\n\nnew stanza";
    const f1 = await writeEntry(cfg, "poem", cfg.kinds.poem, poem, "The Foxes", d, { author: "Claude" });
    const f2 = await writeEntry(cfg, "poem", cfg.kinds.poem, "again", "The Foxes", d, { author: "Claude" });
    expect(f1).toBe(join(d, "Poems", "The Foxes.md"));
    expect(f2).toBe(join(d, "Poems", "The Foxes 2.md"));
    const s = readFileSync(f1, "utf8");
    expect(s).toMatch(/^---\ntitle: The Foxes\nauthor: Claude\ncreated: \d{4}-\d\d-\d\d\ntags:\n  - poem\n---\n# The Foxes\n\n/);
    expect(s).toContain(poem + "\n");
  });
});

import { addWords, planStatus, renderPlan, setBody, setStatus, tickTask, wordsEntry } from "../src/core.ts";

describe("plan notes (J398)", () => {
  const d = new Date(2026, 9, 10, 9, 5);
  const base = () => renderPlan({ title: "Garden tractor", kind: "soliloquy", status: "drafting", words: [wordsEntry("my idea: a $1 tractor\nsecond line, don't \"fix\" it", d)], body: "## Summary\nA tractor.", user: "Angus" }, d);
  test("words verbatim, body and status replaceable", () => {
    let n = base();
    expect(n).toContain("my idea: a $1 tractor\n  second line, don't \"fix\" it");
    expect(planStatus(n)).toBe("drafting");
    n = addWords(n, "turn two: $& stays", d);
    n = setBody(n, "## Summary\nA better tractor.\n\n## Open questions\n1. Size?");
    n = setStatus(n, "ready");
    expect(n).toContain("turn two: $& stays");
    expect(n).toContain("A better tractor.");
    expect(n).not.toContain("A tractor.");
    expect(n.indexOf("my idea")).toBeLessThan(n.indexOf("turn two"));
    expect(planStatus(n)).toBe("ready");
    expect(() => setStatus(n, "finished")).toThrow();
  });
  test("tick by id or unique text, refuse ambiguous", () => {
    let n = setBody(base(), "### Parallel tasks\n- [ ] T1 build the frame · tester: Sweep\n- [ ] T2 build the engine\n- [ ] T10 paint");
    n = tickTask(n, "T1");
    expect(n).toContain("- [x] T1 build the frame");
    expect(n).toContain("- [ ] T10 paint");
    n = tickTask(n, "engine");
    expect(n).toContain("- [x] T2 build the engine");
    expect(() => tickTask(n, "build")).toThrow(/matches 2/);
    expect(tickTask(n, "T1", false)).toContain("- [ ] T1 build");
  });
});

describe("plan task ids (J398 review)", () => {
  test("T0b is an id, distinct from T0", () => {
    const n = setBody(renderPlan({ title: "x", kind: "parallel", status: "ready", words: [], body: "", user: "A" }), "- [ ] T0 card\n- [ ] T0b groundwork\n- [ ] T1 next · after: T0b");
    const t = tickTask(n, "T0b");
    expect(t).toContain("- [x] T0b groundwork");
    expect(t).toContain("- [ ] T0 card");
    expect(t).toContain("- [ ] T1 next");
    expect(tickTask(n, "T0")).toContain("- [x] T0 card");
  });
});
