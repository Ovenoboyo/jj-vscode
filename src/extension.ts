import * as vscode from 'vscode';
import * as path from 'path';
import { JJRunner } from './jj';
import { JJDiffFile, JJChangeInfo, JJResourceState, JJRemoteInfo, JJConflictEntry } from './types';
import { JJGraphWebviewProvider } from './graphProvider';
import { JJRemotesProvider } from './remotesProvider';
import { registerConflictCommands } from './conflictResolver';
import {
  registerGeneralCommands,
  JJ_DIFF_SCHEME,
  JJ_RESOURCE_SCHEME,
  ACTIVE_REMOTE_KEY,
} from './commands';

class JJContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly jj: JJRunner) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cleanPath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    if (cleanPath === 'empty-file') {
      return '';
    }
    const rev = uri.query || '@-';
    return await this.jj.showFile(cleanPath, rev);
  }
}

function formatHighlightedId(info: JJChangeInfo): string {
  const raw = info.changeId;
  const prefixLen = Math.min(info.shortestLen, raw.length);

  let result = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (i < prefixLen && char >= 'a' && char <= 'z') {
      result += String.fromCodePoint(0x1d5ee + (char.charCodeAt(0) - 97));
    } else {
      result += char;
    }
  }
  return result;
}

function createResourceState(
  file: JJDiffFile,
  root: string,
  fromRev: string,
  intoRev: string,
  fromDisplayId: string,
  intoDisplayId: string,
  contextValue: string
): JJResourceState {
  const fileUri = vscode.Uri.file(path.join(root, file.path));

  const stateResourceUri =
    fromRev === '@'
      ? fileUri
      : vscode.Uri.from({
          scheme: JJ_RESOURCE_SCHEME,
          path: file.path,
          query: fromRev,
        });

  const baseUri = vscode.Uri.from({
    scheme: JJ_DIFF_SCHEME,
    path: file.path,
    query: intoRev,
  });

  const targetUri =
    fromRev === '@'
      ? fileUri
      : vscode.Uri.from({
          scheme: JJ_DIFF_SCHEME,
          path: file.path,
          query: fromRev,
        });

  const fileName = path.basename(file.path);
  let title = `${fileName} (${fromDisplayId} vs ${intoDisplayId})`;
  let leftUri = baseUri;
  let rightUri = targetUri;

  if (file.status === 'A') {
    title = `${fileName} (Added in ${fromDisplayId})`;
    leftUri = baseUri.with({ path: 'empty-file' });
  } else if (file.status === 'D') {
    title = `${fileName} (Deleted in ${fromDisplayId})`;
    rightUri = baseUri.with({ path: 'empty-file' });
  }

  return {
    resourceUri: stateResourceUri,
    contextValue,
    fromRev,
    intoRev,
    relativePath: file.path,
    decorations: {
      strikeThrough: file.status === 'D',
      tooltip: `Status: ${file.status} (${fromDisplayId})`,
    },
    command: {
      title: 'Open Diff',
      command: 'vscode.diff',
      arguments: [leftUri, rightUri, title],
    },
  };
}

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  const rootPath = workspaceFolders[0].uri.fsPath;
  const jj = new JJRunner(rootPath);
  const outputChannel = vscode.window.createOutputChannel('Jujutsu SCM');

  const contentProvider = new JJContentProvider(jj);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(JJ_DIFF_SCHEME, contentProvider),
    vscode.workspace.registerTextDocumentContentProvider(JJ_RESOURCE_SCHEME, contentProvider),
    outputChannel
  );

  let scm: vscode.SourceControl | undefined;
  let conflictsGroup: vscode.SourceControlResourceGroup | undefined;
  let workingGroup: vscode.SourceControlResourceGroup | undefined;
  let secondaryGroup: vscode.SourceControlResourceGroup | undefined;
  let remoteStatusBar: vscode.StatusBarItem | undefined;
  let statusBar: vscode.StatusBarItem | undefined;
  let syncStatusBar: vscode.StatusBarItem | undefined;

  let selectedCommitId: string | undefined = undefined;

  async function getActiveRemote(): Promise<string | undefined> {
    const remotes: JJRemoteInfo[] = await jj.getRemotes();
    if (remotes.length === 0) {
      return undefined;
    }

    const saved = context.workspaceState.get<string>(ACTIVE_REMOTE_KEY);
    if (saved && remotes.some((r) => r.name === saved)) {
      return saved;
    }

    const defaultRemote = remotes.some((r) => r.name === 'origin') ? 'origin' : remotes[0].name;
    await context.workspaceState.update(ACTIVE_REMOTE_KEY, defaultRemote);
    return defaultRemote;
  }

  const graphWebviewProvider = new JJGraphWebviewProvider(context.extensionUri, jj, getActiveRemote);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      JJGraphWebviewProvider.viewType,
      graphWebviewProvider
    )
  );

  const remotesProvider = new JJRemotesProvider(jj);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('jjRemotesView', remotesProvider)
  );

  let isRefreshing = false;
  let refreshTimeout: NodeJS.Timeout | undefined;

  function triggerRefresh(delayMs = 200) {
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
    }
    refreshTimeout = setTimeout(() => {
      refresh().catch((err) => outputChannel.appendLine(`Refresh failed: ${err.message}`));
    }, delayMs);
  }

  async function ensureInitialized(): Promise<boolean> {
    const isRepo = await jj.isRepo();
    await vscode.commands.executeCommand('setContext', 'jj:isRepo', isRepo);

    if (!isRepo) {
      if (scm) {
        scm.dispose();
        scm = undefined;
        conflictsGroup = undefined;
        workingGroup = undefined;
        secondaryGroup = undefined;
      }
      if (remoteStatusBar) {
        remoteStatusBar.hide();
      }
      if (statusBar) {
        statusBar.hide();
      }
      if (syncStatusBar) {
        syncStatusBar.hide();
      }
      return false;
    }

    if (!scm) {
      scm = vscode.scm.createSourceControl('jj', 'Jujutsu', workspaceFolders![0].uri);

      conflictsGroup = scm.createResourceGroup('conflicts', 'Conflicts');
      conflictsGroup.hideWhenEmpty = true;

      workingGroup = scm.createResourceGroup('working', 'Working copy');
      secondaryGroup = scm.createResourceGroup('secondary', 'Parent');
      secondaryGroup.hideWhenEmpty = false;

      // Status Bar Ordering: Remote (left: priority 100), Bookmark (priority 99), Sync (priority 98)
      remoteStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      remoteStatusBar.command = 'jj.selectRemote';

      statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
      statusBar.command = 'jj.switchBookmark';

      syncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
      syncStatusBar.command = 'jj.sync';

      context.subscriptions.push(
        scm,
        conflictsGroup,
        workingGroup,
        secondaryGroup,
        remoteStatusBar,
        statusBar,
        syncStatusBar
      );
    }

    return true;
  }

  async function refresh() {
    if (isRefreshing) {
      return;
    }
    isRefreshing = true;

    try {
      const ready = await ensureInitialized();
      if (!ready || !scm || !conflictsGroup || !workingGroup || !secondaryGroup || !remoteStatusBar || !statusBar || !syncStatusBar) {
        return;
      }

      const current = await jj.getChangeInfo('@');
      if (!current) {
        return;
      }

      const firstLineCurrent = current.description.split('\n')[0];
      const workingDesc = firstLineCurrent ? `: ${firstLineCurrent}` : '';
      workingGroup.label = `Working copy${workingDesc}`;

      scm.inputBox.placeholder = `Describe change (${current.changeId}) - press + or run Describe`;

      // 1. Remote Component (Placed on the left)
      const remotes: JJRemoteInfo[] = await jj.getRemotes();
      const activeRemote = await getActiveRemote();

      if (remotes.length > 0 && activeRemote) {
        remoteStatusBar.text = `$(cloud) ${activeRemote}`;
        remoteStatusBar.tooltip = `Active Remote: ${activeRemote}\nClick to switch active remote`;
        remoteStatusBar.show();
      } else {
        remoteStatusBar.hide();
      }

      // 2. Bookmark Component (To the right of the remote component)
      const activeBookmark = await jj.getActiveBookmark(activeRemote);
      if (activeBookmark) {
        statusBar.text = `$(bookmark) ${activeBookmark}`;
        statusBar.tooltip = `Active Bookmark: ${activeBookmark}\nCommit: ${current.changeId} (${current.commitId})\n\nClick to switch bookmark`;
        statusBar.show();
      } else {
        statusBar.hide();
      }

      // 3. Sync Component
      if (remotes.length > 0 && activeRemote) {
        const syncStatus = await jj.getSyncStatus(activeRemote);
        if (syncStatus) {
          syncStatusBar.text = `$(sync) ↑${syncStatus.ahead} ↓${syncStatus.behind}`;
          const bLabel = syncStatus.bookmark !== '(none)' ? `on '${syncStatus.bookmark}' ` : '';
          syncStatusBar.tooltip = `${syncStatus.remote}: ${syncStatus.ahead} unpushed commit(s) in current chain, ${syncStatus.behind} incoming from ${bLabel}${syncStatus.remote}\nClick to pull & push`;
          syncStatusBar.show();
        } else {
          syncStatusBar.hide();
        }
      } else {
        syncStatusBar.hide();
      }

      const targetInspectId = selectedCommitId && selectedCommitId !== current.changeId
        ? selectedCommitId
        : '@';
      const targetInspectInfo = targetInspectId === '@' ? current : await jj.getChangeInfo(targetInspectId);

      if (targetInspectInfo && targetInspectInfo.isConflict) {
        const conflictEntries: JJConflictEntry[] = await jj.getConflictedFiles(targetInspectId);
        if (conflictEntries.length > 0) {
          conflictsGroup.hideWhenEmpty = false;
          conflictsGroup.label = `Conflicts in ${formatHighlightedId(targetInspectInfo)}`;
          conflictsGroup.resourceStates = conflictEntries.map((entry) => {
            const fileUri = vscode.Uri.file(path.join(rootPath, entry.path));
            const tooltipDesc = entry.isDeletion
              ? `Conflict: ${entry.details} (Click to keep or delete, or use down arrow to squash)`
              : `Conflicted file: ${entry.details}. Click to resolve in 3-way Merge Editor.`;

            return {
              resourceUri: fileUri,
              contextValue: entry.isDeletion ? 'jjConflictFileDeletionItem' : 'jjConflictFileItem',
              fromRev: targetInspectId,
              intoRev: '@-',
              relativePath: entry.path,
              decorations: {
                strikeThrough: entry.isDeletion,
                tooltip: tooltipDesc,
                faded: false,
              },
              command: {
                title: 'Resolve Conflict',
                command: 'jj.openConflictResolver',
                arguments: [fileUri, targetInspectId],
              },
            };
          });
        } else {
          conflictsGroup.hideWhenEmpty = true;
          conflictsGroup.resourceStates = [];
        }
      } else {
        conflictsGroup.hideWhenEmpty = true;
        conflictsGroup.resourceStates = [];
      }

      const parentInfo = await jj.getChangeInfo('@-');
      const workingFiles: JJDiffFile[] = await jj.getDiffSummary('@');
      const parentId = parentInfo ? parentInfo.changeId : '@-';
      workingGroup.resourceStates = workingFiles.map((file) =>
        createResourceState(
          file,
          rootPath,
          '@',
          '@-',
          current.changeId,
          parentId,
          'jjWorkingFileItem'
        )
      );

      if (targetInspectId !== '@' && targetInspectInfo) {
        secondaryGroup.hideWhenEmpty = false;
        const formattedId = formatHighlightedId(targetInspectInfo);
        const firstLine = targetInspectInfo.description.split('\n')[0];
        const desc = firstLine ? `: ${firstLine}` : '';
        secondaryGroup.label = `Changed in ${formattedId}${desc}`;

        const inspectedParent = targetInspectInfo.parentIds[0] || `${targetInspectId}-`;
        const inspectedFiles: JJDiffFile[] = await jj.getDiffSummary(targetInspectId);

        secondaryGroup.resourceStates = inspectedFiles.map((file) =>
          createResourceState(
            file,
            rootPath,
            targetInspectId,
            inspectedParent,
            targetInspectInfo.changeId,
            inspectedParent,
            'jjParentFileItem'
          )
        );
      } else if (parentInfo) {
        secondaryGroup.hideWhenEmpty = false;
        const formattedParentId = formatHighlightedId(parentInfo);
        const firstLineParent = parentInfo.description.split('\n')[0];
        const parentDesc = firstLineParent ? `: ${firstLineParent}` : '';
        secondaryGroup.label = `Parent (${formattedParentId})${parentDesc}`;

        const grandParentInfo = await jj.getChangeInfo('@--');
        const grandParentId = grandParentInfo ? grandParentInfo.changeId : '@--';

        const parentFiles: JJDiffFile[] = await jj.getDiffSummary('@-');
        secondaryGroup.resourceStates = parentFiles.map((file) =>
          createResourceState(
            file,
            rootPath,
            '@-',
            '@--',
            parentInfo.changeId,
            grandParentId,
            'jjParentFileItem'
          )
        );
      } else {
        secondaryGroup.hideWhenEmpty = true;
        secondaryGroup.resourceStates = [];
      }

      await graphWebviewProvider.refresh(selectedCommitId);
      remotesProvider.refresh();
    } catch (err: any) {
      outputChannel.appendLine(`Refresh error: ${err.message}`);
    } finally {
      isRefreshing = false;
    }
  }

  const conflictDisposables = registerConflictCommands(jj, rootPath, refresh);
  const generalDisposables = registerGeneralCommands({
    context,
    jj,
    rootPath,
    getScm: () => scm,
    getSelectedCommitId: () => selectedCommitId,
    setSelectedCommitId: (id) => {
      selectedCommitId = id;
    },
    getActiveRemote,
    refresh,
  });

  const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const fileFilter = (uri: vscode.Uri) => {
    if (!uri.fsPath.includes('/.jj/')) {
      triggerRefresh();
    }
  };
  workspaceWatcher.onDidChange(fileFilter);
  workspaceWatcher.onDidCreate(fileFilter);
  workspaceWatcher.onDidDelete(fileFilter);

  vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!doc.uri.fsPath.includes('/.jj/')) {
      triggerRefresh(100);
    }
  });

  const jjOpWatcher = vscode.workspace.createFileSystemWatcher('**/.jj/repo/op_heads/*');
  jjOpWatcher.onDidChange(() => triggerRefresh());
  jjOpWatcher.onDidCreate(() => triggerRefresh());
  jjOpWatcher.onDidDelete(() => triggerRefresh());

  context.subscriptions.push(
    ...conflictDisposables,
    ...generalDisposables,
    workspaceWatcher,
    jjOpWatcher
  );

  refresh();
}

export function deactivate() {}