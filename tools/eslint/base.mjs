// Stack-agnostic ESLint rules every stack extends, so all TypeScript and JavaScript in a
// project follows the same rules. The repository root has no node_modules, so this file
// imports no package: each stack passes in the plugins it installed.

/**
 * @typedef {'off' | 'warn' | 'error' | 0 | 1 | 2} Severity
 * @typedef {Severity | [Severity, ...unknown[]]} RuleEntry
 * @typedef {Record<string, boolean | 'readonly' | 'writable' | 'writeable' | 'off'>} Globals
 * @typedef {{ selector: string, message: string }} RestrictedSyntax
 * @typedef {{
 *   name?: string,
 *   linterOptions?: { reportUnusedDisableDirectives?: Severity },
 *   files?: string[],
 *   ignores?: string[],
 *   extends?: unknown[],
 *   plugins?: Record<string, unknown>,
 *   languageOptions?: { globals?: Globals, parserOptions?: Record<string, unknown> },
 *   rules?: Record<string, RuleEntry>,
 * }} ConfigBlock
 * @typedef {{
 *   configs: {
 *     strictTypeChecked: unknown,
 *     stylisticTypeChecked: unknown,
 *     disableTypeChecked: unknown,
 *   },
 * }} TsEslint the `typescript-eslint` package
 * @typedef {{ configs: { recommended: unknown } }} SonarJs the `eslint-plugin-sonarjs` package
 * @typedef {{ node: Globals }} GlobalsPackage the `globals` package
 * @typedef {{
 *   meta?: { version?: string },
 *   rules: Record<string, { meta?: { deprecated?: unknown } }>,
 * }} Unicorn the `eslint-plugin-unicorn` package
 */

export const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
export const JS_FILES = ['**/*.{js,mjs,cjs,jsx}'];
export const TEST_FILES = ['**/*.{test,spec}.*'];
/** Files that hold components, where a long JSX return is markup rather than logic. */
export const COMPONENT_FILES = ['**/*.{tsx,jsx}'];
// Tools load their config files through the default export.
export const TOOL_CONFIG_FILES = ['**/*.config.{js,mjs,cjs,ts,mts,cts}'];
// Plain JS run by Node rather than bundled for the app.
export const NODE_SCRIPT_FILES = ['**/*.config.{js,mjs,cjs}', '**/*.setup.{js,mjs,cjs}'];

/** @type {Globals} The Node globals config and setup files use, when `globals` is not passed. */
export const NODE_GLOBALS = {
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  exports: 'writable',
  module: 'readonly',
  process: 'readonly',
  require: 'readonly',
};

const NO_DEFAULT_EXPORT_MESSAGE =
  'Use a named export (AGENTS.md §3). Files a framework requires to default-export are exempted in the stack ESLint config.';

/** @type {RestrictedSyntax[]} */
export const NO_DEFAULT_EXPORT = [
  { selector: 'ExportDefaultDeclaration', message: NO_DEFAULT_EXPORT_MESSAGE },
  { selector: "ExportSpecifier[exported.name='default']", message: NO_DEFAULT_EXPORT_MESSAGE },
];

/**
 * AGENTS.md §3: more than three positional parameters take an options object. A selector rather
 * than `max-params`, which cannot exempt a constructor taking its injected dependencies
 * positionally. A TypeScript `this` parameter types the receiver and is no argument, so a fourth
 * entry after it is allowed. Test runners spread each `it.each` table row into its callback, so
 * those callbacks are exempt too.
 * @type {RestrictedSyntax}
 */
export const PARAMETER_CAP = {
  selector: [
    ':matches(:function, TSDeclareFunction, TSEmptyBodyFunctionExpression, TSFunctionType,',
    ' TSMethodSignature)[params.length>3]',
    ":not([params.length=4][params.0.name='this'])",
    ":not(MethodDefinition[kind='constructor'] > FunctionExpression)",
    ":not(CallExpression[callee.callee.property.name='each'] > :function)",
  ].join(''),
  message:
    'More than three positional parameters: take one options object, a named type destructured ' +
    'in the signature (AGENTS.md §3).',
};

/**
 * The `no-restricted-syntax` entry with the default-export ban, the parameter cap and a stack's
 * own selectors.
 * A later block's `no-restricted-syntax` replaces the earlier selectors for the files it matches,
 * so a stack adding selectors must go through this to keep the ban.
 * @param {...RestrictedSyntax} extraSelectors
 * @returns {['error', ...RestrictedSyntax[]]}
 */
export function restrictedSyntax(...extraSelectors) {
  return ['error', ...NO_DEFAULT_EXPORT, PARAMETER_CAP, ...extraSelectors];
}

/**
 * A block lifting the default-export ban for files a framework or tool loads through their
 * default export; the parameter cap still applies. Place it after every block that sets
 * `no-restricted-syntax` for those files.
 * @param {string[]} files
 * @returns {ConfigBlock}
 */
export function allowDefaultExport(files) {
  return { files, rules: { 'no-restricted-syntax': ['error', PARAMETER_CAP] } };
}

/**
 * Rules shared by TS and JS that need no type information.
 * @type {Record<string, RuleEntry>}
 */
const SYNTACTIC_RULES = {
  'no-shadow': 'off',
  '@typescript-eslint/no-shadow': 'error',
  // AGENTS.md §3: a named function is a `function` declaration. Arrows stay for callbacks,
  // closures over the outer `this` (func-style skips those itself) and consts typed by a named
  // function type, which a declaration cannot carry. allowTypeAnnotation needs ESLint ≥ 9.28.
  'func-style': ['error', 'declaration', { allowArrowFunctions: false, allowTypeAnnotation: true }],
  'prefer-arrow-callback': ['error', { allowNamedFunctions: false, allowUnboundThis: true }],
  // Declarations hoist, so a call may reach a function declared further down; a const, class or
  // enum read above its definition is reported, even from inside a function.
  'no-use-before-define': 'off',
  '@typescript-eslint/no-use-before-define': [
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
};

// The unicorn rules SonarQube runs unchanged as its own (S7718–S7787, listed in the
// eslint-plugin-sonarjs README), never unicorn's whole recommended set: that one also bans
// `null` and renames files and identifiers wholesale. S7728 ("for…of, not forEach") is
// `no-for-each` since unicorn 76; the sonarjs README still gives its old `no-array-for-each`.
export const SONAR_UNICORN_RULES = [
  'catch-error-name',
  'consistent-date-clone',
  'consistent-empty-array-spread',
  'consistent-function-scoping',
  'dom-node-dataset',
  'error-message',
  'new-for-builtins',
  'no-abusive-eslint-disable',
  'no-accessor-recursion',
  'no-anonymous-default-export',
  'no-array-callback-reference',
  'no-array-method-this-argument',
  'no-await-expression-member',
  'no-for-each',
  'no-for-loop',
  'no-instanceof-builtins',
  'no-invalid-fetch-options',
  'no-named-default',
  'no-negated-condition',
  'no-negation-in-equality-check',
  'no-object-as-default-parameter',
  'no-single-promise-in-promise-methods',
  'no-thenable',
  'no-this-assignment',
  'no-typeof-undefined',
  'no-unnecessary-polyfills',
  'no-unreadable-iife',
  'no-useless-fallback-in-spread',
  'no-useless-length-check',
  'no-useless-promise-resolve-reject',
  'no-useless-spread',
  'no-zero-fractions',
  'numeric-separators-style',
  'prefer-array-find',
  'prefer-array-flat',
  'prefer-array-flat-map',
  'prefer-array-index-of',
  'prefer-array-some',
  'prefer-at',
  'prefer-blob-reading-methods',
  'prefer-class-fields',
  'prefer-code-point',
  'prefer-date-now',
  'prefer-default-parameters',
  'prefer-dom-node-remove',
  'prefer-export-from',
  'prefer-global-this',
  'prefer-includes',
  'prefer-math-min-max',
  'prefer-math-trunc',
  'prefer-modern-dom-apis',
  'prefer-modern-math-apis',
  'prefer-native-coercion-functions',
  'prefer-negative-index',
  'prefer-node-protocol',
  'prefer-number-properties',
  'prefer-prototype-methods',
  'prefer-regexp-test',
  'prefer-set-has',
  'prefer-set-size',
  'prefer-single-call',
  'prefer-string-raw',
  'prefer-string-replace-all',
  'prefer-string-trim-start-end',
  'prefer-structured-clone',
  'prefer-top-level-await',
  'prefer-type-error',
  'require-module-specifiers',
];

/**
 * Names one rule carries in different unicorn releases, each mapped to its other names. Unicorn
 * 76 removed `no-array-for-each` outright, with no deprecated stub, in favour of `no-for-each`.
 * Every other SONAR_UNICORN_RULES name is the same in 65.0.1 (the last release for ESLint 9)
 * and 77.0.0.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const UNICORN_RULE_ALIASES = {
  'no-for-each': ['no-array-for-each'],
  'no-array-for-each': ['no-for-each'],
};

/**
 * SONAR_UNICORN_RULES entries newer than unicorn 65.0.1, which a stack on that release skips.
 * Any other name the installed plugin lacks throws, so a rename never silently drops a rule.
 * Empty while 65.0.1 has every rule on the list.
 * @type {readonly string[]}
 */
export const UNICORN_RULES_ADDED_AFTER = [];

/**
 * The given unicorn rules as errors, each under the name the installed plugin uses for it.
 * Deprecated rules are no-op stubs, so a name only resolves to an active rule.
 * @param {Unicorn} unicorn
 * @param {readonly string[]} [names]
 * @param {readonly string[]} [addedAfter] names the plugin may lack, skipped when it does
 * @returns {Record<string, 'error'>}
 */
export function unicornRules(
  unicorn,
  names = SONAR_UNICORN_RULES,
  addedAfter = UNICORN_RULES_ADDED_AFTER,
) {
  const isActive = (/** @type {string} */ id) =>
    Object.hasOwn(unicorn.rules, id) && !unicorn.rules[id]?.meta?.deprecated;
  /** @type {Record<string, 'error'>} */
  const rules = {};
  const unresolved = [];
  for (const name of names) {
    const id = [name, ...(UNICORN_RULE_ALIASES[name] ?? [])].find(isActive);
    if (id) rules[`unicorn/${id}`] = 'error';
    else if (!addedAfter.includes(name)) unresolved.push(name);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `eslint-plugin-unicorn ${unicorn.meta?.version ?? '(unknown version)'} has no active rule ` +
        `under any known name for: ${unresolved.join(', ')}. In tools/eslint/base.mjs, add the ` +
        `new name to UNICORN_RULE_ALIASES if unicorn renamed the rule, or the rule to ` +
        `UNICORN_RULES_ADDED_AFTER if it is newer than the oldest unicorn a stack installs.`,
    );
  }
  return rules;
}

/**
 * @param {Unicorn} unicorn
 * @returns {ConfigBlock}
 */
function unicornBlock(unicorn) {
  return {
    files: [...TS_FILES, ...JS_FILES],
    plugins: { unicorn },
    rules: {
      ...unicornRules(unicorn),
      // Its fix for `export { x as default }` is `export default x`, the opposite of the
      // default-export ban; `no-restricted-syntax` already reports the line, with the right fix.
      'unicorn/no-named-default': 'off',
    },
  };
}

/**
 * The shared flat-config blocks. Spread the result into `defineConfig([...])` from
 * `eslint/config`: the blocks use its `extends` key.
 * @param {{
 *   tseslint: TsEslint,
 *   sonarjs: SonarJs,
 *   globals?: GlobalsPackage,
 *   unicorn?: Unicorn,
 *   tsconfigRootDir: string,
 * }} options `tsconfigRootDir` is the folder holding the stack's tsconfig.json.
 * @returns {ConfigBlock[]}
 */
export function sharedConfig({ tseslint, sonarjs, globals, unicorn, tsconfigRootDir }) {
  const { strictTypeChecked, stylisticTypeChecked, disableTypeChecked } = tseslint.configs;
  return [
    // A disable comment that no longer silences anything hides nothing and misleads the reader;
    // ESLint only warns about it by default.
    { linterOptions: { reportUnusedDisableDirectives: 'error' } },
    {
      files: TS_FILES,
      extends: [strictTypeChecked, stylisticTypeChecked],
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: {
        ...SYNTACTIC_RULES,
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        // No `as T` (AGENTS.md §9): a type guard, a zod parse or a throwing assert helper proves
        // the type instead. `as const` stays allowed.
        '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
        // Its fix rewrites `x as T` into `x!`, which strictTypeChecked forbids.
        '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      },
    },
    {
      files: JS_FILES,
      extends: [strictTypeChecked, stylisticTypeChecked, disableTypeChecked],
      rules: {
        ...SYNTACTIC_RULES,
        // typescript-eslint turns these on for TS files only; the compiler covers no-undef there.
        'no-undef': 'error',
        'no-var': 'error',
        'prefer-const': 'error',
        'prefer-rest-params': 'error',
        'prefer-spread': 'error',
      },
    },
    {
      files: NODE_SCRIPT_FILES,
      languageOptions: { globals: globals?.node ?? NODE_GLOBALS },
    },
    // Complexity and code smells: SonarQube's own JS/TS rules. Cognitive complexity is capped at
    // 10, stricter than Sonar's default of 15, and cyclomatic complexity at 15 (rules below).
    /** @type {ConfigBlock} */ (sonarjs.configs.recommended),
    {
      rules: {
        'max-depth': ['error', 4],
        // Cognitive complexity weighs nesting and measures how hard a function is to read; the
        // cyclomatic cap only catches long, flat functions with many branches.
        'sonarjs/cognitive-complexity': ['error', 10],
        complexity: ['error', 15],
        // Sonar rules its recommended preset leaves off, kept where they catch real mistakes.
        'sonarjs/no-inconsistent-returns': 'error',
        'sonarjs/no-built-in-override': 'error',
        'sonarjs/strings-comparison': 'error',
        'sonarjs/expression-complexity': 'error',
        'sonarjs/no-nested-incdec': 'error',
        'no-restricted-syntax': restrictedSyntax(),
      },
    },
    ...(unicorn ? [unicornBlock(unicorn)] : []),
    {
      ignores: TEST_FILES,
      rules: {
        'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
        // Small units (AGENTS.md §3). Blank lines and comments do not count, so documenting a
        // function never fails the build. Tests are out: long arrange/act/assert blocks and
        // describe/it nesting are their natural shape.
        'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
        'max-nested-callbacks': ['error', 3],
        // A literal repeated in production code wants a name; in a test, repetition reads better.
        'sonarjs/no-duplicate-string': 'error',
      },
    },
    {
      // A long JSX return is markup, not logic: cognitive complexity still catches a component
      // that does too much.
      files: COMPONENT_FILES,
      ignores: TEST_FILES,
      rules: {
        'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
      },
    },
    allowDefaultExport(TOOL_CONFIG_FILES),
  ];
}
