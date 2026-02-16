# Hashline Edit

A VS Code extension that gives GitHub Copilot hash-anchored line editing tools.
Instead of reproducing existing file content to make edits (which wastes tokens
and frequently fails), the LLM reads lines tagged with short content hashes and
references those hashes when editing.

Inspired by [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
by Can Bölük.

## How It Works

**Read** a file — each line comes back tagged with a 2-letter content hash:

```
1:qk|import React from 'react';
2:ab|
3:fn|export function App() {
4:mp|  return <div>Hello</div>;
5:ze|}
```

**Edit** by referencing those tags — no need to reproduce the old content:

```json
{
  "edits": [{
    "filePath": "src/app.ts",
    "lineHashes": "4:mp",
    "content": "  return <div>Goodbye</div>;"
  }]
}
```

If the file changed since the read, the hashes won't match and the edit is
safely rejected.

## Installation

### From Source

1. Clone or copy the `hashline-edit/` directory.
2. Install dependencies, compile, and package:
   ```sh
   cd hashline-edit
   npm install
   npm run compile
   npm install -g @vscode/vsce
   vsce package
   ```
3. In VS Code, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
   and run **Extensions: Install from VSIX...**
4. Select the generated `hashline-edit-0.1.0.vsix` file.
5. Reload VS Code when prompted.

### Requirements

- VS Code 1.99 or later (for `vscode.lm.registerTool` API)
- GitHub Copilot extension

## Directing Agents to Use Hashline

The extension registers two tools (`hashline_read` and `hashline_edit`) in
Copilot's tool list, but agents won't prefer them over built-in tools unless
instructed. Here are the ways to direct agents, from most to least recommended.

### Method 1: Custom Instructions (recommended)

Add the following to your `.github/copilot-instructions.md`, `AGENTS.md`, or
`CLAUDE.md`:

```markdown
## File Editing

When reading files for editing, use `#tool:hashlineRead` instead of the
built-in file read tool. It returns lines tagged with content hashes in the
format `{lineNumber}:{hash}|{content}`.

When editing files, use `#tool:hashlineEdit` instead of string-replace tools.
Reference lines by their `{line}:{hash}` pairs from the read output. This
avoids needing to reproduce existing file content and prevents edits to stale
files.

Example workflow:
1. Read: `hashline_read({filePath: "src/app.ts", startLine: 1, endLine: 20})`
   Returns: `1:qk|import React...`
2. Edit: `hashline_edit({edits: [{filePath: "src/app.ts", lineHashes: "4:mp", content: "  return <div>Hello</div>;"}]})`

Operations:
- **Replace**: set `lineHashes` to all lines being replaced, `content` to new text
- **Insert after**: set `insertAfter: true`, `lineHashes` to anchor line
- **Delete**: set `content` to empty string
- Multiple edits can be batched in one call across files
```

The `#tool:hashlineRead` and `#tool:hashlineEdit` syntax creates a direct
reference to the registered tools, which VS Code resolves and includes in
the agent's tool context.

### Method 2: File-Based Instructions

Create `.github/instructions/hashline.instructions.md`:

```markdown
---
name: 'Hashline Editing'
description: 'Use hash-anchored line editing for reliable file modifications'
applyTo: '**/*'
---

Use `#tool:hashlineRead` to read files and `#tool:hashlineEdit` to edit them.
These tools use content hashes to verify edits target the correct lines,
preventing stale-file corruption.

Read output format: `{lineNumber}:{twoLetterHash}|{lineContent}`
Edit input: reference lines as `{line}:{hash}` pairs from the read output.
```

### Method 3: Per-Prompt Reference

Reference the tools directly in any chat message:

```
@workspace Use #hashlineRead and #hashlineEdit to refactor the error handling
in src/server.ts
```

The `#hashlineRead` and `#hashlineEdit` names come from the `toolReferenceName`
defined in the extension's `package.json`.

### Method 4: Custom Agent

Create `.github/agents/hashline-coder.md`:

```markdown
---
name: 'Hashline Coder'
description: 'A coding agent that uses hash-anchored editing for reliable file modifications'
tools:
  - hashline_read
  - hashline_edit
  - terminalLastCommand
---

You are a coding assistant that uses hashline tools for all file operations.

When you need to read a file, use hashline_read. It returns lines in the
format `{lineNumber}:{hash}|{content}`.

When you need to edit a file, use hashline_edit. Specify the lines to change
using `{line}:{hash}` pairs from your most recent read of that file. If an
edit fails due to hash mismatch, re-read the affected region and retry.

Never use built-in file editing tools. Always use hashline_read and
hashline_edit.
```

Invoke with `@hashline-coder` in chat.

### Which Method to Choose

| Method | Scope | Effort | Best For |
|--------|-------|--------|----------|
| Custom instructions | All agents, all files | Add once | Teams adopting hashline project-wide |
| File-based instructions | Matching files only | Add once | Gradual rollout to specific file types |
| Per-prompt reference | Single prompt | Each time | Trying it out, one-off tasks |
| Custom agent | When invoked | Add once | Keeping hashline separate from default agent |

### Notes

- Agents may still fall back to built-in tools for creating new files (which
  hashline doesn't handle). This is expected — hashline is for *editing
  existing files*.
- If an agent reads a file with the built-in `read_file` and then tries to
  use `hashline_edit`, it won't have the hashes. Instructions should emphasize
  using `hashline_read` first.
- The confirmation dialog on `hashline_edit` can be auto-approved via the
  VS Code setting `chat.tools.autoApprove`.

## Operations Reference

| Operation | lineHashes | content | insertAfter |
|-----------|-----------|---------|-------------|
| Replace one line | `"4:mp"` | new text | omit |
| Replace range | `"3:fn,4:mp,5:ze"` | new text (may be multi-line) | omit |
| Insert after line | `"2:ab"` | text to insert | `true` |
| Insert at file start | `"0:"` | text to insert | `true` |
| Delete lines | `"2:ab"` or `"2:ab,3:fn"` | `""` | omit |

## Limitations & Future Work

### Change tracking in Copilot's UI

Edits made by `hashline_edit` do not currently appear in Copilot's "N files
changed" list in the chat UI. This is because VS Code's stable extension API
does not provide a way for tools (registered via `vscode.lm.registerTool`) to
report file edits back into the chat response stream.

The proper fix requires the **`chatParticipantAdditions` proposed API**, which
includes:

- `ChatResponseTextEditPart` — push `TextEdit[]` directly into the chat
  response stream
- `ChatResponseExternalEditPart` — wrap `workspace.applyEdit()` calls in a
  tracked callback via `response.externalEdit(uri, callback)`

These APIs exist in VS Code's proposed API layer
(`vscode.proposed.chatParticipantAdditions.d.ts`) but are not yet stable.
When they stabilize, `hashline_edit` should use `externalEdit()` to wrap its
`workspace.applyEdit()` call, which would automatically track the changes in
Copilot's file change list, enable proper rollback, and handle saving.

As a workaround, `hashline_edit` currently auto-saves files after editing so
changes persist to disk immediately. Edits are visible via `git diff` and in
VS Code's Source Control view, even though they don't appear in the chat UI's
change list.

## License

MIT