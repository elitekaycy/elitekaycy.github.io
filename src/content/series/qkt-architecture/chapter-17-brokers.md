---
title: "Brokers"
excerpt: "A strategy says *buy gold, with a stop below and a target above*. That sentence is venue-agnostic. Nothing about it is."
date: 2026-09-21
order: 17
draft: false
---

## Every venue is a different animal

A strategy says *buy gold, with a stop below and a target above*. That
sentence is venue-agnostic. Nothing about it is.

One venue will take that whole shape in a single message and attach the
stop and target to the resulting position, then enforce them itself. The
next has no concept of a bracket at all — you may send an entry, and you
may send a stop, and keeping them related is your problem. One numbers
every position with a ticket you must name to close it. Another lets you
choose your own identifier for an order and hands it back. One tells you
about fills by pushing them down a socket; the other must be asked, on a
timer, forever.

They also disagree about things a strategy would consider settled. Whether
a second position on the same symbol is a separate thing or folds into the
first — Chapter 5's netting-versus-hedging split — is a property of the
venue. So is whether an opposite-side order closes a position or opens a
new one.

The job of a broker layer is to absorb every one of those differences
without letting any of them leak upward into a strategy, while also not
*lying* about them. Those two goals pull against each other, and the
interesting decisions in this chapter are all on that seam.

## A narrow interface with honest holes

The first decision is what a broker is required to be able to do, and the
answer is: almost nothing.

```kotlin
interface Broker {
    val name: String

    fun submit(request: OrderRequest): SubmitAck

    /** Cancels the working order with client-assigned [orderId]. No-op if already terminal. */
    fun cancel(orderId: String)

    fun modify(orderId: String, changes: OrderModification): SubmitAck =
        throw UnsupportedOperationException("$name does not support modify")

    val supportsPositionTickets: Boolean get() = false

    fun capabilitiesFor(symbol: String): Set<OrderTypeCapability> = capabilities
}
```

Submit, cancel, and a name. That is the required surface. It is
deliberately small because the engine already owns everything around it —
order management, position tracking, P&L attribution, risk. A broker is
not asked to be a trading system. It is asked to be a mouth and an ear.

Look at what the optional parts do when a venue lacks them. `modify`
**throws by default**, naming the broker. `supportsPositionTickets`
defaults to `false`. Neither one quietly returns something plausible.
That is the design's whole character in two default implementations:
a venue that cannot do a thing says so, in a way the caller cannot
mistake for success.

Everything beyond the minimum is optional, and this is where the design
gets careful. An optional capability does not silently return a plausible
answer when a venue lacks it. Ask a broker that cannot report position
tickets for its tickets and you get a refusal or an explicit empty answer,
not a fabricated list. Ask one that cannot say whether the account nets or
hedges and it answers *unknown* — a real value with real meaning, which
Chapter 5's planner then treats conservatively.

Capabilities that arrived later live in *separate* opt-in interfaces
rather than as new methods on the main one, for a stated reason: adding a
method to the core interface would break every broker implementation
compiled against an earlier release. A venue integration someone wrote
last year should keep working when the engine learns a new trick it does
not have.

## Asking, rather than assuming

Now the mechanism that makes one bracket work on two incompatible venues.

Before deciding *how* to send a shape, the engine asks what the venue can
actually do. The vocabulary of that question is a closed set:

```kotlin
enum class OrderTypeCapability {
    MARKET, LIMIT, STOP, STOP_LIMIT, BRACKET, IF_TOUCHED,
    MODIFY, OCO, TRAILING_STOP,
    MULTI_POSITION_PER_SYMBOL, POSITION_MODIFY,
}
```

Note `MULTI_POSITION_PER_SYMBOL` in that list — that is Chapter 5's
hedging-versus-netting distinction, arriving here as a thing the engine
must *ask about* rather than assume.

And it asks **per symbol**, not per broker.

![One bracket order fanning to two venues: one that attaches the stop and target natively, one where the engine decomposes it into children it manages itself](/diagrams/chapter-17/one-bracket-two-venues.png)

*Figure 17.1 — the same bracket, two decompositions. The strategy that wrote it never finds out which one happened.*

The per-symbol part is not fussiness. A single deployment can route gold
to one venue and a crypto pair to another, so "what can this broker do" is
not a well-formed question — only "what can this broker do *for this
symbol*" is. Asking a composite broker for its capabilities without naming
a symbol raises an error rather than returning a merged best guess, which
forces every caller onto the question that has an answer.

When the venue understands brackets, the stop and target are attached to
the position itself, and the venue enforces them. That has a property
nothing the engine does can match: **it keeps working while qkt is not
running.** A stop attached at the venue survives a restart, a crashed
process, a lost network. An engine-held stop is a monitor, and a monitor
that isn't running isn't monitoring.

When the venue does not, the engine decomposes the bracket into an entry
plus two children it holds itself, and cancels the loser when one fills —
the OCO machinery of the next chapter.

There is a lovely piece of restraint in the capability list. One venue can
technically achieve an OCO with two separate calls, and the broker
*declines to advertise the capability anyway*, on the grounds that
claiming it would falsely promise venue-atomic cancellation. Two calls are
not one call. Between them there is a window in which both orders are
live, and a caller told "this venue does OCO" would reasonably assume
there isn't. Refusing to claim a capability you can only approximate is
the same instinct as `null` meaning *unsupported* rather than *zero*.

A similar honesty applies to trailing stops: the capability is absent
because the venue's gateway does not actually apply the trailing distance
it is sent, so the engine emulates the behaviour instead. The capability
list describes what the venue will genuinely do, not what its API accepts.

## Two ways to find out what happened

Venues also differ in how they tell you about fills, and the two shapes
have genuinely different failure modes.

One venue is **polled**: every second, the engine asks for the current
positions and pending orders, and works out what changed. The other
**streams**: a socket pushes executions as they happen, with a periodic
reconciliation running underneath as a safety net.

Polling means fill latency is bounded by the poll interval, and it means
some outcomes are ambiguous — a submit that fails with a network error may
or may not have reached the venue, and the only way to find out is to look.
The handling of that is worth quoting for its reasoning: telling the
strategy the order was *rejected* makes it re-fire and double the
position, so the engine resolves the outcome against venue truth before
reporting anything. An honest "I don't know yet" beats a confident wrong
answer in either direction.

Streaming is faster and brings its own problem: the same execution can be
delivered twice. Both approaches therefore need deduplication, and — a
nice detail — they need *different* deduplication. The streaming venue
gives every execution a unique id, so the engine keeps a bounded set of
recently-seen ids. The polled venue has no such id, so the engine works
with time-windowed maps of tickets instead. The same requirement, two
mechanisms, because the venues offer different raw material.

One thing both share: `submit` returns immediately with an optimistic
acknowledgement, and the real outcome arrives later as an event. The
engine thread never waits on a network round trip, because Chapter 16
established that the engine thread waiting is the engine not trading.

## Several venues at once, and no safety net

A deployment can use more than one venue, and a composite broker routes by
symbol — a list of patterns, first match wins.

![Three symbols routed: two match a venue, one matches nothing and is refused](/diagrams/chapter-17/routing-with-no-fallback.png)

*Figure 17.2 — routing with no default. An unmatched symbol is a deployment error, surfaced immediately.*

The decision worth dwelling on is the absence of a fallback. There is no
default route, no "if nothing matches, use the paper broker." A symbol
that matches nothing produces a hard failure.

Consider what a fallback would do. A typo in a symbol name, a stale
profile, a half-finished deployment — any of those produce a symbol with
no route. With a fallback to the simulator, that order gets *filled*.
Cleanly. The engine now holds a position, tracks its P&L, manages its
stops, and reports it in every status command — and no venue anywhere has
heard of it. It is a position that exists entirely inside the software,
and the first time anyone finds out is when the real account fails to
match. Failing at deploy is enormously better than a phantom.

The same principle governs reads. When a composite asks all its venues for
their open positions and one fails, the answer is not "here is what the
others said." It re-raises, because a caller reconciling against a
silently-partial snapshot concludes it is flat on that venue and starts
trading on that belief. A partial truth presented as a whole one is worse
than an error.

## Absorbing the differences, and carrying them

What it bought is that Chapter 12's strategy file means the same thing on
every venue qkt supports, without pretending the venues are the same. The
differences are asked about explicitly, resolved as early as possible, and
never smoothed into a claim the venue will not honour.

What it cost is spread across three places. The engine carries a second
implementation of things a good venue does natively — OCO, trailing —
because some venues do not, and engine-held protection has a strictly
weaker guarantee than venue-held: it only works while the process is
alive. Every optional capability is a branch, and branches are places two
paths can drift. And a narrow interface means the engine, not the broker,
carries the complexity — which is the right place for it to live, but it
is a large amount of complexity to be carrying.

There is one honest gap worth naming rather than glossing. `qkt brokers
list` shows MT5 profiles and nothing else, even though the engine speaks
to more than one venue. The interface is general; that particular piece of
operator tooling has not caught up with it. Small, real, and better said
than discovered.
