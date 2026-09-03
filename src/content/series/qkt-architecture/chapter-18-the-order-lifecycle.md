---
title: "The Order Lifecycle"
excerpt: "A strategy says `BUY btc SIZING 0.1`. Chapter 1 called the result an order, and for a market order that is almost the whole story: it goes, it fills, it's done."
date: 2026-09-28
order: 18
draft: false
---

## One word that means five things

A strategy says `BUY btc SIZING 0.1`. Chapter 1 called the result an
order, and for a market order that is almost the whole story: it goes, it
fills, it's done.

Now write the shape a real strategy actually uses — an entry with a stop
below it and a target above. How many orders is that?

The answer is: it depends on the venue, it changes over time, and for a
stretch in the middle it is genuinely three orders that must behave like
one. The entry might fill in pieces. The stop might be held by the venue
or held by the engine. When the target fills, the stop must vanish — and
the instant between "the target filled" and "the stop is gone" is a window
in which both are live.

This chapter is about that window and its relatives. Not the happy path,
which is boring, but the states in between and what happens when two of
them are true at once.

## Where an order can be

Start with the vocabulary, because the states are not the obvious ones.

```kotlin
enum class OrderState {
    /** Created locally; not yet submitted. */
    CREATED,

    /** Engine-managed parent waiting for a trigger condition before submission. */
    PENDING,

    /** Submitted to the broker; awaiting acknowledgement. */
    SUBMITTED,

    /** Acknowledged and active on the venue, awaiting fill. */
    WORKING,

    /** Some quantity has filled; the rest is still working. */
    PARTIALLY_FILLED,

    /** Fully filled. Terminal. */
    FILLED,

    /** Cancelled by strategy, engine, or venue. Terminal. */
    CANCELLED,

    /** Refused by the venue. Terminal. */
    REJECTED,
}
```

![Order states: created, submitted, working, partly filled, filled, with pending as an engine-held branch and cancelled or rejected as terminal](/diagrams/chapter-18/where-an-order-can-be.png)

*Figure 18.1 — every state an order can occupy. The interesting one is Pending, which is not on the path to the venue at all.*

Most of these read as expected. **Created** means the engine is tracking it
but nothing has been sent. **Submitted** means it has gone out and the
acknowledgement has not come back. **Working** means the venue holds it.
**Filled**, **cancelled** and **rejected** are terminal — and terminal
genuinely means terminal, because every transition runs through a single
method that refuses to move an order out of a final state. That refusal is
what makes a delayed duplicate event from a venue harmless rather than
corrupting.

**Pending** is the one worth stopping on, because it breaks the pattern.
A pending order is one *the engine itself is watching* — an armed trailing
stop, a stepped stop, a time-tightening stop. The venue has never seen it
and never will until it triggers.

Which produces a small, deliberate asymmetry: when an acknowledgement
arrives for a pending order, it does **not** get promoted to working. It
stays pending, because "working" means the venue holds it, and the venue
does not. Most state machines would treat any ack as forward progress.
This one asks what the state actually means and declines.

That distinction matters because of what Chapter 17 established: an
engine-held stop only protects while the engine is running. Knowing which
of your protective orders live at the venue and which live in your own
process is not a technicality — it is the difference between protection
that survives a crash and protection that doesn't.

## A bracket is three orders that must act like one

A bracket, as data, is an entry plus a target price plus a stop
specification. But it carries one extra thing worth noticing: the
*original expressions* the strategy wrote for those child prices, not just
the numbers they evaluated to.

The reason is a small piece of honesty about fills. A bracket is built
before the entry fills, so any child price computed from the entry — "a
stop half a percent below" — is computed from an *estimate*. When the
entry actually fills, at whatever price it actually got, the children can
be re-anchored to reality rather than to the guess. Keeping the expression
rather than only its result is what makes that possible.

How the bracket reaches the venue then depends on Chapter 17's capability
question. Where the venue understands brackets, it goes as one message and
the venue attaches the protection to the position. Where it doesn't, the
engine sends the entry alone and holds the two children back until it
fills — because sending exits for a position that does not yet exist is
how you end up with a resting order that outlives its reason.

## The either-or that the venue never promised

Now the hard part. A stop and a target are *one-cancels-the-other*: if one
fills, the other must not.

On most venues, that relationship does not exist. Two orders rest
independently, and the OCO is a fiction the engine maintains. Which raises
the obvious question — what happens in the gap between one filling and the
cancel for the other arriving?

![Four sequenced steps: place one leg, wait for acceptance, both rest at the venue, one fills and the sibling is cancelled — with a branch for both filling first](/diagrams/chapter-18/an-oco-is-not-atomic.png)

*Figure 18.2 — the OCO as it actually happens. Step 3 is a real window, and step 4 is a race against it.*

The first decision removes a problem that would otherwise exist at the
start. The legs are **sequenced, not sent together**: leg one goes, and
leg two is sent only once the venue has *accepted* leg one. If leg one is
rejected, the pair is abandoned and leg two is never sent at all.

That closes what would otherwise be a nasty asymmetry — one leg resting at
the venue with no sibling, protecting nothing, cancelling nothing, just an
order sitting there because its partner failed. There is no one-legged
window because there is never a moment when only one leg was *supposed*
to exist.

The second decision is subtler, and it is worth taking slowly.

When one leg fills, the other must be cancelled. To cancel an order you
have to name it, and the name the venue understands is the ticket *it*
assigned — which arrives with the acknowledgement.

So there is a window where the sibling has been sent but not yet
acknowledged. In that window qkt has no venue ticket for it. A cancel sent
now names nothing, and the venue discards it silently — no error, no
effect, and an order still resting that everyone believes is gone.

The cancellation is therefore *deferred* until the acknowledgement lands,
and fires the moment it does. A cancel that quietly does nothing is worse
than one that waits.

And the trigger for all this is the **first partial fill**, not the final
one. The moment the venue commits any volume to one leg, the other is
cancelled — because waiting for the leg to finish filling leaves the
sibling live for exactly as long as the fill takes.

## When the race is lost

Which leaves the case the design cannot prevent. Both orders are resting.
A fast market crosses both levels within one tick, or a cancel is lost.
Both fill.

The position is now double the intended size, in two directions or one,
and no rule anywhere said this could happen — because the rule was qkt's,
and the venue never agreed to it.

qkt detects this and closes the second position by ticket, which works
because Chapter 5's ledger knows exactly which position that fill created.
If there is no ticket to close by — a venue that does not expose them —
it **refuses to guess**, because the alternative is firing a blind
opposite-side market order and hoping it lands on the right thing.

Both branches raise an operator alert. That is the part worth keeping: the
compensable case is not treated as a non-event just because it was
handled. Somebody is told, every time, because an invariant the system
depends on was violated by the outside world and that is worth a human
knowing even when the software coped.

## Deadlines, and a gap worth naming

An order can carry an expiry — good-till-date. Where the venue supports it
natively, the venue enforces it. Where it doesn't, the engine cancels the
order on the first tick past the deadline.

That phrasing hides something, and it should be said plainly:

> [!WARNING]
> Engine-side expiry is **tick-driven**. No independent timer re-checks
> deadlines, so if ticks stop arriving — a quiet market, a feed outage, a
> restart — an expired order sits past its deadline until the next tick
> arrives to notice it. It is cancelled late rather than on time.

There is a nice piece of prevention at the other end of the same feature.
An order whose deadline has *already passed* when it is about to be
submitted is rejected locally, before the venue is contacted, and the
rejection names both clocks — the engine's and the wall's. The reasoning
is that such an order could only round-trip into a venue rejection anyway,
and a divergence between bar time and wall time is much easier to
understand when it is reported as itself than when it arrives disguised as
a venue error code.

A sibling check refuses a bracket whose stop or target is *already crossed*
at submission time, and the argument there is pure Chapter 20: such an
order would fill and instantly stop out in a backtest, which is not what
live would do. Refusing it keeps the two worlds agreeing.

## The tripwire underneath

One last guard, and it is the one that makes the rest safe to trust.

Every protective exit the engine manages is supposed to *reduce* a
position. That is the whole point of it. So after any exit fills, the
engine checks the net position — and if the exit somehow left exposure
sitting on its own side, meaning the "exit" actually opened or increased
something, it raises an alert immediately.

This is a backstop rather than a mechanism: nothing in the design should
ever trip it. Its job is to make sure that if some future path does break
the invariant, it breaks *loudly* on the first occurrence instead of
accumulating quietly. The related sweep retires protective exits that a
netting fill has orphaned — a resting stop whose position no longer exists
would otherwise eventually fire as a naked entry in the opposite
direction, with no protection of its own.

## The state it takes to keep a bracket honest

What it bought is that a strategy writes one bracket and gets one bracket's
worth of behaviour, on venues that support none of it, with every window
where that could break either closed by sequencing or detected and
compensated.

What it cost is a genuinely large amount of state. Parent and child links,
sibling links, deferred cancels, one-shot guards, per-order satellite maps
for trailing high-water marks and stack tiers — all of it living in the
engine because the venue would not hold it. Every one of those maps has to
be torn down when an order dies, and one that isn't leaks for the life of
the process.

And the honest gap: a GTD order's deadline is only as timely as the next
tick. Everything else in this chapter defends against the outside world
misbehaving. That one is a case where the engine's own liveness is the
limit, and the design says so rather than implying a timer that isn't
there.
