---
title: "The Event Bus"
excerpt: "Start with a concrete problem. The `Engine` sketched back in Chapter 1 knew about exactly one `Strategy` and one `Broker` — wired in by name, in its own constructor:"
date: 2026-06-15
order: 3
draft: false
---

Start with a concrete problem. The `Engine` sketched back in Chapter 1 knew
about exactly one `Strategy` and one `Broker` — wired in by name, in its
own constructor:

```kotlin
class Engine(
    private val strategy: Strategy,
    private val broker: Broker,
    ...
) {
    fun onTick(tick: Tick) {
        priceTracker.update(tick.symbol, tick.price)
        strategy.onTick(tick) { signal -> route(signal) }
    }
}
```

That's a complete system — for one strategy. Now add a second thing that
needs to know about ticks. Say a component that groups individual price
updates into five-minute candles, for a strategy that trades off bars
instead of raw ticks. It has nothing to do with the first strategy, but
under this design it still needs its own field in `Engine`'s constructor
and its own line inside `onTick`. Add a second strategy trading a second
symbol: same story. Add a component that logs every tick to disk for
later review: same story again.

Notice what's happening. `Engine`'s actual job is small — "a tick
arrived, set things in motion." But it's accumulating a direct, named
dependency on every unrelated thing in the system that happens to care
about ticks, purely because in this design, knowing a name is the only
way to get told anything.

## The fix, and where it comes from

This exact problem — one component needing to notify several independent
others, none of whom care about each other — shows up constantly outside
trading software too. A news wire doesn't call each subscribing
newspaper individually to read them a story; it publishes the story
once, and any newspaper that's already subscribed picks it up. The wire
never needs to know who its subscribers are in advance, and a new
subscriber can join without the wire changing anything about how it
operates.

Software has the same pattern, with the same name: **publish/subscribe**.
A producer *publishes* a fact. Anything interested *subscribes* to that
kind of fact ahead of time. The component in the middle — holding the
list of subscribers and doing the delivery — is called an **event bus**.

![Two panels. Before: the engine box has a separate arrow to each of four listeners it must name in code. After: the engine has one arrow to a bus, and the bus fans out to the same four listeners, which subscribed on their own](/diagrams/chapter-03/publish-subscribe.png)

*Figure 3.1 — the same four listeners, two designs. Above, every listener costs the engine a field and a line. Below, the engine says "a tick arrived" once and never learns who was listening.*

This isn't a free upgrade, and it's worth being honest about what it
costs. A direct method call is traceable: you can follow it from the
call site straight into the method body, and a stack trace will tell you
exactly who called what. `bus.publish(TickEvent(tick))` gives that up —
the line itself tells you nothing about who's listening or in what
order. You gain the ability to add new subscribers without touching the
publisher. You lose the ability to know what happens next just by
reading the call site. Left undesigned, that trade can rot into a system
where nobody can say with confidence what order things happen in — a
real risk in something moving money, not an academic one.

## What actually gets published

A subscriber handed "the price moved" needs more than the price. It has to
be able to place that fact in time — and when two facts land in the same
millisecond, decide which one came first. So every event on qkt's bus,
whatever else it carries, has the same two fields bolted onto it:

```kotlin
sealed interface Event {
    val timestamp: Long
    val sequenceId: Long
}

data class TickEvent(
    val tick: Tick,
    override val timestamp: Long = 0L,
    override val sequenceId: Long = 0L,
) : Event
```

A `sealed interface` is a closed set of possibilities — every kind of event
that can exist is declared in one place, so the compiler can check that
code handling events has considered all of them. That closure does real
work here: the code that stamps events is a `when` over that sealed set,
so adding a new kind of event to the system will not compile until
stamping knows about it. "Every event carries a time and a sequence
number" isn't a convention anyone has to remember — it's a build error. But look at the two
fields every event carries regardless of payload: a timestamp, and a
sequence number.

That detail matters more than it looks. Recall why `Clock` and a
deterministic id source existed in the first place — so "what time is
it" and "what happened first" could be controlled, not left to chance.
The bus is where that control gets enforced for the entire system, not
just for orders:

```kotlin
fun publish(event: Event) {
    val stamped = stamp(event)   // the bus assigns the time and the sequence number — nothing else does
    val handlers = subscribers[stamped.javaClass].orEmpty()
    for (i in handlers.indices) {
        handlers[i](stamped)
    }
}
```

One authority — the bus, at the moment of publish — decides the
timestamp and the ordering for every event that ever flows through it.
That's what makes two replays of the same history produce identical
event ordering every single time.

Dispatch is synchronous: `publish` returns only once every subscriber has
run, on the publishing thread. That is what keeps the order reproducible —
nothing is queued for later delivery on someone else's schedule — and it
sets a standing requirement on every handler in the system. A subscriber
is expected to be quick and non-blocking, because for as long as one of
them is working, the engine is doing nothing else.

Subscribing is the other half:

```kotlin
inline fun <reified T : Event> subscribe(noinline handler: (T) -> Unit) {
    subscribers.getOrPut(T::class.java) { mutableListOf() }.add { event -> handler(event as T) }
}
```

The candle builder, the second strategy, the audit logger — each can call
`bus.subscribe<TickEvent> { ... }` on its own. `Engine.onTick` never
grows another line for any of them.

## Why the order subscribers run in isn't a detail

Here's a case worth sitting with. Say two subscribers both react to "an
order was filled." One updates the position record — you now hold one
more unit of whatever was bought. The other reacts to that same fill by
cancelling a related order elsewhere, which is now redundant because
this fill made it unnecessary.

If the cancellation subscriber happens to run first, it's making its
decision against a position record that hasn't been updated for this
fill yet. Stale state, correct-looking code, wrong outcome. Neither
subscriber is individually broken — the defect lives entirely in their
order relative to each other, and the type system has no opinion about
that.

qkt's bus makes that order something the code states on purpose:

```kotlin
inline fun <reified T : Event> subscribeFirst(noinline handler: (T) -> Unit) {
    subscribers.getOrPut(T::class.java) { mutableListOf() }.add(0) { event -> handler(event as T) }
}
```

A subscriber that must see current state before anything consequential
happens registers with `subscribeFirst`, which puts it at the front.
Everything else uses ordinary `subscribe`, which appends to the back.
Ordering stops being an accident of who signed up first and becomes a
declared property of the code.

qkt uses exactly one rule here, and it's the one the example just walked
through: the handler that applies a fill to the books goes first, ahead of
every handler that can touch the venue. And notice why the explicit hook
is genuinely necessary rather than decorative — the venue-touching
handlers are built *earlier* during startup, so with ordinary `subscribe`
they would legitimately hold the front of the queue and every one of them
would read a pre-fill book. Registration order would be correct, in the
sense of being exactly what the code asked for, and wrong in the sense
that matters.

![A fill event fans out to two subscribers: the first updates the books and is marked as registered with subscribeFirst; the second cancels a sibling order and reads the now-current position. A red note explains what goes wrong if the order were reversed](/diagrams/chapter-03/subscriber-order.png)

*Figure 3.2 — one fill, two reactions, and the only order that is safe. The books must be current before anything reads them to decide.*

Failure gets the same deliberate treatment — one subscriber throwing
doesn't silence the others:

```kotlin
for (i in handlers.indices) {
    try {
        handlers[i](stamped)
    } catch (e: Exception) {
        log.error("subscriber {} for {} failed", i, stamped::class.simpleName, e)
        if (firstFailure == null) firstFailure = e
    }
}
```

Every subscriber still runs even if an earlier one fails. Stopping
halfway could leave the system worse off than continuing — imagine an
order actually got cancelled out at the venue, but the subscriber that
should have updated the local position record never ran because something
before it threw. The engine's picture of the world and the venue's have
now permanently diverged, and nothing will notice on its own.

So the bus refuses to skip anyone. But it also refuses to swallow the
failure: the first exception is held, every remaining subscriber runs, and
then that exception is rethrown — which is what lets the layer above react
properly, halting the engine loop and raising an alert in live trading, or
failing loudly in a backtest. Continue, then complain, rather than either
crashing halfway through or quietly carrying on.

## One thread, even when the world isn't

Everything so far assumes a single thread — one continuous line of
execution — doing all the publishing. During a backtest replay, that's
simply true: one thread drives the entire replay from start to finish.
It stops being automatically true once a real broker is involved. A
network reply from an actual venue, or a background process checking
prices, arrives on a thread the engine never started.

If that outside thread published directly, two threads could race to
stamp and dispatch events at the same instant — breaking the one
guarantee the bus exists to provide.

```kotlin
val sink = offThreadSink
if (sink != null && Thread.currentThread() !== engineThread) {
    sink(event)
    return
}
```

A publish call from any thread other than the one designated engine
thread gets queued instead of dispatched immediately; the engine thread
drains that queue on its own schedule. Every event still ends up stamped
and delivered by exactly one thread, in exactly one order — no matter
how many other threads tried to publish at once. During a backtest this
condition is simply never true, so the identical code handles both
situations without a single branch that treats live and backtest
differently.

There's a subtler version of the same problem at startup, and it's worth
seeing because it's the kind of gap that only shows up under load. The
engine thread doesn't exist yet while the system is still being built —
but broker pollers and recovery logic can start producing events during
that construction. So the queue is armed *first*, before the thread is
known: from that moment every publish from every thread is queued rather
than dispatched, and the whole backlog drains in order once the loop
actually starts. Without that early arming there's a window, measured in
milliseconds, where an event could be dispatched into a half-built
pipeline on whatever thread happened to produce it.

![Two lanes. Top lane, other threads: a venue reply lands and is queued rather than dispatched. Bottom lane, the one engine thread: it drains the queue, stamps each event with a time and sequence number, and delivers to subscribers](/diagrams/chapter-03/one-engine-thread.png)

*Figure 3.3 — an event produced on the wrong thread waits in a queue; only the engine thread ever stamps and delivers. One thread, one order, even when the world is concurrent.*

## What this bought, and what it cost

What the bus bought is straightforward: the engine announces that a tick
arrived and never learns who cared. New subscribers cost the publisher
nothing. And because exactly one component assigns every event its time
and its place in line, "what happened, in what order" has a single
authority — which is the property the rest of this book quietly depends
on.

The costs are just as real, and three of them are worth carrying forward.
Reading `bus.publish(...)` no longer tells you what happens next; that
knowledge moved out of the call site and into the subscription list.
A subscriber that blocks doesn't slow one feature down, it stops the
engine. And ordering, the thing this chapter spent its longest section on,
is *declared* rather than checked — nothing in the type system stops
someone from using ordinary `subscribe` where the correct answer was
`subscribeFirst`. The bus makes the right ordering expressible and cheap.
It cannot make it automatic.
