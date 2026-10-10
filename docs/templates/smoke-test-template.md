# <Feature> — Smoke Test

Feature: one-line description.
Branch: `feat/<topic>` @ `<commit>`
Date: YYYY-MM-DD

## 0. Launch

```bash
cd <app>
npm install        # only if deps changed
npx expo run:ios   # or the stack's exact launch command
```

Expected: app boots to <screen>, no red screen, no console errors.

## 1. <Main happy path>

| Step | Action | Expected (EXACT on-screen text/value) |
|------|--------|----------------------------------------|
| 1.1  | Tap …  | Button label reads `…`                 |
| 1.2  | Type `concrete seed input` | Output shows `exact expected output` |

## 2. <Second case>

(Repeat the table pattern. Use concrete seed data — real names/refs, not "some text".
If no fitting demo data exists, add minimal demo data to the project's seed first.)

## 3. Edge cases

| Input | Expected |
|-------|----------|
| `""` (empty) | … |
| `"!!!"` | … |
| emoji | … |

## 4. Regression

What previously-working flows to re-check, with their exact expected text.

## Pass criteria

- All tables above match exactly.
- `npm test` → `<N> passed` (exact count), `npm run test:native` → `<M> passed`,
  `npm run typecheck` + `npm run lint` clean.
