---
title: "Backtest/Live Parity"
excerpt: "Chapter 1 stated a requirement and then spent nineteen chapters paying for it:"
date: 2026-10-12
order: 20
draft: false
---

## The sentence the whole book has been serving

Chapter 1 stated a requirement and then spent nineteen chapters paying for
it:

> The same strategy must produce the same decisions whether it's looking
> at historical data played back in a simulator, or at real prices
> arriving from the real market, right now.

Almost everything since has been an instalment on that sentence. The event
bus assigning one order. The clock being handed in rather than consulted.
The ledger having exactly one writer. Money that is exact rather than
close. A language strict enough that "it compiles" means something. A
broker layer that refuses to claim capabilities it can only approximate.

This chapter is where the bill is totalled — and where the claim has to be
stated precisely enough to be *falsifiable*, because a vague promise of
"backtest and live agree" is worth nothing at all.

## Four things that have to be the same

The requirement decomposes into four invariants. They are this book's
framing rather than a phrase you will find written in the source, but each
one has been earned by a chapter, and every known divergence traces back
to one of them.

![The four invariants as a shared spine between two tick sources at the top and two broker implementations at the bottom](/diagrams/chapter-20/what-has-to-be-the-same.png)

*Figure 20.1 — the shape of the claim. Two different inputs and two different outputs, with one identical middle.*

**One code path.** Not "equivalent implementations" — the same objects.
The compiled strategy, the indicator instances, the candle builder, the
rules, the risk engine. Chapter 8 established why a second implementation
would be fatal: two codebases drift, and the drift is invisible until the
numbers stop matching for real money.

**One order of events.** A clock handed to the engine rather than read
from the machine, and a sequence counter that resolves ties. The same
input yields the same sequence, every time, on any machine.

**One writer per fact.** A fill changes the position in exactly one place.
The account view is an index derived from that ledger, never a second
thing anyone writes to. Every realized amount is priced once and folded
once. Chapter 5's argument, restated as a parity requirement: two writers
can disagree, and if they can disagree in live they can disagree
differently in backtest.

**One place per difference.** Where the two worlds genuinely differ, the
difference lives in a single named seam. The clearest example is two
functions and a comment:

```kotlin
/**
 * The price a BUY executes at — the ask, falling back to the tick's single price
 * (mid for quote-driven feeds) when the feed carries no quote depth. Trigger checks
 * must use this side: MT5 fires BUY_STOP on the ask, so an engine or simulator that
 * triggers on mid is systematically ~half a spread optimistic per trigger event.
 */
fun Tick.buyExecPrice(): BigDecimal = ask ?: price

/** The price a SELL executes at — the bid; see [buyExecPrice]. */
fun Tick.sellExecPrice(): BigDecimal = bid ?: price
```

Read the size of that error: **half a spread, on every trigger event.**
On gold, that is a few cents; over ten thousand triggers it is a
meaningful fraction of a strategy's edge, and it always points the same
way — in your favour, in the backtest, and not in real life. It is
invisible in any single trade and decisive in aggregate.

The fix is not a patch at each call site. It is that there is now exactly
one place in the system that answers *which side does this execute
against*, and everything routes through it. Any future code that triggers
on the wrong side has to go out of its way to do so.

## What is actually compared

An invariant nobody checks is a wish, so the checking is worth seeing.

The parity harness takes one strategy source and does something more
paranoid than it first appears: it **compiles it twice, independently** —
once for each mode. That detail matters. Sharing a compiled object between
the two runs would prove the runtime is deterministic while quietly
assuming the compiler is. Compiling twice tests both.

It then drives the identical tick list through a backtest and through a
live session, and captures the same five things from each:

```kotlin
data class Snapshot(
    val trades: List<TradeState>,
    val positions: List<PositionState>,
    val pnl: PnlState,
    val rejections: List<RejectionState>,
    val halts: List<HaltState>,
)

data class Result(val backtest: Snapshot, val live: Snapshot)
```

And the comparison is one line, with no tolerance in it anywhere:

```kotlin
assertThat(result.live).isEqualTo(result.backtest)
```

That is exact structural equality over whole domain objects — not a hash,
not "within a penny." Note what is in the snapshot besides trades:
**rejections and halts**. A run where both sides made the same trades but
one of them rejected an order the other allowed is a *failure*. The
comparison covers the decisions not to trade as well as the decisions to.

The one concession is that numbers are normalised to a canonical string
before comparison, so a difference in decimal *scale* — `1.50` against
`1.5` — cannot produce a false mismatch, while any difference in *value*
still does.

That covers everything above the broker. For the broker itself there is a
narrower and more expensive proof: recorded ticks and order submissions
from a real venue, replayed against the venue simulator, checking that
acceptance decisions match — down to the venue's own numeric rejection
code, its *retcode* — and that fills agree within the instrument's own
tolerances.

## The claim, stated honestly

Here is where a lesser book would declare victory. The documentation
doesn't, and the precision is the most valuable thing in this chapter.

What the main harness proves is:

```
Backtest + PaperBroker  ===  LiveSession + PaperBroker
```

And the docs say, in as many words, that this **does not** prove
`Backtest === LiveSession + a real venue`.

Read those two lines together and you have the honest shape of the whole
enterprise. Everything *above* the broker is proven identical. The broker
is where the proof stops, and the evidence there is narrower: it
demonstrates one demo market-fill shape. It does not demonstrate
cancellation races, partial fills, rejection codes, latency distributions,
or a second venue.

A system that claimed more than that would be claiming something it cannot
know.

## Not every difference is a defect

Which leads to the mechanism that makes this manageable: qkt keeps a
catalogue of known divergences, and the catalogue's most useful feature is
that it sorts them into three kinds.

![Three kinds of divergence: fixed, inherent, and open](/diagrams/chapter-20/not-every-difference-is-a-bug.png)

*Figure 20.2 — the same document holds all three, and conflating them is how a divergence list becomes useless.*

**Fixed** ones were real and are closed — the mid-versus-bid trigger being
the cleanest example.

**Inherent** ones cannot be closed, and saying so is the point. A replay
samples ticks; a live feed delivers whatever it delivers. A quiet symbol's
bar closes on a wall clock in live and on the next tick in replay —
Chapter 4's heartbeat, which exists *because* live has a clock replay
doesn't. A margin floor only applies where there is a real account.
Listing these as permanent properties rather than open bugs is what stops
a divergence list from being a backlog nobody can ever finish.

**Open** ones are known, unresolved, and stated. The one worth carrying
out of this book: a rule that reads the bid/ask **spread** evaluates as
undefined on data synthesised from bars, so it never fires. A backtest of a
spread-aware strategy on bar data reports zero trades — not "this could
not be tested," just zero. It is exactly Chapter 4's compression problem
and Chapter 14's undefined-value discipline meeting in the worst possible
place, and the system detects the combination and warns rather than
pretending.

## Proving it about a specific build

There is one more layer, and it is about a different question: not "is the
design sound" but "did *this exact build* behave, on a real venue, for
hours."

A session can capture its own evidence — a checksummed bundle of the
journals it produced, refusing to produce one if any events were dropped —
and that bundle can be materialised back into replay stores, so a live
session becomes a reproducible replay.

Promotion to production then requires a set of sibling artifacts covering
health, journal, reconciliation, coverage, parity and insights, all
checksummed, all pinned to one commit and one image digest, with a ledger
of used run identifiers so a previous attestation cannot be replayed as a
new one. Zero parity mismatches, zero unexplained rejections, zero
unexplained order outcomes.

That is a different kind of claim from the harness — evidence about one
build on one day rather than a property of the design — and it is the one
that actually gates real money.

## What parity is, and what it is not

What it bought is the thing Chapter 1 said was the whole ballgame: a
backtest number that is a statement about the system that will actually
trade, rather than about a similar system that resembles it.

The costs have been itemised chapter by chapter, and they are not small.
An order of magnitude of backtest speed, given up to avoid a second
engine. A language that refuses rather than accommodates. A ledger that
re-derives instead of incrementing. Startup that fails closed. All of it
in service of one property.

And what it explicitly does **not** buy is worth ending on, because it is
the difference between a rigorous system and an overconfident one. Parity
means the *decisions* match. It does not mean the *outcomes* will. The
venue still has latency the simulator does not model, rejection codes it
has never seen, a spread that was not in the data, and a queue you were
never in. Chapter 11's coin flip is still a coin flip.

What parity gives you is narrower and more valuable than a promise about
the future: when a backtest and a live run disagree, you know the
disagreement is in the execution layer — because everything above it has
been proven identical, and the things that genuinely differ are written
down in a list you can read.
