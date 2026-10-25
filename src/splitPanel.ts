import * as vscode from 'vscode';
import { JJRunner, JJChangeInfo, JJDiffFile } from './jj';

export class JJSplitCommitPanel {
  public static currentPanel: JJSplitCommitPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _jj: JJRunner;
  private _disposables: vscode.Disposable[] = [];

  public static async createOrShow(
    extensionUri: vscode.Uri,
    jj: JJRunner,
    targetRev: string,
    onSuccess: () => Promise<void>
  ) {
    const info = await jj.getChangeInfo(targetRev);
    if (!info) {
      vscode.window.showErrorMessage(`Commit '${targetRev}' not found.`);
      return;
    }

    const diffFiles = await jj.getDiffSummary(targetRev);
    if (diffFiles.length === 0) {
      vscode.window.showInformationMessage(`Commit ${info.changeId} has no file changes to split.`);
      return;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (JJSplitCommitPanel.currentPanel) {
      JJSplitCommitPanel.currentPanel._panel.reveal(column);
      JJSplitCommitPanel.currentPanel.setCommit(info, diffFiles);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'jjSplitCommit',
      `Split Commit ${info.changeId}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    JJSplitCommitPanel.currentPanel = new JJSplitCommitPanel(
      panel,
      extensionUri,
      jj,
      info,
      diffFiles,
      onSuccess
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    jj: JJRunner,
    info: JJChangeInfo,
    diffFiles: JJDiffFile[],
    onSuccess: () => Promise<void>
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._jj = jj;

    this.setCommit(info, diffFiles);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'submit') {
          const selectedFiles = message.selectedFiles as string[];
          if (!selectedFiles || selectedFiles.length === 0) {
            vscode.window.showWarningMessage('Please select at least one file to include in the new split commit.');
            return;
          }

          const desc = (message.description || '').trim();
          this._panel.dispose();

          try {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Splitting commit ${info.changeId}...`,
                cancellable: false,
              },
              async () => {
                await this._jj.splitCommit(info.changeId, desc, selectedFiles);
              }
            );
            vscode.window.showInformationMessage(`Successfully split commit ${info.changeId}.`);
            await onSuccess();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to split commit: ${err.message}`);
          }
        } else if (message.command === 'cancel') {
          this._panel.dispose();
        }
      },
      null,
      this._disposables
    );
  }

  public setCommit(info: JJChangeInfo, diffFiles: JJDiffFile[]) {
    this._panel.title = `Split Commit ${info.changeId}`;
    this._panel.webview.html = this._getHtmlForWebview(info, diffFiles);
  }

  public dispose() {
    JJSplitCommitPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private _getHtmlForWebview(info: JJChangeInfo, diffFiles: JJDiffFile[]): string {
    const rawDesc = info.description || '(no description)';
    const serializedFiles = JSON.stringify(diffFiles);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Split Commit ${info.changeId}</title>
  <style>
    :root {
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-panel-border, #333333);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --focus: var(--vscode-focusBorder, #007fd4);
      --badge-added: #4ec9b0;
      --badge-modified: #cca700;
      --badge-deleted: #f14c4c;
      --badge-renamed: #c586c0;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-family);
      background-color: var(--bg);
      color: var(--fg);
      padding: 24px;
      line-height: 1.5;
      font-size: 13px;
    }

    .container {
      max-width: 720px;
      margin: 0 auto;
    }

    .header {
      margin-bottom: 20px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }

    .title-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    h1 {
      font-size: 18px;
      font-weight: 600;
    }

    .change-badge {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      padding: 2px 8px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
      color: #e3b341;
    }

    .orig-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #8c8c8c);
      background: var(--card-bg);
      padding: 8px 12px;
      border-radius: 4px;
      border-left: 3px solid #007acc;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .form-group {
      margin-bottom: 22px;
    }

    label {
      display: block;
      font-weight: 600;
      margin-bottom: 6px;
      font-size: 13px;
    }

    .help-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #8c8c8c);
      margin-bottom: 8px;
    }

    textarea {
      width: 100%;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 10px 12px;
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      min-height: 72px;
      outline: none;
    }

    textarea:focus {
      border-color: var(--focus);
    }

    .file-selection-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .file-actions {
      display: flex;
      gap: 8px;
    }

    .btn-link {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
      font-size: 12px;
      text-decoration: underline;
      padding: 2px 4px;
    }

    .btn-link:hover {
      color: var(--vscode-textLink-activeForeground, #3794ff);
    }

    .file-list {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      max-height: 320px;
      overflow-y: auto;
    }

    .file-item {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
      gap: 10px;
      transition: background 0.15s;
    }

    .file-item:last-child {
      border-bottom: none;
    }

    .file-item:hover {
      background: rgba(255, 255, 255, 0.04);
    }

    .file-item.selected {
      background: rgba(14, 99, 156, 0.12);
    }

    .file-item input[type="checkbox"] {
      cursor: pointer;
      accent-color: var(--btn-bg);
      width: 15px;
      height: 15px;
    }

    .file-status {
      font-size: 11px;
      font-weight: 700;
      width: 18px;
      text-align: center;
      border-radius: 3px;
      padding: 1px 0;
    }

    .status-A { color: var(--badge-added); }
    .status-M { color: var(--badge-modified); }
    .status-D { color: var(--badge-deleted); }
    .status-R { color: var(--badge-renamed); }

    .file-path {
      flex: 1;
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
    }

    .file-path .old-path {
      opacity: 0.6;
      text-decoration: line-through;
      margin-right: 6px;
    }

    .actions-footer {
      display: flex;
      gap: 12px;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    button.btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 8px 18px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
    }

    button.btn-primary:hover:not(:disabled) {
      background: var(--btn-hover);
    }

    button.btn-primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    button.btn-secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
      border: none;
      padding: 8px 18px;
      font-size: 13px;
      border-radius: 4px;
      cursor: pointer;
    }

    button.btn-secondary:hover {
      background: var(--btn-sec-hover);
    }

    .selection-count {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #8c8c8c);
      font-weight: normal;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title-row">
        <h1>Split Commit</h1>
        <span class="change-badge">${info.changeId}</span>
      </div>
      <div class="orig-desc"><strong>Original Commit:</strong> ${escapeHtml(rawDesc)}</div>
    </div>

    <div class="form-group">
      <label for="commit-desc">New Commit Description</label>
      <div class="help-text">Description for the new commit containing the selected changes. The remaining changes will keep the original description.</div>
      <textarea id="commit-desc" placeholder="Enter description for the new split commit..." autofocus></textarea>
    </div>

    <div class="form-group">
      <div class="file-selection-header">
        <label>Files to include in new commit <span id="selection-count" class="selection-count"></span></label>
        <div class="file-actions">
          <button type="button" class="btn-link" id="btn-select-all">Select All</button>
          <button type="button" class="btn-link" id="btn-deselect-all">Deselect All</button>
        </div>
      </div>
      <div class="file-list" id="file-list"></div>
    </div>

    <div class="actions-footer">
      <button type="button" class="btn-primary" id="btn-submit" disabled>Split Commit</button>
      <button type="button" class="btn-secondary" id="btn-cancel">Cancel</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const files = ${serializedFiles};

    const fileListEl = document.getElementById('file-list');
    const descInput = document.getElementById('commit-desc');
    const submitBtn = document.getElementById('btn-submit');
    const cancelBtn = document.getElementById('btn-cancel');
    const selectAllBtn = document.getElementById('btn-select-all');
    const deselectAllBtn = document.getElementById('btn-deselect-all');
    const selectionCountEl = document.getElementById('selection-count');

    function updateCount() {
      const checked = fileListEl.querySelectorAll('input[type="checkbox"]:checked');
      const count = checked.length;
      selectionCountEl.textContent = '(' + count + ' of ' + files.length + ' selected)';
      submitBtn.disabled = count === 0;
    }

    files.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-item';
      if (index === 0) {
        item.classList.add('selected');
      }

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = file.path;
      if (index === 0) {
        checkbox.checked = true;
      }

      const statusBadge = document.createElement('span');
      statusBadge.className = 'file-status status-' + file.status;
      statusBadge.textContent = file.status;

      const pathSpan = document.createElement('span');
      pathSpan.className = 'file-path';
      if (file.oldPath) {
        pathSpan.innerHTML = '<span class="old-path">' + file.oldPath + '</span>➔ ' + file.path;
      } else {
        pathSpan.textContent = file.path;
      }

      item.appendChild(checkbox);
      item.appendChild(statusBadge);
      item.appendChild(pathSpan);

      item.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
        }
        item.classList.toggle('selected', checkbox.checked);
        updateCount();
      });

      checkbox.addEventListener('change', () => {
        item.classList.toggle('selected', checkbox.checked);
        updateCount();
      });

      fileListEl.appendChild(item);
    });

    selectAllBtn.addEventListener('click', () => {
      fileListEl.querySelectorAll('.file-item').forEach(item => {
        const cb = item.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = true;
        item.classList.add('selected');
      });
      updateCount();
    });

    deselectAllBtn.addEventListener('click', () => {
      fileListEl.querySelectorAll('.file-item').forEach(item => {
        const cb = item.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = false;
        item.classList.remove('selected');
      });
      updateCount();
    });

    submitBtn.addEventListener('click', () => {
      const checked = fileListEl.querySelectorAll('input[type="checkbox"]:checked');
      const selectedFiles = Array.from(checked).map(cb => cb.value);
      if (selectedFiles.length === 0) return;

      vscode.postMessage({
        command: 'submit',
        description: descInput.value,
        selectedFiles: selectedFiles
      });
    });

    cancelBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (!submitBtn.disabled) {
          submitBtn.click();
        }
      } else if (e.key === 'Escape') {
        cancelBtn.click();
      }
    });

    updateCount();
  </script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
