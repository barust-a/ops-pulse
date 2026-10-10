# <Feature Name> Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One sentence describing what this builds.

**Architecture:** 2–3 sentences about the approach.

**Tech Stack:** Key technologies/libraries.

## Global Constraints

- Project-wide requirements, one line each, with exact values copied from the spec.
- Every task's requirements implicitly include this section.

---

### Task 1: <Component Name>

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:123-145`
- Test: `exact/path/to/file.test.ts`

**Interfaces:**
- Consumes: exact signatures from earlier tasks
- Produces: exact function names, parameter and return types later tasks rely on

- [ ] **Step 1: Write the failing test**

```ts
it('does the specific behavior', () => {
  expect(fn(input)).toEqual(expected);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`npm test -- file.test.ts`, fails with "fn is not defined")

- [ ] **Step 3: Minimal implementation** (show the actual code)

- [ ] **Step 4: Run it — expect PASS**

- [ ] **Step 5: Commit** (`git commit -m "feat: <specific thing>"`)

<!-- No placeholders: no TBD/TODO, no "add appropriate error handling", no "similar to
Task N". Every step shows real code, real commands, real expected output. -->
