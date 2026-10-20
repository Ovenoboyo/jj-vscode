import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

export interface JJChangeInfo {
  changeId: string;
  shortestLen: number;
  commitId: string;
  description: string;
  bookmarks: string[];
  remoteBookmarks: string[];
  isConflict: boolean;
  workingCopies: string[];
  parentIds: string[];
  empty: boolean;
}

export interface JJDiffFile {
  status: 'M' | 'A' | 'D' | 'R' | string;
  path: string;
}

export interface RemoteSyncStatus {
  ahead: number;
  behind: number;
  bookmark: string;
  remote: string;
}

export interface JJWorkspace {
  name: string;
  changeId: string;
  commitId: string;
  isDefault: boolean;
}

export interface JJConflictEntry {
  path: string;
  details: string;
  isDeletion: boolean;
}

export interface JJRemoteInfo {
  name: string;
  url: string;
}

export class JJRunner {
  constructor(private readonly workspaceRoot: string) {}

  public async run(args: string[]): Promise<string> {
    const env = { ...process.env };
    const cargoBin = path.join(os.homedir(), '.cargo', 'bin');

    if (env.PATH && !env.PATH.includes(cargoBin)) {
      env.PATH = `${cargoBin}:${env.PATH}`;
    }

    if (!env.SSH_AUTH_SOCK) {
      if (process.platform === 'darwin') {
        env.SSH_AUTH_SOCK = path.join(
          os.homedir(),
          'Library/Group Containers/243LU875E5.groups.com.apple.launchd/ssh-agent'
        );
      } else if (process.platform === 'linux') {
        const uid = process.getuid ? process.getuid() : 1000;
        env.SSH_AUTH_SOCK = `/run/user/${uid}/keyring/ssh` || `/run/user/${uid}/ssh-agent.socket`;
      }
    }

    env.EDITOR = 'true';
    env.JJ_EDITOR = 'true';
    env.VISUAL = 'true';
    env.GIT_TERMINAL_PROMPT = '0';

    try {
      const { stdout } = await execFileAsync('jj', ['--color=never', ...args], {
        cwd: this.workspaceRoot,
        env,
      });
      return stdout.trim();
    } catch (err: any) {
      const errorMsg = err.stderr ? err.stderr.trim() : err.message;
      throw new Error(`jj command failed [jj ${args.join(' ')}]: ${errorMsg}`);
    }
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.run(['root']);
      return true;
    } catch {
      return false;
    }
  }

  async getChangeInfo(rev: string): Promise<JJChangeInfo | null> {
    try {
      const isRoot = await this.run(['log', '--ignore-working-copy', '-r', rev, '--no-graph', '-T', 'root']);
      if (isRoot === 'true') {
        return null;
      }

      const template = `change_id.shortest() ++ "\\0" ++ change_id.short(4) ++ "\\0" ++ commit_id.short() ++ "\\0" ++ description ++ "\\0" ++ bookmarks ++ "\\0" ++ remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(" ") ++ "\\0" ++ conflict ++ "\\0" ++ working_copies.map(|w| w.name()).join(",") ++ "\\0" ++ parents.map(|p| p.change_id().short(4)).join(",") ++ "\\0" ++ empty`;
      const output = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        rev,
        '--no-graph',
        '-T',
        template,
      ]);

      if (!output) return null;

      const [shortestPrefix, rawShortId, commitId, description, bookmarkStr, remoteBookmarkStr, conflictStr, wcStr, parentStr, emptyStr] = output.split('\0');
      const rawBookmarks = bookmarkStr ? bookmarkStr.trim().split(' ').filter(Boolean) : [];
      const remoteBookmarks = remoteBookmarkStr ? remoteBookmarkStr.trim().split(' ').filter(Boolean) : [];

      // Extract base names from remote tracking bookmarks (e.g. "main" from "main@git" or "main@local")
      const remoteBaseNames = new Set(remoteBookmarks.map((rb) => rb.split('@')[0]));

      // Hide the local bookmark badge if a remote counterpart already exists on this commit
      const bookmarks = rawBookmarks.filter((b) => !remoteBaseNames.has(b));

      const workingCopies = wcStr
        ? wcStr
            .trim()
            .split(',')
            .map((w) => w.trim().replace(/@$/, ''))
            .filter((w) => Boolean(w) && w !== 'default')
        : [];
      const parentIds = parentStr ? parentStr.trim().split(',').filter(Boolean) : [];

      return {
        changeId: (rawShortId ?? '').slice(0, 4),
        shortestLen: Math.min(shortestPrefix ? shortestPrefix.length : 1, 4),
        commitId: commitId ?? '',
        description: description ? description.trim() : '',
        bookmarks,
        remoteBookmarks,
        isConflict: conflictStr === 'true',
        workingCopies,
        parentIds,
        empty: emptyStr === 'true',
      };
    } catch {
      return null;
    }
  }

  async getDiffSummary(rev: string = '@'): Promise<JJDiffFile[]> {
    try {
      const output = await this.run(['diff', '-r', rev, '--summary']);
      if (!output) return [];

      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const status = line.slice(0, 1);
          const filePath = line.slice(1).trim();
          return { status, path: filePath };
        });
    } catch {
      return [];
    }
  }

  async showFile(filePath: string, rev: string): Promise<string> {
    try {
      return await this.run(['file', 'show', filePath, '-r', rev]);
    } catch {
      return '';
    }
  }

  async squashAll(fromRev: string, intoRev: string): Promise<void> {
    await this.run(['squash', '-u', '--from', fromRev, '--into', intoRev]);
  }

  async moveFile(fromRev: string, intoRev: string, filePath: string): Promise<void> {
    await this.run(['squash', '-u', '--from', fromRev, '--into', intoRev, filePath]);
  }

  async restoreFile(toRev: string, fromRev: string, filePath: string): Promise<void> {
    await this.run(['restore', '--to', toRev, '--from', fromRev, filePath]);
  }

  async getBookmarks(): Promise<string[]> {
    const raw = await this.run(['bookmark', 'list', '--all-remotes', '--template', 'if(remote, name ++ "@" ++ remote, name) ++ "\\n"']);
    return raw
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
  }

  async getActiveBookmark(): Promise<string | null> {
    try {
      const raw = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        'heads(::@ & (bookmarks() | remote_bookmarks()))',
        '--no-graph',
        '-T',
        'bookmarks.map(|b| b.name()).join(" ") ++ " " ++ remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(" ") ++ "\\n"',
      ]);

      const candidates = raw.split(/\s+/).filter(Boolean);
      return candidates.length > 0 ? candidates[0] : null;
    } catch {
      return null;
    }
  }

  async createBookmark(name: string, revision: string = '@'): Promise<void> {
    await this.run(['bookmark', 'create', name, '-r', revision]);
  }

  async setBookmark(name: string, revision: string = '@'): Promise<void> {
    await this.run(['bookmark', 'set', name, '-r', revision]);
  }

  async advanceAndPushBookmark(bookmark: string, remote: string): Promise<string> {
    const current = await this.getChangeInfo('@');
    const cleanBookmark = bookmark.includes('@') ? bookmark.split('@')[0] : bookmark;
    const targetRev = current && current.empty && !current.description ? '@-' : '@';

    await this.setBookmark(cleanBookmark, targetRev);
    return await this.run(['git', 'push', '--remote', remote, '--bookmark', cleanBookmark]);
  }

  async getRemotes(): Promise<JJRemoteInfo[]> {
    try {
      const raw = await this.run(['git', 'remote', 'list']);
      return raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const parts = l.split(/\s+/);
          return {
            name: parts[0] || '',
            url: parts[1] || '',
          };
        });
    } catch {
      return [];
    }
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.run(['git', 'remote', 'add', name, url]);
  }

  async removeRemote(name: string): Promise<void> {
    await this.run(['git', 'remote', 'remove', name]);
  }

  async fetchRemote(remote: string): Promise<void> {
    await this.run(['git', 'fetch', '--remote', remote]);
  }

  async pushBookmark(bookmark: string, remote: string): Promise<void> {
    const cleanBookmark = bookmark.includes('@') ? bookmark.split('@')[0] : bookmark;
    await this.run(['git', 'push', '--remote', remote, '--bookmark', cleanBookmark]);
  }

  async getSyncStatus(targetRemote?: string): Promise<RemoteSyncStatus | null> {
    try {
      const remotes = await this.getRemotes();
      if (remotes.length === 0) return null;

      const remoteNames = remotes.map((r) => r.name);
      let remote = targetRemote && remoteNames.includes(targetRemote) ? targetRemote : '';
      if (!remote) {
        remote = remoteNames.includes('origin') ? 'origin' : remoteNames[0];
      }

      const rawActive = (await this.getActiveBookmark()) || '';
      const activeBookmark = rawActive.includes('@') ? rawActive.split('@')[0] : rawActive;

      const aheadStr = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        `((remote_bookmarks(remote=${remote})..@) ~ (empty() & description(exact:""))) ~ root()`,
        '--no-graph',
        '-T',
        'commit_id ++ "\\n"',
      ]).catch(async () => {
        return await this.run([
          'log',
          '--ignore-working-copy',
          '-r',
          `((::@) ~ (empty() & description(exact:""))) ~ root()`,
          '--no-graph',
          '-T',
          'commit_id ++ "\\n"',
        ]).catch(() => '');
      });
      const ahead = aheadStr.split('\n').filter(Boolean).length;

      let behind = 0;
      if (activeBookmark) {
        const remoteRef = `${activeBookmark}@${remote}`;
        const behindStr = await this.run([
          'log',
          '--ignore-working-copy',
          '-r',
          `(present(${remoteRef}) ~ ::@) ~ root()`,
          '--no-graph',
          '-T',
          'commit_id ++ "\\n"',
        ]).catch(() => '');
        behind = behindStr.split('\n').filter(Boolean).length;
      }

      return {
        ahead,
        behind,
        bookmark: activeBookmark || '(none)',
        remote,
      };
    } catch {
      return null;
    }
  }

  async getCommitGraph(targetRemote?: string): Promise<JJChangeInfo[]> {
    const revset = targetRemote
      ? `((remote_bookmarks(remote=${targetRemote})..all()) | @ | (visible_heads() & (bookmarks() | remote_bookmarks(remote=${targetRemote}))) | heads(::(remote_bookmarks(remote=${targetRemote})..all()) & remote_bookmarks(remote=${targetRemote}))) ~ root()`
      : `((remote_bookmarks()..all()) | @ | (visible_heads() & (bookmarks() | remote_bookmarks())) | heads(::(remote_bookmarks()..all()) & remote_bookmarks())) ~ root()`;

    const fallbackRevset = '(::(visible_heads() | @) | (@::)) ~ root()';

    const template = `change_id.shortest() ++ "\\0" ++ change_id.short(4) ++ "\\0" ++ commit_id.short() ++ "\\0" ++ description.first_line() ++ "\\0" ++ bookmarks ++ "\\0" ++ remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(" ") ++ "\\0" ++ conflict ++ "\\0" ++ working_copies.map(|w| w.name()).join(",") ++ "\\0" ++ parents.map(|p| p.change_id().short(4)).join(",") ++ "\\0" ++ empty ++ "\\n"`;

    try {
      let output = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        revset,
        '--no-graph',
        '-T',
        template,
      ]).catch(() => '');

      if (!output || output.trim().length === 0) {
        output = await this.run([
          'log',
          '--ignore-working-copy',
          '-r',
          fallbackRevset,
          '--no-graph',
          '-T',
          template,
        ]).catch(() => '');
      }

      if (!output) return [];

      return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [shortestPrefix, rawShortId, commitId, description, bookmarkStr, remoteBookmarkStr, conflictStr, wcStr, parentStr, emptyStr] = line.split('\0');
          const rawBookmarks = bookmarkStr ? bookmarkStr.trim().split(' ').filter(Boolean) : [];
          const remoteBookmarks = remoteBookmarkStr ? remoteBookmarkStr.trim().split(' ').filter(Boolean) : [];

          // Extract base names from remote tracking bookmarks (e.g. "main" from "main@git" or "main@local")
          const remoteBaseNames = new Set(remoteBookmarks.map((rb) => rb.split('@')[0]));

          // Suppress local bookmark badge if a remote counterpart is present on this commit
          const bookmarks = rawBookmarks.filter((b) => !remoteBaseNames.has(b));

          const workingCopies = wcStr
            ? wcStr
                .trim()
                .split(',')
                .map((w) => w.trim().replace(/@$/, ''))
                .filter((w) => Boolean(w) && w !== 'default')
            : [];
          const parentIds = parentStr ? parentStr.trim().split(',').filter(Boolean) : [];

          return {
            changeId: (rawShortId ?? '').slice(0, 4),
            shortestLen: Math.min(shortestPrefix ? shortestPrefix.length : 1, 4),
            commitId: commitId ?? '',
            description: description || '',
            bookmarks,
            remoteBookmarks,
            isConflict: conflictStr === 'true',
            workingCopies,
            parentIds,
            empty: emptyStr === 'true',
          };
        });
    } catch {
      return [];
    }
  }

  async rebaseExact(sourceRev: string, destinationRev: string): Promise<void> {
    await this.run(['rebase', '-r', sourceRev, '-d', destinationRev]);
  }

  async rebaseSubtree(sourceRev: string, destinationRev: string): Promise<void> {
    await this.run(['rebase', '-s', sourceRev, '-d', destinationRev]);
  }

  async newChange(targetRev?: string): Promise<void> {
    const args = ['new'];
    if (targetRev) args.push(targetRev);
    await this.run(args);
  }

  async abandonChange(revision: string): Promise<void> {
    await this.run(['abandon', revision]);
  }

  async describeChange(message: string, revision: string = '@'): Promise<void> {
    await this.run(['describe', '-r', revision, '-m', message]);
  }

  async editChange(revision: string): Promise<void> {
    await this.run(['edit', revision]);
  }

  async switchBookmark(bookmarkName: string): Promise<void> {
    await this.run(['new', bookmarkName]);
  }

  async getWorkspaces(): Promise<JJWorkspace[]> {
    try {
      const raw = await this.run(['workspace', 'list']);
      if (!raw) return [];

      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const colonIndex = line.indexOf(':');
          const name = line.slice(0, colonIndex).trim();
          const rest = line.slice(colonIndex + 1).trim().split(' ');
          const changeId = (rest[0] ?? '').slice(0, 4);
          const commitId = rest[1] ?? '';
          return {
            name,
            changeId,
            commitId,
            isDefault: name === 'default',
          };
        });
    } catch {
      return [];
    }
  }

  async forgetWorkspace(name: string): Promise<void> {
    await this.run(['workspace', 'forget', name]);
  }

  async getConflictedFiles(revision: string = '@'): Promise<JJConflictEntry[]> {
    try {
      const raw = await this.run(['resolve', '--list', '-r', revision]);
      if (!raw) return [];

      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s{2,}|\t/);
          const filePath = parts[0]?.trim() || '';
          const details = parts.slice(1).join(' ').trim();
          const isFileLevelDeletion = /including \d+ deletion/i.test(details) || /deleted on/i.test(details);

          return {
            path: filePath,
            details,
            isDeletion: isFileLevelDeletion,
          };
        })
        .filter((entry) => entry.path.length > 0);
    } catch {
      return [];
    }
  }

  async runNativeMerge(filePath: string): Promise<void> {
    await this.run([
      'resolve',
      filePath,
      '--config',
      'merge-tools.vscode.program="code"',
      '--config',
      'merge-tools.vscode.merge-args=["--wait", "--merge", "$left", "$right", "$base", "$output"]',
      '--tool',
      'vscode',
    ]);
    await this.run(['status']);
  }

  async resolveConflict(filePath: string, revision: string = '@', action: 'keep' | 'delete' | 'content'): Promise<void> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);

    if (action === 'delete') {
      await fs.unlink(absolutePath).catch(() => {});
      await this.run(['status']);
      if (revision !== '@') {
        await this.run(['squash', '-u', '--from', '@', '--into', revision, filePath]).catch(() => {});
      }
    } else if (action === 'keep') {
      const current = await this.getChangeInfo(revision);
      const parentRev = current?.parentIds[0] || `${revision}-`;

      let restored = false;
      try {
        await this.run(['restore', '--to', revision, '--from', parentRev, filePath]);
        restored = true;
      } catch {
        try {
          await this.run(['restore', '--to', revision, '--from', `${parentRev}-`, filePath]);
          restored = true;
        } catch {
          try {
            const content = await fs.readFile(absolutePath);
            await fs.writeFile(absolutePath, content);
          } catch {}
        }
      }

      if (!restored) {
        await this.run(['status']);
        if (revision !== '@') {
          await this.run(['squash', '-u', '--from', '@', '--into', revision, filePath]).catch(() => {});
        }
      }
    } else {
      await this.run(['status']);
      if (revision !== '@') {
        await this.run(['squash', '-u', '--from', '@', '--into', revision, filePath]);
      }
    }

    await this.run(['status']);
  }
}