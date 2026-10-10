import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { repoFiles, repoRoot as root } from './git.mjs';

// The hygiene gates of docs/guides/base/code-hygiene.md: every stack runs knip (dead code) and
// jscpd (duplication) with the same settings, so a finding means the same thing in every stack.
const stacks = repoFiles()
  .filter((path) => /^apps\/[^/]+\/package\.json$/.test(path))
  .map((path) => dirname(path));

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const HYGIENE_SCRIPTS = ['hygiene', 'hygiene:knip', 'hygiene:dup', 'hygiene:dup:update'];
const JSCPD_SHARED = {
  minTokens: 70,
  minLines: 8,
  failOnEmpty: true,
  baseline: '.jscpd-baseline.json',
  failOnNewClones: 0,
};
// Generated files end in `.generated.<ext>` (each app's AGENTS.md): a generator repeats
// itself by design, and its output changes only through the generator.
const JSCPD_GENERATED_IGNORE = '**/*.generated.*';
const KNIP_SHARED = { treatConfigHintsAsErrors: true };
const KNIP_CONFIGS = ['knip.jsonc', 'knip.json'];

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

// JSONC as the stacks write it: whole-line comments and trailing commas.
function readJsonc(path) {
  const json = readFileSync(join(root, path), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replaceAll(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json);
}

function differences(config, shared, where) {
  return Object.entries(shared)
    .filter(([key, value]) => config[key] !== value)
    .map(([key, value]) => `${where}: set "${key}" to ${JSON.stringify(value)}`);
}

describe('hygiene gates', () => {
  it('finds at least one stack', () => {
    assert.ok(stacks.length > 0, 'no apps/*/package.json');
  });

  it('pins knip and jscpd exactly in every stack', () => {
    const violations = stacks.flatMap((stack) => {
      const { devDependencies = {} } = readJson(`${stack}/package.json`);
      return ['knip', 'jscpd']
        .filter((tool) => !EXACT_VERSION.test(devDependencies[tool] ?? ''))
        .map((tool) => `${stack}/package.json: pin ${tool} exactly in devDependencies`);
    });
    assert.deepEqual(violations, []);
  });

  it('gives every stack the hygiene scripts, none of which fixes or re-records on its own', () => {
    const violations = stacks.flatMap((stack) => {
      const { scripts = {} } = readJson(`${stack}/package.json`);
      const missing = HYGIENE_SCRIPTS.filter((name) => scripts[name] === undefined).map(
        (name) => `${stack}/package.json: add the "${name}" script`,
      );
      const fixing = HYGIENE_SCRIPTS.filter((name) => /\s--fix\b/.test(scripts[name] ?? '')).map(
        (name) => `${stack}/package.json: "${name}" must not pass --fix`,
      );
      const recording = ['hygiene', 'hygiene:knip', 'hygiene:dup']
        .filter((name) => (scripts[name] ?? '').includes('--update-baseline'))
        .map((name) => `${stack}/package.json: only "hygiene:dup:update" re-records the baseline`);
      return [...missing, ...fixing, ...recording];
    });
    assert.deepEqual(violations, []);
  });

  it('runs jscpd with the shared thresholds against a committed baseline in every stack', () => {
    const violations = stacks.flatMap((stack) => {
      const path = `${stack}/.jscpd.json`;
      if (!existsSync(join(root, path))) return [`${path}: add the jscpd configuration`];
      const baseline = `${stack}/${JSCPD_SHARED.baseline}`;
      return [
        ...differences(readJson(path), JSCPD_SHARED, path),
        ...(existsSync(join(root, baseline))
          ? []
          : [`${baseline}: record it with the hygiene:dup:update script`]),
      ];
    });
    assert.deepEqual(violations, []);
  });

  it('keeps generated code out of the duplication check in every stack', () => {
    const violations = stacks
      .map((stack) => `${stack}/.jscpd.json`)
      .filter((path) => existsSync(join(root, path)))
      .filter((path) => !(readJson(path).ignore ?? []).includes(JSCPD_GENERATED_IGNORE))
      .map((path) => `${path}: add "${JSCPD_GENERATED_IGNORE}" to "ignore"`);
    assert.deepEqual(violations, []);
  });

  it('runs knip with the shared settings in every stack', () => {
    const violations = stacks.flatMap((stack) => {
      const name = KNIP_CONFIGS.find((file) => existsSync(join(root, stack, file)));
      if (name === undefined) return [`${stack}: add a knip.jsonc`];
      return differences(readJsonc(`${stack}/${name}`), KNIP_SHARED, `${stack}/${name}`);
    });
    assert.deepEqual(violations, []);
  });

  it('reports an export that only its own file uses, in every stack', () => {
    const violations = stacks.flatMap((stack) => {
      const name = KNIP_CONFIGS.find((file) => existsSync(join(root, stack, file)));
      if (name === undefined) return [];
      return readJsonc(`${stack}/${name}`).ignoreExportsUsedInFile
        ? [`${stack}/${name}: drop ignoreExportsUsedInFile, it hides exports nothing imports`]
        : [];
    });
    assert.deepEqual(violations, []);
  });
});
