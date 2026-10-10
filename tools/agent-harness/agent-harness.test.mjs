import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, it } from 'node:test';

import { repoFiles, repoRoot as root } from './git.mjs';

// Guards the instruction files every agent loads (AGENTS.md for Codex and the others,
// CLAUDE.md for Claude Code) and the hooks that enforce what they can only advise. Each
// violation reads as the fix to apply. docs/ is left out: its guides hold reference copies of
// instruction files that no agent loads.
const instructionFiles = repoFiles()
  .filter((path) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path))
  .filter((path) => !path.startsWith('docs/'))
  .filter((path) => existsSync(join(root, path)))
  .sort((a, b) => a.localeCompare(b));

const agentsFiles = instructionFiles.filter((path) => posix.basename(path) === 'AGENTS.md');
/** @param {string} path */
const read = (path) => readFileSync(join(root, path), 'utf8');
/** @param {string} text */
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
/** @param {string} path */
const folderOf = (path) => posix.dirname(path);

const ROOT_AGENTS_MAX_LINES = 200;
const NESTED_AGENTS_MAX_LINES = 150;
// Codex stops reading the root→folder AGENTS.md chain at project_doc_max_bytes.
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

/**
 * Markdown with code blocks and code spans blanked, where links and imports are not live.
 * @param {string} text
 */
function withoutCode(text) {
  /** @type {string | undefined} */
  let fence;
  /** @type {string[]} */
  const prose = [];
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) fence = marker;
    else if (fence !== undefined && marker?.startsWith(fence) === true) fence = undefined;
    else if (fence === undefined) prose.push(line.replaceAll(/`[^`]*`/g, ''));
  }
  return prose.join('\n');
}

/** @param {string} target */
function withoutTrailingPunctuation(target) {
  let end = target.length;
  while (end > 0 && '.,:;'.includes(target.charAt(end - 1))) end--;
  return target.slice(0, end);
}

/**
 * Relative link targets and `@path` imports, with anchors and external links dropped.
 * @param {string} text
 */
function referencesOf(text) {
  const prose = withoutCode(text);
  const links = [...prose.matchAll(/\]\(([^)]*)\)/g)].map(
    (match) => (match[1] ?? '').trim().split(/\s/)[0]?.replaceAll(/^<|>$/g, '') ?? '',
  );
  const imports = prose
    .split(/\s+/)
    .filter((word) => word.startsWith('@'))
    .map((word) => word.slice(1).split(')')[0] ?? '');
  return [...links, ...imports]
    .map((target) => withoutTrailingPunctuation(target))
    .filter((target) => !/^(https?:|mailto:|#|~)/i.test(target))
    .map((target) => decodeURIComponent(target.split('#')[0] ?? ''))
    .filter((target) => target !== '');
}

describe('agent instruction files', () => {
  it('finds the root AGENTS.md', () => {
    assert.ok(agentsFiles.includes('AGENTS.md'), 'create AGENTS.md at the repository root');
  });

  it('pairs every AGENTS.md with a CLAUDE.md that imports it', () => {
    const violations = agentsFiles.flatMap((agents) => {
      const claude = posix.join(folderOf(agents), 'CLAUDE.md');
      if (!existsSync(join(root, claude))) {
        return [`create ${claude} containing the line "@AGENTS.md" so Claude Code loads ${agents}`];
      }
      const imports = read(claude).split(/\r?\n/).includes('@AGENTS.md');
      return imports ? [] : [`add a line that is exactly "@AGENTS.md" to ${claude}`];
    });
    assert.deepEqual(violations, []);
  });

  it('keeps every AGENTS.md short', () => {
    const violations = agentsFiles.flatMap((agents) => {
      const max = agents === 'AGENTS.md' ? ROOT_AGENTS_MAX_LINES : NESTED_AGENTS_MAX_LINES;
      const lines = lineCount(read(agents));
      return lines <= max
        ? []
        : [
            `shorten ${agents} to ${String(max)} lines or fewer (now ${String(lines)}): move detail into docs/ and link it`,
          ];
    });
    assert.deepEqual(violations, []);
  });

  it("keeps each root-to-folder AGENTS.md chain within Codex's project_doc_max_bytes", () => {
    const violations = agentsFiles.flatMap((agents) => {
      const folders = folderOf(agents) === '.' ? [] : folderOf(agents).split('/');
      const chain = [
        'AGENTS.md',
        ...folders.map((_, at) => `${folders.slice(0, at + 1).join('/')}/AGENTS.md`),
      ];
      const bytes = chain
        .filter((path) => existsSync(join(root, path)))
        .reduce((total, path) => total + statSync(join(root, path)).size, 0);
      return bytes <= CODEX_PROJECT_DOC_MAX_BYTES
        ? []
        : [
            `trim the AGENTS.md chain ${chain.join(' → ')} to ${String(CODEX_PROJECT_DOC_MAX_BYTES)} bytes or fewer (now ${String(bytes)}): Codex drops what follows`,
          ];
    });
    assert.deepEqual(violations, []);
  });

  it('only links and imports files that exist', () => {
    const violations = instructionFiles.flatMap((file) =>
      referencesOf(read(file))
        .filter((target) => !existsSync(join(root, folderOf(file), target)))
        .map(
          (target) =>
            `fix the reference "${target}" in ${file}: no such file relative to ${folderOf(file)}/ (wrap text that is not a path in backticks)`,
        ),
    );
    assert.deepEqual(violations, []);
  });
});

describe('guard hooks', () => {
  const settingsPath = '.claude/settings.json';
  const guards = [
    { script: 'guard-bash.mjs', tools: ['Bash'] },
    { script: 'guard-migrations.mjs', tools: ['Edit', 'Write', 'MultiEdit'] },
  ];

  it(`registers every guard as a PreToolUse hook in ${settingsPath}`, () => {
    if (!existsSync(join(root, settingsPath))) {
      assert.fail(`create ${settingsPath} registering the guard hooks in .claude/hooks/`);
    }
    /** @type {{ hooks?: { PreToolUse?: Array<{ matcher?: string, hooks?: Array<{ command?: string }> }> } }} */
    const settings = JSON.parse(read(settingsPath));
    const entries = settings.hooks?.PreToolUse ?? [];
    const violations = guards.flatMap(({ script, tools }) => {
      const command = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${script}"`;
      const missing = [];
      if (!existsSync(join(root, '.claude/hooks', script))) {
        missing.push(`restore .claude/hooks/${script}: ${settingsPath} runs it`);
      }
      const registered = entries.some(
        (entry) =>
          tools.every((tool) => (entry.matcher ?? '').split('|').includes(tool)) &&
          (entry.hooks ?? []).some((hook) => hook.command === command),
      );
      if (!registered) {
        missing.push(
          `add a PreToolUse entry to ${settingsPath} with matcher covering ${tools.join('|')} and command ${command}`,
        );
      }
      return missing;
    });
    assert.deepEqual(violations, []);
  });
});
