import * as vscode from 'vscode';
import { JJRunner, JJChangeInfo } from './jj';

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
        if (!changeId) return;

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
        if (!source || !target || source === target) return;

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

        if (!choice) return;

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
        if (!target) return;
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
    if (!this._view) return;
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
    const serializedCommits = JSON.stringify(commits);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      margin: 0;
      padding: 6px 4px;
      user-select: none;
      overflow-x: auto;
      touch-action: none;
      position: relative;
    }
    body.is-dragging { cursor: grabbing !important; }
    #graph-container { position: relative; }
    .commit-row {
      display: flex;
      align-items: center;
      height: 36px;
      cursor: default;
      border-radius: 4px;
      padding: 0 6px;
      position: relative;
      transition: background-color 0.12s ease;
    }
    .commit-row:hover { background-color: var(--vscode-list-hoverBackground); }
    .commit-row.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      outline: 1px solid var(--vscode-focusBorder);
    }
    .commit-row.convergence-row { opacity: 0.7; cursor: default; }
    .commit-row.convergence-row:hover { background-color: transparent !important; }
    .commit-row.is-rebased-source { opacity: 0.35; }
    .graph-rail-container {
      height: 36px;
      flex-shrink: 0;
      position: relative;
      pointer-events: none;
    }
    .commit-content {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      flex-grow: 1;
      padding-left: 8px;
      pointer-events: none;
    }
    .change-id {
      font-family: var(--vscode-editor-font-family);
      font-size: calc(var(--vscode-font-size) * 0.92);
      font-weight: bold;
      color: var(--vscode-textLink-foreground);
      flex-shrink: 0;
    }
    .commit-row.selected .change-id { color: var(--vscode-list-activeSelectionForeground); }
    .change-id .dim { opacity: 0.6; font-weight: normal; }
    .description {
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-foreground);
      font-size: var(--vscode-font-size);
    }
    .commit-row.selected .description { color: var(--vscode-list-activeSelectionForeground); }
    .pill {
      font-size: calc(var(--vscode-font-size) * 0.82);
      line-height: 16px;
      padding: 1px 6px;
      border-radius: 12px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
    }
    .pill-working {
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border: 1px solid var(--vscode-activityBarBadge-background);
    }
    .pill-bookmark {
      background-color: rgba(63, 185, 80, 0.15);
      color: #3fb950;
      border: 1px solid #2ea043;
    }
    .pill-remote-bookmark {
      background-color: rgba(88, 166, 255, 0.15);
      color: #58a6ff;
      border: 1px solid #1f6feb;
    }
    .pill-worktree {
      background-color: rgba(163, 113, 247, 0.15);
      color: #bc8cff;
      border: 1px solid #8957e5;
    }
    .pill-conflict {
      background-color: rgba(248, 81, 73, 0.15);
      color: #f85149;
      border: 1px solid #da3633;
    }
    .pill-divergent {
      background-color: rgba(248, 81, 73, 0.2);
      color: #f85149;
      border: 1px solid #da3633;
    }
    .pill-changes {
      background-color: rgba(210, 153, 34, 0.15);
      color: #e3b341;
      border: 1px dashed #d29922;
    }
    .action-button-group {
      display: none;
      align-items: center;
      gap: 2px;
      margin-left: auto;
      flex-shrink: 0;
      pointer-events: auto;
    }
    .commit-row:hover .action-button-group,
    .commit-row.selected .action-button-group {
      display: inline-flex;
    }
    .commit-action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 2px;
      border-radius: 3px;
      cursor: pointer;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: none;
    }
    .commit-action-btn:hover {
      background-color: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }
    .commit-action-btn.btn-delete:hover {
      color: var(--vscode-errorForeground, #f85149);
    }

    /* Floating Context Menu */
    #custom-context-menu {
      position: fixed;
      display: none;
      z-index: 1000;
      background: var(--vscode-menu-background, #252526);
      color: var(--vscode-menu-foreground, #cccccc);
      border: 1px solid var(--vscode-menu-border, #454545);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      border-radius: 5px;
      padding: 4px 0;
      min-width: 175px;
    }
    .menu-item {
      padding: 5px 12px;
      font-size: calc(var(--vscode-font-size) * 0.95);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .menu-item:hover {
      background-color: var(--vscode-menu-selectionBackground, #04395e);
      color: var(--vscode-menu-selectionForeground, #ffffff);
    }
    .menu-separator {
      height: 1px;
      background: var(--vscode-menu-separatorBackground, #454545);
      margin: 4px 0;
    }

    #overlay-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 20;
      overflow: visible;
      display: none;
    }
    .outward-branch-line {
      stroke: #e3b341;
      stroke-width: 2.2;
      stroke-dasharray: 4 3;
      fill: none;
    }

    #outward-tooltip {
      position: absolute;
      pointer-events: none;
      z-index: 30;
      display: none;
      background: var(--vscode-editor-background);
      border: 1.5px solid #e3b341;
      color: #e3b341;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
      font-size: calc(var(--vscode-font-size) * 0.9);
      font-weight: 600;
      padding: 3px 10px;
      white-space: nowrap;
      transform: translateY(-50%);
    }
  </style>
</head>
<body>
  <div id="graph-container"></div>
  <div id="custom-context-menu"></div>

  <svg id="overlay-canvas">
    <path id="outward-path" class="outward-branch-line" d="" />
    <circle id="outward-circle" cx="0" cy="0" r="4.5" fill="#e3b341" stroke="var(--vscode-sideBar-background)" stroke-width="1.5" />
  </svg>
  <div id="outward-tooltip"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const commits = ${serializedCommits};
    const currentId = "${currentId}";
    const selectedId = "${selectedCommitId || ''}";
    const activeRemote = "${activeRemote || ''}";
    const container = document.getElementById('graph-container');
    const overlay = document.getElementById('overlay-canvas');
    const outwardPath = document.getElementById('outward-path');
    const outwardCircle = document.getElementById('outward-circle');
    const outwardTooltip = document.getElementById('outward-tooltip');
    const contextMenu = document.getElementById('custom-context-menu');

    const LANE_WIDTH = 20;
    const ROW_HEIGHT = 36;
    const MID_Y = ROW_HEIGHT / 2;
    const COLORS = ['#007acc', '#3fb950', '#bc8cff', '#f0883e', '#58a6ff', '#d29922'];

    // Dedicated branch lanes & multi-track routing layout
    function computeLayout(commitList) {
      const commitIds = new Set(commitList.map(c => c.commitId));

      const internalParents = new Map();
      const internalChildren = new Map();
      commitList.forEach(c => {
        internalChildren.set(c.commitId, []);
      });
      commitList.forEach(c => {
        const parents = (c.parentIds || []).filter(p => commitIds.has(p));
        internalParents.set(c.commitId, parents);
        parents.forEach(p => {
          internalChildren.get(p).push(c.commitId);
        });
      });

      const baseCommits = commitList.filter(c => internalParents.get(c.commitId).length === 0);

      // Assign lanes
      const commitLane = new Map();
      let nextLane = 0;

      // Base commits get dedicated lanes (lanes 0, 1, 2...)
      baseCommits.forEach(bc => {
        commitLane.set(bc.commitId, nextLane++);
      });

      // Bottom-up lane propagation to primary children
      for (let r = commitList.length - 1; r >= 0; r--) {
        const c = commitList[r];
        const myLane = commitLane.get(c.commitId) ?? nextLane++;
        commitLane.set(c.commitId, myLane);

        const children = internalChildren.get(c.commitId) || [];
        if (children.length > 0) {
          const primaryChild = children[0];
          if (!commitLane.has(primaryChild)) {
            commitLane.set(primaryChild, myLane);
          }
          for (let i = 1; i < children.length; i++) {
            if (!commitLane.has(children[i])) {
              commitLane.set(children[i], nextLane++);
            }
          }
        }
      }

      commitList.forEach(c => {
        if (!commitLane.has(c.commitId)) {
          commitLane.set(c.commitId, nextLane++);
        }
      });

      const maxLanes = Math.max(nextLane, 1);
      const rowLanes = commitList.map(c => commitLane.get(c.commitId) ?? 0);

      const laneStartRow = new Map();
      const laneEndRow = new Map();

      for (let r = 0; r < commitList.length; r++) {
        const l = rowLanes[r];
        if (!laneStartRow.has(l)) {
          laneStartRow.set(l, r);
        }
        laneEndRow.set(l, r);
      }

      const baseLanes = new Set(baseCommits.map(c => commitLane.get(c.commitId)));
      baseLanes.forEach(l => {
        laneEndRow.set(l, commitList.length - 1);
      });

      // For non-base lanes (forks), find the parent row where they merge
      commitList.forEach((c, r) => {
        const l = rowLanes[r];
        if (!baseLanes.has(l)) {
          const parents = internalParents.get(c.commitId) || [];
          parents.forEach(pId => {
            const pRow = commitList.findIndex(item => item.commitId === pId);
            if (pRow !== -1) {
              const curEnd = laneEndRow.get(l) ?? r;
              laneEndRow.set(l, Math.max(curEnd, pRow));
            }
          });
        }
      });

      const rowPaths = [];

      for (let r = 0; r < commitList.length; r++) {
        const c = commitList[r];
        const myLane = rowLanes[r];
        const nodeX = myLane * LANE_WIDTH + LANE_WIDTH / 2;
        const paths = [];

        const children = internalChildren.get(c.commitId) || [];
        const parents = internalParents.get(c.commitId) || [];

        // 1. Pass-through lines on other lanes active in this row
        for (let l = 0; l < maxLanes; l++) {
          if (l !== myLane) {
            const start = laneStartRow.get(l) ?? 0;
            const end = laneEndRow.get(l) ?? 0;
            if (r > start) {
              if (baseLanes.has(l) && r <= end) {
                const x = l * LANE_WIDTH + LANE_WIDTH / 2;
                paths.push({
                  d: \`M \${x} 0 L \${x} \${ROW_HEIGHT}\`,
                  stroke: COLORS[l % COLORS.length]
                });
              } else if (!baseLanes.has(l) && r < end) {
                const x = l * LANE_WIDTH + LANE_WIDTH / 2;
                paths.push({
                  d: \`M \${x} 0 L \${x} \${ROW_HEIGHT}\`,
                  stroke: COLORS[l % COLORS.length]
                });
              }
            }
          }
        }

        // 2. Inbound lines from children
        children.forEach(chId => {
          const chLane = commitLane.get(chId) ?? myLane;
          const chX = chLane * LANE_WIDTH + LANE_WIDTH / 2;
          if (chLane === myLane) {
            paths.push({
              d: \`M \${nodeX} 0 L \${nodeX} \${MID_Y}\`,
              stroke: COLORS[myLane % COLORS.length]
            });
          } else {
            paths.push({
              d: \`M \${chX} 0 C \${chX} \${MID_Y * 0.6}, \${nodeX} \${MID_Y * 0.6}, \${nodeX} \${MID_Y}\`,
              stroke: COLORS[chLane % COLORS.length]
            });
          }
        });

        // 3. Outbound lines to parents (or down if base)
        paths.push({
          d: \`M \${nodeX} \${MID_Y} L \${nodeX} \${ROW_HEIGHT}\`,
          stroke: COLORS[myLane % COLORS.length]
        });

        if (parents.length > 1) {
          for (let pIdx = 1; pIdx < parents.length; pIdx++) {
            const pId = parents[pIdx];
            const pLane = commitLane.get(pId) ?? myLane;
            const targetX = pLane * LANE_WIDTH + LANE_WIDTH / 2;
            paths.push({
              d: \`M \${nodeX} \${MID_Y} C \${nodeX} \${MID_Y + 14}, \${targetX} \${MID_Y + 14}, \${targetX} \${ROW_HEIGHT}\`,
              stroke: COLORS[pLane % COLORS.length]
            });
          }
        }

        rowPaths.push(paths);
      }

      // 4. Convergence row at bottom
      const targetLane = 0;
      const targetX = targetLane * LANE_WIDTH + LANE_WIDTH / 2;
      const convergePaths = [];
      Array.from(baseLanes).sort((a, b) => a - b).forEach(l => {
        const x = l * LANE_WIDTH + LANE_WIDTH / 2;
        if (l === targetLane) {
          convergePaths.push({
            d: \`M \${x} 0 L \${x} \${MID_Y}\`,
            stroke: COLORS[l % COLORS.length]
          });
        } else {
          convergePaths.push({
            d: \`M \${x} 0 C \${x} \${MID_Y * 0.75}, \${targetX} \${MID_Y * 0.75}, \${targetX} \${MID_Y}\`,
            stroke: COLORS[l % COLORS.length]
          });
        }
      });

      return { rowLanes, rowPaths, maxLanes, baseLanes: Array.from(baseLanes), convergePaths, targetX };
    }

    const { rowLanes, rowPaths, maxLanes, baseLanes, convergePaths, targetX } = computeLayout(commits);
    const totalRailWidth = Math.max(maxLanes * LANE_WIDTH + 8, 32);

    window.addEventListener('click', () => {
      contextMenu.style.display = 'none';
    });

    commits.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'commit-row';
      if (selectedId && (c.changeId === selectedId || c.commitId === selectedId)) {
        row.classList.add('selected');
      }
      row.dataset.changeId = c.changeId;
      row.dataset.commitId = c.commitId;
      row.dataset.rowIdx = idx;
      row.dataset.lane = rowLanes[idx];
      row.title = "Click to inspect. Double-click to branch on top.";

      row.addEventListener('click', () => {
        if (dragThresholdPassed) return;
        vscode.postMessage({ command: 'selectCommit', changeId: c.changeId });
      });

      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'newOnTop', changeId: c.changeId });
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();

        contextMenu.innerHTML = '';

        const multiDiffOpt = document.createElement('div');
        multiDiffOpt.className = 'menu-item';
        multiDiffOpt.textContent = 'Open Unified Diff';
        multiDiffOpt.onclick = () => {
          vscode.postMessage({ command: 'openMultiDiff', changeId: c.changeId });
        };
        contextMenu.appendChild(multiDiffOpt);

        const pushBranchOpt = document.createElement('div');
        pushBranchOpt.className = 'menu-item';
        pushBranchOpt.textContent = 'Upload / Push This Chain';
        pushBranchOpt.onclick = () => {
          vscode.postMessage({ command: 'pushChain', changeId: c.changeId });
        };
        contextMenu.appendChild(pushBranchOpt);

        const bookmarkOpt = document.createElement('div');
        bookmarkOpt.className = 'menu-item';
        bookmarkOpt.textContent = 'Create Bookmark Here...';
        bookmarkOpt.onclick = () => {
          vscode.postMessage({ command: 'createBookmark', changeId: c.changeId });
        };
        contextMenu.appendChild(bookmarkOpt);

        if (c.isDivergent) {
          const convergeOpt = document.createElement('div');
          convergeOpt.className = 'menu-item';
          convergeOpt.textContent = 'Converge Divergent Changes';
          convergeOpt.onclick = () => {
            vscode.postMessage({ command: 'convergeCommit', changeId: c.changeId, commitId: c.commitId });
          };
          contextMenu.appendChild(convergeOpt);
        }

        if (c.bookmarks && c.bookmarks.length > 0) {
          c.bookmarks.forEach((bm) => {
            const removeBmOpt = document.createElement('div');
            removeBmOpt.className = 'menu-item';
            removeBmOpt.textContent = \`Remove Bookmark '\${bm}'\`;
            removeBmOpt.onclick = () => {
              vscode.postMessage({ command: 'removeBookmark', bookmark: bm });
            };
            contextMenu.appendChild(removeBmOpt);
          });
        }

        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        contextMenu.appendChild(sep);

        const editOpt = document.createElement('div');
        editOpt.className = 'menu-item';
        editOpt.textContent = 'Edit This Change';
        editOpt.onclick = () => {
          vscode.postMessage({ command: 'editCommit', changeId: c.changeId });
        };
        contextMenu.appendChild(editOpt);

        const abandonOpt = document.createElement('div');
        abandonOpt.className = 'menu-item';
        abandonOpt.textContent = 'Abandon Commit';
        abandonOpt.onclick = () => {
          vscode.postMessage({ command: 'abandonCommit', changeId: c.changeId });
        };
        contextMenu.appendChild(abandonOpt);

        contextMenu.style.display = 'block';
        const menuWidth = 190;
        const menuHeight = contextMenu.offsetHeight || 160;
        let posX = e.clientX;
        let posY = e.clientY;

        if (posX + menuWidth > window.innerWidth) posX = window.innerWidth - menuWidth - 8;
        if (posY + menuHeight > window.innerHeight) posY = window.innerHeight - menuHeight - 8;

        contextMenu.style.left = Math.max(posX, 4) + 'px';
        contextMenu.style.top = Math.max(posY, 4) + 'px';
      });

      const isCurrent = c.commitId === currentId || c.changeId === currentId;
      const myLane = rowLanes[idx];
      const nodeX = myLane * LANE_WIDTH + LANE_WIDTH / 2;
      const nodeColor = isCurrent
        ? 'var(--vscode-activityBarBadge-background, #007acc)'
        : COLORS[myLane % COLORS.length];

      let svgLines = '';
      rowPaths[idx].forEach(p => {
        svgLines += \`<path d="\${p.d}" stroke="\${p.stroke}" stroke-width="2.2" fill="none" />\`;
      });

      const svg = \`
        <svg class="graph-rail-container" style="width: \${totalRailWidth}px;" viewBox="0 0 \${totalRailWidth} \${ROW_HEIGHT}">
          \${svgLines}
          <circle class="node-circle" cx="\${nodeX}" cy="\${MID_Y}" r="\${isCurrent ? 6.5 : 5}" fill="\${nodeColor}" stroke="var(--vscode-sideBar-background)" stroke-width="2" />
        </svg>
      \`;

      const pLen = Math.min(c.shortestLen, c.changeId.length);
      const prefix = c.changeId.slice(0, pLen);
      const suffix = c.changeId.slice(pLen);
      const formattedId = \`<span>\${prefix}</span><span class="dim">\${suffix}</span>\`;

      let tagsHtml = '';
      if (isCurrent) {
        tagsHtml += \`<span class="pill pill-working">Working copy</span>\`;
      }
      c.workingCopies.forEach(wc => {
        tagsHtml += \`<span class="pill pill-worktree">\${wc}</span>\`;
      });
      c.bookmarks.forEach(b => {
        tagsHtml += \`<span class="pill pill-bookmark">\${b}</span>\`;
      });
      c.remoteBookmarks.forEach(rb => {
        tagsHtml += \`<span class="pill pill-remote-bookmark">\${rb}</span>\`;
      });
      if (c.isConflict) {
        tagsHtml += \`<span class="pill pill-conflict">💥 conflict</span>\`;
      }
      if (c.isDivergent) {
        tagsHtml += \`<span class="pill pill-divergent">divergent</span>\`;
      }
      if (!c.description && !c.empty) {
        tagsHtml += \`<span class="pill pill-changes">(has changes)</span>\`;
      }

      const descText = c.description || (c.empty ? '(empty)' : '');

      row.innerHTML = \`
        \${svg}
        <div class="commit-content">
          <span class="change-id">\${formattedId}</span>
          \${tagsHtml}
          <span class="description">\${descText}</span>
        </div>
        <div class="action-button-group">
          <button class="commit-action-btn btn-edit" title="Edit this commit directly">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-3-3zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207l6.5-6.5zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.499.499 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11l.178-.178z"/>
            </svg>
          </button>
          <button class="commit-action-btn btn-diff" title="Open Unified Multi-Diff Editor for this commit">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h5V2h-5zm6 0v12h5a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-5z"/>
            </svg>
          </button>
          <button class="commit-action-btn btn-delete" title="Abandon commit">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM6.5 1.5h3a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25ZM3.5 5.5v8.25c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.5h-9Zm3 2a.5.5 0 0 1 .5.5v4.5a.5.5 0 0 1-1 0V8a.5.5 0 0 1 .5-.5Zm3 0a.5.5 0 0 1 .5.5v4.5a.5.5 0 0 1-1 0V8a.5.5 0 0 1 .5-.5Z"/>
            </svg>
          </button>
        </div>
      \`;

      const editBtn = row.querySelector('.btn-edit');
      if (editBtn) {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'editCommit', changeId: c.changeId });
        });
      }

      const diffBtn = row.querySelector('.btn-diff');
      if (diffBtn) {
        diffBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'openMultiDiff', changeId: c.changeId });
        });
      }

      const deleteBtn = row.querySelector('.btn-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'abandonCommit', changeId: c.changeId });
        });
      }

      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (e.target && e.target.closest('.commit-action-btn'))) return;
        isMouseDown = true;
        dragThresholdPassed = false;
        draggedElement = row;
        draggedId = c.changeId;
        startX = e.clientX;
        startY = e.clientY;
      });

      container.appendChild(row);
    });

    if (baseLanes && baseLanes.length > 0) {
      const convRow = document.createElement('div');
      convRow.className = 'commit-row convergence-row';
      convRow.title = activeRemote ? \`Pushed commits outside view (remote: \${activeRemote})\` : 'Pushed commits outside view';

      let convSvgLines = '';
      convergePaths.forEach(p => {
        convSvgLines += \`<path d="\${p.d}" stroke="\${p.stroke}" stroke-width="2.2" fill="none" />\`;
      });

      const convSvg = \`
        <svg class="graph-rail-container" style="width: \${totalRailWidth}px;" viewBox="0 0 \${totalRailWidth} \${ROW_HEIGHT}">
          \${convSvgLines}
          <circle class="convergence-circle" cx="\${targetX}" cy="\${MID_Y}" r="4.5" fill="var(--vscode-sideBar-background)" stroke="var(--vscode-descriptionForeground)" stroke-width="2" />
        </svg>
      \`;

      const remoteLabel = activeRemote ? \`(pushed to \${activeRemote})\` : '(pushed)';
      convRow.innerHTML = \`
        \${convSvg}
        <div class="commit-content">
          <span class="description" style="font-style: italic; opacity: 0.65;">\${remoteLabel}</span>
        </div>
      \`;

      container.appendChild(convRow);
    }

    let draggedElement = null;
    let draggedId = null;
    let currentDropTarget = null;
    let isMouseDown = false;
    let dragThresholdPassed = false;
    let startX = 0;
    let startY = 0;

    function hideOutwardVisuals() {
      overlay.style.display = 'none';
      outwardTooltip.style.display = 'none';
      currentDropTarget = null;
    }

    function showOutwardVisuals(sourceId, targetRow) {
      const targetCircle = targetRow.querySelector('.node-circle');
      if (!targetCircle) return;

      const containerRect = container.getBoundingClientRect();
      const circleRect = targetCircle.getBoundingClientRect();
      const targetId = targetRow.dataset.changeId;

      const circleX = (circleRect.left - containerRect.left) + (circleRect.width / 2);
      const circleY = (circleRect.top - containerRect.top) + (circleRect.height / 2);
      const branchEndX = totalRailWidth + 24;
      const branchEndY = circleY - 14;

      const ctrl1X = circleX + 18;
      const ctrl1Y = circleY;
      const ctrl2X = branchEndX - 10;
      const ctrl2Y = branchEndY;

      const pathData = \`M \${circleX} \${circleY} C \${ctrl1X} \${ctrl1Y}, \${ctrl2X} \${ctrl2Y}, \${branchEndX} \${branchEndY}\`;
      outwardPath.setAttribute('d', pathData);
      outwardCircle.setAttribute('cx', branchEndX);
      outwardCircle.setAttribute('cy', branchEndY);

      overlay.style.display = 'block';
      outwardTooltip.textContent = \`↪ Rebase \${sourceId} onto \${targetId}\`;
      outwardTooltip.style.left = (branchEndX + 8) + 'px';
      outwardTooltip.style.top = branchEndY + 'px';
      outwardTooltip.style.display = 'block';
    }

    window.addEventListener('pointermove', (e) => {
      if (!isMouseDown || !draggedId) return;

      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (!dragThresholdPassed && dist > 5) {
        dragThresholdPassed = true;
        document.body.classList.add('is-dragging');
        if (draggedElement) {
          draggedElement.classList.add('is-rebased-source');
        }
      }

      if (dragThresholdPassed) {
        const hovered = document.elementFromPoint(e.clientX, e.clientY);
        const targetRow = hovered ? hovered.closest('.commit-row') : null;
        const targetId = targetRow ? targetRow.dataset.changeId : null;

        if (targetRow && targetId && targetId !== draggedId) {
          if (currentDropTarget !== targetId) {
            currentDropTarget = targetId;
            showOutwardVisuals(draggedId, targetRow);
          }
        } else {
          if (currentDropTarget !== null) {
            hideOutwardVisuals();
          }
        }
      }
    });

    window.addEventListener('pointerup', () => {
      const finalSource = draggedId;
      const finalTarget = currentDropTarget;
      const wasDragging = dragThresholdPassed;

      document.body.classList.remove('is-dragging');
      hideOutwardVisuals();

      if (draggedElement) {
        draggedElement.classList.remove('is-rebased-source');
      }

      isMouseDown = false;
      dragThresholdPassed = false;
      draggedElement = null;
      draggedId = null;
      currentDropTarget = null;

      if (wasDragging && finalSource && finalTarget && finalSource !== finalTarget) {
        vscode.postMessage({ command: 'rebase', source: finalSource, target: finalTarget });
      }
    });
  </script>
</body>
</html>`;
  }
}