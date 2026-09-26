# pi-jot

Pi commands that jot things down **exactly as typed**: `/note`, `/idea` and `/todo`,
plus any kinds you add. They write Markdown into an Obsidian vault by default, but the
folders, file names, entry format, and even the app that receives each entry come from
one settings file.

```
/note remember to buy eggs!          -> ~/Obsidian/Notes/BuyEggs.md     "- [14:32 CDT] remember to buy eggs!"
/note @Shopping eggs, milk           -> ~/Obsidian/Notes/Shopping.md    (@Title picks the file)
/note                                -> the agent writes one note summarising the recent conversation
/idea build a tractor for the garden -> ~/Obsidian/Ideas/Tractor.md     (the agent picks the title only)
/idea                                -> the agent writes up an idea from the conversation (asks if none)
/todo                                -> summary of open items in ThingsToDo/todo.md and the lists it links
/todo NIM                            -> only the matching list(s)
/todo add <item>                     -> the agent files "- [ ] <item>" (item kept exactly as typed)
/todo done <item>                    -> the agent ticks the best match and moves it to ## Done
```

## Exactly as typed

Pi's prompt templates parse arguments shell-style, which eats apostrophes and quote marks,
so these are extension commands that receive the raw text. For append kinds (`note`, `idea`,
your own) the **extension writes the text itself**. When a kind wants the agent to pick a
title (`"title": "agent"`), the text is held by the extension and the agent only calls the
`jot_save` tool with a title and a pending id: it never retypes your words.
(`/todo add` still has the agent place the item in the right list, told to copy it verbatim.)

## Install

```
pi install git:github.com/angusforbes/pi-jot
```

or, from a checkout, add its path to `packages` in `~/.pi/agent/settings.json`. Then `/reload`.

## Configure: `~/.pi/agent/jot.json`

Optional; everything has a default. Your file is merged over the defaults, kind by kind and
field by field, and re-read on every command (adding or renaming a *command* needs `/reload`).
`PI_JOT_CONFIG` points at a different file.

```json
{
  "root": "~/Obsidian",
  "user": "Angus",
  "kinds": {
    "note":  { "folder": "Notes" },
    "idea":  { "folder": "Ideas" },
    "todo":  { "folder": "ThingsToDo", "file": "todo.md" },
    "quote": { "mode": "append", "folder": "Quotes", "file": "{date}.md", "entry": "> {text}\n", "title": "auto" }
  }
}
```

| Field | Meaning |
|---|---|
| `root` | Base directory (`~` allowed). `"."` means the session's working directory, e.g. a `notes/` folder inside the current project. A kind may set its own `root`. |
| `user` | How the agent refers to you in its instructions (default "the user"). |
| `kinds.<name>` | One command per kind (`command` renames it; `"enabled": false` hides it). |
| `mode` | `append` (save an entry) or `list` (the agent manages a todo list). |
| `folder`, `file` | Where it goes; `file` may use `{title}` and `{date}` (YYYY-MM-DD). Paths cannot escape the folder. |
| `entry` | Entry template: `{text}`, `{time}` (HH:MM TZ), `{date}`, `{title}`. Default `- [{time}] {text}`; continuation lines of a `- ` bullet are indented. |
| `title` | `auto` (from the first words, no agent) or `agent` (agent picks it; see `titleStyle`). |
| `titleStyle`, `bare`, `description` | What the agent is told about titles, what a bare command asks for, and the command's help text. |
| `handler` | Hand the entry to another app instead of appending to the file: an argv array, the entry on stdin, `{file}` `{title}` `{kind}` placeholders and `JOT_FILE`/`JOT_TITLE`/`JOT_KIND` in the environment. |

A new kind in the config (like `quote` above) becomes a new command after `/reload`; no code needed.

## Tool

`jot_save { kind, title, pending_id? , text? }`: writes one entry for an append kind and returns
the path. With a `pending_id` from a command message it writes the held, as-typed text.

## Develop

`bun test` (core logic: titles, templates, paths, merging, writing, handlers).
