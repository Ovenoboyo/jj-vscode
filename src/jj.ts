import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

export * from './types';
import {
  JJChangeInfo,
  JJDiffFile,
  RemoteSyncStatus,
  JJWorkspace,
  JJConflictEntry,
  JJRemoteInfo,
} from './types';

export class JJRunner {
  constructor(private readonly workspaceRoot: string) {}

  public async run(args: string[], input?: string): Promise<string> {
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

    return new Promise((resolve, reject) => {
      const child = execFile('jj', ['--color=never', ...args], {
        cwd: this.workspaceRoot,
        env,
      }, (err: any, stdout: string, stderr: string) => {
        if (err) {
          const errorMsg = stderr ? stderr.trim() : err.message;
          reject(new Error(`jj command failed [jj ${args.join(' ')}]:${errorMsg}`));
        } else {
          resolve(stdout.trim());
        }
      });

      if (input && child.stdin) {
        child.stdin.write(input);
        child.stdin.end();
      }
    });
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

      const template = `change_id.shortest() ++ "\\0" ++ change_id.short(4) ++ if(divergent, "/" ++ change_offset) ++ "\\0" ++ commit_id.short() ++ "\\0" ++ description ++ "\\0" ++ bookmarks ++ "\\0" ++ remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(" ") ++ "\\0" ++ conflict ++ "\\0" ++ working_copies.map(|w| w.name()).join(",") ++ "\\0" ++ parents.map(|p| p.commit_id().short()).join(",") ++ "\\0" ++ empty ++ "\\0" ++ divergent`;
      const output = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        rev,
        '--no-graph',
        '-T',
        template,
      ]);

      if (!output) {return null;}

      const [shortestPrefix, rawShortId, commitId, description, bookmarkStr, remoteBookmarkStr, conflictStr, wcStr, parentStr, emptyStr, divergentStr] = output.split('\0');
      const rawBookmarks = bookmarkStr ? bookmarkStr.trim().split(' ').filter(Boolean) : [];
      const rawRemoteBookmarks = remoteBookmarkStr ? remoteBookmarkStr.trim().split(' ').filter(Boolean) : [];

      const localBookmarks = rawBookmarks.filter((b) => !b.includes('@'));
      const localBaseNames = new Set(localBookmarks.map((b) => b.replace(/[*?]$/, '')));

      const remoteBookmarkSet = new Set<string>();
      rawBookmarks.filter((b) => b.includes('@')).forEach((rb) => remoteBookmarkSet.add(rb));
      rawRemoteBookmarks.forEach((rb) => {
        const baseName = rb.split('@')[0];
        if (!localBaseNames.has(baseName)) {
          remoteBookmarkSet.add(rb);
        }
      });

      const bookmarks = localBookmarks;
      const remoteBookmarks = Array.from(remoteBookmarkSet);

      const workingCopies = wcStr
        ? wcStr
            .trim()
            .split(',')
            .map((w) => w.trim().replace(/@$/, ''))
            .filter((w) => Boolean(w) && w !== 'default')
        : [];
      const parentIds = parentStr ? parentStr.trim().split(',').filter(Boolean) : [];

      return {
        changeId: rawShortId ?? '',
        shortestLen: Math.min(shortestPrefix ? shortestPrefix.length : 1, (rawShortId ?? '').length),
        commitId: commitId ?? '',
        description: description ? description.trim() : '',
        bookmarks,
        remoteBookmarks,
        isConflict: conflictStr === 'true',
        isDivergent: divergentStr === 'true',
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
      if (!output) {return [];}

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

  async getBookmarks(targetRemote?: string): Promise<string[]> {
    const raw = await this.run([
      'bookmark',
      'list',
      '--all-remotes',
      '--template',
      'if(present, name ++ "\\t" ++ if(remote, remote, "") ++ "\\n")',
    ]);

    const items = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, remote] = l.split('\t');
        return { name: name?.trim() || '', remote: remote?.trim() || '' };
      })
      .filter((item) => item.name.length > 0);

    const byName = new Map<string, Set<string>>();
    for (const item of items) {
      if (!byName.has(item.name)) {
        byName.set(item.name, new Set());
      }
      if (item.remote) {
        byName.get(item.name)!.add(item.remote);
      }
    }

    const result: string[] = [];
    for (const [name, remotes] of byName.entries()) {
      if (targetRemote) {
        const hasLocal = items.some((i) => i.name === name && !i.remote);
        const hasTargetRemote = remotes.has(targetRemote);
        if (hasTargetRemote || hasLocal) {
          result.push(`${name}@${targetRemote}`);
        } else if (remotes.size > 0) {
          result.push(`${name}@${Array.from(remotes)[0]}`);
        }
      } else {
        if (remotes.size > 0) {
          const preferred = remotes.has('origin') ? 'origin' : Array.from(remotes)[0];
          result.push(`${name}@${preferred}`);
        } else {
          result.push(name);
        }
      }
    }
    return result.sort();
  }

  async getActiveBookmark(targetRemote?: string): Promise<string | null> {
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
      if (targetRemote) {
        const matching = candidates.find((b) => b.endsWith(`@${targetRemote}`));
        if (matching) {
          return matching;
        }
        const local = candidates.find((b) => !b.includes('@'));
        if (local) {
          return `${local}@${targetRemote}`;
        }
      }

      const filtered = candidates.filter((b) => {
        if (!b.includes('@')) {
          return true;
        }
        if (!targetRemote) {
          return true;
        }
        return b.endsWith(`@${targetRemote}`);
      });
      return filtered.length > 0 ? filtered[0] : null;
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

  async deleteBookmark(name: string): Promise<void> {
    await this.run(['bookmark', 'delete', name]);
  }

  async advanceAndPushBookmark(bookmark: string, remote: string): Promise<string> {
    const current = await this.getChangeInfo('@');
    const cleanBookmark = bookmark.includes('@') ? bookmark.split('@')[0] : bookmark;
    const targetRev = current && current.empty && !current.description ? '@-' : '@';

    await this.setBookmark(cleanBookmark, targetRev);
    return await this.run(['git', 'push', '--remote', remote, '--bookmark', cleanBookmark]);
  }

  async pushRevision(revision: string, remote: string): Promise<string> {
    const info = await this.getChangeInfo(revision);
    let bookmarkToPush = info?.bookmarks[0];

    if (!bookmarkToPush) {
      const active = await this.getActiveBookmark(remote);
      if (active) {
        bookmarkToPush = active.includes('@') ? active.split('@')[0] : active;
        await this.setBookmark(bookmarkToPush, revision);
      }
    }

    if (bookmarkToPush) {
      return await this.run(['git', 'push', '--remote', remote, '--bookmark', bookmarkToPush]);
    } else {
      return await this.run(['git', 'push', '--remote', remote, '-r', revision]);
    }
  }

  async converge(revision?: string): Promise<string> {
    const cleanRev = revision?.includes('/') ? revision.split('/')[0] : revision;
    const revset = cleanRev ? `change_id(${cleanRev})` : 'divergent()';
    return await this.run(['converge', '-r', revset], 'n\n');
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
      if (remotes.length === 0) {return null;}

      const remoteNames = remotes.map((r) => r.name);
      let remote = targetRemote && remoteNames.includes(targetRemote) ? targetRemote : '';
      if (!remote) {
        remote = remoteNames.includes('origin') ? 'origin' : remoteNames[0];
      }

      const rawActive = (await this.getActiveBookmark(remote)) || '';
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
    const remotes = await this.getRemotes();
    let remote = targetRemote && remotes.some((r) => r.name === targetRemote) ? targetRemote : '';
    if (!remote && remotes.length > 0) {
      remote = remotes.some((r) => r.name === 'origin') ? 'origin' : remotes[0].name;
    }

    const remoteRefExpr = remote ? `remote_bookmarks(remote=${remote})` : `remote_bookmarks()`;
    let hasRemoteBookmarks = false;
    if (remote) {
      const checkRemote = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        remoteRefExpr,
        '--no-graph',
        '-T',
        'commit_id',
      ]).catch(() => '');
      hasRemoteBookmarks = checkRemote.trim().length > 0;
    }

    let revset = hasRemoteBookmarks
      ? `(((${remoteRefExpr}::(visible_heads() | @ | divergent())) | (visible_heads() | @ | bookmarks() | divergent() | ${remoteRefExpr})) ~ (::(${remoteRefExpr}) ~ (${remoteRefExpr}))) ~ root()`
      : `(root()::(visible_heads() | @ | bookmarks() | divergent())) ~ root()`;
    let fallbackRevset = `(::(visible_heads() | @ | divergent())) ~ root()`;

    try {
      const otherHeadsRaw = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        'heads((visible_heads() | bookmarks() | remote_bookmarks()) ~ (::@ | @::))',
        '--no-graph',
        '-T',
        'commit_id ++ "\\n"',
      ]).catch(() => '');

      const otherHeads = otherHeadsRaw.trim().split('\n').filter(Boolean);
      if (otherHeads.length > 0) {
        const excludedHeads: string[] = [];
        await Promise.all(
          otherHeads.map(async (headId) => {
            const countRaw = await this.run([
              'log',
              '--ignore-working-copy',
              '-r',
              `::((visible_heads() | @) & (::@ | @::)) ~ ::${headId}`,
              '--no-graph',
              '-T',
              'change_id.short() ++ "\\n"',
            ]).catch(() => '');
            const aheadCount = countRaw.trim().split('\n').filter(Boolean).length;
            if (aheadCount > 10) {
              excludedHeads.push(headId);
            }
          })
        );

        if (excludedHeads.length > 0) {
          const excludeExpr = excludedHeads.map((h) => `(::${h} ~ ::@)`).join(' | ');
          revset = `(${revset}) ~ (${excludeExpr})`;
          fallbackRevset = `(${fallbackRevset}) ~ (${excludeExpr})`;
        }
      }
    } catch {
      // Ignore errors and keep default revset
    }

    const template = `change_id.shortest() ++ "\\0" ++ change_id.short(4) ++ if(divergent, "/" ++ change_offset) ++ "\\0" ++ commit_id.short() ++ "\\0" ++ description.first_line() ++ "\\0" ++ bookmarks ++ "\\0" ++ remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(" ") ++ "\\0" ++ conflict ++ "\\0" ++ working_copies.map(|w| w.name()).join(",") ++ "\\0" ++ parents.map(|p| p.commit_id().short()).join(",") ++ "\\0" ++ empty ++ "\\0" ++ divergent ++ "\\n"`;

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

      if (!output) {return [];}

      const rawItems = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [shortestPrefix, rawShortId, commitId, description, bookmarkStr, remoteBookmarkStr, conflictStr, wcStr, parentStr, emptyStr, divergentStr] = line.split('\0');
          const rawBookmarks = bookmarkStr ? bookmarkStr.trim().split(' ').filter(Boolean) : [];
          const rawRemoteBookmarks = remoteBookmarkStr ? remoteBookmarkStr.trim().split(' ').filter(Boolean) : [];

          const localBookmarks = rawBookmarks.filter((b) => !b.includes('@'));
          const localBaseNames = new Set(localBookmarks.map((b) => b.replace(/[*?]$/, '')));

          const remoteBookmarkSet = new Set<string>();
          rawBookmarks.filter((b) => b.includes('@')).forEach((rb) => remoteBookmarkSet.add(rb));
          rawRemoteBookmarks.forEach((rb) => {
            const baseName = rb.split('@')[0];
            if (!localBaseNames.has(baseName)) {
              remoteBookmarkSet.add(rb);
            }
          });

          const bookmarks = localBookmarks;
          const remoteBookmarks = Array.from(remoteBookmarkSet);

          const workingCopies = wcStr
            ? wcStr
                .trim()
                .split(',')
                .map((w) => w.trim().replace(/@$/, ''))
                .filter((w) => Boolean(w) && w !== 'default')
            : [];
          const parentIds = parentStr ? parentStr.trim().split(',').filter(Boolean) : [];

          return {
            changeId: rawShortId ?? '',
            shortestLen: Math.min(shortestPrefix ? shortestPrefix.length : 1, (rawShortId ?? '').length),
            commitId: commitId ?? '',
            description: description || '',
            bookmarks,
            remoteBookmarks,
            isConflict: conflictStr === 'true',
            isDivergent: divergentStr === 'true',
            workingCopies,
            parentIds,
            empty: emptyStr === 'true',
          };
        });

      const itemMap = new Map<string, JJChangeInfo>();
      rawItems.forEach((item) => itemMap.set(item.commitId, item));
      const knownIds = new Set(itemMap.keys());

      // Filter parents to only revisions present in the current set
      rawItems.forEach((item) => {
        item.parentIds = item.parentIds.filter((p) => knownIds.has(p));
      });

      // Build children mapping and child counts for topological sort
      const childrenMap = new Map<string, string[]>();
      const childCount = new Map<string, number>();
      for (const id of knownIds) {
        childrenMap.set(id, []);
        childCount.set(id, 0);
      }

      for (const item of rawItems) {
        for (const p of item.parentIds) {
          childrenMap.get(p)!.push(item.commitId);
          childCount.set(p, (childCount.get(p) || 0) + 1);
        }
      }

      // Compute topological height/depth (distance from root)
      const depthMap = new Map<string, number>();
      function getDepth(id: string, path = new Set<string>()): number {
        if (depthMap.has(id)) {return depthMap.get(id)!;}
        if (path.has(id)) {return 0;}
        path.add(id);
        const item = itemMap.get(id);
        if (!item) {return 0;}
        let maxP = 0;
        for (const p of item.parentIds) {
          maxP = Math.max(maxP, getDepth(p, path));
        }
        const d = maxP + 1;
        depthMap.set(id, d);
        return d;
      }
      for (const id of knownIds) {
        getDepth(id);
      }

      // Ready heads (commits with 0 children)
      const ready: string[] = [];
      for (const [id, count] of childCount.entries()) {
        if (count === 0) {ready.push(id);}
      }

      const sorted: JJChangeInfo[] = [];
      let lastEmitted: string | null = null;

      while (ready.length > 0) {
        let bestIdx = -1;

        if (lastEmitted) {
          const lastItem = itemMap.get(lastEmitted)!;
          // 1. Follow direct parent if ready (keeps linear branches contiguous)
          for (const pId of lastItem.parentIds) {
            const idx = ready.indexOf(pId);
            if (idx !== -1) {
              bestIdx = idx;
              break;
            }
          }

          // 2. If direct parent is waiting for sibling children, prioritize ready nodes that lead to it
          if (bestIdx === -1) {
            for (const pId of lastItem.parentIds) {
              const sibIdx = ready.findIndex((rId) => {
                const visited = new Set<string>();
                function hasAncestor(curr: string): boolean {
                  if (curr === pId) {return true;}
                  if (visited.has(curr)) {return false;}
                  visited.add(curr);
                  const it = itemMap.get(curr);
                  if (!it) {return false;}
                  return it.parentIds.some((p) => hasAncestor(p));
                }
                return hasAncestor(rId);
              });
              if (sibIdx !== -1) {
                bestIdx = sibIdx;
                break;
              }
            }
          }
        }

        // 3. Pick the candidate with the greatest depth (the branch furthest ahead)
        // Tie-breaker: prioritize bookmarks, non-empty commits, stable commitId
        if (bestIdx === -1) {
          bestIdx = 0;
          for (let i = 1; i < ready.length; i++) {
            const dCurr = depthMap.get(ready[i]) ?? 0;
            const dBest = depthMap.get(ready[bestIdx]) ?? 0;
            if (dCurr > dBest) {
              bestIdx = i;
            } else if (dCurr === dBest) {
              const itemCurr = itemMap.get(ready[i])!;
              const itemBest = itemMap.get(ready[bestIdx])!;
              const currScore = (itemCurr.bookmarks.length > 0 || itemCurr.remoteBookmarks.length > 0 ? 2 : 0) + (itemCurr.description ? 1 : 0);
              const bestScore = (itemBest.bookmarks.length > 0 || itemBest.remoteBookmarks.length > 0 ? 2 : 0) + (itemBest.description ? 1 : 0);
              if (currScore > bestScore) {
                bestIdx = i;
              }
            }
          }
        }

        const [chosenId] = ready.splice(bestIdx, 1);
        const chosenItem = itemMap.get(chosenId)!;
        sorted.push(chosenItem);
        lastEmitted = chosenId;

        for (const pId of chosenItem.parentIds) {
          const c = (childCount.get(pId) || 1) - 1;
          childCount.set(pId, c);
          if (c === 0) {
            ready.push(pId);
          }
        }
      }

      return sorted;
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
    if (targetRev) {args.push(targetRev);}
    await this.run(args);
  }

  async abandonChange(revision: string): Promise<void> {
    const workspaces = await this.getWorkspaces();
    const match = workspaces.find((w) => w.changeId === revision || revision === '@');

    if (match && !match.isDefault) {
      await this.forgetWorkspace(match.name);
      return;
    }

    const current = await this.getChangeInfo('@');
    if (current && current.changeId === revision) {
      const parent = current.parentIds[0] || 'root()';
      await this.run(['edit', parent]);
      await this.run(['abandon', revision]);
      return;
    }

    await this.run(['abandon', revision]);
  }

  async describeChange(message: string, revision: string = '@'): Promise<void> {
    await this.run(['describe', '-r', revision, '-m', message]);
  }

  async editChange(revision: string): Promise<void> {
    await this.run(['edit', revision]);
  }

  async switchBookmark(bookmarkName: string): Promise<void> {
    const rawName = bookmarkName.trim();
    const baseName = rawName.includes('@') ? rawName.split('@')[0] : rawName;

    let validRev = rawName;
    const exists = await this.run([
      'log',
      '--ignore-working-copy',
      '-r',
      validRev,
      '--no-graph',
      '-T',
      'change_id.short(4)',
    ]).catch(() => '');

    if (!exists && baseName !== rawName) {
      validRev = baseName;
    }

    const headOutput = await this.run([
      'log',
      '--ignore-working-copy',
      '-r',
      `heads(${validRev}:: & (visible_heads() | @))`,
      '--no-graph',
      '-T',
      'commit_id ++ "\\0" ++ change_id.short(4) ++ "\\0" ++ empty ++ "\\0" ++ if(description, "has_desc", "no_desc") ++ "\\n"',
    ]).catch(() => '');

    const lines = headOutput.trim().split('\n').filter(Boolean);
    let targetTip: { changeId: string; isEmpty: boolean; hasDesc: boolean } | null = null;

    for (const line of lines) {
      const [commitId, changeId, isEmpty, descFlag] = line.split('\0');
      const bmOutput = await this.run([
        'log',
        '--ignore-working-copy',
        '-r',
        `heads(::${commitId} & (bookmarks() | remote_bookmarks()))`,
        '--no-graph',
        '-T',
        'bookmarks.map(|b| b.name()).join(" ") ++ " " ++ remote_bookmarks.map(|b| b.name() ++ "@" ++ b.remote()).join(" ") ++ "\\n"',
      ]).catch(() => '');

      const bms = bmOutput.trim().split(/\s+/).filter(Boolean);
      const matches = bms.some((b) => {
        const bBase = b.split('@')[0].replace(/[*?]$/, '');
        return bBase === baseName || b === rawName || b === validRev;
      });

      if (matches) {
        targetTip = { changeId, isEmpty: isEmpty === 'true', hasDesc: descFlag === 'has_desc' };
        break;
      }
    }

    if (targetTip) {
      if (targetTip.isEmpty && !targetTip.hasDesc) {
        await this.editChange(targetTip.changeId);
        return;
      }
      await this.newChange(targetTip.changeId);
    } else {
      await this.newChange(validRev);
    }
  }

  async getWorkspaces(): Promise<JJWorkspace[]> {
    try {
      const raw = await this.run(['workspace', 'list']);
      if (!raw) {return [];}

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
      if (!raw) {return [];}

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