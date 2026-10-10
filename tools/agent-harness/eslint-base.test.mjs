import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  COMPONENT_FILES,
  JS_FILES,
  PARAMETER_CAP,
  SONAR_UNICORN_RULES,
  TEST_FILES,
  TOOL_CONFIG_FILES,
  TS_FILES,
  UNICORN_RULES_ADDED_AFTER,
  allowDefaultExport,
  restrictedSyntax,
  sharedConfig,
  unicornRules,
} from '../eslint/base.mjs';
import { repoFiles, repoRoot as root } from './git.mjs';

// The shared ESLint base takes its plugins as arguments, so stand-ins are enough to check how
// it assembles the blocks. Each stack's lint run checks that the rules actually bite.
const fakeTseslint = {
  configs: {
    strictTypeChecked: [{ name: 'strict-type-checked' }],
    stylisticTypeChecked: [{ name: 'stylistic-type-checked' }],
    disableTypeChecked: { name: 'disable-type-checked' },
  },
};
const fakeSonarjs = { configs: { recommended: { name: 'sonarjs-recommended' } } };

/** @param {Record<string, unknown>} [extra] */
const build = (extra = {}) =>
  sharedConfig({
    tseslint: fakeTseslint,
    sonarjs: fakeSonarjs,
    tsconfigRootDir: '/stack',
    ...extra,
  });

/**
 * @param {ReturnType<typeof build>} config
 * @param {string} pattern
 */
const blocksFor = (config, pattern) =>
  config.filter((block) => Array.isArray(block.files) && block.files.includes(pattern));

/**
 * A stand-in unicorn plugin holding every SonarQube rule, some renamed, dropped or deprecated.
 * @param {{ version?: string, rename?: Record<string, string>, drop?: string[], deprecated?: string[] }} [options]
 */
const fakeUnicorn = ({ version = '77.0.0', rename = {}, drop = [], deprecated = [] } = {}) => ({
  meta: { name: 'eslint-plugin-unicorn', version },
  rules: Object.fromEntries(
    SONAR_UNICORN_RULES.filter((name) => !drop.includes(name)).map((name) => {
      const id = rename[name] ?? name;
      return [id, { meta: deprecated.includes(id) ? { deprecated: true } : {} }];
    }),
  ),
});

/** @param {ReturnType<typeof build>} config */
const unicornBlockOf = (config) => config.find((block) => block.plugins?.['unicorn']);

// A command that lints: eslint itself, or a framework wrapper around it.
const RUNS_ESLINT = /\b(eslint|expo lint|next lint)\b/;

const DEFAULT_EXPORT_SELECTORS = [
  'ExportDefaultDeclaration',
  "ExportSpecifier[exported.name='default']",
];

describe('tools/eslint/base.mjs', () => {
  it('restrictedSyntax keeps the default-export selectors and appends a stack’s own', () => {
    const extra = { selector: 'DebuggerStatement', message: 'No debugger.' };
    const [level, ...entries] = restrictedSyntax(extra);
    assert.equal(level, 'error');
    assert.deepEqual(
      entries.map((entry) => entry.selector),
      [...DEFAULT_EXPORT_SELECTORS, PARAMETER_CAP.selector, 'DebuggerStatement'],
    );
  });

  it('lints TypeScript type-aware with the stack’s tsconfig root', () => {
    const [tsBlock] = blocksFor(build(), '**/*.{ts,tsx,mts,cts}');
    assert.ok(tsBlock, 'a block must target **/*.{ts,tsx,mts,cts}');
    assert.deepEqual(tsBlock.extends, [
      fakeTseslint.configs.strictTypeChecked,
      fakeTseslint.configs.stylisticTypeChecked,
    ]);
    assert.deepEqual(tsBlock.languageOptions?.parserOptions, {
      projectService: true,
      tsconfigRootDir: '/stack',
    });
    assert.equal(tsBlock.rules?.['@typescript-eslint/switch-exhaustiveness-check'], 'error');
  });

  it('rejects every type assertion in TypeScript but `as const`, as AGENTS.md §9 states', () => {
    const [tsBlock] = blocksFor(build(), '**/*.{ts,tsx,mts,cts}');
    assert.deepEqual(tsBlock?.rules?.['@typescript-eslint/consistent-type-assertions'], [
      'error',
      { assertionStyle: 'never' },
    ]);
  });

  it('applies the same rules to JavaScript, minus the type-aware ones', () => {
    const [jsBlock] = blocksFor(build(), '**/*.{js,mjs,cjs,jsx}');
    assert.ok(jsBlock, 'a block must target **/*.{js,mjs,cjs,jsx}');
    assert.deepEqual(jsBlock.extends?.at(-1), fakeTseslint.configs.disableTypeChecked);
    assert.equal(jsBlock.rules?.['no-undef'], 'error');
    assert.equal(jsBlock.rules?.['@typescript-eslint/no-shadow'], 'error');
  });

  it('bans default exports everywhere and exempts tool config files last', () => {
    const config = build();
    const banned = config.find((block) => !block.files && block.rules?.['no-restricted-syntax']);
    assert.deepEqual(banned?.rules?.['no-restricted-syntax'], restrictedSyntax());
    assert.deepEqual(config.at(-1), allowDefaultExport(TOOL_CONFIG_FILES));
    assert.ok(TOOL_CONFIG_FILES.includes('**/*.config.{js,mjs,cjs,ts,mts,cts}'));
  });

  it('gives tool config and setup files Node globals, from the globals package when passed', () => {
    const nodeBlockOf = (/** @type {ReturnType<typeof build>} */ config) =>
      config.find(
        (block) =>
          block.languageOptions?.globals && block.files?.some((f) => f.includes('.config.')),
      );
    const fallback = nodeBlockOf(build())?.languageOptions?.globals ?? {};
    for (const name of ['__dirname', 'require', 'module', 'process', 'console']) {
      assert.ok(name in fallback, `${name} must be a Node global without the globals package`);
    }
    const node = { Buffer: 'readonly' };
    assert.deepEqual(nodeBlockOf(build({ globals: { node } }))?.languageOptions?.globals, node);
  });

  it('adds no unicorn block when the stack does not pass the plugin', () => {
    const config = build();
    assert.equal(unicornBlockOf(config), undefined);
    const ruleIds = config.flatMap((block) => Object.keys(block.rules ?? {}));
    assert.deepEqual(
      ruleIds.filter((id) => id.startsWith('unicorn/')),
      [],
    );
  });

  it('enables the SonarQube unicorn rules as errors on TS and JS files', () => {
    const unicorn = fakeUnicorn();
    const config = build({ unicorn });
    const block = unicornBlockOf(config);
    assert.ok(block, 'a block must register the unicorn plugin');
    assert.equal(block.plugins?.['unicorn'], unicorn);
    assert.deepEqual(block.files, [...TS_FILES, ...JS_FILES]);
    for (const name of SONAR_UNICORN_RULES.filter((n) => n !== 'no-named-default')) {
      assert.equal(block.rules?.[`unicorn/${name}`], 'error', `unicorn/${name}`);
    }
    assert.ok(
      config.indexOf(block) < config.length - 1,
      'the default-export exemption must stay the last block',
    );
  });

  it('turns no-named-default off: its fix is the default export the house rule bans', () => {
    const block = unicornBlockOf(build({ unicorn: fakeUnicorn() }));
    assert.equal(block?.rules?.['unicorn/no-named-default'], 'off');
  });

  it('resolves a renamed rule both ways', () => {
    assert.ok(SONAR_UNICORN_RULES.includes('no-for-each'));
    const old = fakeUnicorn({ version: '65.0.1', rename: { 'no-for-each': 'no-array-for-each' } });
    assert.equal(unicornRules(old)['unicorn/no-array-for-each'], 'error');
    assert.equal(unicornRules(old)['unicorn/no-for-each'], undefined);
    assert.equal(unicornRules(old, ['no-array-for-each'])['unicorn/no-array-for-each'], 'error');
    assert.equal(
      unicornRules(fakeUnicorn(), ['no-array-for-each'])['unicorn/no-for-each'],
      'error',
    );
  });

  it('skips a deprecated stub for the active name it was renamed to', () => {
    const unicorn = fakeUnicorn({ deprecated: ['no-for-each'] });
    unicorn.rules['no-array-for-each'] = { meta: {} };
    assert.deepEqual(unicornRules(unicorn, ['no-for-each']), {
      'unicorn/no-array-for-each': 'error',
    });
  });

  it('throws, naming the rules and the plugin version, when a rule cannot be resolved', () => {
    const unicorn = fakeUnicorn({
      version: '65.0.1',
      drop: ['prefer-at'],
      deprecated: ['no-thenable'],
    });
    assert.throws(
      () => build({ unicorn }),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /eslint-plugin-unicorn 65\.0\.1/);
        assert.match(error.message, /prefer-at/);
        assert.match(error.message, /no-thenable/);
        assert.match(error.message, /UNICORN_RULE_ALIASES/);
        assert.match(error.message, /UNICORN_RULES_ADDED_AFTER/);
        return true;
      },
    );
  });

  it('skips only the rules listed as newer than the oldest supported unicorn', () => {
    assert.deepEqual(unicornRules(fakeUnicorn(), ['prefer-at'], ['prefer-at']), {
      'unicorn/prefer-at': 'error',
    });
    assert.deepEqual(
      unicornRules(fakeUnicorn({ drop: ['prefer-at'] }), ['prefer-at'], ['prefer-at']),
      {},
    );
    for (const name of UNICORN_RULES_ADDED_AFTER) {
      assert.ok(SONAR_UNICORN_RULES.includes(name), `${name} must be a SonarQube unicorn rule`);
    }
  });

  it('caps positional parameters at three with a selector, as AGENTS.md states', () => {
    const config = build();
    const capped = config.find((block) => !block.files && block.rules?.['no-restricted-syntax']);
    assert.ok(restrictedSyntax().includes(PARAMETER_CAP));
    assert.deepEqual(capped?.rules?.['no-restricted-syntax'], restrictedSyntax());
    assert.match(PARAMETER_CAP.selector, /\[params\.length>3\]/);
    assert.ok(
      config.every(
        (block) =>
          block.rules?.['max-params'] === undefined &&
          block.rules?.['@typescript-eslint/max-params'] === undefined,
      ),
      'max-params stays off: it cannot exempt a constructor taking injected dependencies',
    );
  });

  it('keeps the parameter cap where it lifts the default-export ban', () => {
    assert.deepEqual(allowDefaultExport(['app/**']), {
      files: ['app/**'],
      rules: { 'no-restricted-syntax': ['error', PARAMETER_CAP] },
    });
  });

  it('makes a named function a declaration on TS and JS, as AGENTS.md states', () => {
    const config = build();
    for (const pattern of [...TS_FILES, ...JS_FILES]) {
      const rules = Object.assign({}, ...blocksFor(config, pattern).map((block) => block.rules));
      assert.deepEqual(
        rules['func-style'],
        ['error', 'declaration', { allowArrowFunctions: false, allowTypeAnnotation: true }],
        pattern,
      );
      assert.deepEqual(
        rules['prefer-arrow-callback'],
        ['error', { allowNamedFunctions: false, allowUnboundThis: true }],
        pattern,
      );
    }
  });

  it('lets a call reach a function declared below it, but not a const, class or enum', () => {
    const config = build();
    for (const pattern of [...TS_FILES, ...JS_FILES]) {
      const rules = Object.assign({}, ...blocksFor(config, pattern).map((block) => block.rules));
      assert.equal(rules['no-use-before-define'], 'off', pattern);
      assert.deepEqual(
        rules['@typescript-eslint/no-use-before-define'],
        [
          'error',
          {
            functions: false,
            classes: true,
            variables: true,
            allowNamedExports: false,
            enums: true,
            typedefs: false,
            ignoreTypeReferences: true,
          },
        ],
        pattern,
      );
    }
  });

  it('caps cognitive complexity at 10 and cyclomatic complexity at 15, tests included', () => {
    const complexity = build().find((block) => block.rules?.['max-depth'] !== undefined);
    assert.equal(complexity?.files, undefined);
    assert.equal(complexity?.ignores, undefined);
    assert.deepEqual(complexity?.rules?.['sonarjs/cognitive-complexity'], ['error', 10]);
    assert.deepEqual(complexity?.rules?.['complexity'], ['error', 15]);
  });

  it('caps a function at 50 lines and callbacks at three levels, outside tests', () => {
    const outsideTests = build().find((block) => block.ignores === TEST_FILES);
    assert.deepEqual(outsideTests?.rules?.['max-lines-per-function'], [
      'error',
      { max: 50, skipBlankLines: true, skipComments: true },
    ]);
    assert.deepEqual(outsideTests?.rules?.['max-nested-callbacks'], ['error', 3]);
  });

  it('lets a component function reach 150 lines, after the general cap and still not in tests', () => {
    const config = build();
    const general = config.findIndex((block) => block.ignores === TEST_FILES);
    const components = config.findIndex((block) => block.files === COMPONENT_FILES);
    assert.ok(components > general, 'the component block comes after the general cap');
    assert.equal(config[components]?.ignores, TEST_FILES);
    assert.deepEqual(config[components]?.rules?.['max-lines-per-function'], [
      'error',
      { max: 150, skipBlankLines: true, skipComments: true },
    ]);
  });

  it('fails on a disable comment that no longer silences anything', () => {
    const options = build().find((block) => block.linterOptions !== undefined);
    assert.deepEqual(options, { linterOptions: { reportUnusedDisableDirectives: 'error' } });
  });

  it('fails every stack lint run on a single warning', () => {
    const violations = repoFiles()
      .filter((path) => /^apps\/[^/]+\/package\.json$/.test(path))
      .flatMap((path) => {
        const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
        const commands = [
          ...Object.entries(manifest.scripts ?? {}),
          ...Object.entries(manifest['lint-staged'] ?? {}).flatMap(([glob, tasks]) =>
            [tasks].flat().map((task) => [`lint-staged ${glob}`, task]),
          ),
        ];
        return commands
          .filter(([, command]) => RUNS_ESLINT.test(command) && !/--max-warnings=0\b/.test(command))
          .map(
            ([name, command]) => `${path}: "${name}" runs "${command}" without --max-warnings=0`,
          );
      });
    assert.deepEqual(violations, []);
  });

  it('is extended by every stack ESLint config', () => {
    const configs = repoFiles().filter((path) =>
      /^apps\/[^/]+\/eslint\.config\.[cm]?[jt]s$/.test(path),
    );
    const violations = configs
      .filter(
        (path) => !/tools\/eslint\/base\.mjs['"]/.test(readFileSync(join(root, path), 'utf8')),
      )
      .map((path) => `${path}: spread sharedConfig() from tools/eslint/base.mjs into the config`);
    assert.deepEqual(violations, []);
  });
});
