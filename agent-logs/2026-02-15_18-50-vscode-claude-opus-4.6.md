User: Read this article: https://blog.can.ac/2026/02/12/the-harness-problem/
I want to create a tool for github copilot within vscode inspired by that article. It should have a mode for reading a range of lines from a file, and print the lines prefixed with line number and a two-character hash of the line contents. It should also have a mode for replacing a range of lines based on line number and content hashes of the lines. Plan this out first. How do tools work - do they avoid shell escaping? Let me know of any questions of issues with this approach.

GitHub Copilot: 

  



Fetched https://blog.can.ac/2026/02/12/the-harness-problem/

I've read the article. Here's my plan and analysis:

## The Hashline Concept

The article argues that edit tools waste tokens by making models reproduce content they already saw. Instead, tag each line with a short content hash when reading, then reference those tags when editing — the hash acts as a lightweight, verifiable anchor.

## Tool Design

**Two tools, implemented as an MCP server (simplest path for VS Code + Copilot):**

### `hashline_read`
- **Params**: `filePath: string`, `startLine: number`, `endLine: number`
- **Returns**: Lines formatted as `{lineNum}:{2charHash}|{content}`
- Example output:
  ```
  11:a3|function hello() {
  22:f1|  return "world";
  33:0e|}
  ```

### `hashline_replace`
- **Params**: `filePath: string`, `startLine: number`, `startHash: string`, `endLine: number`, `endHash: string`, `newContent: string`
- Validates that line numbers + hashes still match current file content before applying
- Replaces the entire range `[startLine, endLine]` with `newContent`
- Rejects if hashes don't match (file changed since read)

## Shell Escaping

**MCP tools completely avoid shell escaping.** The MCP protocol communicates via JSON-RPC over stdio. Your tool implementation receives parameters as structured typed values (strings, numbers, etc.) — no shell is involved at any point. This is a major advantage over tools that shell out to commands. Newlines, quotes, backslashes in `newContent` are just normal string characters.

## Questions & Issues

1. **Insert-only operations**: The article mentions "insert after `3:0e`". Should we support an insert mode (no lines deleted, just insert after a hash-anchored line)? I'd suggest supporting it by allowing `startLine` > `endLine` (e.g., start=4, end=3 means "insert before line 4 without deleting anything"), or adding a separate `hashline_insert` tool.

2. **Hash length**: 2 hex chars = 256 values. Collision probability within a file is low but nonzero. The article mentions 2-3 chars. 2 is fine for files under ~500 lines; 3 would be safer. Which do you prefer?

3. **Hash function**: I'd use the first 2 hex chars of a CRC32 or FNV-1a of the (trimmed?) line content. Trimming whitespace before hashing would make hashes stable across reformatting — but then you lose the ability to detect whitespace-only changes. I'd lean toward hashing the raw line.

4. **Multi-range edits**: Should `hashline_replace` accept an array of replacements in one call? This reduces round-trips but adds complexity. The article's benchmark just used single-edit calls.

5. **Implementation**: I'd implement this as a simple Node.js MCP server with a `package.json` that VS Code can discover. It would be ~100 lines of code. Alternatively, it could be a Python script. Preference?

6. **Scope**: Should the tool work only on workspace files, or any absolute path? MCP servers typically work with any path.

Want me to proceed with implementation, and if so, what are your preferences on the above questions?

User: Why an MCP server rather than VS Code extension using the vscode.lm.registerTool API?

GitHub Copilot: 

 Good point — `vscode.lm.registerTool` is the better choice here. Advantages:

- **Native integration**: The tool shows up directly in Copilot Chat without any MCP configuration. Users just install the extension.
- **Direct workspace access**: You get the full `vscode.workspace.fs` API, text document management, etc. — no need to reimplement path resolution or security boundaries.
- **No separate process**: MCP runs as a child process communicating over stdio. A VS Code extension runs in the extension host — simpler architecture, no process lifecycle to manage.
- **Simpler distribution**: Just a `.vsix` or Marketplace publish.

The main reason to prefer MCP would be **cross-tool compatibility** — an MCP server works with Claude Code, Cursor, Windsurf, etc., not just VS Code Copilot. If you only care about Copilot in VS Code, `vscode.lm.registerTool` is strictly better.

Both avoid shell escaping — `registerTool` receives typed parameters via the tool invocation schema (JSON), same as MCP.

Want me to build it as a VS Code extension using `vscode.lm.registerTool`?

User: For hash length and operations supported, help me figure out what will work best for an LLM. Will the LLM turn a hex hash like 8F into a single token, or multiple? Is there a good way to use an arbitrary single token? Is there some other way to identify the hash of a line that would work better for an LLM? And does putting a : after the line number and a | after the hash work well for an LLM in terms of token use and comprehension?Or is there something else that will better help an LLM recall and use these tokens? As far as multi-line edits: will an LLM want to replace multiple chunks at a time, or prefer a single tool call per chunk? I like the idea of an insert mode. Delete mode can be accomodated by replacing a range of lines with nothing. For ranges, I lean toward requiring a full list of hashes: replace 2:3f,3:c8,4:18 with ... But you tell me what will work best for an LLM editing code. I agree with hashing the entire line content including whitespace.

GitHub Copilot: 

 Great questions. Let me analyze each systematically.

## Tokenization of Hashes

**Hex like `8F`**: In BPE tokenizers (Claude, GPT, etc.), `8F` with mixed case is often 2 tokens (`8`, `F`). Lowercase `8f` is more likely 1 token but not guaranteed for all combos.

**Best single-token option: two lowercase letters (a-z).** Combinations like `qk`, `ab`, `fn` are almost always single tokens because they appear constantly as subwords in English training data. This gives 676 values instead of hex's 256 — and collision doesn't matter for correctness anyway since the line number already disambiguates position. The hash just detects if *that specific line* changed, so even 256 values (0.4% false match per line) is fine. 676 is a bonus.

**Avoid**: two-digit numbers for the hash — they'd visually collide with line numbers and confuse the model.

## Delimiter Choice

`42:qk|  if (x > 0) {` costs exactly 4 overhead tokens:
- `42` → 1 token
- `:` → 1 token  
- `qk` → 1 token
- `|` → 1 token

This is good. The `:` after line numbers matches grep/compiler output format, which LLMs have seen billions of times. The `|` is a clear, single-token boundary that doesn't appear as frequently at line starts in code. I'd keep this format exactly as proposed.

## Full Hash List vs. Start/End Anchors

Your instinct for the full list is right. Reasoning:

- The hashes are **in the model's context window** from the read call. The model is *copying* them, not recalling from memory. LLMs are excellent at copying sequences from context.
- Full list gives maximum verification — if ANY line was inserted/deleted/modified, the edit is rejected.
- For typical edits (1-15 lines being replaced), listing all hashes adds trivial token cost.
- Start/end only would fail to detect mid-range insertions or deletions by other tools.

For very large replacements (50+ lines), the model should probably re-read the file anyway. So the full list is the right tradeoff.

## Multi-Chunk in One Call

**One call, multiple chunks.** Each tool call round-trip costs the model ~100+ tokens of overhead (tool result framing, re-attending to context). If a model needs to change 3 spots in one file, forcing 3 calls wastes ~300 tokens and 3 inference cycles. A single call with an array of replacements is strictly better.

Suggested schema:

```json
{
  "filePath": "src/foo.ts",
  "edits": [
    {
      "lineHashes": "42:qk,43:ab,44:fn",
      "content": "  if (x >= 0) {\n    return true;\n  }"
    },
    {
      "lineHashes": "78:mp",
      "content": "  return result + 1;"
    }
  ]
}
```

The `lineHashes` as a comma-separated string is compact — the model generates it by copying `{num}:{hash}` pairs from its read output. No nested JSON objects for each line, which would balloon token count.

## Insert and Delete

- **Delete**: `lineHashes: "10:ab,11:cd,12:ef"`, `content: ""` — deletes those 3 lines.
- **Insert after**: `lineHashes: "10:ab"`, `content: "  new line\n  another"`, plus an `"insertAfter": true` flag. This keeps line 10 intact and inserts after it.
- **Insert at start of file**: Might need a special sentinel like `lineHashes: "0:"` to mean "before line 1."

## Summary of Recommendations

| Aspect | Recommendation | Why |
|---|---|---|
| Hash chars | 2 lowercase letters a-z | Single token, visually distinct from line numbers, 676 values |
| Read format | `42:qk\|content` | 4 tokens overhead, grep-like, clear boundaries |
| Edit spec | Full hash list `"42:qk,43:ab"` | Copy-from-context is easy; maximum correctness |
| Multi-chunk | Array of edits per call | Saves round-trips, tokens, latency |
| Insert | Flag on the edit | Clean, no ambiguity |
| Delete | Empty content string | Natural, no extra API surface |

Want me to start building the extension?

User: Great. Should we support reading from or editing multiple files in one operation? Would an LLM use that? And what should the tool return to the LLM in case of success or errors? I lean toward applying the edits that worked and returning some kind of failure for the ones that failed, but I defer to your judgement. Also, what language is best to write this in? I lean toward a lightweight scripting language like python for the first draft. Are there any issues with that? And we'll go with the vscode.lm.registerTool. 

GitHub Copilot: 

 ## Multi-file operations

**Read**: No, keep single-file. When an LLM needs to read multiple files, they're typically discovered incrementally (read file A → see import → read file B). A batch read would only be useful if the model already knows exactly which files it needs, which is rare. Also, returning multiple files in one result blob makes it harder for the model to reference which hashes came from where.

**Edit**: Yes, support multi-file. When an LLM is making a coordinated change (renaming a function used in 3 files, updating an import and its usage), it already knows all the edits. Making it issue 3 sequential tool calls wastes time. Schema:

```json
{
  "edits": [
    { "filePath": "src/foo.ts", "lineHashes": "10:qk,11:ab", "content": "new code" },
    { "filePath": "src/bar.ts", "lineHashes": "5:mn", "content": "updated import" }
  ]
}
```

## Error Handling

**Apply what works, report what failed.** This is correct. Reasoning:

- If the model edited 4 chunks and 1 fails due to a stale hash, rolling back the other 3 would force the model to redo all of them. Wasteful.
- The model needs to know *which* edit failed and *why* so it can re-read just that region and retry.

Return format:

```json
{
  "applied": 3,
  "failed": 1,
  "results": [
    { "filePath": "src/foo.ts", "lineHashes": "10:qk,11:ab", "status": "ok" },
    { "filePath": "src/bar.ts", "lineHashes": "5:mn", "status": "error",
      "error": "hash mismatch at line 5: expected 'mn', got 'xp'" }
  ]
}
```

One subtlety: **edits within the same file must be applied bottom-up** (highest line numbers first), otherwise earlier insertions/deletions shift line numbers for later edits. The tool should handle this automatically — sort edits per file in reverse line order before applying.

## Language

**Must be TypeScript.** VS Code extensions run in the extension host, which is a Node.js process. The `vscode.lm.registerTool` API is only available from the `vscode` module in a JS/TS extension. There's no way to use Python here — the extension entry point must export an `activate` function that VS Code calls, and it must use the `vscode` namespace.

The good news: the actual logic is simple (~150 lines of TypeScript). The hash function, line reading, and file editing are straightforward string operations. TypeScript is fine for this. No complex dependencies needed.

Shall I build it?

User: Yes, first write a .md specification, then build it in a subdirectory of this project.

GitHub Copilot: 

  

Created 6 todos

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/SPEC.md)

Starting: *Scaffold VS Code extension* (2/6)

Now let me look at the `vscode.lm.registerTool` API to make sure I use the correct interfaces: 

Searched VS Code API for "vscode.lm.registerTool API for language model tools, LanguageModelTool interface, tool registration, IToolInvocation, tool parameter schema, tool result"

Searched VS Code API for "LanguageModelToolResult LanguageModelToolResultPart LanguageModelToolInvocationOptions LanguageModelTextPart content text part"

Searched VS Code API for "LanguageModelToolInvocationOptions input toolInvocationToken prepareInvocation"

Searched VS Code API for "package.json contributes languageModelTools contribution point tool declaration"

Good, I have the full API picture. Now let me scaffold the extension and implement everything. 

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/package.json)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/tsconfig.json)

Starting: *Implement hash function* (3/6)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/src/hash.ts)

Starting: *Implement hashline_read tool* (4/6)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/src/readTool.ts)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/src/util.ts)

Starting: *Implement hashline_edit tool* (5/6)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/src/editTool.ts)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/src/extension.ts)

Starting: *Build and test extension* (6/6)

Ran terminal command:  cd /Users/sethml/src/opencascade-rs/hashline-edit && npm install 2>&1

Ran terminal command:  npx tsc -p ./ 2>&1

Clean compile. Let me verify the output: 

Read [](file:///Users/sethml/src/opencascade-rs/hashline-edit/out)

Let me add a .gitignore and a quick smoke test for the hash function: 

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/.gitignore)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/src/hash.test.ts)

Ran terminal command:  npx tsc -p ./ 2>&1 && node out/hash.test.js 2>&1

Completed: *Build and test extension* (6/6)

Extension is built and tested. Here's the file structure:

```
hashline-edit/
├── SPEC.md              # Full specification
├── package.json         # Extension manifest with tool schemas
├── tsconfig.json
├── .gitignore
├── src/
│   ├── extension.ts     # Registers both tools
│   ├── hash.ts          # FNV-1a → two-letter hash
│   ├── hash.test.ts     # Smoke test (node out/hash.test.js)
│   ├── readTool.ts      # hashline_read tool
│   ├── editTool.ts      # hashline_edit tool
│   └── util.ts          # Path resolution helper
└── out/                 # Compiled JS (gitignored)
```

**To use it**: Open the hashline-edit folder in VS Code's Extension Development Host (F5), and the `hashline_read` / `hashline_edit` tools will appear in Copilot Chat.

Key design decisions implemented:
- **2-letter hashes** (`ja`, `wx`, etc.) — single tokens, 93/100 unique in testing
- **Full hash list** in edits for maximum verification
- **Multi-file, multi-chunk** edits in one call, applied bottom-up per file
- **Partial success**: applied edits kept, failures reported individually
- **Confirmation dialog** on edits via `prepareInvocation`
- **Insert-after** with `insertAfter: true`, **delete** with empty `content`
- **`0:`** sentinel for insert-at-beginning-of-file

Made changes.

User: Do I need to direct agents to use the tool for edits? What's the best way to do so? Write up instructions in SPEC.md.

GitHub Copilot: 

 Good question. Registered tools appear in Copilot's tool list, but the agent won't prefer them over built-in tools unless directed. Let me research the best mechanisms and add instructions. 



Fetched https://code.visualstudio.com/docs/copilot/copilot-customization



Fetched https://code.visualstudio.com/docs/copilot/customization/custom-instructions

Now I have the full picture. Let me add the usage instructions to the spec. 

Read [](file:///Users/sethml/src/opencascade-rs/hashline-edit/SPEC.md#175-175), lines 175 to 190

Read [](file:///Users/sethml/src/opencascade-rs/hashline-edit/SPEC.md#240-240), lines 240 to 263

Replacing 23 lines with 146 lines in [](file:///Users/sethml/src/opencascade-rs/hashline-edit/SPEC.md)


```

```
Done. The spec now has a full "Directing Agents to Use Hashline Tools" section with four methods ranked by practicality:

1. **Custom instructions** (`copilot-instructions.md` / AGENTS.md) — recommended, project-wide, uses `#tool:hashlineRead` syntax
2. **File-based instructions** (`.instructions.md` with `applyTo` glob) — for gradual rollout
3. **Per-prompt reference** (`#hashlineRead` in chat) — for trying it out
4. **Custom agent** (`.github/agents/hashline-coder.md`) — for isolating hashline from the default agent

The key insight: just registering the tools isn't enough. The `#tool:toolReferenceName` syntax in instruction files creates a direct binding that VS Code resolves, making the tools visible in the agent's context. Without that, agents will default to their built-in `read_file` / `replace_string_in_file`.

Made changes.

User: Split SPED.md - keep the specification bits there, but move the "how to use this" bits into a README.md. Add how to install the tool in vscode to the README. Then commit.

GitHub Copilot: 

  

Created 4 todos

Read [](file:///Users/sethml/src/opencascade-rs/hashline-edit/SPEC.md#1-1), lines 1 to 150

Read [](file:///Users/sethml/src/opencascade-rs/hashline-edit/SPEC.md#150-150), lines 150 to 386

Starting: *Create README.md with usage/install* (2/4)

Created [](file:///Users/sethml/src/opencascade-rs/hashline-edit/README.md)

Starting: *Trim SPEC.md to spec-only* (3/4)

Now trim the "Directing Agents" and "File Structure" sections from SPEC.md, keeping only the technical specification: 

Replacing 146 lines with 12 lines in [](file:///Users/sethml/src/opencascade-rs/hashline-edit/SPEC.md)


```

```


Starting: *Commit changes* (4/4)

Ran terminal command:  cd /Users/sethml/src/opencascade-rs && git add hashline-edit/ && git status --short hashline-edit/

Ran terminal command:  git commit -m "Add hashline-edit VS Code extension

Hash-anchored line editing tools for GitHub Copilot. Reads files with
line-number:hash tags, edits by referencing those hashes. Prevents
stale-file edits and eliminates token waste from reproducing content.

Two tools: hashline_read (read with hashes) and hashline_edit (edit by
hash reference). Supports replace, insert-after, delete, multi-chunk
and multi-file edits in a single call.

Inspired by 'The Harness Problem' by Can Bölük."

Completed: *Commit changes* (4/4)

Done. Committed as `3219326`. 

- **SPEC.md** — now contains only the technical specification: line format, hash function, tool schemas, parameters, validation rules, and return values.
- **README.md** — contains the "how to use" content: overview, installation (from source + packaged `.vsix`), all four methods for directing agents, operations reference table, and agent behavior notes.

Made changes.