---
title: "qkt as a Subject"
excerpt: "Chapter 1 ended with a sketch of the loop: three types, about twenty lines. And it isn't wrong, either — a tick arrives, the strategy decides, the broker answers, the books update. That genuinely is..."
date: 2026-06-08
order: 2
draft: false
---

Chapter 1 ended with a sketch of the loop: three types, about twenty
lines. And it isn't wrong, either — a tick arrives, the strategy decides,
the broker answers, the books update. That genuinely is what a trading
engine does.

qkt is **655 Kotlin source files and about 95,000 lines of engine code** —
twice that once you count the tests — across **just over 2,500 commits**.

The distance between those two numbers is what this chapter is about. Not
because the sketch was a lie; it wasn't. But everything between *this
describes the loop* and *this can be trusted with money* turned out to
live in the gap between twenty lines and ninety-five thousand. That's a
small production system, and every decision inside it was made under the
pressure of having to keep working as it grew — not "this is fine for a
demo."

## The module map, and what it tells you

![The twenty-eight qkt packages laid out along the loop from chapter 1: market data packages under "the price moves", strategy and DSL packages under "the strategy decides", execution, risk, positions and P&L packages under "the wish is checked", the broker package under "the broker tries", and a row of plumbing packages beneath them all](/diagrams/chapter-02/packages-on-the-loop.png)

*Figure 2.1 — the folders are the loop. Every package with a trading concept in its name sits on one of the four stages from Figure 1.2; the rest is plumbing those stages stand on.*

Twenty-eight top-level packages, and notice what they're named after:
**trading concepts** — `broker`, `risk`, `positions`, `pnl`, `dsl` — not technical
roles like `service`, `repository`, `controller`, `dto`. This is a real,
deliberate choice, and it's worth understanding the alternative it
rejected.

A lot of software defaults to organizing by *technical layer*: all the
"services" in one folder, all the "models" in another, all the
"controllers" in a third. That layout makes sense when the interesting
complexity in your system is architectural — how requests flow through
layers. But in a trading engine, the interesting complexity is *domain*
complexity: what's the difference between a *resting* order (one waiting at
the venue for its price) and a filled one; how a *trailing stop* (a stop
that follows the price up behind a winning trade) interacts with a
*bracket* (an entry with its stop and its target attached); what happens
when a broker reports a position the engine didn't expect. None of that
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

## The tech stack, and why Kotlin

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

The rest of that dependency list holds two choices that can be made in a
sentence and one worth slowing down for. `ktlint` formats the code as part
of the build rather than as a polite request, and `dokka` generates the API
documentation out of the code's own comments — both are the same move,
which is taking a convention that reliably decays when humans maintain it
and making the build responsible for it instead.

The interesting one is what's *absent*. There is no mocking framework here
at all — no Mockito, no MockK — in a 95,000-line codebase where you would
expect one as a matter of course.

Think about what a mock actually asserts. Write the usual "verify that
`execute` was called with this order" and the test passes when one
particular method received one particular argument. That's a claim about
how the code is *written*, not about what it *does*. Rename the method,
split it in two, route the call through a new collaborator, and the test
goes red while the system's behaviour is byte-for-byte what it was
yesterday. Do that a few dozen times and everyone learns that a red test
means somebody moved some code, which is precisely the moment a test suite
stops protecting anything.

So every stand-in in qkt's tests is a small real object instead: a paper
broker that actually fills an order, a fixed clock that actually reports
the time it was handed. They cost a few more lines to write than a mock
would, and what that buys is assertions about outcomes — this trade ended
up at this price, this position ended up flat — which survive any refactor
that doesn't change what the system does. For a codebase whose whole
safety argument is *replay the history and compare the numbers*, tests
that assert on numbers rather than on call sequences are the only kind
that fit the argument.

## The discipline as a case study, not a bureaucracy

Here's something worth taking seriously as a lesson in its own right,
independent of trading: **qkt enforces a one-way promotion pipeline
across three branches.**

![Four boxes left to right: a feature branch, dev, testing, main, with the gate between each one labeled — reviewed with checks green, automatic on every green push, manual with evidence](/diagrams/chapter-02/promotion-pipeline.png)

*Figure 2.2 — one direction only. Code enters at the left and can only move right, and each gate is a different kind of check: fast tests, then the slow integration suite, then a human holding a piece of evidence.*

`dev` is where every change lands first, through a reviewed pull request,
and the fast checks — build and tests, on Linux and on Windows — have to be
green. `testing` never receives a human commit: every green push to `dev`
triggers a job that merges it into `testing` as a promotion commit, and
`testing` then runs the slower integration suite and builds the container
image the live bots actually pull. `main`, the release branch that version
tags are cut from, is stricter still: it only receives a *promotion pull
request*, and that request can only be opened once a paper-soak run — a
supervised, hours-long run of the exact `testing` build against a demo
venue — has produced an attestation for that exact commit. A human reviews
and merges it. Nobody ever commits directly to `testing` or `main`.

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
