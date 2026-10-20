import * as vscode from 'vscode';
import { JJRunner, JJChangeInfo } from './jj';

export class JJGraphWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'jjGraphView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly jj: JJRunner
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
      } else if (message.command === 'edit') {
        try {
          const targetRev = message.changeId;
          const targetInfo = await this.jj.getChangeInfo(targetRev);

          if (targetInfo && targetInfo.empty && !targetInfo.description && targetInfo.parentIds.length > 0) {
            const parentRev = targetInfo.parentIds[0];
            const parentInfo = await this.jj.getChangeInfo(parentRev);

            if (parentInfo && parentInfo.empty && !parentInfo.description) {
              await this.jj.abandonChange(parentInfo.changeId);
            }
          }

          await this.jj.editChange(targetRev);
          await vscode.commands.executeCommand('jj.refresh');
        } catch (err: any) {
          vscode.window.showErrorMessage(err.message);
        }
      } else if (message.command === 'showContextMenu') {
        const { changeId } = message;
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(diff-multiple) Open Unified Diff for Commit', action: 'multidiff' },
            { label: '$(bookmark) Create Bookmark Here', action: 'bookmark' },
            { label: '$(folder-library) Create Workspace Here', action: 'workspace' },
            { label: '$(check) Edit This Change', action: 'edit' },
          ],
          { placeHolder: `Actions for commit ${changeId}` }
        );

        if (!choice) return;

        if (choice.action === 'multidiff') {
          await vscode.commands.executeCommand('jj.openMultiDiff', changeId);
        } else if (choice.action === 'bookmark') {
          await vscode.commands.executeCommand('jj.createBookmark', changeId);
        } else if (choice.action === 'workspace') {
          await vscode.commands.executeCommand('jj.addWorkspace', changeId);
        } else if (choice.action === 'edit') {
          await this.jj.editChange(changeId);
          await vscode.commands.executeCommand('jj.refresh');
        }
      }
    });

    this.refresh();
  }

  async refresh(selectedCommitId?: string) {
    if (!this._view) return;
    try {
      const commits = await this.jj.getCommitGraph();
      const current = await this.jj.getChangeInfo('@');
      this._view.webview.html = this.getHtml(commits, current?.changeId ?? '', selectedCommitId);
    } catch {
      this._view.webview.html = '<div style="padding: 12px; color: var(--vscode-errorForeground);">Failed to load JJ Graph</div>';
    }
  }

  private getHtml(commits: JJChangeInfo[], currentId: string, selectedCommitId?: string): string {
    const serializedCommits = JSON.stringify(commits);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    * {
      box-sizing: border-box;
    }
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
    body.is-dragging {
      cursor: grabbing !important;
    }
    #graph-container {
      position: relative;
    }
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
    .commit-row:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    .commit-row.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      outline: 1px solid var(--vscode-focusBorder);
    }
    .commit-row.is-rebased-source {
      opacity: 0.35;
    }
    .graph-rail-container {
      height: 36px;
      flex-shrink: 0;
      position: relative;
      pointer-events: none;
    }
    .commit-content {
      display: flex;
      align-items: center;
      gap: 8px;
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
    .commit-row.selected .change-id {
      color: var(--vscode-list-activeSelectionForeground);
    }
    .change-id .dim {
      opacity: 0.6;
      font-weight: normal;
    }
    .description {
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-foreground);
      font-size: var(--vscode-font-size);
    }
    .commit-row.selected .description {
      color: var(--vscode-list-activeSelectionForeground);
    }
    .pill {
      font-size: calc(var(--vscode-font-size) * 0.82);
      line-height: 16px;
      padding: 1px 7px;
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
      background-color: rgba(63, 185, 80, 0.2);
      color: #3fb950;
      border: 1px solid #2ea043;
    }
    .pill-worktree {
      background-color: rgba(163, 113, 247, 0.2);
      color: #bc8cff;
      border: 1px solid #8957e5;
    }
    .pill-conflict {
      background-color: rgba(248, 81, 73, 0.2);
      color: #f85149;
      border: 1px solid #da3633;
    }
    .pill-changes {
      background-color: rgba(210, 153, 34, 0.2);
      color: #e3b341;
      border: 1px dashed #d29922;
    }
    .diff-action-btn {
      display: none;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 2px;
      border-radius: 3px;
      cursor: pointer;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: none;
      margin-left: auto;
      flex-shrink: 0;
      pointer-events: auto;
    }
    .commit-row:hover .diff-action-btn,
    .commit-row.selected .diff-action-btn {
      display: inline-flex;
    }
    .diff-action-btn:hover {
      background-color: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
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
    const container = document.getElementById('graph-container');
    const overlay = document.getElementById('overlay-canvas');
    const outwardPath = document.getElementById('outward-path');
    const outwardCircle = document.getElementById('outward-circle');
    const outwardTooltip = document.getElementById('outward-tooltip');

    const LANE_WIDTH = 20;
    const ROW_HEIGHT = 36;
    const MID_Y = ROW_HEIGHT / 2;
    const COLORS = [
      '#007acc',
      '#3fb950',
      '#bc8cff',
      '#f0883e',
      '#58a6ff',
      '#d29922'
    ];

    function computeLayout(commitList) {
      const rowLanes = [];
      const rowPaths = [];
      let activeTracks = [];
      let maxLanes = 1;

      for (let r = 0; r < commitList.length; r++) {
        const c = commitList[r];
        let myLane = activeTracks.indexOf(c.changeId);
        const isHead = myLane === -1;

        if (isHead) {
          myLane = activeTracks.indexOf(null);
          if (myLane === -1) {
            myLane = activeTracks.length;
            activeTracks.push(c.changeId);
          } else {
            activeTracks[myLane] = c.changeId;
          }
        }

        rowLanes[r] = myLane;
        maxLanes = Math.max(maxLanes, activeTracks.length);

        const paths = [];

        activeTracks.forEach((trackId, lIdx) => {
          if (trackId !== null && trackId !== c.changeId) {
            const x = lIdx * LANE_WIDTH + LANE_WIDTH / 2;
            paths.push({
              d: \`M \${x} 0 L \${x} \${ROW_HEIGHT}\`,
              stroke: COLORS[lIdx % COLORS.length]
            });
          }
        });

        const nodeX = myLane * LANE_WIDTH + LANE_WIDTH / 2;

        if (!isHead) {
          paths.push({
            d: \`M \${nodeX} 0 L \${nodeX} \${MID_Y}\`,
            stroke: COLORS[myLane % COLORS.length]
          });
        }

        activeTracks[myLane] = null;

        const parents = c.parentIds || [];
        if (parents.length > 0) {
          parents.forEach((parentId, pIdx) => {
            let pLane = activeTracks.indexOf(parentId);

            if (pIdx === 0 && pLane === -1) {
              pLane = myLane;
              activeTracks[pLane] = parentId;
            } else if (pLane === -1) {
              pLane = activeTracks.indexOf(null);
              if (pLane === -1) {
                pLane = activeTracks.length;
                activeTracks.push(parentId);
              } else {
                activeTracks[pLane] = parentId;
              }
            }

            const targetX = pLane * LANE_WIDTH + LANE_WIDTH / 2;
            maxLanes = Math.max(maxLanes, activeTracks.length);

            if (targetX === nodeX) {
              paths.push({
                d: \`M \${nodeX} \${MID_Y} L \${targetX} \${ROW_HEIGHT}\`,
                stroke: COLORS[pLane % COLORS.length]
              });
            } else {
              paths.push({
                d: \`M \${nodeX} \${MID_Y} C \${nodeX} \${MID_Y + 12}, \${targetX} \${MID_Y + 12}, \${targetX} \${ROW_HEIGHT}\`,
                stroke: COLORS[pLane % COLORS.length]
              });
            }
          });
        }

        while (activeTracks.length > 0 && activeTracks[activeTracks.length - 1] === null) {
          activeTracks.pop();
        }

        rowPaths[r] = paths;
      }

      return { rowLanes, rowPaths, maxLanes };
    }

    const { rowLanes, rowPaths, maxLanes } = computeLayout(commits);
    const totalRailWidth = Math.max(maxLanes * LANE_WIDTH + 8, 32);

    commits.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'commit-row';
      if (selectedId && c.changeId === selectedId) {
        row.classList.add('selected');
      }
      row.dataset.changeId = c.changeId;
      row.dataset.rowIdx = idx;
      row.dataset.lane = rowLanes[idx];
      row.title = "Click to inspect in source control. Click icon to open unified diff. Double click to edit.";

      row.addEventListener('click', (e) => {
        if (dragThresholdPassed) return;
        vscode.postMessage({ command: 'selectCommit', changeId: c.changeId });
      });

      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'edit', changeId: c.changeId });
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        vscode.postMessage({ command: 'showContextMenu', changeId: c.changeId });
      });

      const isCurrent = c.changeId === currentId;
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
      if (c.isConflict) {
        tagsHtml += \`<span class="pill pill-conflict">💥 conflict</span>\`;
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
        <button class="diff-action-btn" title="Open Unified Multi-Diff Editor for this commit">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h5V2h-5zm6 0v12h5a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-5z"/>
          </svg>
        </button>
      \`;

      const diffBtn = row.querySelector('.diff-action-btn');
      if (diffBtn) {
        diffBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'openMultiDiff', changeId: c.changeId });
        });
      }

      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (e.target && e.target.closest('.diff-action-btn'))) return;
        isMouseDown = true;
        dragThresholdPassed = false;
        draggedElement = row;
        draggedId = c.changeId;
        startX = e.clientX;
        startY = e.clientY;
      });

      container.appendChild(row);
    });

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