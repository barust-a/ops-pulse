import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCommand } from '../../.claude/hooks/guard-bash.mjs';

const script = fileURLToPath(new URL('../../.claude/hooks/guard-bash.mjs', import.meta.url));

const bypass = /Pre-commit gates are law \(AGENTS\.md §4\)/;
const force = /Force-push needs the owner's explicit approval/;

describe('checkCommand: hook bypasses', () => {
  for (const command of [
    'git commit --no-verify -m "wip"',
    'git commit -n -m "wip"',
    'git commit -an -m "wip"',
    'git commit -nm "wip"',
    'git commit -m wip -n',
    'git push --no-verify',
    'git merge --no-verify feature',
    'git -C apps/web commit --no-verify',
    String.raw`git -C "C:\work\my project" commit -n`,
    'npm run lint && git commit -n -m "x"',
    'npm run lint; git commit --no-verify',
    'echo y | git commit -n',
    'cd /repo && git add . && git commit -an',
    'git -c core.hooksPath=/dev/null commit -m "x"',
    'git -c core.hooksPath= commit -m "x"',
    'HUSKY=0 git commit -m "x"',
    'env HUSKY=0 git push',
    '/usr/bin/git commit -n',
    'git.exe commit --no-verify',
    'echo $(git commit -n)',
    'git commit -m "$(cat <<\'EOF\'\nfeat: x\nEOF\n)" --no-verify',
  ]) {
    it(`blocks ${command}`, () => {
      assert.match(checkCommand(command) ?? '', bypass);
    });
  }

  for (const command of [
    'git commit -m "mention --no-verify in the message"',
    "git commit -m 'explain why -n is banned'",
    'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\ngit commit --no-verify is forbidden\nEOF\n)"',
    'git commit -F - <<EOF\ngit push --force\nEOF',
    'git commit -m note',
    'git commit -mnote',
    'git commit -m -n',
    'git commit --message --no-verify',
    'git commit -- --no-verify',
    'git commit --amend --no-edit',
    'git push -n origin main',
    'git merge -n feature',
    'git log --oneline -n 5',
    'echo --no-verify',
    'grep -n "--no-verify" AGENTS.md',
    'some-tool analyze --no-verify',
    'git -c user.name=me commit -m "x"',
    'git config core.hooksPath',
    'HUSKY=1 git commit -m "x"',
    '# git commit --no-verify',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(checkCommand(command), null);
    });
  }
});

describe('checkCommand: force-push', () => {
  for (const command of [
    'git push --force',
    'git push -f origin main',
    'git push origin main -f',
    'git push -uf origin feat/x',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main',
    'git push origin +main',
    'git push origin +HEAD:refs/heads/main',
    'git -C ../other push --force',
    'npm test && git push -f',
  ]) {
    it(`blocks ${command}`, () => {
      assert.match(checkCommand(command) ?? '', force);
    });
  }

  for (const command of [
    'git push',
    'git push -u origin feat/agent-harness',
    'git push origin main',
    'git push -o ci.skip origin main',
    'git push origin HEAD:main',
    'git fetch --force',
    'git checkout -f main',
    'git commit -m "do not git push --force"',
    'git push origin "feat/x" && echo "+done"',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(checkCommand(command), null);
    });
  }
});

/** @param {string} input */
const run = (input) => spawnSync(process.execPath, [script], { input, encoding: 'utf8' });

describe('guard-bash hook, end to end', () => {
  it('exits 2 with the reason on stderr for a blocked command', () => {
    const result = run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -n' } }),
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, bypass);
  });

  it('exits 0 for an allowed command', () => {
    const result = run(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }),
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  it('exits 0 when the input is not a Bash call it understands', () => {
    assert.equal(run('not json').status, 0);
    assert.equal(run(JSON.stringify({ tool_name: 'Bash', tool_input: {} })).status, 0);
  });
});
