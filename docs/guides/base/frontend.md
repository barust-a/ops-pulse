# Front-end: accessibility, internationalization and React

Read when: building or reviewing UI code.

Related guides:
- Performance and Web Vitals → `performance.md` (Web front-ends).
- UI tests → `testing.md` (Frontend and E2E).
- XSS, CSRF and CORS → `security.md`.

Project rules in `AGENTS.md` override this file.

## Accessibility (target: WCAG 2.2 AA)

- **Use semantic HTML first.**
  - `<button>` for actions, `<a href>` for navigation, `<label>` for every input.
  - Landmarks (`<main>`, `<nav>`, `<header>`) and headings in order.
- **ARIA only when no native element has the semantics you need** (the first rule of ARIA). Wrong ARIA is worse than none.
- **Names and text alternatives:**
  - Every control has an accessible name.
  - Images have `alt` text; decorative images get an empty `alt=""`.
  - Errors are described in text, not by color alone, and linked to their field.
- **Keyboard and focus:**
  - Everything works with the keyboard, with a visible focus indicator.
  - Dialogs: move focus in, keep it inside, and restore it on close.
  - Move focus sensibly on route changes.
- **Contrast:** 4.5:1 for text; 3:1 for large text and UI components.
- **Criteria new in WCAG 2.2:**
  - focus not obscured (2.4.11);
  - a single-pointer alternative to dragging (2.5.7);
  - targets at least 24×24 CSS px (2.5.8);
  - consistent help (3.2.6);
  - no redundant entry (3.3.7);
  - accessible authentication (3.3.8): no cognitive tests; allow paste and password managers.
- **Test with role-based queries** (`getByRole`). If a test can't find an element by role and name, a screen reader can't either.

## Internationalization

- **Never concatenate translated fragments.** Write one message per sentence, with named placeholders (ICU MessageFormat).
- **Plurals and variants:** use `plural`/`select` with an `other` branch, never `count === 1 ? … : …`.
- **Formatting:** format dates, numbers, currencies, lists and relative times with `Intl.*` in the user's locale. Store instants in UTC and convert only for display.
- **Text handling:**
  - `.length` counts UTF-16 code units; use `Intl.Segmenter` for the characters users see.
  - Normalize text (`normalize("NFC")`) before comparing or storing it.
  - Sort with `Intl.Collator`.
- **Layout:** use CSS logical properties (`margin-inline-start`) so right-to-left layouts work. Don't bake text into images.
- **Message catalogs:** keep UI strings in catalogs, not scattered literals.

## React

- **Rendering is a pure function of props and state.**
  - Derive values during render instead of syncing them into state.
  - Never mutate props or state.
- **Effects only synchronize with external systems** (subscriptions, timers, non-React widgets), and each one has cleanup. Not effects (react.dev, *You Might Not Need an Effect*):
  - transforming data for rendering → compute it during render;
  - responding to a user event → do it in the handler;
  - resetting state → use a `key`.
- **Server data:**
  - Fetch through the framework's data loading or a client cache (TanStack Query, SWR, router loaders), not ad-hoc effects.
  - If you must fetch in an effect, handle cleanup and races.
- **Keys:** stable, unique keys from the data. Never use array indexes for lists that can reorder.
- **Rules of Hooks**, enforced with `eslint-plugin-react-hooks`.
- **Compose; don't inherit.** Customize with props, `children` and function props. The React team has found no use case for component inheritance hierarchies.
- **Custom hooks** (`useOnlineStatus`, not `useMount`):
  - share stateful logic, never the state itself;
  - give each a specific purpose;
  - don't extract one for every small duplication.
- **Compound components** (`<Tabs>` + `<Tabs.Panel>`) share implicit state through Context, not `cloneElement`.
- **New code reuses logic with hooks,** not container/presentational splits, HOCs or render props.
- **Naming:** event-handler props are `onX`; their implementations are `handleX`.
- **Memoization:**
  - React Compiler (stable since October 2025) memoizes automatically.
  - Without it, use `useMemo`, `useCallback` and `memo` only after measuring: about 1 ms or more under CPU throttling, in a production build.
  - They are performance hints. Correctness must never depend on them.

## Component structure

The goal is code that reads like the screen: someone looking at a screen or its mock-up finds the code of any zone by its name, and a component's JSX shows which zones it is made of, in screen order.

- **Start from the screen.** Draw a box around each zone of the screen or mock-up and name it; those names become the components (react.dev, *Thinking in React*).
- **When to extract a part:**
  - Extract a zone that needs only a few values and callbacks from the parent.
  - Keep the markup in the parent when the zone is bound to the parent's state, derived values and handlers, so that extracting it would hand most of that logic down. Put a comment above it saying what it shows on screen.
  - A zone takes its own logic with it: data that only one zone uses is fetched in that zone; the parent keeps what several zones share.
  - State lives in the closest common parent of the components that read it, and goes down as a value and its setter.
  - Signs a split is due: a component past about 80 lines, JSX nested more than about five levels, a run of conditionals in the markup, a block whose shape repeats, more than about six props (split it, or pass `children`).
  - Don't split for its own sake. A part you can't name after what it shows, in one noun phrase, is the wrong cut (`Part1`, `Wrapper`, `Section2`).
  - A function that calls no hook is not named `useX`.
- **Where parts live:**
  - In the screen's own file while only that screen uses them, declared at module top level. **Never declare a component inside another component**: it is a new type on every render, so React remounts it and loses its state.
  - Helpers and parts first, in the order they appear on screen; the exported component last.
  - One exported component per file. A file nearing the size cap moves its largest part to its own file.
  - Props are an `interface XProps` with `readonly` fields, destructured in the signature; a part with one or two props may type them inline.
  - A vendored UI-kit component (shadcn/ui and the like) gets a variant rather than a restyle at each use.
- **Names and comments:**
  - A part is named after the zone it draws: `SubjectField`, `FolderChecklist`, `FormActions`.
  - Each part has a one-line JSDoc saying what it draws and quoting the text the screen shows, so searching the code for on-screen text lands on the part.
  - Logic kept in the parent gets a comment saying what it changes on screen, never a narration of the code.
- **Markup:**
  - Conditional markup is `cond ? <X /> : null`, never `cond && <X />`: a `0` on the left renders as "0".
  - A part with nothing to show returns `null` early.
  - No nested ternaries: past one condition, move the choice into a part with early returns.
  - Exclusive states: early returns in one part. Independent states: separate conditionals, with a comment when it isn't obvious why they can show together. **In a refactor, keep the original's shape**: sibling conditionals give each state its own DOM node, early returns give them one node that React reuses when the state flips, which reorders its attributes and keeps its focus.
  - A class string written for the third time names something: a part, or a variant of the component.
- **What lint can't see.** Complexity and nesting rules catch part of this, but `max-lines-per-function` rules usually exempt React components, and no rule catches repeated JSX or class strings: those are the author's and the reviewer's job.
- **Finding the code behind a zone:** React DevTools, *Components* tab; hovering a component highlights its zone. It only helps when the zones are components with real names.
