---
title: "What Building qkt Teaches About Trading Systems in General"
excerpt: "Chapter 1 opened with a claim that trading is a loop: watch a price, decide something, maybe act, see what happened, repeat. Twenty-three chapters later that is still true, and it is worth admitting..."
date: 2026-11-09
order: 24
draft: false
---

## Back to the loop

Chapter 1 opened with a claim that trading is a loop: watch a price, decide
something, maybe act, see what happened, repeat. Twenty-three chapters
later that is still true, and it is worth admitting how little of this book
was actually about it.

Almost none of the machinery here exists to make better decisions. The
event bus does not improve a signal. Exact arithmetic does not find an
edge. Reconciliation, warmup gates, capability negotiation, the divergence
catalogue — none of it makes a strategy smarter. Every one of them exists
to make sure that **what the system believes is what is actually true**,
and that when it isn't, somebody finds out.

That is the first general lesson, and it is not obvious at the start: in a
trading system, correctness work vastly outweighs strategy work, and the
ratio is not a sign that something has gone wrong. It is the job.

## What the money changes

It is worth naming what actually makes this domain different, because it
is not complexity — plenty of software is more complex.

It is that **the feedback is delayed, noisy, and expensive**. A web service
with a bug produces errors immediately. A trading system with a bug
produces *trades*, which look exactly like the trades it is supposed to
produce, and the only signal that anything is wrong is a number that is
slightly off — weeks later, mixed in with the natural variance of a
strategy that loses money regularly on purpose.

That single property explains almost every decision in this book. It is why
the system refuses rather than proceeds. Why it re-derives rather than
increments. Why it fails closed on ambiguity. Why it keeps journals it
mostly never reads. Why "compiles" is made to mean something. In a domain
where you cannot rely on noticing your mistakes, the design has to
compensate by making certain mistakes structurally impossible and the rest
loudly announced.

That is the frame for everything that follows. Each lesson below is a
consequence of it, not an independent piece of advice.

It also explains what the whole thing costs. Every chapter ended with a
price: an order of magnitude of backtest speed, a language that refuses
half-finished ideas, startup that will not start, a ledger that recomputes
what it could have incremented. None of it is free, and for a system with
faster feedback, most of it would be over-engineering. The bill only makes
sense against a failure mode that hides.

## The idea that kept arriving

If one thread runs through the whole book, it is this.

![The same principle — absence is a value, not zero — appearing independently in six different chapters](/diagrams/chapter-24/one-idea-in-six-places.png)

*Figure 24.1 — six components, six unrelated problems, one answer.*

A stop-loss that is `null` because the venue has no such concept, versus
one that is `0` because the position is genuinely unprotected. An indicator
whose buffer is still filling, which returns nothing rather than a number
computed from too little. A ratio whose denominator does not exist,
reported as `n/a` rather than as an impressive figure. A failed venue read
that means *unknown* rather than *everything closed*. A contract size that
will not resolve, refusing to start rather than booking a plausible `1`. A
spread on data synthesised from bars, evaluating as undefined.

None of those were coordinated. They are six independent answers to the
same question — *what do I do when there is no answer?* — and every one of
them refuses the convenient lie.

The general lesson: **the dangerous failure is not the exception, it is the
plausible number.** An exception stops the program and someone reads a
stack trace. A zero standing in for "unknown" propagates silently through
every downstream calculation, is summed into totals, is charted, and
eventually becomes a decision. Nothing anywhere was wrong. The system
simply lied, quietly, in a way no component could be blamed for.

Designing against that means giving absence a representation and then
refusing to flatten it — in the type system where possible, in an explicit
`n/a` where not, and in a refusal to start where the missing thing is
load-bearing.

## Choose which way to be wrong

The second recurring shape is about ambiguity you cannot eliminate.

Chapter 11 had the cleanest instance: a bar records four numbers and
discards the path, so when both a stop and a target sit inside its range,
which one filled is genuinely unknowable. There is no correct answer to
recover.

What qkt does is choose the direction of the error. The adverse extreme is
emitted first — always, deterministically — so that when the reconstruction
is wrong, it is wrong *against* the strategy. A backtest that is
systematically slightly pessimistic produces strategies that survive
contact with a venue. One that is slightly optimistic produces confident
numbers and unpleasant surprises.

The same reasoning appears elsewhere in different clothes. Order volume
rounds down, never up, because handing a venue more size than authorised is
the failure with teeth. A halt blocks new exposure but never the exit,
because trapping someone in the position that triggered the halt is worse
than the halt itself. A reconciliation that cannot decide refuses to start
rather than guessing.

The general lesson: **when you cannot be right, decide in advance which way
to be wrong, and make it the same way every time.** Consistency matters as
much as direction — a bias you know about can be reasoned around; a bias
that varies cannot.

## Separate noticing from acting

A smaller structural idea that turned out to matter more than expected.

Chapter 19's reconciliation machinery detects drift constantly. It never
acts on it. The component that builds flatten orders is deliberately dumb,
and closing a position only ever happens from an explicit path — a strategy
stopping, a kill switch, an operator command.

That separation is what makes a bug in detection survivable. If detection
could act, a false positive would close real positions automatically, and
the blast radius of a subtle comparison error becomes money. With them
apart, the worst case is a wrong report that a human reads.

The general lesson: **the more automatic a system's response, the more
certain its diagnosis has to be.** Where certainty is not available — and
in reconciliation it frequently isn't — the honest design reports and waits.

## Say what you do not know

Chapter 20's most valuable artifact is not the parity harness. It is the
catalogue: a document listing every known way backtest and live differ,
sorted into fixed, inherent, and open.

The insight is that **a catalogue of known differences is worth more than a
claim of equivalence**, because the claim is never fully true and everyone
knows it. Once the claim is "these are equivalent," every discovered
difference is an embarrassment to be argued about. Once it is "here is
where they differ and why," a new difference is just a new row, and — more
importantly — the *inherent* ones stop being treated as a backlog that can
somehow be finished.

That habit shows up all over the system in miniature. A backtest report
that prints its own execution assumptions. A broker declining to advertise
a capability it can only approximate. A journal that records that it
dropped events. A chapter of this book ending with what its subject does
not do.

It is worth collecting those endings, because read together they say
something the individual chapters cannot. A rule reading the bid/ask spread
never fires on data built from bars, and reports no trades rather than
"untestable." An expiring order is cancelled on the next tick, so a quiet
market cancels it late. A trailing stop resumes from the last high-water
mark that reached disk, losing whatever the price did during an outage.
Where several strategies share one account, ownership of a venue position
can be genuinely undecidable. The operator tooling lists one venue's
profiles and not the others'. Latency is measured but not exposed where a
dashboard could scrape it. And the performance claims throughout rest on
profiling nobody else can re-run, because there is no benchmark suite.

None of those are resolved by this chapter, and listing them is not an
apology. It is the point: **that list is the most honest description of the
system available**, more useful than any of the chapters' successes,
because it is the part a reader would otherwise have to discover on their
own — at their own cost, in their own account.

The general lesson: **a system that documents its limits is more trustworthy
than one that appears to have none** — and the second kind does not exist,
only the kind that hasn't told you.

## Determinism is not a feature

Chapter 8 made this argument locally; it generalises.

Determinism cannot be added. There is no library for it, no flag, no layer
that can be wrapped around a system to make it reproducible. It either
holds at every level — time, identifiers, ordering, arithmetic,
concurrency — or it does not hold at all. One `System.currentTimeMillis()`
on a hot path, one `HashSet` iteration order, one floating-point sum, and
the property is gone, and gone silently.

What it buys, when you have it, is the ability to answer "did this change
alter behaviour" mechanically instead of by argument. That single
capability is what makes a trading system safe to modify — and modifying
it is not optional, because markets change.

The general lesson applies well beyond trading: **properties that must hold
everywhere have to be designed in from the first line**, because they
cannot be retrofitted onto a system that has been assuming otherwise.

## What to take

If a reader takes four things from this book, these are the four:

**One writer per fact.** The moment two components can both change the same
truth, they can disagree, and no amount of care prevents it forever. Derive
instead of duplicating, even when deriving costs more.

**Absence is a value.** Give "I don't know" a representation and refuse to
collapse it into a number. The zero that means nothing is the most
expensive value in a financial system.

**Choose your direction of error.** Where ambiguity cannot be removed,
resolve it the same way every time, and resolve it against yourself.

**Write down the limits.** The parts of a system that are known not to work
are more valuable to a reader than the parts that do, because those are the
parts that will surprise them.

None of those are about trading. They are what trading teaches, because it
is a domain where the alternative is unusually expensive and unusually slow
to notice.

The loop from Chapter 1 is still four steps. Everything else in this book
is what it costs to run it honestly.
