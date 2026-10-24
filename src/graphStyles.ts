export function getGraphStyles(): string {
  return `
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
  `;
}
