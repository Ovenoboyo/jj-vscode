import * as vscode from 'vscode';
import * as path from 'path';
import { JJRunner } from './jj';
import { JJResourceState, JJDiffFile, JJRemoteInfo } from './types';
import { JJRemoteTreeItem } from './remotesProvider';
import { JJSplitCommitPanel } from './splitPanel';
import { filterFilesWithDiff } from './diffUtils';

export const JJ_DIFF_SCHEME = 'jj-diff';
export const JJ_RESOURCE_SCHEME = 'jj-resource';
export const ACTIVE_REMOTE_KEY = 'jjActiveRemote';

export interface CommandDependencies {
  context: vscode.ExtensionContext;
  jj: JJRunner;
  rootPath: string;
  getScm: () => vscode.SourceControl | undefined;
  getSelectedCommitId: () => string | undefined;
  setSelectedCommitId: (id: string | undefined) => void;
  getActiveRemote: () => Promise<string | undefined>;
  refresh: () => Promise<void>;
}

export function registerGeneralCommands(deps: CommandDependencies): vscode.Disposable[] {
  const {
    context,
    jj,
    rootPath,
    getScm,
    getSelectedCommitId,
    setSelectedCommitId,
    getActiveRemote,
    refresh,
  } = deps;

  const selectRemoteCmd = vscode.commands.registerCommand('jj.selectRemote', async () => {
    try {
      const remotes: JJRemoteInfo[] = await jj.getRemotes();
      if (remotes.length === 0) {
        vscode.window.showInformationMessage('No remotes configured in this repository.');
        return;
      }

      const active = await getActiveRemote();
      const picks: (vscode.QuickPickItem & { remoteName: string })[] = remotes.map((r) => ({
        label: r.name === active ? `$(check) ${r.name}` : r.name,
        description: r.url,
        remoteName: r.name,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select active remote for synchronization and graph filtering',
      });

      if (!selected) {
        return;
      }

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
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        const info = await jj.getChangeInfo(rev);
        if (!info) {
          return;
        }

        const parentRev = info.parentIds[0] || `${rev}-`;
        const rawDiffFiles: JJDiffFile[] = await jj.getDiffSummary(rev);
        const diffFiles = await filterFilesWithDiff(rawDiffFiles, rev, parentRev, rootPath, jj);

        if (diffFiles.length === 0) {
          vscode.window.showInformationMessage(`No file changes in commit ${info.changeId}.`);
          return;
        }

        const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = diffFiles.map((file) => {
          const fileUri = vscode.Uri.file(path.join(rootPath, file.path));

          let originalUri: vscode.Uri | undefined = vscode.Uri.from({
            scheme: JJ_DIFF_SCHEME,
            path: file.oldPath || file.path,
            query: parentRev,
          });

          let modifiedUri: vscode.Uri | undefined =
            rev === '@'
              ? fileUri
              : vscode.Uri.from({
                  scheme: JJ_DIFF_SCHEME,
                  path: file.path,
                  query: rev,
                });

          if (file.status === 'A') {
            originalUri = undefined;
          } else if (file.status === 'D') {
            modifiedUri = undefined;
          }

          return [fileUri, originalUri, modifiedUri];
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
      if (!name) {
        return;
      }

      const url = await vscode.window.showInputBox({
        prompt: `Enter URL for remote '${name.trim()}'`,
        placeHolder: 'git@github.com:user/repo.git or https://...',
        validateInput: (v) => (!v || !v.trim() ? 'URL required' : null),
      });
      if (!url) {
        return;
      }

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
          const remotes: JJRemoteInfo[] = await jj.getRemotes();
          if (remotes.length === 0) {
            vscode.window.showInformationMessage('No remotes found.');
            return;
          }
          const pick = await vscode.window.showQuickPick(remotes.map((r) => r.name), {
            placeHolder: 'Select remote to remove',
          });
          if (!pick) {
            return;
          }
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

  const selectCommitCmd = vscode.commands.registerCommand(
    'jj.selectCommit',
    async (arg?: string | any) => {
      const changeId = typeof arg === 'string' ? arg : undefined;
      if (changeId) {
        setSelectedCommitId(changeId);
        await refresh();
      }
    }
  );

  const newChangeCmd = vscode.commands.registerCommand('jj.new', async () => {
    try {
      const scm = getScm();
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
      setSelectedCommitId(undefined);
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
          rev = getSelectedCommitId() || '@';
        }

        const info = await jj.getChangeInfo(rev);
        const promptTarget = info ? `${info.changeId}` : rev;

        const name = await vscode.window.showInputBox({
          prompt: `Create bookmark on ${promptTarget}`,
          placeHolder: 'e.g. main, feature/auth, v0.1',
          validateInput: (val) => {
            if (!val || !val.trim()) {
              return 'Bookmark name cannot be empty';
            }
            if (/\s/.test(val)) {
              return 'Bookmark name cannot contain spaces';
            }
            return null;
          },
        });

        if (!name) {
          return;
        }

        await jj.createBookmark(name.trim(), rev);
        vscode.window.showInformationMessage(`Created bookmark '${name.trim()}' on ${promptTarget}`);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const syncCmd = vscode.commands.registerCommand('jj.sync', async () => {
    const remote = await getActiveRemote();
    if (!remote) {
      vscode.window.showInformationMessage('No active remote configured.');
      return;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Syncing with ${remote}...` },
        async () => {
          await jj.fetchRemote(remote);
          const status = await jj.getSyncStatus(remote);
          if (status && status.ahead > 0 && status.bookmark !== '(none)') {
            await jj.advanceAndPushBookmark(status.bookmark, remote);
          }
        }
      );
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Sync error: ${err.message}`);
    }
  });

  const fetchCmd = vscode.commands.registerCommand('jj.fetch', async () => {
    const remote = await getActiveRemote();
    if (!remote) {
      return;
    }

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

  const describeCmd = vscode.commands.registerCommand('jj.describe', async (targetRev?: string) => {
    try {
      const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
      const info = await jj.getChangeInfo(rev);
      if (!info) {
        return;
      }

      const inputBox = vscode.window.createInputBox();
      inputBox.title = `JJ: Describe Change (${info.changeId})`;
      inputBox.value = info.description;
      inputBox.prompt = 'Enter description for this change';
      inputBox.onDidAccept(async () => {
        const text = inputBox.value;
        inputBox.hide();
        try {
          await jj.describeChange(text, info.changeId);
          await refresh();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to describe change: ${err.message}`);
        }
      });
      inputBox.show();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to describe change: ${err.message}`);
    }
  });

  const describeWorkingCmd = vscode.commands.registerCommand('jj.describeWorking', async () => {
    await vscode.commands.executeCommand('jj.describe', '@');
  });

  const describeParentCmd = vscode.commands.registerCommand('jj.describeParent', async () => {
    const target = getSelectedCommitId() || '@-';
    await vscode.commands.executeCommand('jj.describe', target);
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
      const target = getSelectedCommitId() || '@-';
      const targetInfo = await jj.getChangeInfo(target);
      const parent = targetInfo?.parentIds[0] || `${target}-`;
      await jj.squashAll(target, parent);
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  function extractPathsAndRevs(
    resource: any,
    extraArgs: any[]
  ): { paths: string[]; fromRev?: string; intoRev?: string; isWorkingGroup?: boolean } {
    const items = [resource, ...extraArgs].filter(Boolean);
    const paths: string[] = [];
    let fromRev: string | undefined;
    let intoRev: string | undefined;
    let isWorkingGroup = false;

    for (const item of items) {
      if (item.relativePath) {
        paths.push(item.relativePath);
        if (item.oldRelativePath) {
          paths.push(item.oldRelativePath);
        }
        if (item.fromRev) {
          fromRev = item.fromRev;
        }
        if (item.intoRev) {
          intoRev = item.intoRev;
        }
      } else {
        let uri: vscode.Uri | undefined;
        if (item instanceof vscode.Uri) {
          uri = item;
        } else if (item.resourceUri instanceof vscode.Uri) {
          uri = item.resourceUri;
        } else if (item.uri instanceof vscode.Uri) {
          uri = item.uri;
        }

        if (uri) {
          const rel = path.relative(rootPath, uri.fsPath);
          if (rel && rel !== '.') {
            paths.push(rel);
          }
        }

        if (item.fromRev) {
          fromRev = item.fromRev;
        }
        if (item.intoRev) {
          intoRev = item.intoRev;
        }
        if (item.resourceGroup?.id === 'working' || item.id === 'working') {
          isWorkingGroup = true;
        }
      }
    }

    return { paths: Array.from(new Set(paths)), fromRev, intoRev, isWorkingGroup };
  }

  const squashFileCmd = vscode.commands.registerCommand(
    'jj.squashFile',
    async (resource: any, ...extraArgs: any[]) => {
      if (!resource) {
        return;
      }
      try {
        const { paths, fromRev, intoRev, isWorkingGroup } = extractPathsAndRevs(resource, extraArgs);
        let srcRev = fromRev;
        let dstRev = intoRev;

        if (!srcRev || !dstRev) {
          if (isWorkingGroup || resource.contextValue === 'jjWorkingFileItem') {
            srcRev = srcRev || '@';
            dstRev = dstRev || '@-';
          } else {
            const target = getSelectedCommitId() || '@-';
            const targetInfo = await jj.getChangeInfo(target);
            srcRev = srcRev || target;
            dstRev = dstRev || targetInfo?.parentIds[0] || `${target}-`;
          }
        }

        if (paths.length > 0) {
          await jj.moveFile(srcRev, dstRev, ...paths);
        } else if (resource.id === 'working') {
          await jj.squashAll('@', '@-');
        } else if (resource.id === 'parent' || resource.id === 'secondary') {
          const target = getSelectedCommitId() || '@-';
          const targetInfo = await jj.getChangeInfo(target);
          const parent = targetInfo?.parentIds[0] || `${target}-`;
          await jj.squashAll(target, parent);
        }
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const moveFileToWorkingCmd = vscode.commands.registerCommand(
    'jj.moveFileToWorking',
    async (resource: any, ...extraArgs: any[]) => {
      if (!resource) {
        return;
      }
      try {
        const { paths, fromRev } = extractPathsAndRevs(resource, extraArgs);
        const target = getSelectedCommitId() || '@-';
        const srcRev = fromRev || target;

        if (paths.length > 0) {
          await jj.moveFile(srcRev, '@', ...paths);
        } else if (resource.id === 'parent' || resource.id === 'secondary') {
          await jj.moveFile(target, '@');
        }
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const moveParentGroupCmd = vscode.commands.registerCommand('jj.moveParentToWorking', async () => {
    try {
      const target = getSelectedCommitId() || '@-';
      await jj.moveFile(target, '@');
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const openFileCmd = vscode.commands.registerCommand(
    'jj.openFile',
    async (resource: any) => {
      if (!resource) {
        return;
      }
      const relPath = resource.relativePath || (resource.resourceUri ? path.relative(rootPath, resource.resourceUri.fsPath) : undefined);
      if (!relPath) {
        return;
      }
      try {
        const fileUri = vscode.Uri.file(path.join(rootPath, relPath));
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
      }
    }
  );

  const revertFileCmd = vscode.commands.registerCommand(
    'jj.revertFile',
    async (resource: any, ...extraArgs: any[]) => {
      if (!resource) {
        return;
      }
      const { paths, fromRev, intoRev, isWorkingGroup } = extractPathsAndRevs(resource, extraArgs);
      if (paths.length === 0) {
        return;
      }

      const isWorkingCopy = fromRev === '@' || isWorkingGroup || resource.contextValue === 'jjWorkingFileItem';
      const displayName = paths.length === 1 ? `'${paths[0]}'` : `${paths.length} items`;
      const promptMsg = isWorkingCopy
        ? `Are you sure you want to discard changes in ${displayName}?`
        : `Revert ${displayName}? Changes will be placed into your working copy.`;

      const confirm = await vscode.window.showWarningMessage(promptMsg, { modal: true }, 'Discard Changes');
      if (confirm !== 'Discard Changes') {
        return;
      }

      try {
        const targetInto = intoRev || '@-';
        if (isWorkingCopy) {
          await jj.restoreFile('@', '@-', ...paths);
        } else {
          await jj.restoreFile('@', targetInto, ...paths);
        }
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
      }
    }
  );

  const switchBookmarkCmd = vscode.commands.registerCommand('jj.switchBookmark', async () => {
    try {
      const activeRemote = await getActiveRemote();
      const bookmarks = await jj.getBookmarks(activeRemote);
      if (bookmarks.length === 0) {
        vscode.window.showInformationMessage('No bookmarks found.');
        return;
      }
      const selected = await vscode.window.showQuickPick(bookmarks, {
        placeHolder: activeRemote
          ? `Select bookmark for remote '${activeRemote}' to switch to (e.g. main, new-bookmark@${activeRemote})`
          : 'Select bookmark to switch to (e.g. main, @-)',
      });
      if (selected) {
        await jj.switchBookmark(selected);
        setSelectedCommitId(undefined);
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
        setSelectedCommitId(undefined);
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
        value: getSelectedCommitId() || '@',
      });
      if (!source) {
        return;
      }

      const destination = await vscode.window.showInputBox({
        prompt: `Destination revision for ${source}`,
        placeHolder: 'e.g. main, new-bookmark@local, @-',
      });
      if (!destination) {
        return;
      }

      await jj.rebaseSubtree(source.trim(), destination.trim());
      setSelectedCommitId(undefined);
      await refresh();
    } catch (err: any) {
      vscode.window.showErrorMessage(err.message);
    }
  });

  const convergeCmd = vscode.commands.registerCommand('jj.converge', async (target?: string) => {
    try {
      const targetRev =
        target ||
        (await vscode.window.showInputBox({
          prompt: 'Enter revision or change ID to converge',
          value: getSelectedCommitId() || '',
          placeHolder: 'e.g. k, change_id(...)',
        }));
      if (targetRev) {
        await jj.converge(targetRev.trim());
        vscode.window.showInformationMessage(`Converged divergent changes for '${targetRev.trim()}'.`);
        await refresh();
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to converge: ${err.message}`);
    }
  });

  const splitCommitCmd = vscode.commands.registerCommand(
    'jj.splitCommit',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        await JJSplitCommitPanel.createOrShow(context.extensionUri, jj, rev, refresh);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open split commit panel: ${err.message}`);
      }
    }
  );

  const squashCommitCmd = vscode.commands.registerCommand(
    'jj.squashCommit',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        const info = await jj.getChangeInfo(rev);
        const parent = info?.parentIds[0] || `${rev}-`;
        await jj.squashAll(rev, parent);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Squash failed: ${err.message}`);
      }
    }
  );

  const squashCommitIntoCmd = vscode.commands.registerCommand(
    'jj.squashCommitInto',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        const activeRemote = await getActiveRemote();
        const graph = await jj.getCommitGraph(activeRemote);
        const candidates = graph.filter((c) => c.changeId !== rev && c.commitId !== rev);

        const picks = candidates.map((c) => ({
          label: c.changeId,
          description: c.description.split('\n')[0] || (c.empty ? '(empty)' : ''),
          detail: c.bookmarks.join(', '),
          targetId: c.changeId,
        }));

        const chosen = await vscode.window.showQuickPick(picks, {
          placeHolder: `Select commit to squash ${rev} into:`,
        });

        if (!chosen) {
          return;
        }

        await jj.squashAll(rev, chosen.targetId);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Squash into failed: ${err.message}`);
      }
    }
  );

  const squashFileIntoCmd = vscode.commands.registerCommand(
    'jj.squashFileInto',
    async (resource: any, ...extraArgs: any[]) => {
      if (!resource) {
        return;
      }
      try {
        const { paths, fromRev, isWorkingGroup } = extractPathsAndRevs(resource, extraArgs);
        const srcRev = fromRev || (isWorkingGroup || resource.contextValue === 'jjWorkingFileItem' ? '@' : (getSelectedCommitId() || '@-'));

        const activeRemote = await getActiveRemote();
        const graph = await jj.getCommitGraph(activeRemote);
        const candidates = graph.filter((c) => c.changeId !== srcRev && c.commitId !== srcRev);

        const picks = candidates.map((c) => ({
          label: c.changeId,
          description: c.description.split('\n')[0] || (c.empty ? '(empty)' : ''),
          detail: c.bookmarks.join(', '),
          targetId: c.changeId,
        }));

        const chosen = await vscode.window.showQuickPick(picks, {
          placeHolder: `Select target commit to squash file(s) into:`,
        });

        if (!chosen) {
          return;
        }

        if (paths.length > 0) {
          await jj.moveFile(srcRev, chosen.targetId, ...paths);
        } else {
          await jj.squashAll(srcRev, chosen.targetId);
        }
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Squash file into failed: ${err.message}`);
      }
    }
  );

  const copyPathCmd = vscode.commands.registerCommand(
    'jj.copyPath',
    async (resource: any, ...extraArgs: any[]) => {
      if (!resource) {
        return;
      }
      try {
        const { paths } = extractPathsAndRevs(resource, extraArgs);
        if (paths.length > 0) {
          const text = paths.join('\n');
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage(`Copied path: ${text}`);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to copy path: ${err.message}`);
      }
    }
  );

  const openDiffCmd = vscode.commands.registerCommand(
    'jj.openDiff',
    async (resource: any) => {
      if (!resource) {
        return;
      }
      if (resource.command && resource.command.command === 'vscode.diff') {
        await vscode.commands.executeCommand('vscode.diff', ...resource.command.arguments);
      } else {
        const rel = resource.relativePath;
        if (rel) {
          const fromRev = resource.fromRev || '@';
          const intoRev = resource.intoRev || '@-';
          const fileUri = vscode.Uri.file(path.join(rootPath, rel));
          const baseUri = vscode.Uri.from({
            scheme: JJ_DIFF_SCHEME,
            path: resource.oldRelativePath || rel,
            query: intoRev,
          });
          const targetUri = fromRev === '@'
            ? fileUri
            : vscode.Uri.from({
                scheme: JJ_DIFF_SCHEME,
                path: rel,
                query: fromRev,
              });
          const fileName = path.basename(rel);
          await vscode.commands.executeCommand('vscode.diff', baseUri, targetUri, `${fileName} (${fromRev} vs ${intoRev})`);
        }
      }
    }
  );

  const rebaseCommitCmd = vscode.commands.registerCommand(
    'jj.rebaseCommit',
    async (sourceRev?: string) => {
      try {
        const src = typeof sourceRev === 'string' ? sourceRev : (getSelectedCommitId() || '@');
        const activeRemote = await getActiveRemote();
        const graph = await jj.getCommitGraph(activeRemote);
        const candidates = graph.filter((c) => c.changeId !== src && c.commitId !== src);

        const picks = candidates.map((c) => ({
          label: c.changeId,
          description: c.description.split('\n')[0] || (c.empty ? '(empty)' : ''),
          detail: c.bookmarks.join(', '),
          targetId: c.changeId,
        }));

        const chosen = await vscode.window.showQuickPick(picks, {
          placeHolder: `Select destination parent(s) for ${src} (multi-select allowed for merge)`,
          canPickMany: true,
        });

        if (!chosen || chosen.length === 0) {
          return;
        }

        const dests = chosen.map((c) => c.targetId);

        const choice = await vscode.window.showQuickPick(
          [
            {
              label: 'This commit and its descendants (-s)',
              description: `Rebase subtree starting at ${src}`,
              subtree: true,
            },
            {
              label: 'Only this commit (-r)',
              description: `Rebase ${src} without its descendants`,
              subtree: false,
            },
          ],
          { placeHolder: `Rebase type for ${src} onto ${dests.join(', ')}?` }
        );

        if (!choice) {
          return;
        }

        await jj.rebaseCommit(src, dests, choice.subtree);
        vscode.window.showInformationMessage(`Rebased ${src} onto ${dests.join(', ')}`);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Rebase failed: ${err.message}`);
      }
    }
  );

  const moveBookmarkHereCmd = vscode.commands.registerCommand(
    'jj.moveBookmarkHere',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        const activeRemote = await getActiveRemote();
        const bookmarks = await jj.getBookmarks(activeRemote);
        if (bookmarks.length === 0) {
          vscode.window.showInformationMessage('No bookmarks found to move.');
          return;
        }

        const selected = await vscode.window.showQuickPick(bookmarks, {
          placeHolder: `Select bookmark to move to ${rev}:`,
        });

        if (!selected) {
          return;
        }

        const cleanName = selected.includes('@') ? selected.split('@')[0] : selected;
        await jj.moveBookmark(cleanName, rev);
        vscode.window.showInformationMessage(`Moved bookmark '${cleanName}' to ${rev}.`);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to move bookmark: ${err.message}`);
      }
    }
  );

  const fixReachableCmd = vscode.commands.registerCommand(
    'jj.fixReachable',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Running jj fix on reachable commits from ${rev}...` },
          async () => {
            await jj.fixReachable(rev);
          }
        );
        vscode.window.showInformationMessage(`Fixed reachable commits from ${rev}.`);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Fix failed: ${err.message}`);
      }
    }
  );

  const newChildCmd = vscode.commands.registerCommand(
    'jj.newChild',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        await jj.newChange(rev);
        setSelectedCommitId(undefined);
        await refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create new child commit: ${err.message}`);
      }
    }
  );

  const viewDiffToBaseCmd = vscode.commands.registerCommand(
    'jj.viewDiffToBase',
    async (targetRev?: string) => {
      try {
        const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
        const baseRev = await jj.getBaseRevision(rev);
        const rawDiffFiles: JJDiffFile[] = await jj.getDiffSummary(rev);
        const diffFiles = await filterFilesWithDiff(rawDiffFiles, rev, baseRev, rootPath, jj);

        if (diffFiles.length === 0) {
          vscode.window.showInformationMessage(`No changes between base ${baseRev} and ${rev}.`);
          return;
        }

        const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = diffFiles.map((file) => {
          const fileUri = vscode.Uri.file(path.join(rootPath, file.path));

          let originalUri: vscode.Uri | undefined = vscode.Uri.from({
            scheme: JJ_DIFF_SCHEME,
            path: file.oldPath || file.path,
            query: baseRev,
          });

          let modifiedUri: vscode.Uri | undefined =
            rev === '@'
              ? fileUri
              : vscode.Uri.from({
                  scheme: JJ_DIFF_SCHEME,
                  path: file.path,
                  query: rev,
                });

          if (file.status === 'A') {
            originalUri = undefined;
          } else if (file.status === 'D') {
            modifiedUri = undefined;
          }

          return [fileUri, originalUri, modifiedUri];
        });

        const title = `Diff ${baseRev} ➔ ${rev}`;
        await vscode.commands.executeCommand('vscode.changes', title, resources);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to view diff to base: ${err.message}`);
      }
    }
  );

  const copyChangeIdCmd = vscode.commands.registerCommand(
    'jj.copyChangeId',
    async (targetRev?: string) => {
      const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
      const info = await jj.getChangeInfo(rev);
      const changeId = info?.changeId || rev;
      await vscode.env.clipboard.writeText(changeId);
      vscode.window.showInformationMessage(`Copied Change ID: ${changeId}`);
    }
  );

  const copyCommitHashCmd = vscode.commands.registerCommand(
    'jj.copyCommitHash',
    async (targetRev?: string) => {
      const rev = typeof targetRev === 'string' ? targetRev : (getSelectedCommitId() || '@');
      const fullHash = await jj.getFullCommitId(rev);
      if (fullHash) {
        await vscode.env.clipboard.writeText(fullHash);
        vscode.window.showInformationMessage(`Copied Git Commit Hash: ${fullHash}`);
      } else {
        vscode.window.showErrorMessage(`Could not resolve git commit hash for ${rev}`);
      }
    }
  );

  const refreshCmd = vscode.commands.registerCommand('jj.refresh', () => refresh());

  return [
    refreshCmd,
    selectRemoteCmd,
    openMultiDiffCmd,
    splitCommitCmd,
    squashCommitCmd,
    squashCommitIntoCmd,
    squashFileIntoCmd,
    copyPathCmd,
    openDiffCmd,
    rebaseCommitCmd,
    moveBookmarkHereCmd,
    fixReachableCmd,
    newChildCmd,
    viewDiffToBaseCmd,
    copyChangeIdCmd,
    copyCommitHashCmd,
    addRemoteCmd,
    removeRemoteCmd,
    selectCommitCmd,
    newChangeCmd,
    createBookmarkCmd,
    syncCmd,
    fetchCmd,
    describeWorkingCmd,
    describeParentCmd,
    describeCmd,
    squashWorkingGroupCmd,
    squashParentGroupCmd,
    moveParentGroupCmd,
    squashFileCmd,
    moveFileToWorkingCmd,
    openFileCmd,
    revertFileCmd,
    switchBookmarkCmd,
    editCmd,
    rebaseCmd,
    convergeCmd,
  ];
}
