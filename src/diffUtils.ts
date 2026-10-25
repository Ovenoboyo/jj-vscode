import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { JJRunner, JJDiffFile } from './jj';

export async function filterFilesWithDiff(
  files: JJDiffFile[],
  fromRev: string,
  intoRev: string,
  rootPath: string,
  jj: JJRunner
): Promise<JJDiffFile[]> {
  const result: JJDiffFile[] = [];

  for (const file of files) {
    const fullPath = path.isAbsolute(file.path) ? file.path : path.join(rootPath, file.path);

    if (file.status === 'M') {
      let currentContent: string | null = null;
      if (fromRev === '@') {
        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.scheme === 'file' && d.uri.fsPath === fullPath
        );
        if (openDoc) {
          currentContent = openDoc.getText();
        } else {
          try {
            currentContent = await fs.readFile(fullPath, 'utf8');
          } catch {
            currentContent = null;
          }
        }
      } else {
        currentContent = await jj.showFile(file.path, fromRev);
      }

      if (currentContent !== null) {
        const baseContent = await jj.showFile(file.oldPath || file.path, intoRev);
        if (currentContent === baseContent || currentContent.trim() === baseContent.trim()) {
          // File has no content diff with base
          continue;
        }
      }
    } else if (file.status === 'D') {
      if (fromRev === '@') {
        try {
          await fs.access(fullPath);
          const diskContent = await fs.readFile(fullPath, 'utf8');
          const baseContent = await jj.showFile(file.oldPath || file.path, intoRev);
          if (diskContent === baseContent || diskContent.trim() === baseContent.trim()) {
            // File was restored and matches base -> no diff
            continue;
          }
        } catch {
          // File does not exist on disk -> truly deleted
        }
      }
    } else if (file.status === 'A') {
      if (fromRev === '@') {
        const openDoc = vscode.workspace.textDocuments.find(
          (d) => d.uri.scheme === 'file' && d.uri.fsPath === fullPath
        );
        if (!openDoc) {
          try {
            await fs.access(fullPath);
          } catch {
            // File does not exist on disk -> skip
            continue;
          }
        }
      }
    }

    result.push(file);
  }

  return result;
}
