# <Title> — Design

Date: YYYY-MM-DD
Status: Draft | Approved
Branch: feat/<topic>

## 1. Purpose

One paragraph: what problem this solves and for whom. If you can't write it in one
paragraph, the scope is too big — decompose first.

## 2. Scope

- In scope: …
- Out of scope (explicitly): …

## 3. Architecture & structure

Which layers/files are touched or created, and the responsibility of each. Show the data
flow. For each new unit answer: what does it do, how do you use it, what does it depend on?

## 4. Data & boundaries

Every new shape crossing a boundary, with its zod schema sketch. Where is it validated?
What is the safe default on parse failure?

## 5. Error handling

What can fail, where it is caught, what the user sees.

## 6. Testing

Which behaviors get vitest coverage, which get component/integration tests, and the edge
cases (`""`, `"a"`, `"!!!"`, emoji, very long input, …).

## 7. Open questions / decisions taken

Decisions made during brainstorming, with the rejected alternatives and why.
