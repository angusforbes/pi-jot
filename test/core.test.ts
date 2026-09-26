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
