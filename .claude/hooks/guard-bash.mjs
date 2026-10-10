// Claude Code PreToolUse hook for Bash: refuses git commands that bypass the pre-commit gates
// or rewrite remote history. Reads the hook JSON on stdin; exit 2 blocks the call and shows
// stderr to Claude. Plain Node, no shell logic: the same file runs under Git Bash on Windows.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BYPASS =
  'Pre-commit gates are law (AGENTS.md §4): fix what the hook reports instead of bypassing it.';
const FORCE_PUSH = "Force-push needs the owner's explicit approval: ask them.";

const WRAPPERS = new Set(['env', 'command', 'sudo', 'time', 'nohup', 'nice', 'exec', 'xargs']);
// Global git options whose value is the next word when not attached with `=`.
const GIT_GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);
// Per-subcommand options that take a value, so the value word is never read as a flag.
const SHORT_WITH_VALUE = { commit: 'mFcCtuS', push: 'o' };
const LONG_WITH_VALUE = {
  commit: new Set([
    '--message',
    '--file',
    '--author',
    '--date',
    '--template',
    '--reuse-message',
    '--reedit-message',
    '--fixup',
    '--squash',
    '--cleanup',
    '--trailer',
    '--pathspec-from-file',
  ]),
  push: new Set(['--push-option', '--repo', '--receive-pack', '--exec']),
};

/** Removes here-document bodies, which are data (often a commit message), not commands. */
function stripHeredocs(command) {
  const kept = [];
  const pending = [];
  for (const line of command.split('\n')) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(/(?<!<)<<-?\s*(['"]?)([\w.-]+)\1/g)) {
      if (match[2] !== undefined) pending.push(match[2]);
    }
  }
  return kept.join('\n');
}

/** Splits a shell command into simple commands, each a list of unquoted words. */
function splitCommands(command) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === ' ' || char === '\t') {
      endWord();
    } else if ('\n;&|()`'.includes(char)) {
      endCommand();
    } else if (char === '#' && !inWord) {
      const newline = command.indexOf('\n', index);
      index = newline === -1 ? command.length : newline - 1;
    } else if (char === '\\') {
      index++;
      if (command[index] !== '\n' && index < command.length) word += command[index];
      inWord = true;
    } else if (char === "'") {
      const close = command.indexOf("'", index + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(index + 1, end);
      index = end;
      inWord = true;
    } else if (char === '"') {
      index++;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === '\\' && '"\\$`\n'.includes(command[index + 1] ?? '')) index++;
        word += command[index];
        index++;
      }
      inWord = true;
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const isGit = (word) => /^git(\.exe)?$/i.test(word.split(/[\\/]/).pop() ?? '');
const isAssignment = (word) => /^[A-Za-z_]\w*=/.test(word);

/** Returns the git invocation of a simple command, or null when it does not run git. */
function parseGit(words) {
  const env = [];
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (isAssignment(word)) env.push(word);
    else if (!WRAPPERS.has(word) && !(index > 0 && word.startsWith('-'))) break;
    index++;
  }
  if (index >= words.length || !isGit(words[index])) return null;
  index++;
  const config = [];
  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index];
    if (GIT_GLOBAL_WITH_VALUE.has(option)) {
      if (option === '-c') config.push(words[index + 1] ?? '');
      index += 2;
    } else {
      index++;
    }
  }
  return { env, config, subcommand: words[index] ?? '', args: words.slice(index + 1) };
}

/** Flags and positional words of a subcommand, option values left out. */
function readArgs(subcommand, args) {
  const shortWithValue = SHORT_WITH_VALUE[subcommand] ?? '';
  const longWithValue = LONG_WITH_VALUE[subcommand] ?? new Set();
  const flags = [];
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      flags.push(arg);
      if (longWithValue.has(arg)) index++;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at++) {
        flags.push(`-${arg[at]}`);
        if (shortWithValue.includes(arg[at])) {
          if (at === arg.length - 1) index++;
          break;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function checkGit({ env, config, subcommand, args }) {
  const { flags, positionals } = readArgs(subcommand, args);
  if (env.some((assignment) => /^HUSKY=0$/.test(assignment))) return BYPASS;
  if (config.some((setting) => /^core\.hookspath=/i.test(setting))) return BYPASS;
  if (flags.includes('--no-verify')) return BYPASS;
  if (subcommand === 'commit' && flags.includes('-n')) return BYPASS;
  if (subcommand === 'push') {
    const forced = flags.some(
      (flag) => flag === '-f' || flag === '--force' || flag.startsWith('--force-with-lease'),
    );
    if (forced || positionals.some((refspec) => refspec.startsWith('+'))) return FORCE_PUSH;
  }
  return null;
}

/**
 * @param {string} command
 * @returns {string | null} why the command is refused, or null to let it run
 */
export function checkCommand(command) {
  for (const words of splitCommands(stripHeredocs(command))) {
    const git = parseGit(words);
    const reason = git && checkGit(git);
    if (reason) return reason;
  }
  return null;
}

function main() {
  let command;
  try {
    command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
  } catch {
    return 0;
  }
  if (typeof command !== 'string') return 0;
  const reason = checkCommand(command);
  if (reason === null) return 0;
  process.stderr.write(`${reason}\n`);
  return 2;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main();
