---
title: "qkt as a Subject"
excerpt: "Before we go back to concepts, let's actually look at what we're studying. Right now qkt is 648 Kotlin files, about 94,000 lines, and roughly 2,500 commits deep. That's not a toy project someone hacked together over a..."
date: 2026-06-08
order: 2
draft: false
---

Before we go back to concepts, let's actually look at what we're studying.
Right now qkt is **648 Kotlin files, about 94,000 lines, and roughly 2,500
commits deep**. That's not a toy project someone hacked together over a
weekend — it's the size of a small production system. Worth internalizing
that scale now, because every architectural decision we're about to
discuss was made under the pressure of *this actually has to keep working
as it grows*, not "this is fine for a demo."

## The module map, and what it tells you

```
accounting  app        backtest   broker      bus        candles
cli         common     dsl        engine      events     evidence
execution   indicators instrument lsp         marketdata notify
observability observe  persistence pnl        positions  research
risk        strategy   tools      trade
```

Twenty-eight top-level packages. Notice what they're named after: **trading
concepts** — `broker`, `risk`, `positions`, `pnl`, `dsl` — not technical
roles like `service`, `repository`, `controller`, `dto`. This is a real,
deliberate choice, and it's worth understanding the alternative it
rejected.

A lot of software defaults to organizing by *technical layer*: all the
"services" in one folder, all the "models" in another, all the
"controllers" in a third. That layout makes sense when the interesting
complexity in your system is architectural — how requests flow through
layers. But in a trading engine, the interesting complexity is *domain*
complexity: what's the difference between a resting order and a filled
one, how does a trailing stop interact with a bracket, what happens when a
broker reports a position the engine didn't expect. None of that
complexity lives "in the service layer" — it lives in the concepts
themselves. So qkt organizes around the concepts. If you want to
understand risk halts, you go to one folder, `risk/`, and everything
about risk is there — not scattered across a `services/RiskService.kt`, a
`models/RiskLimit.kt`, and a `controllers/RiskController.kt` three folders
apart.

The tradeoff, honestly: package-by-domain can get you duplicate-looking
utility code across packages, because you're optimizing for "everything
about X is together" over "no code is ever duplicated." qkt's engineering
norms explicitly accept that cost — small, focused files (their own
convention caps most files around 150 lines) over clever cross-cutting
abstractions.

There's a package here that might surprise you: `lsp/`. That's a
**Language Server Protocol** implementation — qkt ships editor tooling
(autocomplete, error-checking) for its own strategy-description language,
the same protocol VS Code and Neovim use for every serious programming
language. Notice what that says about priorities: this project treats "a
human has to write strategies in this language comfortably" as seriously
as it treats the execution engine itself.

## The tech stack, and what else was on the table

```kotlin
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    application
    alias(libs.plugins.ktlint)
    alias(libs.plugins.dokka)
}
```

**Kotlin, on the JVM.** Worth asking: why not Python (the default choice
for anything "quant"), why not Rust or C++ (the default choice for
anything "low-latency"), why not Go?

- **Python** is the lingua franca of research and data science — pandas,
  numpy, the whole ecosystem. But Python's dynamic typing is a liability
  the moment you're handling money and orders: a strategy that silently
  receives `None` where it expected a price, or a `float` where you
  needed exact decimal math, fails at runtime, maybe after money has
  already moved. Python is also slow enough that a tick-by-tick engine
  written naively in it becomes a genuine latency problem well before
  you'd hit any real trading volume.
- **Rust or C++** would win on raw speed and memory control, which
  matters *somewhere* in a trading system — but that somewhere is a
  narrow hot path, not the whole system. Paying C++'s tax (manual memory
  management, longer iteration cycles, a much smaller pool of
  contributors who can safely touch the codebase) across the *entire*
  surface — DSL parsing, reporting, CLI tooling, brokers — is a bad trade
  when only a sliver of the code is actually latency-critical.
- **Kotlin** sits in a sweet spot for this specific job: it compiles to
  the JVM (mature, fast, garbage-collected but *predictably* so if you're
  careful about allocation and blocking calls on the hot path), it has
  real static types and null-safety baked into the
  language (that `Trade?` nullable-return pattern from Chapter 1 is a
  *language feature*, not a convention you have to enforce by hand), and
  it reads almost as concisely as Python while catching entire categories
  of bugs at compile time that Python only catches in production. The JVM
  also means access to a huge, battle-tested ecosystem — logging
  (`slf4j`/`logback`), HTTP (`okhttp`), serialization — without writing
  any of that from scratch.

The real lesson here isn't "Kotlin is the best language" — it's that the
choice was made by weighing *where the speed actually matters* (a narrow
hot path) against *where correctness and iteration speed matter far more*
(everything else), and picking the language that serves the larger set
well while still being fast enough where it counts.

A few smaller, equally deliberate choices in that dependency list:

- **`ktlint`** — an automated code formatter wired into the build, not a
  suggestion. This matters more than it sounds: in a codebase this size,
  "please format your code nicely" as a human convention decays within
  weeks. Making the build itself fail on a formatting violation means
  style is never a matter of opinion or a review-comment tax on every PR.
- **`dokka`** — auto-generates API documentation straight from the code's
  own doc-comments. The alternative — hand-maintained docs living in a
  wiki somewhere — always drifts out of sync with the code. Generating
  docs *from* the code means they can't drift; they're either right or
  the build breaks.
- **JUnit 5 + AssertJ** for testing, explicitly *not* a mocking framework
  (no Mockito, no MockK). We touched this in Chapter 1 — every "fake" in
  the test suite is a small real object, not a magic stand-in that
  records which methods got called. The tradeoff: writing a fake `Broker`
  by hand takes a few more lines than `mock(Broker::class)`. What you get
  back: a test that verifies *actual behavior* ("the trade ended up with
  this price") instead of *implementation detail* ("this method got
  called with these arguments") — the latter breaks every time you
  refactor internals even when behavior didn't change, which is exactly
  the kind of test that erodes trust in a test suite over time.

## The discipline as a case study, not a bureaucracy

Here's something worth taking seriously as a lesson in its own right,
independent of trading: **qkt enforces a one-way promotion pipeline
across three branches** —

```
feature branch → dev → testing → main
```

`dev` is where all work lands first, and it runs a fast test suite.
`testing` only ever receives code that already passed `dev`'s checks, via
an automatic fast-forward — no human retypes anything, no merge commit
muddies the history — and it runs a slower, more thorough integration
suite. `main`, the release branch that tags actually get cut from, only
ever receives code that already survived `testing`, via a *manual*
fast-forward. Nobody ever commits directly to `testing` or `main`.

Why go to this trouble instead of just merging to `main` when a feature's
done? Because in a system that moves real money, the cost of *finding out
something's broken after it's live* is not "we'll patch it later" — it
can be an actual loss. The three-stage pipeline exists to catch problems
at increasingly expensive-to-ignore checkpoints, each one cheaper to fail
at than the next. This is the same instinct as a staging environment in
any serious software shop, just made structurally impossible to skip
rather than merely encouraged.

The same discipline shows up in how a feature gets *built*, not just
released. Before code gets written, there's a **design spec** — a
document that lays out what's being built and why, including the
alternatives that were considered and rejected. Then an **implementation
plan** breaking the work into small, ordered steps, each ending in its
own commit. Only then does code get written. And once a phase ships, it
gets a **changelog** — not "what we built," which you can get from the
diff, but "here's how you actually use it," with worked examples.

This is worth naming explicitly, because it's the same instinct that
makes a *trading system itself* trustworthy, just applied one level up,
to the process of building the trading system: **a decision without a
recorded reason is a decision nobody can safely revisit.** In the engine,
that shows up as reachable-yet-unmodeled outcomes — a rejection, a null
price — being represented deliberately rather than papered over. In the
engineering process, it shows up as "don't ship a feature without writing
down why it's shaped the way it is." Same discipline, two different
layers.
