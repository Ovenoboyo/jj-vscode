import * as vscode from 'vscode';
import { JJRunner, JJChangeInfo } from './jj';
import { getGraphHtml } from './graphHtml';

export class JJGraphWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'jjGraphView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly jj: JJRunner,
    private readonly getActiveRemote: () => Promise<string | undefined>
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'selectCommit') {
        await vscode.commands.executeCommand('jj.selectCommit', message.changeId);
      } else if (message.command === 'openMultiDiff') {
        await vscode.commands.executeCommand('jj.openMultiDiff', message.changeId);
      } else if (message.command === 'editCommit') {
        try {
          await this.jj.editChange(message.changeId);
          await vscode.commands.executeCommand('jj.refresh');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to edit commit: ${err.message}`);
        }
      } else if (message.command === 'newOnTop') {
        try {
          await this.jj.newChange(message.changeId);
          await vscode.commands.executeCommand('jj.refresh');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to create change on commit: ${err.message}`);
        }
      } else if (message.command === 'pushChain') {
        try {
          const remote = await this.getActiveRemote();
          if (!remote) {
            vscode.window.showInformationMessage('No active remote configured.');
            return;
          }
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Pushing chain ${message.changeId} to ${remote}...` },
            async () => {
              await this.jj.pushRevision(message.changeId, remote);
            }
          );
          vscode.window.showInformationMessage(`Pushed chain starting at ${message.changeId} to ${remote}.`);
          await vscode.commands.executeCommand('jj.refresh');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Push failed: ${err.message}`);
        }
      } else if (message.command === 'removeBookmark') {
        try {
          await this.jj.deleteBookmark(message.bookmark);
          vscode.window.showInformationMessage(`Removed bookmark '${message.bookmark}'.`);
          await vscode.commands.executeCommand('jj.refresh');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to delete bookmark: ${err.message}`);
        }
      } else if (message.command === 'abandonCommit') {
        const { changeId } = message;
        if (!changeId) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to abandon commit '${changeId}'?`,
          { modal: true },
          'Abandon'
        );

        if (confirm === 'Abandon') {
          try {
            await this.jj.abandonChange(changeId);
            vscode.window.showInformationMessage(`Abandoned commit '${changeId}'.`);
            await vscode.commands.executeCommand('jj.refresh');
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to abandon commit: ${err.message}`);
          }
        }
      } else if (message.command === 'rebase') {
        const { source, target } = message;
        if (!source || !target || source === target) {
          return;
        }

        const choice = await vscode.window.showQuickPick(
          [
            {
              label: 'Only this commit (-r)',
              description: `Rebase ${source} onto ${target} directly`,
              action: 'exact',
            },
            {
              label: 'This commit and its descendants (-s)',
              description: `Rebase entire branch subtree from ${source} onto ${target}`,
              action: 'subtree',
            },
          ],
          { placeHolder: `Rebase ${source} onto ${target}?` }
        );

        if (!choice) {
          return;
        }

        try {
          if (choice.action === 'exact') {
            await this.jj.rebaseExact(source, target);
          } else {
            await this.jj.rebaseSubtree(source, target);
          }
          vscode.window.showInformationMessage(`Rebased ${source} onto ${target}`);
          await vscode.commands.executeCommand('jj.refresh');
        } catch (err: any) {
          vscode.window.showErrorMessage(err.message);
        }
      } else if (message.command === 'convergeCommit') {
        const { changeId, commitId } = message;
        const target = changeId || commitId;
        if (!target) {
          return;
        }
        try {
          await this.jj.converge(target);
          vscode.window.showInformationMessage(`Converged divergent changes for '${target}'.`);
          await vscode.commands.executeCommand('jj.refresh');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to converge changes: ${err.message}`);
        }
      }
    });

    this.refresh();
  }

  async refresh(selectedCommitId?: string) {
    if (!this._view) {
      return;
    }
    try {
      const activeRemote = await this.getActiveRemote();
      const commits = await this.jj.getCommitGraph(activeRemote);
      const current = await this.jj.getChangeInfo('@');
      this._view.webview.html = this.getHtml(commits, current?.commitId || current?.changeId || '', selectedCommitId, activeRemote);
    } catch {
      this._view.webview.html = '<div style="padding: 12px; color: var(--vscode-errorForeground);">Failed to load JJ Graph</div>';
    }
  }

  private getHtml(commits: JJChangeInfo[], currentId: string, selectedCommitId?: string, activeRemote?: string): string {
    return getGraphHtml(commits, currentId, selectedCommitId, activeRemote);
  }
}