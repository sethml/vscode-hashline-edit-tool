# Hashline Edit — VS Code Extension Specification

## Overview

Hashline Edit is a VS Code extension that provides two language model tools
(`vscode.lm.registerTool`) for GitHub Copilot. The tools enable LLMs to read
and edit files using line-number + content-hash anchors, eliminating the need
for the model to reproduce existing file content when making edits.

Inspired by [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
by Can Bölük.

## Motivation

Current edit tools (`str_replace`, `apply_patch`) require the model to
reproduce the exact text it wants to replace. This wastes tokens and causes
frequent failures due to whitespace mismatches, multiple matches, or imperfect
recall. Hashline gives each line a short, verifiable content hash so the model
can reference lines by number + hash without reproducing their content.

## Line Format

When a file is read, each line is returned in this format:

```
{lineNumber}:{hash}|{content}
```

Example:
```
1:qk|import React from 'react';
2:ab|
3:fn|export function App() {
4:mp|  return <div>Hello</div>;
5:ze|}
```

### Line Number
1-based integer. No padding.

### Hash
Two lowercase ASCII letters (a–z), derived from the full line content
including leading/trailing whitespace but excluding the line terminator.

The hash is computed as: take the FNV-1a 32-bit hash of the line's bytes
(UTF-8), then map to two letters:

```
letter1 = (hash_value % 26) → 'a'..'z'
letter2 = ((hash_value >> 8) % 26) → 'a'..'z'
```

This yields 676 possible values. Collisions within a file are possible but
harmless — the line number is the primary identifier; the hash detects
content changes.

### Delimiter
`:` separates line number from hash (matches grep/compiler output convention).
`|` separates hash from content (single token, visually distinct from code).

## Tool 1: `hashline_read`

### Description (shown to LLM)
Read lines from a file with line numbers and content hashes. Each line is
formatted as `{lineNumber}:{hash}|{content}`. Use these hashes with
`hashline_edit` to make edits.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Absolute or workspace-relative path to the file |
| `startLine` | number | no | First line to read (1-based, default: 1) |
| `endLine` | number | no | Last line to read (1-based, inclusive, default: last line) |

### Return Value
The hashline-formatted text as a single string, one line per file line.
If the file doesn't exist or the range is invalid, return an error message.

### Example

Request:
```json
{ "filePath": "src/app.ts", "startLine": 1, "endLine": 5 }
```

Response:
```
1:qk|import React from 'react';
2:ab|
3:fn|export function App() {
4:mp|  return <div>Hello</div>;
5:ze|}
```

## Tool 2: `hashline_edit`

### Description (shown to LLM)
Edit file(s) by specifying line ranges with content hashes. Supports replace,
insert-after, and delete operations. Edits are verified against content hashes
to prevent applying changes to stale file contents. Multiple edits can be
applied in one call; successfully applied edits are kept even if others fail.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `edits` | array | yes | Array of edit operations (see below) |

Each edit object:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | yes | Absolute or workspace-relative path |
| `lineHashes` | string | yes | Comma-separated `{line}:{hash}` pairs identifying the target lines |
| `content` | string | yes | Replacement content (may be multi-line). Empty string = delete. |
| `insertAfter` | boolean | no | If true, insert `content` after the identified line(s) instead of replacing them. `lineHashes` should be a single entry identifying the anchor line. Default: false. |

### Operations

**Replace**: Provide `lineHashes` listing every line to replace, and `content`
with the new text. The identified lines are removed and `content` is inserted
in their place.

```json
{
  "filePath": "src/app.ts",
  "lineHashes": "4:mp",
  "content": "  return <div>Goodbye</div>;"
}
```

**Multi-line replace**:
```json
{
  "filePath": "src/app.ts",
  "lineHashes": "3:fn,4:mp,5:ze",
  "content": "export function App() {\n  return <div>Goodbye</div>;\n}"
}
```

**Insert after**:
```json
{
  "filePath": "src/app.ts",
  "lineHashes": "2:ab",
  "content": "import { useState } from 'react';",
  "insertAfter": true
}
```

**Insert at beginning of file**:
```json
{
  "filePath": "src/app.ts",
  "lineHashes": "0:",
  "content": "// Header comment",
  "insertAfter": true
}
```

**Delete**:
```json
{
  "filePath": "src/app.ts",
  "lineHashes": "2:ab",
  "content": ""
}
```

### Edit Application Order

Edits within the same file are sorted by line number descending (bottom-up)
before application. This ensures that earlier edits don't shift line numbers
for later edits.

Edits across different files are independent and applied per-file.

### Validation

Before applying an edit:
1. Parse `lineHashes` into `(lineNumber, expectedHash)` pairs.
2. For each pair, read the current content of that line.
3. Compute the hash of the current content.
4. If any hash doesn't match, reject **that edit** with an error.
5. Verify the line numbers are contiguous (for replace operations).

### Return Value

JSON object:

```json
{
  "applied": 2,
  "failed": 1,
  "results": [
    {
      "filePath": "src/app.ts",
      "lineHashes": "4:mp",
      "status": "ok"
    },
    {
      "filePath": "src/bar.ts",
      "lineHashes": "10:qk,11:ab",
      "status": "ok"
    },
    {
      "filePath": "src/baz.ts",
      "lineHashes": "5:mn",
      "status": "error",
      "error": "hash mismatch at line 5: expected 'mn', got 'xp'"
    }
  ]
}
```

On complete success with a single edit, a shorter response:
```json
{ "status": "ok", "applied": 1 }
```

## Hash Function: FNV-1a 32-bit

```
hash = 2166136261 (offset basis)
for each byte in line:
    hash = hash XOR byte
    hash = hash * 16777619
    hash = hash & 0xFFFFFFFF  (keep 32-bit)
letter1 = String.fromCharCode(97 + (hash % 26))
letter2 = String.fromCharCode(97 + ((hash >>> 8) % 26))
result = letter1 + letter2
```

FNV-1a is fast, simple (~5 lines), has no dependencies, and distributes
well for short strings. The 2-letter mapping is intentionally lossy — we
only need enough entropy to detect unintended changes, not to be
collision-resistant.

## Extension Packaging

- Extension ID: `hashline-edit`
- Display name: Hashline Edit
- Contributes: two language model tools via `vscode.lm.registerTool`
- Activation: on startup (`onStartupFinished`)
- Language: TypeScript
- No external dependencies
- Minimum VS Code version: 1.99 (for `lm.registerTool` API)

See [README.md](README.md) for installation, usage, and how to direct agents
to use these tools.
