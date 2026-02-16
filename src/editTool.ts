import * as vscode from 'vscode';
import { lineHash } from './hash';
import { resolveFilePath } from './util';

interface EditOperation {
    filePath: string;
    lineHashes: string;
    content: string;
    insertAfter?: boolean;
}

interface EditInput {
    edits: EditOperation[];
}

interface EditResult {
    filePath: string;
    lineHashes: string;
    status: 'ok' | 'error';
    error?: string;
    startLine?: number;
    endLine?: number;
}

/**
 * Parse "10:qk,11:ab,12:fn" into [{line: 10, hash: "qk"}, ...]
 */
function parseLineHashes(lineHashes: string): { line: number; hash: string }[] {
    return lineHashes.split(',').map((entry) => {
        const colonIdx = entry.indexOf(':');
        if (colonIdx === -1) {
            throw new Error(`Invalid lineHash entry: "${entry}" — expected "line:hash"`);
        }
        const line = parseInt(entry.substring(0, colonIdx), 10);
        const hash = entry.substring(colonIdx + 1);
        if (isNaN(line)) {
            throw new Error(`Invalid line number in "${entry}"`);
        }
        return { line, hash };
    });
}

/**
 * Apply a batch of edits to a single file. Edits are sorted bottom-up
 * so line number shifts don't affect subsequent edits.
 */
async function applyEditsToFile(
    uri: vscode.Uri,
    edits: { op: EditOperation; parsed: { line: number; hash: string }[] }[]
): Promise<EditResult[]> {
    const document = await vscode.workspace.openTextDocument(uri);
    const totalLines = document.lineCount;
    const results: EditResult[] = [];

    // Validate all edits first (before modifying anything)
    const validEdits: {
        op: EditOperation;
        parsed: { line: number; hash: string }[];
        range: vscode.Range;
        newText: string;
    }[] = [];

    for (const { op, parsed } of edits) {
        // Handle insert at beginning of file
        if (parsed.length === 1 && parsed[0].line === 0 && parsed[0].hash === '') {
            if (op.insertAfter) {
                const newText = op.content + (op.content.length > 0 ? '\n' : '');
                validEdits.push({
                    op,
                    parsed,
                    range: new vscode.Range(0, 0, 0, 0),
                    newText,
                });
                results.push({ filePath: op.filePath, lineHashes: op.lineHashes, status: 'ok', startLine: 1, endLine: 1 });
                continue;
            } else {
                results.push({
                    filePath: op.filePath,
                    lineHashes: op.lineHashes,
                    status: 'error',
                    error: '"0:" is only valid with insertAfter: true',
                });
                continue;
            }
        }

        // Validate each line:hash pair
        let valid = true;
        for (const { line, hash } of parsed) {
            if (line < 1 || line > totalLines) {
                results.push({
                    filePath: op.filePath,
                    lineHashes: op.lineHashes,
                    status: 'error',
                    error: `line ${line} out of range (file has ${totalLines} lines)`,
                });
                valid = false;
                break;
            }
            const actualContent = document.lineAt(line - 1).text;
            const actualHash = lineHash(actualContent);
            if (actualHash !== hash) {
                results.push({
                    filePath: op.filePath,
                    lineHashes: op.lineHashes,
                    status: 'error',
                    error: `hash mismatch at line ${line}: expected '${hash}', got '${actualHash}'`,
                });
                valid = false;
                break;
            }
        }
        if (!valid) {
            continue;
        }

        // Check contiguity for replace operations
        if (!op.insertAfter && parsed.length > 1) {
            const sortedLines = parsed.map((p) => p.line).sort((a, b) => a - b);
            for (let i = 1; i < sortedLines.length; i++) {
                if (sortedLines[i] !== sortedLines[i - 1] + 1) {
                    results.push({
                        filePath: op.filePath,
                        lineHashes: op.lineHashes,
                        status: 'error',
                        error: `lines must be contiguous for replace; gap between ${sortedLines[i - 1]} and ${sortedLines[i]}`,
                    });
                    valid = false;
                    break;
                }
            }
            if (!valid) {
                continue;
            }
        }

        // Compute the TextEdit range and replacement text
        const lineNumbers = parsed.map((p) => p.line).sort((a, b) => a - b);
        const firstLine = lineNumbers[0];
        const lastLine = lineNumbers[lineNumbers.length - 1];

        if (op.insertAfter) {
            // Insert after the last anchored line
            const insertLine = lastLine - 1; // 0-based
            const lineLen = document.lineAt(insertLine).text.length;
            const newText = '\n' + op.content;
            validEdits.push({
                op,
                parsed,
                range: new vscode.Range(insertLine, lineLen, insertLine, lineLen),
                newText,
            });
        } else if (op.content === '') {
            // Delete: remove entire lines including line breaks
            let range: vscode.Range;
            if (lastLine < totalLines) {
                // Delete from start of first line to start of line after last
                range = new vscode.Range(firstLine - 1, 0, lastLine, 0);
            } else {
                // Deleting to end of file
                if (firstLine > 1) {
                    // Include the preceding newline
                    const prevLineLen = document.lineAt(firstLine - 2).text.length;
                    range = new vscode.Range(firstLine - 2, prevLineLen, lastLine - 1, document.lineAt(lastLine - 1).text.length);
                } else {
                    // Deleting entire file content
                    range = new vscode.Range(0, 0, lastLine - 1, document.lineAt(lastLine - 1).text.length);
                }
            }
            validEdits.push({
                op,
                parsed,
                range,
                newText: '',
            });
        } else {
            // Replace: replace from start of first line to end of last line
            const lastLineLen = document.lineAt(lastLine - 1).text.length;
            const range = new vscode.Range(firstLine - 1, 0, lastLine - 1, lastLineLen);
            validEdits.push({
                op,
                parsed,
                range,
                newText: op.content,
            });
        }

        results.push({ filePath: op.filePath, lineHashes: op.lineHashes, status: 'ok', startLine: firstLine, endLine: lastLine });
    }

    // Sort valid edits bottom-up (by start line descending) so earlier edits
    // don't shift positions of later ones
    validEdits.sort((a, b) => b.range.start.line - a.range.start.line);

    // Apply via WorkspaceEdit
    if (validEdits.length > 0) {
        const wsEdit = new vscode.WorkspaceEdit();
        for (const edit of validEdits) {
            wsEdit.replace(uri, edit.range, edit.newText);
        }
        const success = await vscode.workspace.applyEdit(wsEdit);
        if (!success) {
            // Mark all as failed
            for (const result of results) {
                if (result.status === 'ok') {
                    result.status = 'error';
                    result.error = 'workspace edit failed to apply';
                }
            }
        } else {
            // Auto-save the document so changes persist to disk
            await document.save();
        }
    }

    return results;
}

export class HashlineEditTool implements vscode.LanguageModelTool<EditInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<EditInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { edits } = options.input;

        if (!edits || edits.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('Error: no edits provided.'),
            ]);
        }

        // Group edits by file
        const byFile = new Map<string, { op: EditOperation; parsed: { line: number; hash: string }[] }[]>();
        const parseErrors: EditResult[] = [];

        for (const edit of edits) {
            try {
                const parsed = parseLineHashes(edit.lineHashes);
                const key = edit.filePath;
                if (!byFile.has(key)) {
                    byFile.set(key, []);
                }
                byFile.get(key)!.push({ op: edit, parsed });
            } catch (err: any) {
                parseErrors.push({
                    filePath: edit.filePath,
                    lineHashes: edit.lineHashes,
                    status: 'error',
                    error: err.message,
                });
            }
        }

        const allResults: EditResult[] = [...parseErrors];

        // Process each file
        for (const [filePath, fileEdits] of byFile) {
            try {
                const uri = resolveFilePath(filePath);
                const results = await applyEditsToFile(uri, fileEdits);
                allResults.push(...results);
            } catch (err: any) {
                for (const { op } of fileEdits) {
                    allResults.push({
                        filePath: op.filePath,
                        lineHashes: op.lineHashes,
                        status: 'error',
                        error: err.message,
                    });
                }
            }
        }

        const applied = allResults.filter((r) => r.status === 'ok').length;
        const failed = allResults.filter((r) => r.status === 'error').length;

        // Compute per-file post-edit line ranges for the result summary
        const fileRanges = new Map<string, { start: number; end: number; added: number; removed: number }>();
        for (const result of allResults) {
            if (result.status !== 'ok' || !result.startLine || !result.endLine) {
                continue;
            }
            const existing = fileRanges.get(result.filePath);
            if (existing) {
                existing.start = Math.min(existing.start, result.startLine);
                existing.end = Math.max(existing.end, result.endLine);
            } else {
                fileRanges.set(result.filePath, { start: result.startLine, end: result.endLine, added: 0, removed: 0 });
            }
        }
        // Accumulate per-file add/remove counts from input
        for (const edit of edits) {
            const range = fileRanges.get(edit.filePath);
            if (!range) { continue; }
            const lineHashCount = edit.lineHashes === '0:' ? 0 : edit.lineHashes.split(',').length;
            const contentLineCount = edit.content === '' ? 0 : edit.content.split('\n').length;
            if (edit.insertAfter) {
                range.added += contentLineCount;
            } else if (edit.content === '') {
                range.removed += lineHashCount;
            } else {
                range.added += contentLineCount;
                range.removed += lineHashCount;
            }
        }

        // Build a compact result object
        if (failed === 0 && applied === 1) {
            const r = allResults.find((r) => r.status === 'ok')!;
            const range = fileRanges.get(r.filePath);
            const postEnd = range ? range.start + (range.end - range.start) + range.added - range.removed : undefined;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({
                    status: 'ok', applied: 1,
                    ...(range ? { file: r.filePath, startLine: range.start, endLine: Math.max(range.start, postEnd!) } : {}),
                })),
            ]);
        }

        const response: Record<string, unknown> = { applied, failed };
        // Add per-file ranges
        const files: Record<string, unknown>[] = [];
        for (const [fp, range] of fileRanges) {
            const postEnd = range.start + (range.end - range.start) + range.added - range.removed;
            files.push({ file: fp, startLine: range.start, endLine: Math.max(range.start, postEnd) });
        }
        if (files.length > 0) { response.files = files; }
        if (failed > 0) {
            response.errors = allResults
                .filter((r) => r.status === 'error')
                .map((r) => ({ filePath: r.filePath, lineHashes: r.lineHashes, error: r.error }));
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(response, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<EditInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const edits = options.input.edits ?? [];

        // Build per-file, per-edit chunk info with validation
        type ChunkInfo = { added: number; removed: number; minLine: number; maxLine: number; isDelete: boolean; isInsertAfter: boolean; valid: boolean };
        const fileChunks = new Map<string, ChunkInfo[]>();
        for (const edit of edits) {
            if (!fileChunks.has(edit.filePath)) {
                fileChunks.set(edit.filePath, []);
            }
            const lineHashCount = edit.lineHashes === '0:' ? 0 : edit.lineHashes.split(',').length;
            const contentLineCount = edit.content === '' ? 0 : edit.content.split('\n').length;

            let minLine = Infinity;
            let maxLine = 0;
            const lineHashPairs: { line: number; hash: string }[] = [];
            if (edit.lineHashes !== '0:') {
                for (const entry of edit.lineHashes.split(',')) {
                    const colonIdx = entry.indexOf(':');
                    if (colonIdx !== -1) {
                        const line = parseInt(entry.substring(0, colonIdx), 10);
                        const hash = entry.substring(colonIdx + 1);
                        if (!isNaN(line) && line > 0) {
                            minLine = Math.min(minLine, line);
                            maxLine = Math.max(maxLine, line);
                            lineHashPairs.push({ line, hash });
                        }
                    }
                }
            }

            let added = 0;
            let removed = 0;
            const isDelete = edit.content === '' && !edit.insertAfter;
            if (edit.insertAfter) {
                added = contentLineCount;
            } else if (edit.content === '') {
                removed = lineHashCount;
            } else {
                added = contentLineCount;
                removed = lineHashCount;
            }

            // Pre-validate hashes against the actual file
            let valid = true;
            try {
                const uri = resolveFilePath(edit.filePath);
                const doc = await vscode.workspace.openTextDocument(uri);
                for (const { line, hash } of lineHashPairs) {
                    if (line < 1 || line > doc.lineCount) {
                        valid = false;
                        break;
                    }
                    const actualHash = lineHash(doc.lineAt(line - 1).text);
                    if (actualHash !== hash) {
                        valid = false;
                        break;
                    }
                }
            } catch {
                valid = false;
            }

            fileChunks.get(edit.filePath)!.push({ added, removed, minLine, maxLine, isDelete, isInsertAfter: !!edit.insertAfter, valid });
        }

        // Build per-file summary lines, separating valid and failing edits
        const editedLines = this.formatChunks(fileChunks, 'Edited', true);
        const editLines = this.formatChunks(fileChunks, 'Edit', false);

        const invocationMsg = new vscode.MarkdownString(editedLines.join('  \n'));
        invocationMsg.isTrusted = true;

        const confirmMsg = new vscode.MarkdownString(editLines.join('  \n'));
        confirmMsg.isTrusted = true;

        return {
            invocationMessage: invocationMsg,
            confirmationMessages: {
                title: 'Hashline Edit',
                message: confirmMsg,
            },
        };
    }

    private formatChunks(
        fileChunks: Map<string, { added: number; removed: number; minLine: number; maxLine: number; isDelete: boolean; isInsertAfter: boolean; valid: boolean }[]>,
        verb: string,
        isPostEdit: boolean
    ): string[] {
        const lines: string[] = [];

        // Group all files' chunks into valid and failing
        const validFileChunks = new Map<string, typeof fileChunks extends Map<string, infer V> ? V : never>();
        const failingFileChunks = new Map<string, typeof fileChunks extends Map<string, infer V> ? V : never>();

        for (const [filePath, chunks] of fileChunks) {
            const valid = chunks.filter(c => c.valid);
            const failing = chunks.filter(c => !c.valid);
            if (valid.length > 0) { validFileChunks.set(filePath, valid); }
            if (failing.length > 0) { failingFileChunks.set(filePath, failing); }
        }

        // Format valid edits
        for (const [filePath, chunks] of validFileChunks) {
            const formatted = this.formatFileChunks(filePath, chunks, isPostEdit);
            lines.push(`${verb}: ${formatted}`);
        }

        // Format failing edits in bold
        for (const [filePath, chunks] of failingFileChunks) {
            const formatted = this.formatFileChunks(filePath, chunks, isPostEdit);
            lines.push(`**Failing: ${formatted}**`);
        }

        return lines;
    }

    private formatFileChunks(
        filePath: string,
        chunks: { added: number; removed: number; minLine: number; maxLine: number; isDelete: boolean; isInsertAfter: boolean }[],
        isPostEdit: boolean
    ): string {
        const basename = filePath.split('/').pop() ?? filePath;
        const uri = resolveFilePath(filePath);
        const parts: string[] = [];

        // Sort chunks by minLine for correct cumulative delta tracking
        const sortedChunks = [...chunks].sort((a, b) => a.minLine - b.minLine);
        let cumulativeDelta = 0;

        for (let i = 0; i < sortedChunks.length; i++) {
            const chunk = sortedChunks[i];

            // Build line fragment
            let lineFragment = '';
            if (chunk.minLine !== Infinity && chunk.minLine > 0) {
                if (isPostEdit) {
                    // Post-edit: adjust line numbers by cumulative delta from earlier chunks
                    if (chunk.isDelete) {
                        lineFragment = `#L${chunk.minLine + cumulativeDelta}`;
                    } else if (chunk.isInsertAfter) {
                        const postStart = chunk.maxLine + cumulativeDelta + 1;
                        lineFragment = `#L${postStart}-L${postStart + chunk.added}`;
                    } else {
                        const adjustedMin = chunk.minLine + cumulativeDelta;
                        lineFragment = `#L${adjustedMin}-L${adjustedMin + chunk.added}`;
                    }
                    cumulativeDelta += chunk.added - chunk.removed;
                } else {
                    // Pre-edit: show the original lines that will be affected
                    if (chunk.isInsertAfter) {
                        lineFragment = `#L${chunk.maxLine + 1}`;
                    } else {
                        lineFragment = `#L${chunk.minLine}-L${chunk.maxLine + 1}`;
                    }
                }
            }

            // Build diff string: -M+N order (removed then added)
            let diffStr = '';
            if (chunk.removed > 0) { diffStr += `-${chunk.removed}`; }
            if (chunk.added > 0) { diffStr += `+${chunk.added}`; }
            if (!diffStr) { diffStr = '+0'; }

            const linkUrl = `${uri.toString()}${lineFragment}`;
            if (i === 0) {
                parts.push(`[${basename} ${diffStr}](${linkUrl})`);
            } else {
                parts.push(`[${diffStr}](${linkUrl})`);
            }
        }

        return parts.join(', ');
    }
}
