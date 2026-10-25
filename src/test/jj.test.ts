import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { JJRunner, parseDiffSummaryLine, normalizeDiffPath, JJDiffFile } from '../jj';
import { filterFilesWithDiff } from '../diffUtils';

const execFileAsync = promisify(execFile);

suite('JJ SCM Test Suite', function () {
  this.timeout(60000);

  let tempDir: string;
  let remoteDir: string;
  let jj: JJRunner;

  async function runCmd(cmd: string, args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync(cmd, args, { cwd });
    return stdout;
  }

  suiteSetup(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-remote-'));

    // Initialize a bare git repository as the remote
    await runCmd('git', ['init', '--bare', remoteDir], tempDir);

    // Initialize jj repo in tempDir
    await runCmd('jj', ['git', 'init'], tempDir);
    await runCmd('jj', ['config', 'set', '--repo', 'user.name', 'Test User'], tempDir);
    await runCmd('jj', ['config', 'set', '--repo', 'user.email', 'test@example.com'], tempDir);
    await runCmd('jj', ['config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'none()'], tempDir);
    await runCmd('jj', ['git', 'remote', 'add', 'origin', remoteDir], tempDir);

    jj = new JJRunner(tempDir);
  });

  suiteTeardown(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(remoteDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('Empty remote handling (getCommitGraph with unpushed remote)', async () => {
    // Add a remote that has nothing pushed to it
    const emptyRemoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-empty-remote-'));
    await runCmd('git', ['init', '--bare', emptyRemoteDir], tempDir);
    await runCmd('jj', ['git', 'remote', 'add', 'empty-remote', emptyRemoteDir], tempDir);

    // Create a commit on main
    await jj.describeChange('Initial commit on main');
    await jj.createBookmark('main');

    // Query commit graph with the empty remote
    const graph = await jj.getCommitGraph('empty-remote');
    assert.ok(graph.length > 0, 'Commit graph should not be empty');

    // Root commit or initial commit should be returned and have valid structure
    const initialCommit = graph.find((c) => c.description === 'Initial commit on main');
    assert.ok(initialCommit, 'Initial commit should be in the graph');

    await fs.rm(emptyRemoteDir, { recursive: true, force: true }).catch(() => {});
  });

  test('Bookmark deduplication and branch@remote formatting', async () => {
    // Push main to origin so origin has main@origin
    await runCmd('jj', ['git', 'push', '--remote', 'origin', '--bookmark', 'main'], tempDir);

    // Create a local-only bookmark
    await jj.createBookmark('local-feature');

    // getBookmarks with targetRemote='origin'
    const bookmarks = await jj.getBookmarks('origin');

    // Both should be formatted as name@origin and deduplicated
    assert.ok(bookmarks.includes('main@origin'), 'Should include main@origin');
    assert.ok(bookmarks.includes('local-feature@origin'), 'Should format local-only as local-feature@origin');

    // Ensure no bare 'main' duplicate exists
    assert.strictEqual(bookmarks.filter((b) => b === 'main').length, 0, 'Should not contain bare duplicate');
    assert.strictEqual(bookmarks.filter((b) => b.startsWith('main@')).length, 1, 'Should have exactly one main entry');

    // Test getActiveBookmark
    const active = await jj.getActiveBookmark('origin');
    assert.strictEqual(active, 'main@origin', 'Active bookmark should match targetRemote format');
  });

  test('switchBookmark seamlessly handles ancestor bookmarks and format fallback', async () => {
    // Current working copy is on main.
    // Create a new bookmark 'feature-branch' and advance 2 commits on top of it.
    await jj.newChange('main@origin');
    await jj.describeChange('Feature commit 1');
    await jj.createBookmark('feature-branch');

    await jj.newChange('@');
    await jj.describeChange('Feature commit 2');

    // Now switch back to main@origin (which is an ancestor)
    await jj.switchBookmark('main@origin');

    const current = await jj.getChangeInfo('@');
    assert.ok(current, 'Working copy should exist');

    // Current working copy should have parent pointing to main or be on main, not on feature-branch
    assert.ok(!current.description.includes('Feature commit 2'), 'Should not remain on feature-branch tip');

    // Switch to local-feature@origin (which does not exist remotely, should fallback cleanly to local-feature)
    await jj.switchBookmark('local-feature@origin');
    const onLocal = await jj.getChangeInfo('@');
    assert.ok(onLocal, 'Should successfully switch using fallback');
  });

  test('Branch filtering when active branch is > 10 commits ahead', async () => {
    // Create a side branch
    await jj.newChange('main@origin');
    await jj.describeChange('Side branch base');
    await jj.createBookmark('side-branch');

    // Switch to main and add 5 commits (<= 10 ahead of side-branch)
    await jj.switchBookmark('main@origin');
    for (let i = 1; i <= 5; i++) {
      await jj.newChange('@');
      await jj.describeChange(`Main commit ${i}`);
    }

    let graph = await jj.getCommitGraph('origin');
    let sideCommit = graph.find((c) => c.description === 'Side branch base');
    assert.ok(sideCommit, 'Side branch should be visible when active branch is <= 10 commits ahead');

    // Add 6 more commits so active branch is 11 commits ahead (> 10)
    for (let i = 6; i <= 11; i++) {
      await jj.newChange('@');
      await jj.describeChange(`Main commit ${i}`);
    }

    graph = await jj.getCommitGraph('origin');
    sideCommit = graph.find((c) => c.description === 'Side branch base');
    assert.strictEqual(sideCommit, undefined, 'Side branch should be hidden when active branch is > 10 commits ahead');

    // Switching to side-branch restores its visibility
    await jj.switchBookmark('side-branch@origin');
    graph = await jj.getCommitGraph('origin');
    sideCommit = graph.find((c) => c.description === 'Side branch base');
    assert.ok(sideCommit, 'Side branch should become visible when activated via switchBookmark');
  });

  test('Divergent commits detection and convergence', async () => {
    // Create a clone to simulate divergent changes on a bookmark
    const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-clone-'));
    await runCmd('jj', ['git', 'clone', tempDir, cloneDir], tempDir);
    await runCmd('jj', ['config', 'set', '--repo', 'revset-aliases."immutable_heads()"', 'none()'], cloneDir);

    // In clone: create bookmark 'div-bookmark' and push to origin
    await runCmd('jj', ['new', 'root()', '-m', 'Base version'], cloneDir);
    await runCmd('jj', ['bookmark', 'create', 'div-bookmark'], cloneDir);
    await runCmd('jj', ['git', 'push', '--bookmark', 'div-bookmark'], cloneDir);

    // In original repo: fetch and rewrite div-bookmark with version A and push
    await runCmd('jj', ['git', 'fetch'], tempDir);
    await runCmd('jj', ['describe', '-r', 'div-bookmark', '-m', 'Version A'], tempDir);
    await runCmd('jj', ['git', 'push', '--bookmark', 'div-bookmark'], tempDir);

    // In clone: rewrite div-bookmark locally with version B
    await runCmd('jj', ['describe', '-r', 'div-bookmark', '-m', 'Version B'], cloneDir);

    // In clone: fetch from origin, causing divergence between local Version B and origin Version A
    await runCmd('jj', ['git', 'fetch'], cloneDir);

    const cloneJj = new JJRunner(cloneDir);

    // Check commit graph: divergent commits should be detected
    const graph = await cloneJj.getCommitGraph('origin');
    const divergentCommits = graph.filter((c) => c.isDivergent);
    assert.ok(divergentCommits.length >= 2, 'Should detect at least 2 divergent commits');

    // Converge the divergent change
    const targetChange = divergentCommits[0].changeId;
    await cloneJj.converge(targetChange);

    // Verify divergence is resolved
    const graphAfter = await cloneJj.getCommitGraph('origin');
    const divergentAfter = graphAfter.filter((c) => c.changeId === targetChange && c.isDivergent);
    assert.strictEqual(divergentAfter.length, 0, 'Divergence should be resolved after converge');

    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  });

  test('parseDiffSummaryLine handles standard and renamed files', () => {
    assert.deepStrictEqual(parseDiffSummaryLine('M src/main.rs'), {
      status: 'M',
      path: 'src/main.rs',
    });

    assert.deepStrictEqual(parseDiffSummaryLine('A src/new.rs'), {
      status: 'A',
      path: 'src/new.rs',
    });

    assert.deepStrictEqual(parseDiffSummaryLine('D src/old.rs'), {
      status: 'D',
      path: 'src/old.rs',
    });

    assert.deepStrictEqual(
      parseDiffSummaryLine('R src/hooks/{extensions_test.rs => registries_test.rs}'),
      {
        status: 'R',
        path: 'src/hooks/registries_test.rs',
        oldPath: 'src/hooks/extensions_test.rs',
      }
    );

    assert.deepStrictEqual(parseDiffSummaryLine('R {foo.txt => bar.txt}'), {
      status: 'R',
      path: 'bar.txt',
      oldPath: 'foo.txt',
    });

    assert.deepStrictEqual(
      parseDiffSummaryLine('R {src/hooks/extensions_test.rs => other/registries_test.rs}'),
      {
        status: 'R',
        path: 'other/registries_test.rs',
        oldPath: 'src/hooks/extensions_test.rs',
      }
    );

    assert.deepStrictEqual(
      parseDiffSummaryLine('R src/{hooks => newhooks}/test.rs'),
      {
        status: 'R',
        path: 'src/newhooks/test.rs',
        oldPath: 'src/hooks/test.rs',
      }
    );

    assert.deepStrictEqual(
      parseDiffSummaryLine('R old.txt => new.txt'),
      {
        status: 'R',
        path: 'new.txt',
        oldPath: 'old.txt',
      }
    );
  });

  test('getDiffSummary properly parses renames in a repository', async () => {
    const hooksDir = path.join(tempDir, 'src', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const oldFile = path.join(hooksDir, 'extensions_test.rs');
    await fs.writeFile(oldFile, '// test content\n');

    await jj.describeChange('Add extensions test');
    await runCmd('jj', ['new'], tempDir);

    const newFile = path.join(hooksDir, 'registries_test.rs');
    await fs.rename(oldFile, newFile);

    const diff = await jj.getDiffSummary('@');
    const renamed = diff.find((f) => f.path === 'src/hooks/registries_test.rs');

    assert.ok(renamed, 'Should find renamed file by its new path');
    assert.strictEqual(renamed.status, 'R');
    assert.strictEqual(renamed.oldPath, 'src/hooks/extensions_test.rs');
  });

  test('splitCommit splits commit and assigns files and descriptions accurately', async () => {
    await jj.newChange();
    const fileA = path.join(tempDir, 'split_a.txt');
    const fileB = path.join(tempDir, 'split_b.txt');
    await fs.writeFile(fileA, 'content a\n');
    await fs.writeFile(fileB, 'content b\n');
    await jj.describeChange('Combined feature with A and B');

    // Split split_a.txt into new commit with description 'Part A only'
    await jj.splitCommit('@', 'Part A only', ['split_a.txt']);

    // Check parent commit (@-): should contain split_a.txt and description 'Part A only'
    const parentInfo = await jj.getChangeInfo('@-');
    assert.ok(parentInfo, 'Parent commit should exist');
    assert.strictEqual(parentInfo.description, 'Part A only');

    const parentDiff = await jj.getDiffSummary('@-');
    assert.ok(parentDiff.some((f) => f.path === 'split_a.txt'), 'Parent should contain split_a.txt');
    assert.ok(!parentDiff.some((f) => f.path === 'split_b.txt'), 'Parent should not contain split_b.txt');

    // Check current commit (@): should keep remaining split_b.txt and original description
    const currentInfo = await jj.getChangeInfo('@');
    assert.ok(currentInfo, 'Current commit should exist');
    assert.strictEqual(currentInfo.description, 'Combined feature with A and B');

    const currentDiff = await jj.getDiffSummary('@');
    assert.ok(currentDiff.some((f) => f.path === 'split_b.txt'), 'Current should contain split_b.txt');
    assert.ok(!currentDiff.some((f) => f.path === 'split_a.txt'), 'Current should not contain split_a.txt');
  });

  test('getCommitGraph places current branch and its branches first before other bookmarks', async () => {
    // Create an other branch with bookmark 'other-feature' and 3 commits
    await jj.newChange('main@origin');
    await jj.describeChange('Other branch commit 1');
    await jj.createBookmark('other-feature');
    await jj.newChange('@');
    await jj.describeChange('Other branch commit 2');
    await jj.newChange('@');
    await jj.describeChange('Other branch commit 3');

    // Now create and switch to 'active-work' branch
    await jj.newChange('main@origin');
    await jj.describeChange('Active branch commit 1');
    await jj.createBookmark('active-work');

    // Ensure working copy is on active-work branch
    const graph = await jj.getCommitGraph('origin');

    // The first commit in the graph must belong to the active branch or working copy, not other-feature
    assert.ok(graph.length > 0, 'Graph must not be empty');
    assert.strictEqual(
      graph[0].description,
      'Active branch commit 1',
      'Current branch commit should appear first in the graph'
    );

    // Other branch commits must show up after the current branch
    const activeIdx = graph.findIndex((c) => c.description === 'Active branch commit 1');
    const otherIdx = graph.findIndex((c) => c.description === 'Other branch commit 3');
    assert.ok(activeIdx !== -1, 'Active branch commit must exist in graph');
    assert.ok(otherIdx !== -1, 'Other branch commit must exist in graph');
    assert.ok(activeIdx < otherIdx, 'Current branch commits must appear before other bookmarks');
  });

  test('filterFilesWithDiff filters out files with no actual diff', async () => {
    await jj.newChange();
    const testFile = path.join(tempDir, 'identical.txt');
    await fs.writeFile(testFile, 'base content\n');
    await jj.describeChange('Base content commit');

    await jj.newChange();
    // Simulate diff summary reporting M for identical.txt even though content is identical
    const fakeDiff: JJDiffFile[] = [
      { status: 'M', path: 'identical.txt' },
      { status: 'A', path: 'real_addition.txt' },
    ];

    const fileA = path.join(tempDir, 'real_addition.txt');
    await fs.writeFile(fileA, 'addition\n');

    const filtered = await filterFilesWithDiff(fakeDiff, '@', '@-', tempDir, jj);

    assert.strictEqual(filtered.length, 1, 'Should filter out identical file');
    assert.strictEqual(filtered[0].path, 'real_addition.txt');
  });

  test('getCommitGraph limits to at most 3 branches and excludes distant branches', async () => {
    // Current branch is on active-work
    // Create branch 1 close to active-work
    await jj.newChange('main@origin');
    await jj.describeChange('Branch 1 commit');
    await jj.createBookmark('branch-1');

    // Create branch 2 close to active-work
    await jj.newChange('main@origin');
    await jj.describeChange('Branch 2 commit');
    await jj.createBookmark('branch-2');

    // Create branch 3 close to active-work - should be excluded by 3-branch limit
    await jj.newChange('main@origin');
    await jj.describeChange('Branch 3 commit');
    await jj.createBookmark('branch-3');

    // Create branch-distant (>10 commits away)
    await jj.newChange('main@origin');
    for (let i = 0; i < 11; i++) {
      await jj.newChange('@');
      await jj.describeChange(`Distant commit ${i}`);
    }
    await jj.createBookmark('branch-distant');

    // Switch back to active-work
    await jj.editChange('active-work');

    const graph = await jj.getCommitGraph('origin');
    const descriptions = graph.map((c) => c.description);

    // Active branch must be present
    assert.ok(descriptions.includes('Active branch commit 1'));
    // Branch-distant must NOT be present (> 10 commits away)
    assert.ok(!descriptions.includes('Distant commit 10'));
    assert.ok(!graph.some((c) => c.bookmarks.includes('branch-distant')));

    // Only at most 2 other branches should be present (3 branches total)
    const otherBookmarks = ['branch-1', 'branch-2', 'branch-3'].filter((b) =>
      graph.some((c) => c.bookmarks.includes(b))
    );
    assert.ok(otherBookmarks.length <= 2, `Should have at most 2 other branches in graph, got ${otherBookmarks.length}`);
  });

  test('moveFile moves whole directory between revisions', async () => {
    await jj.newChange();
    const dirPath = path.join(tempDir, 'subfolder');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'file1.txt'), 'content 1\n');
    await fs.writeFile(path.join(dirPath, 'file2.txt'), 'content 2\n');
    await jj.describeChange('Commit with subfolder');

    // Create new change on top
    await jj.newChange();
    // Move subfolder from @- into @
    await jj.moveFile('@-', '@', 'subfolder');

    const diff = await jj.getDiffSummary('@');
    const paths = diff.map((d) => d.path);
    assert.ok(paths.includes('subfolder/file1.txt'));
    assert.ok(paths.includes('subfolder/file2.txt'));
  });

  test('working copy appears right above the commit it is on with sibling branches preceding working copy', async () => {
    // Create base commit P
    await jj.newChange('main@origin');
    await jj.describeChange('Base parent commit P');

    // Create sibling branch B off P
    await jj.newChange('@');
    await jj.describeChange('Sibling branch B');

    // Create working copy WC off P
    await jj.newChange('@-');
    await jj.describeChange('Working copy WC');

    const graph = await jj.getCommitGraph('origin');
    const idxB = graph.findIndex((c) => c.description === 'Sibling branch B');
    const idxWC = graph.findIndex((c) => c.description === 'Working copy WC');
    const idxP = graph.findIndex((c) => c.description === 'Base parent commit P');

    assert.ok(idxB !== -1, 'Sibling branch B must be in graph');
    assert.ok(idxWC !== -1, 'Working copy WC must be in graph');
    assert.ok(idxP !== -1, 'Base parent commit P must be in graph');

    // In top-to-bottom graph order: B precedes WC, and WC immediately precedes P (idxP === idxWC + 1)
    assert.ok(idxB < idxWC, 'Sibling branch B should appear above working copy in topological sort');
    assert.strictEqual(idxP, idxWC + 1, 'Working copy must appear right above parent commit P');
  });

  test('branches at least 10 commits behind main are hidden', async () => {
    // Create an old branch
    await jj.newChange('main@origin');
    await jj.describeChange('Old branch commit');
    await jj.createBookmark('old-branch');

    // Advance main by 11 commits ahead of old-branch
    await jj.switchBookmark('main@origin');
    for (let i = 1; i <= 11; i++) {
      await jj.newChange('@');
      await jj.describeChange(`Advancing main ${i}`);
    }
    await jj.setBookmark('main', '@');

    const graph = await jj.getCommitGraph('origin');
    const oldBranchCommit = graph.find((c) => c.description === 'Old branch commit');
    assert.strictEqual(oldBranchCommit, undefined, 'Old branch should be hidden when >= 10 commits behind main');
  });
});
