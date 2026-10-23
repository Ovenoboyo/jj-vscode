import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { JJRunner } from '../jj';

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
});
