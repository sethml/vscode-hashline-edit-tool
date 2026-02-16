import * as vscode from 'vscode';
import { HashlineReadTool } from './readTool';
import { HashlineEditTool } from './editTool';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('hashline_read', new HashlineReadTool())
    );
    context.subscriptions.push(
        vscode.lm.registerTool('hashline_edit', new HashlineEditTool())
    );
}

export function deactivate() {}
