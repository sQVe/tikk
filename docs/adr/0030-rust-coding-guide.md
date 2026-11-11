# ADR 0030: A Rust coding guide adapts Tau's coding rules

**Date**: 2026-11-11\
**Status**: Accepted\
**Related**: [ADR 0004 (Toolchain and quality gates)](./0004-toolchain-and-quality-gates.md),
[Rust coding guide](../coding.md),
[rust-analyzer style](https://github.com/rust-lang/rust-analyzer/blob/master/docs/book/src/contributing/style.md),
[Zed rules](https://github.com/zed-industries/zed/blob/main/.rules),
[Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)

## Context

Agents write most of tikk's code, and Tau's coding instructions load in every session. Those
instructions were written for TypeScript. They say that repository conventions win when they differ.

Read literally, several Tau rules conflict with ordinary Rust. Tau bans every abbreviation, but
trait methods require names such as `fmt`. Tau asks to assign call chains and ternary expressions
to variables. Rust combines computing and deciding with `?`, `if let`, `let ... else`, and
value-producing `match`. Tau puts helpers before their callers, but Rust items are in scope in
the whole module.

Rust also brings ownership and lint suppression rules that need to be concrete enough to check in
review. Published guidance does not settle every detail. Zed asks for full words, while
rust-analyzer's examples use names such as `s`.

## Decision

tikk keeps Tau's coding instructions and adds `docs/coding.md`, which states only the Rust rules
that override, clarify, or add to them. A Tau rule the guide does not change applies as written.
The guide keeps one policy per item. Its reasons live in this ADR.

The code-structure ADRs keep authority over domain errors, module boundaries, side effects,
lifetime ownership, file names, and test placement. The guide links to those decisions instead
of repeating them. In particular, typed domain errors remain required by ADR 0005, and ADR 0007's
function records take precedence over trait-based fakes.

### Names

Names use full words, as Tau asks. The exceptions are names a standard or trait method requires,
generic `T`, short lifetimes such as `'a`, and GPUI's `cx` and `window`. These names are common
Rust and GPUI vocabulary, so expanding them makes tikk harder to compare with its sources. Putting
`window` before `cx` matches GPUI callbacks. Other short names gain nothing the full word lacks.

### Item order and modules

Items read top-down: public and high-level items first, private helpers after, as rust-analyzer
orders them. A reader meets what a module offers before how it works. The compiler does not need
helpers first, so Tau's helper-before-caller rule has no Rust reason behind it.

[ADR 0006](./0006-capability-modules.md) already decides module files. The guide adds no second rule.

### Errors

Typed errors derive `thiserror` and hold data in fields, so callers and tests match a variant
instead of parsing text. A test that tells failures apart counts as such a caller. An error built
with `anyhow!` carries only its message, so that test could only compare text.

`xtask` counts as app code. Its tasks report errors with `anyhow` and context, because a new error
type adds no value when no caller reads it. This does not relax ADR 0005's typed domain errors.
The automation crates of
[rust-analyzer](https://github.com/rust-lang/rust-analyzer/blob/6e37b2d62127d445d77069031b416c48c9b0b4f2/xtask/src/main.rs#L33-L90),
[Zed](https://github.com/zed-industries/zed/blob/4ba7d82f6872cb5ee8adc122529e49ba28057c3a/tooling/xtask/src/main.rs#L4-L55),
[uv](https://github.com/astral-sh/uv/blob/4470c33bd7115dfb75922a59280e445d05cc181e/crates/uv-dev/src/main.rs#L18-L77),
and [Ruff](https://github.com/astral-sh/ruff/blob/8960d6db60e495867635b8aaedbe90e352b4b19f/crates/ruff_dev/src/main.rs#L93-L129)
also report with `anyhow`. An `xtask` error that a test tells apart gets a typed error, as anywhere
else. Importing anyhow's `Context` trait as `_` avoids reserving the name of GPUI's `Context` type.

An `expect` message says why a call cannot fail, so a panic points at the broken assumption.
Discarding a `Result` hides failures. The guide names the forms that do so, including `.ok()`.

`Drop` cannot return an error, so a cleanup error there goes to stderr with `eprintln!` under a
narrow lint expectation. tikk has no logger, so stderr is the one place such an error can go.
One fixed form is easier to follow than a judgment of which errors are safe to drop.

### Statements

`?`, `if let`, `let ... else`, value-producing `if` and `match`, and short iterator chains are
written inline. They are normal Rust forms, and splitting them adds names that carry no meaning.
A long chain, or one whose result is a concept, still gets a name. GPUI element builders stay in
one fluent chain, including conditional children. This keeps the visual hierarchy together instead
of spreading it across intermediate bindings.

### Function size

Tau's size rules remain review signals. An exhaustive `match` or GPUI builder can be long and
still do one job. Splitting it only to meet a count scatters one decision or layout. ADR 0009 keeps
the ownership rules.

### Ownership

Functions borrow views such as `&str`, `&[T]`, and `&Path` to read, and take owned values to keep
them. The signature shows who owns the data, and callers can pass any matching container.
A clone is deliberate, because it can copy large data or share state. `redundant_clone` catches
some needless clones.

A lint suppression uses `#[expect(lint, reason = "...")]`. The compiler warns when the expected
lint no longer fires, and the reason tells the next reader why the lint does not apply.
A lint that fires only in some builds uses `#[allow(lint, reason = "...")]` instead.

### Doc comments

Doc comments go only on items another crate uses, and state only errors, panics, and invariants
that names and types cannot show. tikk publishes no library, so full API documentation would mostly
restate signatures.

### GPUI

GPUI entity updates hold a borrow of the entity's state. Reading or updating the same entity through
its handle inside that update would borrow it again and panic. The closure's state and context
are the safe way to work with it.

GPUI tasks and subscriptions cancel when dropped. Their owner must keep them, or detach them on
purpose, so work does not silently stop at the end of a scope. A child holds a weak parent handle
to avoid a reference cycle that keeps both alive after the view closes.

Rendering stays declarative because GPUI may render repeatedly. Starting work or notifying from
render would repeat effects or trigger another render. State changes notify once, and background
results check the state they started from, so an old result cannot replace a newer selection.
Stable domain IDs keep element state attached to the right item when a list changes order.

The core and CLI stay independent of GPUI. The kit boundary in `tikk-ui` keeps component types out
of other UI code, so a kit change has one translation point. ADRs 0002 and 0003 own those boundaries.
The scene binary's list and readiness output are command protocols, so they use the same narrow
printing exception as the CLI and xtask.

### Tests

ADR 0009 owns test placement and naming. Case tables are plain loops, which need no dependency.
Fakes replace only IO boundaries, so tests run real logic. Tests match error variants and data,
because `is_err()` passes for any failure and message text changes with wording.

Test folders come from `tempfile`, because its guard removes the folder even when the test panics.
Hand-written cleanup at the end of a test never runs after a failed assertion. Mutation survivors
are advice, as in Tau.

### Lints

`print_stdout`, `print_stderr`, `allow_attributes_without_reason`, `should_panic_without_expect`,
and `redundant_clone` check parts of these rules. ADR 0004 states how tikk adds single lints.
Printing command output is a narrow exception, not permission to print from an entire crate.

## Consequences

### Positive

- Agents and the owner get rules that fit the Rust code they read and write.
- The guide stays short because it holds only additions and differences.
- Error and test rules let tests check what failed without depending on message wording.

### Negative

- A reader must combine Tau's instructions, this guide, and the code-structure ADRs.
- When Tau's coding instructions change, the guide may need a matching change.
- Most rules cannot be checked by a lint, so review must check them.
- Typed errors and `expect` messages take more code than `unwrap` and string errors.

## Alternatives considered

### A full Rust guide that repeats Tau's rules

Write every rule in one guide. Rejected because Tau's instructions load in every session anyway,
and two copies of a rule drift apart.

### Tau's coding instructions unchanged

Follow Tau's rules literally. Rejected because several forbid normal Rust forms, such as `?`
inside an expression.

### An external guide adopted whole

Adopt rust-analyzer's style guide or Zed's rules as written. Rejected because they disagree on
names, and each was written for its own large code base, not tikk.

### Helpers before their callers

Keep Tau's order. Rejected because Rust does not need it, and top-down order shows a module's API
first.

### Size limits as lints

Set clippy's size thresholds to Tau's numbers. Rejected because exhaustive matches would trip them
while still doing one job, and fixes would scatter code to meet a number.

### `missing_docs` and full rustdoc

Turn on `missing_docs`. Rejected because tikk publishes no library, and the lint would force
comments that restate names.

### Lints that ban `unwrap` and `expect`

Turn on `unwrap_used` and `expect_used`. Rejected because a panic is right for a bug, and `expect`
with a reason documents the assumption.

### One error style everywhere

Use only typed errors or only `anyhow`. Rejected because branching callers need variants, while
reporting-only tooling gains nothing from a new type.

### `String` errors in `xtask`

Keep `Result<_, String>`. Rejected because a string loses the cause chain that `anyhow` keeps,
and tests can only compare message text.

### Test case libraries and mocking frameworks

Use `rstest` and `mockall`. Deferred because plain loops and narrow IO fakes cover the tests,
and each library adds a dependency.
