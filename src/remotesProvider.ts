import * as vscode from 'vscode';
import { JJRunner, JJRemoteInfo } from './jj';

export class JJRemoteTreeItem extends vscode.TreeItem {
  constructor(public readonly remote: JJRemoteInfo) {
    super(remote.name, vscode.TreeItemCollapsibleState.None);
    this.description = remote.url;
    this.tooltip = `${remote.name}: ${remote.url}`;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'jjRemoteItem';
  }
}

export class JJRemotesProvider implements vscode.TreeDataProvider<JJRemoteTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<JJRemoteTreeItem | undefined | void> = new vscode.EventEmitter<JJRemoteTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<JJRemoteTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor(private readonly jj: JJRunner) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: JJRemoteTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<JJRemoteTreeItem[]> {
    const isRepo = await this.jj.isRepo();
    if (!isRepo) return [];

    const remotes = await this.jj.getRemotes();
    return remotes.map((r) => new JJRemoteTreeItem(r));
  }
}