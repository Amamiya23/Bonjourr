# Bonjourr Development Guide

Bonjourr is a minimalist and customizable "new tab" browser extension.

1. Use **Deno** as its runtime and task runner. Never use `npm` or others. If **Deno** fails at something, stop and ask for help.
2. Do not try to add dependencies, find a native solution.
3. Repeat yourself instead of writing difficult or unreadable code.
4. After code changes, run `deno task format` only on changed files and run `deno task types` once when finished. Do not repeat these checks between edits. Documentation-only or agent-instruction-only changes do not require formatting, type checks, or tests.

## Testing scope

- Keep validation proportional to the change. Run only the necessary tests for the affected behavior, using the smallest relevant test file or test filter.
- Avoid full-project test suites by default. Run broader tests only when changes affect shared infrastructure or multiple features, or when a failure indicates a wider impact. State the reason before broadening validation.
- Do not add tests for simple, reversible style, copy, or configuration changes unless they address a concrete regression risk. Once relevant checks pass, do not repeat or expand them unless further changes or unresolved failures justify it.
