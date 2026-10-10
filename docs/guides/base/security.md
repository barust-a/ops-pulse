# Security, dependencies and configuration

**Read this when:**
- handling input from outside the process;
- working on authentication or authorization;
- handling secrets;
- handling URLs, file paths or HTML that come from users;
- writing crypto code;
- adding or updating a dependency;
- changing configuration.

Project rules in `AGENTS.md` override this file.

## Rules that always apply

1. **All external input is untrusted.** That includes HTTP requests, files, environment, DB rows, queues, third-party responses, and LLM and tool output.
   - Validate it on the server, at the boundary, with allow-lists.
   - Validation does not replace parameterization and encoding.
2. **Never build SQL, shell commands, HTML, regexes or URLs** by concatenating untrusted data.
3. **Check authorization on the server**, on every request, for the specific object requested.
   - Deny by default.
   - Fail closed when a check errors.
4. **Secrets never appear in** code, version control, client bundles, logs, error messages, fixtures or snapshots.
5. **Never add a package** without confirming it exists under that exact name and is the one you meant. Ask before adding any dependency.
6. **Send generic errors to clients.** Keep details and stack traces in server logs.

## OWASP Top 10:2025

| ID | Category |
|---|---|
| A01 | Broken Access Control (SSRF now included) |
| A02 | Security Misconfiguration |
| A03 | Software Supply Chain Failures |
| A04 | Cryptographic Failures |
| A05 | Injection |
| A06 | Insecure Design |
| A07 | Authentication Failures |
| A08 | Software or Data Integrity Failures |
| A09 | Security Logging and Alerting Failures |
| A10 | Mishandling of Exceptional Conditions (including failing open) |

## Input and injection

- **Allow-list** type, length, range and format, then add semantic checks.
  - Reject anything outside the rules; don't try to recognize every malicious string.
  - Limit request body size before parsing.
  - Client-side checks are for user experience only.
- **SQL:** use parameterized queries, tagged-template query builders, or an ORM's parameter binding. Never build SQL by string concatenation.
- **Processes:** use `execFile`/`spawn` with an argument array. `exec` with interpolated strings runs through `/bin/sh`.
- **Regex:**
  - Escape user text before building a regex from it (`RegExp.escape`).
  - On untrusted input, avoid nested or overlapping quantifiers and backreferences (ReDoS).
  - Cap the input length and anchor the match.
- **Never use** `eval`, `new Function` or string-form `setTimeout`. `node:vm` is not a security boundary.

## Output and the browser

- **XSS:**
  - Rely on the framework's automatic escaping.
  - Treat every escape hatch as a review blocker: `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`, `bypassSecurityTrust*`, `v-html`.
  - Write text with `textContent`.
  - When HTML is unavoidable, sanitize it with DOMPurify and don't modify it afterwards.
  - Block `javascript:` URLs: validate user-supplied links with `z.httpUrl()` (Zod 4); `z.url()` accepts `javascript:`.
  - CSP is a second layer, not a substitute for encoding.
- **CSRF:** cookie-authenticated, state-changing requests need a CSRF token. `SameSite` cookies help, but they do not replace the token.
- **CORS:** allow-list origins. Never reflect an arbitrary `Origin`, and never use `*` with credentials.
- **Security headers:** set them, for example with `helmet` in Node.

## Authentication and authorization

- Route every permission decision through one policy function, such as `can(actor, action, resource)`.
- Check ownership of the object (IDOR). Hard-to-guess IDs are not authorization.
- Unit-test the authorization rules, including the deny paths.
- Rate-limit authentication and expensive endpoints.
- Hash passwords with Argon2id (or bcrypt/scrypt) through a vetted library.
- Generate tokens with a CSPRNG (`crypto.randomUUID`, `crypto.getRandomValues`), never `Math.random`.

## Secrets

- Load secrets from a secret manager, or from injected files or environment.
  - Prefer short-lived credentials, and rotate them.
  - Environment variables are visible to the process tree and can end up in dumps, so prefer mounted secrets for anything sensitive.
- Never log `process.env`, whole config objects, or headers that carry tokens.
- Scan for secrets in pre-commit hooks and in CI.
- If a secret leaks, revoke and rotate it first. Rewriting git history is not enough.
- Litmus test (Twelve-Factor): could the repository be open-sourced right now without exposing a credential?

## User-supplied URLs and paths (SSRF, traversal)

- **Never pass a user-supplied URL straight to an HTTP client.** Instead:
  - allow-list the host and build the request yourself;
  - disable redirects;
  - resolve the host and block loopback, private and link-local ranges (including `169.254.169.254`);
  - connect to the IP you checked, which defeats DNS rebinding.
- **File paths:** map IDs to files rather than accepting paths. If you must accept a path, canonicalize it and verify it stays under the base directory.

## Deserialization and crypto

- Parse untrusted data as JSON, then validate it with a schema. Never use formats or libraries that can execute code or instantiate arbitrary types.
- Never write your own crypto. Use WebCrypto/`node:crypto`, libsodium or Tink, with their recommended defaults.

## JS/TS specifics

- **Prototype pollution:**
  - Never deep-merge, `Object.assign` or set-by-path keys that come from untrusted input.
  - Use a `Map` or `Object.create(null)` for dictionaries.
  - Reject the keys `__proto__`, `constructor` and `prototype`.
  - Parse with schemas that strip unknown keys.
- **npm install scripts:** set `ignore-scripts=true` and allow-list only the packages that need install scripts.

## Supply chain and dependencies

- **Before adding a dependency, check whether the platform or an existing dependency already does the job.** Examples: `fetch`, `URL`, `structuredClone`, `crypto.randomUUID`, `Intl`, `AbortController`, `node:test`.
  - "A little copying is better than a little dependency" (Go proverb, via Russ Cox). This applies to small, non-security code only.
  - Never copy crypto, parsers, sanitizers or time-zone logic. Depend on vetted libraries for those.
- **Evaluate the package, and record why you chose it:**
  - maintenance and issue health;
  - users;
  - security history;
  - license;
  - transitive dependencies;
  - bundle size (for browser code);
  - whether it processes untrusted input.
- **Verify the package exists and is the one you meant** (`npm view <name>`: repository, maintainers, publish dates; downloads on npmjs.com).
  - AI-suggested package names are hallucinated often enough that attackers register them ("slopsquatting").
  - Watch for typosquats.
  - Use scoped names to prevent dependency confusion.
- **Lockfile:** commit it. In CI, install with `npm ci` or `--frozen-lockfile`. Never edit a lockfile by hand.
- **Wrap each third-party library behind a thin adapter you own.** Replacing it then touches one file, and vendor types stay out of the domain.
- **Update continuously, in small steps** (Renovate or Dependabot).
  - Set a minimum release age of 1–3 days for new versions; security fixes skip the wait.
  - Review the new transitive dependencies an upgrade brings.
  - Run `npm audit` and `npm audit signatures`.
- **Versions and hygiene:**
  - Applications pin exact versions through the lockfile; libraries declare semver ranges.
  - Remove unused dependencies.
  - Keep one library per job (not two date libraries).

## Configuration

- **Config is everything that varies between deploys.** Keep it out of the code (Twelve-Factor).
- **Read the environment in one module.** Nothing else reads `process.env`.
- **Validate and type all config at startup, and fail fast.** Name the bad key; never print secret values.
- **No `if (env === 'production')` branches.** Model each behavior as its own setting or feature flag.
- **Defaults:**
  - Give defaults only for safe, non-secret values.
  - Ship a `.env.example` that lists keys with no values.
  - Never commit `.env`.

```ts
import * as z from "zod"; // Zod 4
const Env = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().positive().default(3000),
  SEARCH_V2: z.stringbool().default(false), // z.coerce.boolean().parse("false") is true
});
export type Config = Readonly<z.infer<typeof Env>>;
/** Call once, from main.ts: the only reader of process.env. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Object.freeze(Env.parse(env));
```
