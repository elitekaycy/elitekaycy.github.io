---
title: "The Event Bus"
excerpt: "Start with a concrete problem. The Engine from the previous chapter knew about exactly one Strategy and one Broker — wired in by name, in its own constructor:"
date: 2026-06-15
order: 3
draft: false
---

Start with a concrete problem. The `Engine` from the previous chapter knew
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

Every fact announced on qkt's bus — a tick, a fill, anything — shares one
shape:

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

`sealed interface` is the same tool `Signal` used in the first chapter —
a closed set of possibilities the compiler can check exhaustively. But
look at the two fields every event carries regardless of payload: a
timestamp, and a sequence number.

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
halfway could leave the system worse off than continuing — imagine the
sibling order actually got cancelled out at the venue, but the
subscriber that should have updated the local position record never ran
because something before it threw. That's a real gap between what the
system believes and what's actually true. The failure itself isn't
hidden either: it's remembered and re-raised once every subscriber has
had its turn.

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

---

The event bus exists because a design where one component must know
every interested party by name stops scaling the moment more than a
couple of things care about the same fact. Publish/subscribe fixes that,
and it does so here without giving up either guarantee already
established: one deterministic order for every event, decided by exactly
one authority — even once real, concurrent infrastructure is part of the
picture.
