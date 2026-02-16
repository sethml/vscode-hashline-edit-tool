import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolve a file path that may be absolute or workspace-relative to a vscode.Uri.
 */
export function resolveFilePath(filePath: string): vscode.Uri {
    if (path.isAbsolute(filePath)) {
        return vscode.Uri.file(filePath);
    }
    // Resolve relative to first workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        return vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
    }
    // Fallback: treat as absolute
    return vscode.Uri.file(filePath);
}
