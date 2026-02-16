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
                results.push({ filePath: op.filePath, lineHashes: op.lineHashes, status: 'ok' });
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

        results.push({ filePath: op.filePath, lineHashes: op.lineHashes, status: 'ok' });
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

        // Compact response for single successful edit
        if (allResults.length === 1 && applied === 1) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify({ status: 'ok', applied: 1 })),
            ]);
        }

        const response = {
            applied,
            failed,
            results: allResults,
        };

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(response, null, 2)),
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<EditInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const editCount = options.input.edits?.length ?? 0;
        const files = new Set(options.input.edits?.map((e) => e.filePath) ?? []);
        const fileCount = files.size;

        return {
            invocationMessage: `Applying ${editCount} edit(s) to ${fileCount} file(s)`,
            confirmationMessages: {
                title: 'Hashline Edit',
                message: new vscode.MarkdownString(
                    `Apply ${editCount} edit(s) to ${fileCount} file(s)?`
                ),
            },
        };
    }
}
