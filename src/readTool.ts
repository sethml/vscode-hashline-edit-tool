import * as vscode from 'vscode';
import { formatLine } from './hash';
import { resolveFilePath } from './util';

interface ReadInput {
    filePath: string;
    startLine?: number;
    endLine?: number;
}

export class HashlineReadTool implements vscode.LanguageModelTool<ReadInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReadInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, startLine, endLine } = options.input;

        try {
            const uri = resolveFilePath(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const totalLines = document.lineCount;

            const start = Math.max(1, startLine ?? 1);
            const end = Math.min(totalLines, endLine ?? totalLines);

            if (start > totalLines) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `Error: startLine ${start} exceeds file length (${totalLines} lines).`
                    ),
                ]);
            }

            const lines: string[] = [];
            for (let i = start; i <= end; i++) {
                const lineContent = document.lineAt(i - 1).text;
                lines.push(formatLine(i, lineContent));
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(lines.join('\n')),
            ]);
        } catch (err: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error reading file: ${err.message}`),
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ReadInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { filePath, startLine, endLine } = options.input;
        const basename = filePath.split('/').pop() ?? filePath;
        const uri = resolveFilePath(filePath);

        // Build line fragment for link (end+1 so VS Code highlights the full range)
        let lineFragment = '';
        let rangeText = 'all lines';
        if (startLine) {
            if (endLine) {
                lineFragment = `#L${startLine}-L${endLine + 1}`;
                rangeText = `lines ${startLine}-${endLine}`;
            } else {
                lineFragment = `#L${startLine}-L${startLine + 1}`;
                rangeText = `from line ${startLine}`;
            }
        }

        const msg = new vscode.MarkdownString(
            `Reading ${rangeText} of [${basename}](${uri.toString()}${lineFragment})`
        );
        msg.isTrusted = true;

        return {
            invocationMessage: msg,
        };
    }
}
