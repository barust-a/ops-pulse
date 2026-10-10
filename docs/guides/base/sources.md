# Sources

The research behind the base guide, grouped by topic and compiled in October 2026. Each entry is a primary source or a reputable summary that was read in full or in its relevant parts. Version facts age, so re-check them.

## Books

- Martin Fowler, *Refactoring: Improving the Design of Existing Code*, 2nd ed. (2018)
- Kent Beck, *Tidy First?* (2023); *Test-Driven Development: By Example* (2002)
- Michael Feathers, *Working Effectively with Legacy Code* (2004)
- Joshua Kerievsky, *Refactoring to Patterns* (2004)
- John Ousterhout, *A Philosophy of Software Design*, 2nd ed. (2021)
- Robert C. Martin, *Clean Code* (2008); *Clean Architecture* (2017)
- Andrew Hunt & David Thomas, *The Pragmatic Programmer*, 20th anniversary ed. (2019)
- Steve McConnell, *Code Complete*, 2nd ed. (2004)
- Gamma, Helm, Johnson & Vlissides, *Design Patterns* (1994)
- Eric Evans, *Domain-Driven Design* (2003); Vaughn Vernon, *Implementing Domain-Driven Design* (2013)
- Martin Fowler, *Patterns of Enterprise Application Architecture* (2002)
- Michael Nygard, *Release It!*, 2nd ed. (2018)
- Winters, Manshreck & Wright, *Software Engineering at Google* (2020) — https://abseil.io/resources/swe-book
- Dan Vanderkam, *Effective TypeScript*, 2nd ed. (2024)
- Felienne Hermans, *The Programmer's Brain* (2021)
- Ford, Parsons, Kua & Sadalage, *Building Evolutionary Architectures*, 2nd ed. (2022)
- Freeman & Pryce, *Growing Object-Oriented Software, Guided by Tests* (2009); Gerard Meszaros, *xUnit Test Patterns* (2007)
- Kernighan & Plauger, *The Elements of Programming Style*, 2nd ed. (1978); Abelson & Sussman, *SICP* (1985)

## Refactoring and legacy code

- Catalog of Refactorings — https://refactoring.com/catalog/
- Fowler, Changes for the 2nd Edition of Refactoring — https://martinfowler.com/articles/refactoring-2nd-changes.html
- Fowler & Beck, Bad Smells in Code (*Refactoring* ch. 3) — https://www.informit.com/articles/article.aspx?p=2952392
- Fowler, CodeSmell · DefinitionOfRefactoring · RefactoringMalapropism · OpportunisticRefactoring · DesignStaminaHypothesis — https://martinfowler.com/bliki/
- Fowler, Workflows of Refactoring — https://martinfowler.com/articles/workflowsOfRefactoring/
- Fowler, An example of preparatory refactoring — https://martinfowler.com/articles/preparatory-refactoring-example.html
- Fowler, Refactoring with Loops and Collection Pipelines — https://martinfowler.com/articles/refactoring-pipelines.html
- Fowler, Is High Quality Software Worth the Cost? — https://martinfowler.com/articles/is-quality-worth-cost.html
- Sato, ParallelChange — https://martinfowler.com/bliki/ParallelChange.html
- Fowler, BranchByAbstraction · StranglerFigApplication — https://martinfowler.com/bliki/BranchByAbstraction.html · https://martinfowler.com/bliki/StranglerFigApplication.html
- Hodgson, Feature Toggles — https://martinfowler.com/articles/feature-toggles.html
- Ellnestam & Brolund, *The Mikado Method*, ch. 1 — https://manning-content.s3.amazonaws.com/download/3/558b9be-92a7-4ebf-90ba-c7fdd830aea7/MikadoMethod_CH01.pdf
- *Software Engineering at Google*, ch. 22, Large-Scale Changes — https://abseil.io/resources/swe-book/html/ch22.html
- Feathers, The Seam Model — https://www.informit.com/articles/article.aspx?p=359417
- Feathers, Characterization Testing — https://michaelfeathers.silvrback.com/characterization-testing
- Beck, *Tidy First?* newsletter — https://tidyfirst.substack.com/
- Industrial Logic, Refactoring to Patterns catalog — https://www.industriallogic.com/refactoring-to-patterns/
- refactoring.guru, Code Smells — https://refactoring.guru/refactoring/smells
- ApprovalTests — https://approvaltests.com/
- VS Code, Refactoring TypeScript — https://code.visualstudio.com/docs/typescript/typescript-refactoring
- Refactoring tools:
  - ts-morph — https://ts-morph.com/
  - jscodeshift — https://github.com/facebook/jscodeshift
  - ast-grep — https://github.com/ast-grep/ast-grep
  - Comby — https://comby.dev/
  - OpenRewrite — https://docs.openrewrite.org/
- Liu et al., LLMs for automated refactoring (safety of LLM refactorings) — https://arxiv.org/abs/2411.04444

## Clean code and principles

- qntm, It's probably time to stop recommending Clean Code — https://qntm.org/clean
- Ousterhout & Martin, APOSD vs Clean Code — https://github.com/johnousterhout/aposd-vs-clean-code
- Fowler bliki — https://martinfowler.com/bliki/:
  - FlagArgument
  - CommandQuerySeparation
  - TellDontAsk
  - Yagni
  - BeckDesignRules
  - FunctionLength
- Campbell, Cognitive Complexity (SonarSource) — https://www.sonarsource.com/docs/CognitiveComplexity.pdf
- Duffy, The Error Model — https://joeduffyblog.com/2016/02/07/the-error-model/
- Shore, Fail Fast — https://martinfowler.com/ieeeSoftware/failFast.pdf
- Pike, Errors are values — https://go.dev/blog/errors-are-values
- Rust Book, To panic! or Not to panic! — https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html
- Metz, The Wrong Abstraction — https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction
- Dodds, AHA Programming — https://kentcdodds.com/blog/aha-programming
- Abramov, Goodbye, Clean Code — https://overreacted.io/goodbye-clean-code/
- Hyrum's Law — https://www.hyrumslaw.com/
- RFC 9413, Maintaining Robust Protocols — https://www.rfc-editor.org/rfc/rfc9413.html
- Atwood, Code Tells You How, Comments Tell You Why — https://blog.codinghorror.com/code-tells-you-how-comments-tell-you-why/
- *The Pragmatic Programmer* tips — https://pragprog.com/tips/
- Hunt & Thomas, DRY — The Evils of Duplication — https://media.pragprog.com/titles/tpp20/dry.pdf
- Hoare, Null References: The Billion Dollar Mistake — https://www.infoq.com/presentations/Null-References-The-Billion-Dollar-Mistake-Tony-Hoare/
- McConnell, *Code Complete 2*, ch. 5 sample — https://ptgmedia.pearsoncmg.com/images/9780735619678/samplepages/9780735619678a.pdf
- Bernhardt, Functional Core, Imperative Shell — https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell
- Go Proverbs — https://go-proverbs.github.io/

## Naming

- Google TypeScript Style Guide, Naming — https://google.github.io/styleguide/tsguide.html#naming
- Go:
  - Code Review Comments — https://go.dev/wiki/CodeReviewComments
  - Effective Go, Names — https://go.dev/doc/effective_go#names
  - Gerrand, What's in a name? — https://go.dev/talks/2014/names.slide
- Rust API Guidelines, Naming — https://rust-lang.github.io/api-guidelines/naming.html
- Swift API Design Guidelines — https://www.swift.org/documentation/api-design-guidelines/
- .NET Framework Design Guidelines, Naming — https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/general-naming-conventions
- PEP 8, Naming Conventions — https://peps.python.org/pep-0008/#naming-conventions
- Kotlin Coding Conventions — https://kotlinlang.org/docs/coding-conventions.html#naming-rules
- Google Java Style, Naming — https://google.github.io/styleguide/javaguide.html#s5-naming
- Google AIP-140, Field names — https://google.aip.dev/140
- Spolsky, Making Wrong Code Look Wrong — https://www.joelonsoftware.com/2005/05/11/making-wrong-code-look-wrong/
- Hilton & Hermans, Naming Guidelines for Professional Programmers — https://ppig.org/files/2017-PPIG-28th-hilton.pdf
- Feitelson et al., How Developers Choose Names — https://arxiv.org/abs/2103.07487
- Hofmeister et al., Shorter Identifier Names Take Longer to Comprehend — https://brains-on-code.github.io/shorter-identifier-names.pdf
- Arnaoudova, Linguistic Antipatterns — https://veneraarnaoudova.com/linguistic-anti-pattern-detector-lapd/LAs/
- Belshee, Naming as a Process — https://www.digdeeproots.com/articles/naming-process/
- Fowler, UbiquitousLanguage — https://martinfowler.com/bliki/UbiquitousLanguage.html

## Architecture and modularity

- Parnas, On the Criteria To Be Used in Decomposing Systems into Modules — https://wstomv.win.tue.nl/edu/2ip30/references/criteria_for_modularization.pdf
- Connascence — https://connascence.io/
- Ousterhout, APOSD 2nd ed., summary of principles and red flags — https://yingang.github.io/aposd2e-zh/en/summary.html
- Martin:
  - The Single Responsibility Principle — https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html
  - The Clean Architecture — https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
  - Screaming Architecture — https://blog.cleancoder.com/uncle-bob/2011/09/30/Screaming-Architecture.html
- North, CUPID — https://dannorth.net/blog/cupid-for-joyful-coding/
- Henney, SOLID Deconstruction — https://accu.org/conf-docs/PDFs_2012/Kevlin_SOLID_Deconstruction.pdf
- Cockburn, Hexagonal Architecture — https://alistair.cockburn.us/hexagonal-architecture/
- Bogard, Vertical Slice Architecture — https://www.jimmybogard.com/vertical-slice-architecture/
- Brown, Modular monolith / package by component — https://simonbrown.je/modular-monolith/
- Fowler, PresentationDomainDataLayering — https://martinfowler.com/bliki/PresentationDomainDataLayering.html
- Grzybek, Modular Monolith: A Primer — https://www.kamilgrzybek.com/blog/posts/modular-monolith-primer
- Shopify, Under Deconstruction: The State of Shopify's Monolith — https://shopify.engineering/shopify-monolith
- Conway's Law — https://www.melconway.com/Home/Conways_Law.html
- Gross, Locality of Behaviour — https://htmx.org/essays/locality-of-behaviour/
- tef, Write code that is easy to delete, not easy to extend — https://programmingisterrible.com/post/139222674273/write-code-that-is-easy-to-delete-not-easy-to
- Hickey, Simple Made Easy (transcript) — https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md
- Zakirullin, Cognitive load is what matters — https://github.com/zakirullin/cognitive-load
- Dodds, Colocation — https://kentcdodds.com/blog/colocation
- Barrel files:
  - TkDodo, Please Stop Using Barrel Files — https://tkdodo.eu/blog/please-stop-using-barrel-files
  - Hagemeister, The barrel file debacle — https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-7/
  - Atlassian, Faster builds by removing barrel files — https://www.atlassian.com/blog/atlassian-engineering/faster-builds-when-removing-barrel-files
- bulletproof-react, Project Structure — https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md
- Boundary and architecture checks:
  - Nx, Enforce Module Boundaries — https://nx.dev/docs/features/enforce-module-boundaries
  - eslint-plugin-boundaries — https://github.com/javierbrea/eslint-plugin-boundaries
  - dependency-cruiser — https://github.com/sverweij/dependency-cruiser
  - ArchUnitTS — https://github.com/LukasNiessen/ArchUnitTS
- Nygard, Documenting Architecture Decisions — https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions

## Design patterns

- Gamma, Design Principles from Design Patterns — https://www.artima.com/articles/design-principles-from-design-patterns
- Norvig, Design Patterns in Dynamic Languages — https://norvig.com/design-patterns/design-patterns.pdf
- refactoring.guru, Design Patterns catalog — https://refactoring.guru/design-patterns/catalog
- patterns.dev — https://www.patterns.dev/
- Wlaschin, Railway Oriented Programming — https://fsharpforfunandprofit.com/rop/
- Wlaschin, Against Railway-Oriented Programming — https://fsharpforfunandprofit.com/posts/against-railway-oriented-programming/
- Minsky, Effective ML Revisited — https://blog.janestreet.com/effective-ml-revisited/
- King, Parse, don't validate — https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/
- Google Testing Blog, Functional Core, Imperative Shell (2025) — https://testing.googleblog.com/2025/10/simplify-your-code-functional-core.html
- Seemann, Dependency rejection — https://blog.ploeh.dk/2017/02/02/dependency-rejection/
- Seemann, Service Locator is an Anti-Pattern — https://blog.ploeh.dk/2010/02/03/ServiceLocatorisanAnti-Pattern/
- Fowler, PoEAA catalog — https://martinfowler.com/eaaCatalog/
- Fowler, AnemicDomainModel — https://martinfowler.com/bliki/AnemicDomainModel.html
- Evans, Domain-Driven Design Reference — https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf
- Vernon, Effective Aggregate Design — https://www.dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_1.pdf
- Brooker, Exponential Backoff And Jitter — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- Brooker, Timeouts, retries, and backoff with jitter — https://d1.awsstatic.com/builderslibrary/pdfs/timeouts-retries-and-backoff-with-jitter.pdf
- Microsoft, Cloud Design Patterns — https://learn.microsoft.com/en-us/azure/architecture/patterns/
- Fowler, CircuitBreaker — https://martinfowler.com/bliki/CircuitBreaker.html
- Richardson (microservices.io):
  - Transactional outbox — https://microservices.io/patterns/data/transactional-outbox.html
  - Saga — https://microservices.io/patterns/data/saga.html
- Stripe, Designing robust and predictable APIs with idempotency — https://stripe.com/blog/idempotency
- Foote & Yoder, Big Ball of Mud — http://www.laputan.org/mud/

## Testing

- Vocke, The Practical Test Pyramid — https://martinfowler.com/articles/practical-test-pyramid.html
- *Software Engineering at Google*, ch. 11–13:
  - ch. 11 — https://abseil.io/resources/swe-book/html/ch11.html
  - ch. 12 — https://abseil.io/resources/swe-book/html/ch12.html
  - ch. 13 — https://abseil.io/resources/swe-book/html/ch13.html
- Beck:
  - Test Desiderata — https://testdesiderata.com/
  - Canon TDD — https://newsletter.kentbeck.com/p/canon-tdd
- Dodds:
  - The Testing Trophy — https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications
  - Effective Snapshot Testing — https://kentcdodds.com/blog/effective-snapshot-testing
- Spotify, Testing of Microservices — https://engineering.atspotify.com/2018/01/testing-of-microservices
- Testing Library:
  - Guiding Principles — https://testing-library.com/docs/guiding-principles
  - Queries — https://testing-library.com/docs/queries/about
- Fowler:
  - Mocks Aren't Stubs — https://martinfowler.com/articles/mocksArentStubs.html
  - Eradicating Non-Determinism in Tests — https://martinfowler.com/articles/nonDeterminism.html
  - TestCoverage — https://martinfowler.com/bliki/TestCoverage.html
- Freeman, Mackinnon, Pryce & Walnes, Mock Roles, not Objects — https://jmock.org/oopsla2004.pdf
- Google Testing Blog, Code Coverage Best Practices — https://testing.googleblog.com/2020/08/code-coverage-best-practices.html
- Stryker, Mutant states and metrics — https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/
- Playwright, Best Practices — https://playwright.dev/docs/best-practices
- fast-check, Why property-based? — https://fast-check.dev/docs/introduction/why-property-based/
- MSW, Philosophy — https://mswjs.io/docs/philosophy
- Pact — https://docs.pact.io/
- Test speed and parallel runs (checked October 2026):
  - Jest, Configuration, CLI and environment variables (30.5) — https://jestjs.io/docs/configuration
  - Jest 30 release notes, barrel files and memory — https://jestjs.io/blog/2025/06/04/jest-30
  - Jest sequencer source, how `--shard` splits and orders files — https://github.com/jestjs/jest/blob/main/packages/jest-test-sequencer/src/index.ts
  - Vitest, Improving Performance — https://vitest.dev/guide/improving-performance
  - Atlassian, Faster builds when removing barrel files (2025) — https://www.atlassian.com/blog/atlassian-engineering/faster-builds-when-removing-barrel-files
  - Goldberg, Speeding up Jest with swc (2022) — https://www.joshuakgoldberg.com/blog/jest-babel-to-swc
  - PostgreSQL, CREATE DATABASE (template databases) — https://www.postgresql.org/docs/current/sql-createdatabase.html

## Performance

- Knuth, Structured Programming with go to Statements (1974) — https://pic.plover.com/knuth-GOTO.pdf
- Pike, Notes on Programming in C — https://www.lysator.liu.se/c/pikestyle.html
- Fowler, TwoHardThings — https://martinfowler.com/bliki/TwoHardThings.html
- Muratori, "Clean" Code, Horrible Performance — https://www.computerenhance.com/p/clean-code-horrible-performance
- Martin & Muratori discussion — https://github.com/unclebob/cmuratori-discussion/blob/main/cleancodeqa.md
- Dean & Barroso, The Tail at Scale — https://www.barroso.org/publications/TheTailAtScale.pdf
- Google SRE Book, Service Level Objectives — https://sre.google/sre-book/service-level-objectives/
- Node.js:
  - Don't Block the Event Loop — https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop
  - Profiling — https://nodejs.org/en/learn/getting-started/profiling
- V8:
  - Fast properties — https://v8.dev/blog/fast-properties
  - Elements kinds — https://v8.dev/blog/elements-kinds
- Benchmarking:
  - mitata — https://github.com/evanwashere/mitata
  - tinybench — https://github.com/tinylibs/tinybench
- Winand, No Offset — https://use-the-index-luke.com/no-offset
- PostgreSQL, Using EXPLAIN — https://www.postgresql.org/docs/current/using-explain.html
- HikariCP, About Pool Sizing — https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing
- DataLoader — https://github.com/graphql/dataloader
- MDN, HTTP caching — https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching
- web.dev, Web Vitals — https://web.dev/articles/vitals
- Russell, The Performance Inequality Gap 2026 — https://infrequently.org/2025/11/performance-inequality-gap-2026/
- React Compiler v1.0 — https://react.dev/blog/2025/10/07/react-compiler-1

## Security, dependencies, configuration

- OWASP Top 10:2025 — https://top10.owasp.org/2025/
- OWASP Cheat Sheet Series — https://cheatsheetseries.owasp.org/. Most relevant sheets:
  - Input Validation
  - Cross Site Scripting Prevention
  - NPM Security
  - Node.js Security
  - Prototype Pollution Prevention
  - Secrets Management
  - Authorization
  - SSRF Prevention
  - Logging
- Cox, Our Software Dependency Problem — https://research.swtch.com/deps
- The Twelve-Factor App, Config — https://12factor.net/config
- Spracklen et al., We Have a Package for You! (package hallucinations, USENIX Security 2025) — https://arxiv.org/abs/2406.10279

## Interfaces, data, observability, collaboration

- Bloch, How to Design a Good API and Why it Matters — https://research.google.com/pubs/archive/32713.pdf
- Meyers, Make Interfaces Easy to Use Correctly and Hard to Use Incorrectly — https://97-things-every-x-should-know.gitbooks.io/97-things-every-programmer-should-know/content/en/thing_55/
- Semantic Versioning 2.0.0 — https://semver.org/
- RFC 9457, Problem Details for HTTP APIs — https://www.rfc-editor.org/rfc/rfc9457.html
- IETF draft, The Idempotency-Key HTTP Header Field — https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.html
- Google AIP-158, Pagination — https://google.aip.dev/158
- PostgreSQL wiki, Don't Do This — https://wiki.postgresql.org/wiki/Don%27t_Do_This
- OpenTelemetry, Logs — https://opentelemetry.io/docs/concepts/signals/logs/
- Google engineering practices — https://google.github.io/eng-practices/:
  - The Standard of Code Review
  - What to look for in a code review
  - Small CLs
- Sadowski et al., Modern Code Review: A Case Study at Google — https://sback.it/publications/icse2018seip.pdf
- Conventional Commits 1.0.0 — https://www.conventionalcommits.org/en/v1.0.0/
- Beams, How to Write a Git Commit Message — https://cbea.ms/git-commit/
- Diátaxis — https://diataxis.fr/

## TypeScript, JavaScript and front-end

- TypeScript releases:
  - Announcing TypeScript 6.0 — https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
  - Announcing TypeScript 7.0 — https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- TypeScript docs:
  - TSConfig Reference — https://www.typescriptlang.org/tsconfig/
  - Choosing Compiler Options — https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html
  - Do's and Don'ts — https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html
- typescript-eslint:
  - Shared Configs — https://typescript-eslint.io/users/configs/
  - Rules — https://typescript-eslint.io/rules/
- Effective TypeScript:
  - Site — https://effectivetypescript.com/
  - The Golden Rule of Generics — https://effectivetypescript.com/2020/08/12/generics-golden-rule/
- Total TypeScript, Type vs Interface — https://www.totaltypescript.com/type-vs-interface-which-should-you-use
- Schema validation:
  - Zod 4 — https://zod.dev/v4
  - Standard Schema — https://standardschema.dev/
- TC39 finished proposals — https://github.com/tc39/proposals/blob/main/finished-proposals.md
- Node.js:
  - Node.js, TypeScript (type stripping) — https://nodejs.org/api/typescript.html
  - Node.js Best Practices — https://github.com/goldbergyoni/nodebestpractices
- react.dev:
  - You Might Not Need an Effect — https://react.dev/learn/you-might-not-need-an-effect
  - Reusing Logic with Custom Hooks — https://react.dev/learn/reusing-logic-with-custom-hooks
- W3C, What's New in WCAG 2.2 — https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- MDN, Temporal — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal

## Agent instruction files and agent failure modes

- AGENTS.md — https://agents.md/
- Claude Code docs:
  - Memory (CLAUDE.md) — https://code.claude.com/docs/en/memory
  - Best practices — https://code.claude.com/docs/en/best-practices
- Anthropic, Prompting best practices — https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- OpenAI:
  - Codex AGENTS.md guide — https://developers.openai.com/codex/guides/agents-md
  - Codex Prompting Guide — https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide
- GitHub:
  - Docs, Repository custom instructions — https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
  - Blog, How to write a great agents.md — https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
- Cursor, Rules — https://cursor.com/docs/context/rules
- Gemini CLI, GEMINI.md — https://geminicli.com/docs/cli/gemini-md/
- Gloaguen et al. (ETH Zurich), Evaluating AGENTS.md — https://arxiv.org/abs/2602.11988
- Chatlatanagulchai et al., Agent READMEs: An Empirical Study of Context Files — https://arxiv.org/abs/2511.12884
- Jaroslawicz et al., How Many Instructions Can LLMs Follow at Once? — https://arxiv.org/abs/2507.11538
- HumanLayer, Writing a good CLAUDE.md — https://www.humanlayer.dev/blog/writing-a-good-claude-md
- Zhong, Raghunathan & Carlini, ImpossibleBench — https://arxiv.org/abs/2510.20270
- METR:
  - Recent Frontier Models Are Reward Hacking — https://metr.org/blog/2025-06-05-recent-reward-hacking/
  - Many SWE-bench-Passing PRs Would Not Be Merged — https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/
- GitClear, AI Copilot Code Quality 2025 — https://www.gitclear.com/ai_assistant_code_quality_2025_research

## Dead code, duplication and cleanup loops

- knip — https://knip.dev; the docs as Markdown: https://github.com/webpro-nl/knip/tree/main/packages/docs/src/content/docs (`reference/{cli,configuration,known-issues}`, `features/{auto-fix,production-mode}`, `guides/{adopt-gradually,handling-issues}`)
- jscpd — https://jscpd.dev/llms.txt, with `/raw/getting-started/configuration.md` (baselines) and `/raw/ci-and-hooks/ci.md`
- Claude Code, headless runs and CLI flags — https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference
- A knip baseline that also fails on stale entries, and a jscpd gate that bans inline suppressions — https://github.com/vouchington/vouchington/issues/1360, https://github.com/vouchington/vouchington/issues/550
- A count-based ratchet drifting under concurrent merges — https://github.com/aws-samples/sample-autonomous-cloud-coding-agents/issues/607
- Kilo, I let agents clean up the Kilo codebase (one job, one PR per run) — https://blog.kilo.ai/p/i-let-agents-clean-up-the-kilo-codebase
- 56kode, Clean a TypeScript project with knip and an AI workflow — https://www.56kode.com/posts/clean-typescript-project-knip-ai-workflow/
