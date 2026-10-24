import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { JJRunner } from './jj';
import { JJResourceState, JJConflictEntry } from './types';

export function registerConflictCommands(
  jj: JJRunner,
  rootPath: string,
  refresh: () => Promise<void>
): vscode.Disposable[] {
  const openConflictResolverCmd = vscode.commands.registerCommand(
    'jj.openConflictResolver',
    async (fileUri: vscode.Uri, revision: string) => {
      try {
        const filePath = vscode.workspace.asRelativePath(fileUri);
        const fullPath = path.join(rootPath, filePath);

        const fileContent = await fs.readFile(fullPath, 'utf8').catch(() => '');
        const hasTextMarkers = fileContent.includes('<<<<<<<') || fileContent.includes('>>>>>>>');

        const conflicts: JJConflictEntry[] = await jj.getConflictedFiles(revision);
        const entry = conflicts.find((c) => c.path === filePath);

        if (entry && entry.isDeletion && !hasTextMarkers) {
          const choice = await vscode.window.showInformationMessage(
            `'${path.basename(filePath)}' is in conflict: one branch deleted this file, while another branch modified/kept it.`,
            'Keep File',
            'Delete File',
            'Inspect Content'
          );

          if (choice === 'Keep File') {
            await jj.resolveConflict(filePath, revision, 'keep');
            vscode.window.showInformationMessage(`Resolved: Kept '${path.basename(filePath)}'.`);
            await refresh();
            return;
          } else if (choice === 'Delete File') {
            await jj.resolveConflict(filePath, revision, 'delete');
            vscode.window.showInformationMessage(`Resolved: Deleted '${path.basename(filePath)}'.`);
            await refresh();
            return;
          } else if (choice === 'Inspect Content') {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
            return;
          }
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Close the merge conflict resolver when done',
            cancellable: false,
          },
          async () => {
            await jj.runNativeMerge(filePath);
          }
        );

        await refresh();
      } catch {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    }
  );

  const resolveConflictFileCmd = vscode.commands.registerCommand(
    'jj.resolveConflict',
    async (resource: JJResourceState) => {
      if (!resource || !resource.relativePath) {
        return;
      }

      try {
        const filePath = resource.relativePath;
        const targetRev = resource.fromRev || '@';
        const fullPath = path.join(rootPath, filePath);

        const text = await fs.readFile(fullPath, 'utf8').catch(() => '');
        const hasTextMarkers = text.includes('<<<<<<<') || text.includes('%%%%%%%') || text.includes('>>>>>>>');

        const conflicts: JJConflictEntry[] = await jj.getConflictedFiles(targetRev);
        const entry = conflicts.find((c) => c.path === filePath);

        if (entry && entry.isDeletion && !hasTextMarkers) {
          const choice = await vscode.window.showQuickPick(
            [
              { label: '$(check) Keep File', action: 'keep', description: 'Retain the file and its current contents' },
              { label: '$(trash) Delete File', action: 'delete', description: 'Confirm deletion of the file' },
            ],
            { placeHolder: `Resolve deletion conflict for ${path.basename(filePath)}` }
          );

          if (!choice) {
            return;
          }
          await jj.resolveConflict(filePath, targetRev, choice.action as 'keep' | 'delete');
          vscode.window.showInformationMessage(`Resolved conflict for '${path.basename(filePath)}'.`);
          await refresh();
          return;
        }

        if (hasTextMarkers) {
          const proceed = await vscode.window.showWarningMessage(
            `'${path.basename(filePath)}' still contains conflict markers (<<<<<<< / >>>>>>>). Mark as resolved anyway?`,
            'Mark Resolved',
            'Cancel'
          );
          if (proceed !== 'Mark Resolved') {
            return;
          }
        }

        await jj.resolveConflict(filePath, targetRev, 'content');
        vscode.window.showInformationMessage(`Marked '${path.basename(filePath)}' as resolved in ${targetRev}.`);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const squashConflictFileCmd = vscode.commands.registerCommand(
    'jj.squashConflictFile',
    async (resource: JJResourceState) => {
      if (!resource || !resource.relativePath) {
        return;
      }
      try {
        const filePath = resource.relativePath;
        const targetRev = resource.fromRev || '@';
        const targetInfo = await jj.getChangeInfo(targetRev);
        const parentRev = targetInfo?.parentIds[0] || `${targetRev}-`;

        await jj.moveFile(targetRev, parentRev, filePath);
        vscode.window.showInformationMessage(`Squashed '${path.basename(filePath)}' into ${parentRev}.`);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to squash conflicted file: ${err.message}`);
      }
    }
  );

  return [openConflictResolverCmd, resolveConflictFileCmd, squashConflictFileCmd];
}
