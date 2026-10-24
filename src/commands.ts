import * as vscode from 'vscode';
import * as path from 'path';
import { JJRunner } from './jj';
import { JJResourceState, JJDiffFile, JJRemoteInfo } from './types';
import { JJRemoteTreeItem } from './remotesProvider';

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
        const diffFiles: JJDiffFile[] = await jj.getDiffSummary(rev);

        if (diffFiles.length === 0) {
          vscode.window.showInformationMessage(`No file changes in commit ${info.changeId}.`);
          return;
        }

        const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = diffFiles.map((file) => {
          const fileUri = vscode.Uri.file(path.join(rootPath, file.path));

          let originalUri: vscode.Uri | undefined = vscode.Uri.from({
            scheme: JJ_DIFF_SCHEME,
            path: file.path,
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
      const current = getSelectedCommitId();
      setSelectedCommitId(changeId === current ? undefined : changeId);
      await refresh();
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

  const describeWorkingCmd = vscode.commands.registerCommand('jj.describeWorking', async () => {
    const info = await jj.getChangeInfo('@');
    if (!info) {
      return;
    }

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
    const info = await jj.getChangeInfo(getSelectedCommitId() || '@-');
    if (!info) {
      return;
    }

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
      const target = getSelectedCommitId() || '@-';
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
      if (!resource || !resource.relativePath) {
        return;
      }
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
      if (!resource || !resource.relativePath) {
        return;
      }
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
      if (!resource || !resource.relativePath) {
        return;
      }
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
      if (!resource || !resource.relativePath) {
        return;
      }

      const fileName = path.basename(resource.relativePath);
      const isWorkingCopy = resource.fromRev === '@';
      const promptMsg = isWorkingCopy
        ? `Are you sure you want to discard changes in '${fileName}'?`
        : `Revert '${fileName}'? Changes will be placed into your working copy.`;

      const confirm = await vscode.window.showWarningMessage(promptMsg, { modal: true }, 'Revert File');
      if (confirm !== 'Revert File') {
        return;
      }

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

  const refreshCmd = vscode.commands.registerCommand('jj.refresh', () => refresh());

  return [
    refreshCmd,
    selectRemoteCmd,
    openMultiDiffCmd,
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
