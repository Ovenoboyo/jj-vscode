import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { JJRunner, JJDiffFile, JJChangeInfo } from './jj';
import { JJGraphWebviewProvider } from './graphProvider';
import { JJRemotesProvider, JJRemoteTreeItem } from './remotesProvider';

const JJ_DIFF_SCHEME = 'jj-diff';
const JJ_RESOURCE_SCHEME = 'jj-resource';
const ACTIVE_REMOTE_KEY = 'jjActiveRemote';

interface JJResourceState extends vscode.SourceControlResourceState {
  fromRev: string;
  intoRev: string;
  relativePath: string;
}

class JJContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly jj: JJRunner) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const rev = uri.query || '@-';
    const relativePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    return await this.jj.showFile(relativePath, rev);
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
  let statusBar: vscode.StatusBarItem | undefined;
  let remoteStatusBar: vscode.StatusBarItem | undefined;
  let syncStatusBar: vscode.StatusBarItem | undefined;

  let selectedCommitId: string | undefined = undefined;

  async function getActiveRemote(): Promise<string | undefined> {
    const remotes = await jj.getRemotes();
    if (remotes.length === 0) return undefined;

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
      if (statusBar) statusBar.hide();
      if (remoteStatusBar) remoteStatusBar.hide();
      if (syncStatusBar) syncStatusBar.hide();
      return false;
    }

    if (!scm) {
      scm = vscode.scm.createSourceControl('jj', 'Jujutsu', workspaceFolders![0].uri);

      conflictsGroup = scm.createResourceGroup('conflicts', 'Conflicts');
      conflictsGroup.hideWhenEmpty = true;

      workingGroup = scm.createResourceGroup('working', 'Working copy');
      secondaryGroup = scm.createResourceGroup('secondary', 'Parent');
      secondaryGroup.hideWhenEmpty = false;

      // Status Bar: Active Bookmark
      statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      statusBar.command = 'jj.switchBookmark';

      // Status Bar: Active Remote selector
      remoteStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
      remoteStatusBar.command = 'jj.selectRemote';

      // Status Bar: Remote divergence
      syncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
      syncStatusBar.command = 'jj.sync';

      context.subscriptions.push(scm, conflictsGroup, workingGroup, secondaryGroup, statusBar, remoteStatusBar, syncStatusBar);
    }

    return true;
  }

  async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;

    try {
      const ready = await ensureInitialized();
      if (!ready || !scm || !conflictsGroup || !workingGroup || !secondaryGroup || !statusBar || !remoteStatusBar || !syncStatusBar) {
        return;
      }

      const current = await jj.getChangeInfo('@');
      if (!current) return;

      const firstLineCurrent = current.description.split('\n')[0];
      const workingDesc = firstLineCurrent ? `: ${firstLineCurrent}` : '';
      workingGroup.label = `Working copy${workingDesc}`;

      scm.inputBox.placeholder = `Describe change (${current.changeId}) - press + or run Describe`;

      // 1. Active bookmark component
      const activeBookmark = await jj.getActiveBookmark();
      if (activeBookmark) {
        statusBar.text = `$(bookmark) ${activeBookmark}`;
        statusBar.tooltip = `Active Bookmark: ${activeBookmark}\nCommit: ${current.changeId} (${current.commitId})\n\nClick to switch bookmark`;
        statusBar.show();
      } else {
        statusBar.hide();
      }

      // 2. Active Remote Selector & Divergence
      const remotes = await jj.getRemotes();
      const activeRemote = await getActiveRemote();

      if (remotes.length > 0 && activeRemote) {
        remoteStatusBar.text = `$(cloud) ${activeRemote}`;
        remoteStatusBar.tooltip = `Active Remote: ${activeRemote}\nClick to switch active remote`;
        remoteStatusBar.show();

        const syncStatus = await jj.getSyncStatus(activeRemote);
        if (syncStatus) {
          syncStatusBar.text = `$(sync) ↑${syncStatus.ahead} ↓${syncStatus.behind}`;
          const bLabel = syncStatus.bookmark !== '(none)' ? `on '${syncStatus.bookmark}' ` : '';
          syncStatusBar.tooltip = `${syncStatus.remote}: ${syncStatus.ahead} unpushed commit(s) in current chain, ${syncStatus.behind} incoming from ${bLabel}${syncStatus.remote}\nClick to sync`;
          syncStatusBar.show();
        } else {
          syncStatusBar.hide();
        }
      } else {
        remoteStatusBar.hide();
        syncStatusBar.hide();
      }

      const targetInspectId = selectedCommitId && selectedCommitId !== current.changeId
        ? selectedCommitId
        : '@';
      const targetInspectInfo = targetInspectId === '@' ? current : await jj.getChangeInfo(targetInspectId);

      if (targetInspectInfo && targetInspectInfo.isConflict) {
        const conflictEntries = await jj.getConflictedFiles(targetInspectId);
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
      const workingFiles = await jj.getDiffSummary('@');
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
        const inspectedFiles = await jj.getDiffSummary(targetInspectId);

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

        const parentFiles = await jj.getDiffSummary('@-');
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

  // --- Commands (All prefixed with JJ: for Command Palette) ---

  const selectRemoteCmd = vscode.commands.registerCommand('jj.selectRemote', async () => {
    try {
      const remotes = await jj.getRemotes();
      if (remotes.length === 0) {
        vscode.window.showInformationMessage('No remotes configured in this repository.');
        return;
      }

      const active = await getActiveRemote();
      const picks = remotes.map((r) => ({
        label: r.name === active ? `$(check) ${r.name}` : r.name,
        description: r.url,
        remoteName: r.name,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select active remote for synchronization and graph filtering',
      });

      if (!selected) return;

      await context.workspaceState.update(ACTIVE_REMOTE_KEY, selected.remoteName);
      vscode.window.showInformationMessage(`Active remote set to '${selected.remoteName}'.`);
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const openMultiDiffCmd = vscode.commands.registerCommand(
    'jj.openMultiDiff',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (selectedCommitId || '@');
        const info = await jj.getChangeInfo(rev);
        if (!info) return;

        const parentRev = info.parentIds[0] || `${rev}-`;
        const diffFiles = await jj.getDiffSummary(rev);

        if (diffFiles.length === 0) {
          vscode.window.showInformationMessage(`No file changes in commit ${info.changeId}.`);
          return;
        }

        const resources: [vscode.Uri, vscode.Uri][] = diffFiles.map((file) => {
          const fileUri = vscode.Uri.file(path.join(rootPath, file.path));

          let originalUri = vscode.Uri.from({
            scheme: JJ_DIFF_SCHEME,
            path: file.path,
            query: parentRev,
          });

          let modifiedUri =
            rev === '@'
              ? fileUri
              : vscode.Uri.from({
                  scheme: JJ_DIFF_SCHEME,
                  path: file.path,
                  query: rev,
                });

          if (file.status === 'A') {
            originalUri = originalUri.with({ path: 'empty-file' });
          } else if (file.status === 'D') {
            modifiedUri = originalUri.with({ path: 'empty-file' });
          }

          return [originalUri, modifiedUri];
        });

        const title = `Changes in ${info.changeId}${info.description ? ` (${info.description.split('\n')[0]})` : ''}`;
        await vscode.commands.executeCommand('vscode.changes', title, resources);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open multi-diff editor: ${err.message}`);
      }
    }
  );

  const addRemoteCmd = vscode.commands.registerCommand('jj.addRemote', async () => {
    try {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter remote name',
        placeHolder: 'e.g. origin, upstream',
        validateInput: (v) => (!v || !v.trim() ? 'Name required' : null),
      });
      if (!name) return;

      const url = await vscode.window.showInputBox({
        prompt: `Enter URL for remote '${name.trim()}'`,
        placeHolder: 'git@github.com:user/repo.git or https://...',
        validateInput: (v) => (!v || !v.trim() ? 'URL required' : null),
      });
      if (!url) return;

      await jj.addRemote(name.trim(), url.trim());
      await context.workspaceState.update(ACTIVE_REMOTE_KEY, name.trim());
      vscode.window.showInformationMessage(`Added and activated remote '${name.trim()}'.`);
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const removeRemoteCmd = vscode.commands.registerCommand(
    'jj.removeRemote',
    async (item?: JJRemoteTreeItem) => {
      try {
        let name = item?.remote?.name;
        if (!name) {
          const remotes = await jj.getRemotes();
          if (remotes.length === 0) {
            vscode.window.showInformationMessage('No remotes found.');
            return;
          }
          const pick = await vscode.window.showQuickPick(remotes.map((r) => r.name), {
            placeHolder: 'Select remote to remove',
          });
          if (!pick) return;
          name = pick;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Remove git remote '${name}'?`,
          { modal: true },
          'Remove'
        );
        if (confirm === 'Remove') {
          await jj.removeRemote(name);
          const active = await getActiveRemote();
          if (active === name) {
            await context.workspaceState.update(ACTIVE_REMOTE_KEY, undefined);
          }
          vscode.window.showInformationMessage(`Removed remote '${name}'.`);
          await refresh();
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const openConflictResolverCmd = vscode.commands.registerCommand(
    'jj.openConflictResolver',
    async (fileUri: vscode.Uri, revision: string) => {
      try {
        const filePath = vscode.workspace.asRelativePath(fileUri);
        const fullPath = path.join(rootPath, filePath);

        const fileContent = await fs.readFile(fullPath, 'utf8').catch(() => '');
        const hasTextMarkers = fileContent.includes('<<<<<<<') || fileContent.includes('>>>>>>>');

        const conflicts = await jj.getConflictedFiles(revision);
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
      if (!resource || !resource.relativePath) return;

      try {
        const filePath = resource.relativePath;
        const targetRev = resource.fromRev || '@';
        const fullPath = path.join(rootPath, filePath);

        const text = await fs.readFile(fullPath, 'utf8').catch(() => '');
        const hasTextMarkers = text.includes('<<<<<<<') || text.includes('%%%%%%%') || text.includes('>>>>>>>');

        const conflicts = await jj.getConflictedFiles(targetRev);
        const entry = conflicts.find((c) => c.path === filePath);

        if (entry && entry.isDeletion && !hasTextMarkers) {
          const choice = await vscode.window.showQuickPick(
            [
              { label: '$(check) Keep File', action: 'keep', description: 'Retain the file and its current contents' },
              { label: '$(trash) Delete File', action: 'delete', description: 'Confirm deletion of the file' },
            ],
            { placeHolder: `Resolve deletion conflict for ${path.basename(filePath)}` }
          );

          if (!choice) return;
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
          if (proceed !== 'Mark Resolved') return;
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
      if (!resource || !resource.relativePath) return;
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

  const selectCommitCmd = vscode.commands.registerCommand(
    'jj.selectCommit',
    async (arg?: string | any) => {
      const changeId = typeof arg === 'string' ? arg : undefined;
      selectedCommitId = changeId === selectedCommitId ? undefined : changeId;
      await refresh();
    }
  );

  const newChangeCmd = vscode.commands.registerCommand('jj.new', async () => {
    try {
      if (scm && scm.inputBox.value.trim().length > 0) {
        const desc = scm.inputBox.value.trim();
        await jj.describeChange(desc, '@');
        scm.inputBox.value = '';
        await jj.newChange();
      } else {
        const current = await jj.getChangeInfo('@');
        if (current && current.empty && !current.description) {
          const parent = await jj.getChangeInfo('@-');
          if (parent) {
            await jj.abandonChange('@');
            await jj.newChange(parent.changeId);
          } else {
            await jj.newChange();
          }
        } else {
          await jj.newChange();
        }
      }
      selectedCommitId = undefined;
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const createBookmarkCmd = vscode.commands.registerCommand(
    'jj.createBookmark',
    async (arg?: string | any) => {
      try {
        let rev: string | undefined;
        if (typeof arg === 'string') {
          rev = arg;
        } else if (arg && typeof arg === 'object') {
          rev = arg.fromRev || arg.changeId || arg.revision;
        }
        if (!rev) {
          rev = selectedCommitId || '@';
        }

        const info = await jj.getChangeInfo(rev);
        const promptTarget = info ? `${info.changeId}` : rev;

        const name = await vscode.window.showInputBox({
          prompt: `Create bookmark on ${promptTarget}`,
          placeHolder: 'e.g. main, feature/auth, v0.1',
          validateInput: (val) => {
            if (!val || !val.trim()) return 'Bookmark name cannot be empty';
            if (/\s/.test(val)) return 'Bookmark name cannot contain spaces';
            return null;
          },
        });

        if (!name) return;

        await jj.createBookmark(name.trim(), rev);
        vscode.window.showInformationMessage(`Created bookmark '${name.trim()}' on ${promptTarget}`);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const manageWorkspacesCmd = vscode.commands.registerCommand('jj.manageWorkspaces', async () => {
    try {
      const workspaces = await jj.getWorkspaces();
      if (workspaces.length <= 1) {
        vscode.window.showInformationMessage('Only the default workspace exists.');
        return;
      }

      const picks = workspaces
        .filter((w) => !w.isDefault)
        .map((w) => ({
          label: `$(folder) ${w.name}`,
          description: `Commit: ${w.changeId}`,
          workspace: w,
        }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a workspace to forget / disconnect',
      });

      if (!selected) return;

      const confirm = await vscode.window.showWarningMessage(
        `Forget workspace '${selected.workspace.name}'? (Files on disk will remain untouched)`,
        { modal: true },
        'Forget'
      );

      if (confirm === 'Forget') {
        await jj.forgetWorkspace(selected.workspace.name);
        vscode.window.showInformationMessage(`Workspace '${selected.workspace.name}' forgotten.`);
        await refresh();
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const syncCmd = vscode.commands.registerCommand('jj.sync', async () => {
    const remote = await getActiveRemote();
    if (!remote) {
      vscode.window.showInformationMessage('No active remote configured.');
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetching from ${remote}...` },
        async () => {
          await jj.fetchRemote(remote);
        }
      );

      const status = await jj.getSyncStatus(remote);
      if (status && status.ahead > 0 && status.bookmark !== '(none)') {
        const pushChoice = await vscode.window.showInformationMessage(
          `Fetched remote. You have ${status.ahead} commit(s) ready to push on '${status.bookmark}'.`,
          'Push Bookmark'
        );
        if (pushChoice === 'Push Bookmark') {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Advancing '${status.bookmark}' and pushing to ${remote}...`,
            },
            async () => {
              await jj.advanceAndPushBookmark(status.bookmark, remote);
            }
          );
          vscode.window.showInformationMessage(`Advanced '${status.bookmark}' and pushed to ${remote}.`);
        }
      }
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const fetchCmd = vscode.commands.registerCommand('jj.fetch', async () => {
    const remote = await getActiveRemote();
    if (!remote) return;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetching from ${remote}...` },
        async () => {
          await jj.fetchRemote(remote);
        }
      );
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const describeWorkingCmd = vscode.commands.registerCommand('jj.describeWorking', async () => {
    const info = await jj.getChangeInfo('@');
    if (!info) return;

    const inputBox = vscode.window.createInputBox();
    inputBox.title = `JJ: Describe Working Copy (${info.changeId})`;
    inputBox.value = info.description;
    inputBox.onDidAccept(async () => {
      const text = inputBox.value;
      inputBox.hide();
      await jj.describeChange(text, '@');
      await refresh();
    });
    inputBox.show();
  });

  const describeParentCmd = vscode.commands.registerCommand('jj.describeParent', async () => {
    const info = await jj.getChangeInfo(selectedCommitId || '@-');
    if (!info) return;

    const inputBox = vscode.window.createInputBox();
    inputBox.title = `JJ: Describe Change (${info.changeId})`;
    inputBox.value = info.description;
    inputBox.onDidAccept(async () => {
      const text = inputBox.value;
      inputBox.hide();
      await jj.describeChange(text, info.changeId);
      await refresh();
    });
    inputBox.show();
  });

  const describeCmd = vscode.commands.registerCommand('jj.describe', async () => {
    vscode.commands.executeCommand('jj.describeWorking');
  });

  const squashWorkingGroupCmd = vscode.commands.registerCommand('jj.squashWorking', async () => {
    try {
      await jj.squashAll('@', '@-');
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const squashParentGroupCmd = vscode.commands.registerCommand('jj.squashParent', async () => {
    try {
      const target = selectedCommitId || '@-';
      const targetInfo = await jj.getChangeInfo(target);
      const parent = targetInfo?.parentIds[0] || `${target}-`;
      await jj.squashAll(target, parent);
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const squashFileCmd = vscode.commands.registerCommand(
    'jj.squashFile',
    async (resource: JJResourceState) => {
      if (!resource || !resource.relativePath) return;
      try {
        await jj.moveFile(resource.fromRev, resource.intoRev, resource.relativePath);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const moveFileToWorkingCmd = vscode.commands.registerCommand(
    'jj.moveFileToWorking',
    async (resource: JJResourceState) => {
      if (!resource || !resource.relativePath) return;
      try {
        await jj.moveFile(resource.fromRev, '@', resource.relativePath);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const openFileCmd = vscode.commands.registerCommand(
    'jj.openFile',
    async (resource: JJResourceState) => {
      if (!resource || !resource.relativePath) return;
      try {
        if (resource.fromRev === '@') {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(path.join(rootPath, resource.relativePath))
          );
          await vscode.window.showTextDocument(doc);
        } else {
          const revUri = vscode.Uri.from({
            scheme: JJ_DIFF_SCHEME,
            path: resource.relativePath,
            query: resource.fromRev,
          });
          const doc = await vscode.workspace.openTextDocument(revUri);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
      }
    }
  );

  const revertFileCmd = vscode.commands.registerCommand(
    'jj.revertFile',
    async (resource: JJResourceState) => {
      if (!resource || !resource.relativePath) return;

      const fileName = path.basename(resource.relativePath);
      const isWorkingCopy = resource.fromRev === '@';
      const promptMsg = isWorkingCopy
        ? `Are you sure you want to discard changes in '${fileName}'?`
        : `Revert '${fileName}'? Changes will be placed into your working copy.`;

      const confirm = await vscode.window.showWarningMessage(promptMsg, { modal: true }, 'Revert File');
      if (confirm !== 'Revert File') return;

      try {
        if (isWorkingCopy) {
          await jj.restoreFile('@', '@-', resource.relativePath);
        } else {
          await jj.restoreFile('@', resource.intoRev, resource.relativePath);
        }
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const switchBookmarkCmd = vscode.commands.registerCommand('jj.switchBookmark', async () => {
    try {
      const bookmarks = await jj.getBookmarks();
      if (bookmarks.length === 0) {
        vscode.window.showInformationMessage('No bookmarks found.');
        return;
      }
      const selected = await vscode.window.showQuickPick(bookmarks, {
        placeHolder: 'Select bookmark to switch to (e.g. main, new-bookmark@local, main@origin)',
      });
      if (selected) {
        await jj.switchBookmark(selected);
        selectedCommitId = undefined;
        await refresh();
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const editCmd = vscode.commands.registerCommand('jj.edit', async () => {
    try {
      const targetRev = await vscode.window.showInputBox({
        prompt: 'Enter revision or change ID to edit',
        placeHolder: 'e.g. k, main, new-bookmark@local, @-',
      });
      if (targetRev) {
        await jj.editChange(targetRev.trim());
        selectedCommitId = undefined;
        await refresh();
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const rebaseCmd = vscode.commands.registerCommand('jj.rebase', async () => {
    try {
      const source = await vscode.window.showInputBox({
        prompt: 'Revision to rebase (source)',
        value: selectedCommitId || '@',
      });
      if (!source) return;

      const destination = await vscode.window.showInputBox({
        prompt: `Destination revision for ${source}`,
        placeHolder: 'e.g. main, new-bookmark@local, @-',
      });
      if (!destination) return;

      await jj.rebaseSubtree(source.trim(), destination.trim());
      selectedCommitId = undefined;
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const refreshCmd = vscode.commands.registerCommand('jj.refresh', () => refresh());

  const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const fileFilter = (uri: vscode.Uri) => {
    if (!uri.fsPath.includes('/.jj/')) triggerRefresh();
  };
  workspaceWatcher.onDidChange(fileFilter);
  workspaceWatcher.onDidCreate(fileFilter);
  workspaceWatcher.onDidDelete(fileFilter);

  vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!doc.uri.fsPath.includes('/.jj/')) triggerRefresh(100);
  });

  const jjOpWatcher = vscode.workspace.createFileSystemWatcher('**/.jj/repo/op_heads/*');
  jjOpWatcher.onDidChange(() => triggerRefresh());
  jjOpWatcher.onDidCreate(() => triggerRefresh());
  jjOpWatcher.onDidDelete(() => triggerRefresh());

  context.subscriptions.push(
    refreshCmd,
    selectRemoteCmd,
    openMultiDiffCmd,
    addRemoteCmd,
    removeRemoteCmd,
    openConflictResolverCmd,
    resolveConflictFileCmd,
    squashConflictFileCmd,
    selectCommitCmd,
    createBookmarkCmd,
    manageWorkspacesCmd,
    syncCmd,
    fetchCmd,
    describeWorkingCmd,
    describeParentCmd,
    squashWorkingGroupCmd,
    squashParentGroupCmd,
    squashFileCmd,
    moveFileToWorkingCmd,
    openFileCmd,
    revertFileCmd,
    newChangeCmd,
    describeCmd,
    switchBookmarkCmd,
    editCmd,
    rebaseCmd,
    workspaceWatcher,
    jjOpWatcher
  );

  refresh();
}

export function deactivate() {}