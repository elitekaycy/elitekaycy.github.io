---
title: "Candles"
excerpt: "Anyone who has ever glanced at a stock or crypto chart has seen candles, even without knowing the word for the underlying object. Each one of those small red or green shapes on the chart is a summary..."
date: 2026-06-22
order: 4
draft: false
---

Anyone who has ever glanced at a stock or crypto chart has seen candles,
even without knowing the word for the underlying object. Each one of
those small red or green shapes on the chart is a summary of everything
that happened to a price over some fixed stretch of time — a minute, an
hour, a day. It answers four questions about that stretch: where did the
price start, where did it end, how high did it go, how low did it fall.
That's it. Four numbers, called **open, high, low, close** — OHLC for
short — compressing potentially thousands of individual price changes
into one shape a person can glance at and understand in half a second.

Why bother compressing at all? Because a raw stream of ticks is too
noisy and too voluminous to reason about directly, for a person or for
an algorithm. A strategy that wants to know "has this market been
trending up over the last hour" doesn't want to personally inspect every
one of the several thousand ticks that arrived during that hour — it
wants one clean number per hour: the close. Almost every classic piece
of trading vocabulary — a moving average (the average of the last N
closes), a breakout (a close beyond the recent high or low), a candlestick
pattern — is defined in terms of these compressed bars, not raw ticks.
Bars are the unit trading actually thinks in.

![Left: eleven ticks inside a five-minute window, with the first price, the lowest, the highest and the last price marked. Right: the single candle they become, with open 100, high 110, low 90 and close 105](/diagrams/chapter-04/ticks-become-a-candle.png)

*Figure 4.1 — compression. Eleven facts go in, four numbers come out, and the four are exactly the ones a trader's vocabulary is built on.*

## Turning that into a software problem

So: something has to sit between the raw tick stream and anything that
wants bars, and do the compressing. What does that something actually
need to track, while a five-minute window is still open and ticks keep
arriving? Four running numbers — the first price it saw (open, fixed
forever once set), the highest and lowest it's seen so far (high and
low, both capable of only moving in one direction as new ticks arrive),
and the most recent price (close, which keeps getting overwritten by
every new tick until the window ends). The moment a tick arrives that
belongs to the *next* window, the current one is done — it gets
finalized and handed off, and a brand new one starts.

The previous chapter already established the piece this naturally plugs
into: a component that wants to react to every tick just subscribes to
`TickEvent`. A candle builder is exactly that kind of subscriber — it
listens to the same tick stream everything else does, and rather than
acting on each tick immediately, it accumulates them until a window
closes, at which point it publishes something new of its own.

## The shape of a finished bar

```kotlin
data class Candle(
    val symbol: String,
    val open: BigDecimal,
    val high: BigDecimal,
    val low: BigDecimal,
    val close: BigDecimal,
    val volume: BigDecimal,
    val startTime: Long,
    val endTime: Long,
    val bid: BigDecimal? = null,
    val ask: BigDecimal? = null,
)
```

The four OHLC fields map directly onto the chart shape described above;
`volume` is how much was traded during the window, where the feed reports
it.
`startTime`/`endTime` pin down exactly which window this bar covers —
necessary for the same audit-trail reason `Order` and `Trade` carried
timestamps back in the first chapter: a bar is a claim about a specific
slice of history, and that claim needs to be checkable. `bid`/`ask`
— the price buyers are offering and the price sellers are asking, the two
sides of the market — carry over from the last tick seen in the window,
for the same reason a `Tick` optionally carries them: not every price feed
reports both sides, so it stays optional rather than pretending a value
exists when it doesn't.

## Which bar does this tick belong to?

Before anything can accumulate, there's a question to settle that sounds
trivial and isn't: a tick arrives carrying a timestamp — which
five-minute window is it part of?

We all know how to round a number down. That's genuinely all this is,
done in milliseconds: integer-divide the timestamp by the window size,
then multiply back, and you land on the start of whichever window that
timestamp falls into. But notice the decision hiding inside it — qkt
anchors every window to the epoch, so a five-minute bar always starts at
:00, :05, :10, and a daily bar always starts at UTC midnight.

```kotlin
@JvmInline
value class TimeWindow(val durationMs: Long) {
    fun windowStartFor(timestamp: Long): Long = (timestamp / durationMs) * durationMs
}
```

That `@JvmInline value class` is doing quiet work too. A window is,
underneath, just a `Long` — but a bare `Long` could be milliseconds,
seconds, or a typo, and nothing would catch it. Giving it a name means a
five-minute window is written and read as `TimeWindow.FIVE_MINUTES` or
`TimeWindow.parse("5m")`, while still compiling down to a plain `Long`
with no object allocated at runtime. The safety is free.

That has a consequence worth knowing about up front. Many trading
platforms use **session-anchored** bars, where the daily bar starts at the
market's own open — for FX, conventionally 17:00 New York. So qkt's daily
bar and a broker's daily bar cover different stretches of history and will
not share an open or a close, and comparing the two directly will mislead
you.

Epoch alignment is what keeps a window a pure function of the timestamp.
No session calendar, no venue rollover table, no holiday list, and — the
part that carries the most weight — the same tick lands in the same window
whether it arrives live or gets replayed years from now. Anchoring to
sessions would trade all of that away to make charts line up.

## Building one bar at a time

A live system rarely watches one instrument. Gold, a couple of FX pairs,
and BTC might all be streaming at once, and each one's five-minute window
opens and closes on its own schedule — so there isn't *a* bar in
progress, there's one per symbol:

```kotlin
private val open = mutableMapOf<String, MutableCandle>()
```

Handling one tick then comes down to three cases: there's no bar open yet
for this symbol (start one), the tick still belongs to the currently open
bar (update it), or the tick belongs to the *next* window (finalize the
current bar and start a fresh one):

```kotlin
if (tick.timestamp >= state.endTime) {
    emitClosed(state)
    open[tick.symbol] = newState(tick)
    return
}
state.update(tick)
```

`emitClosed` is the moment a finished bar gets published onto the event
bus as a `CandleEvent`, exactly the way `Engine` published `TickEvent` —
anything downstream (an indicator, a strategy trading off bars instead
of ticks) subscribes to that independently.

## A closed bar stays closed

There's a rule worth pulling out on its own, because it protects
something important: once a bar has been published, nothing is allowed
to reopen it, even if a tick shows up afterward claiming to belong to
that window.

```kotlin
if (tick.timestamp < (lastClosedEnd[tick.symbol] ?: Long.MIN_VALUE)) {
    if (countLateDrop) droppedLateTicks++
    return
}
```

Think through why this has to be true. The moment a bar is published,
anything listening — a moving average, a strategy's own internal state —
has already incorporated it into a calculation and moved on. If a
late-arriving tick were allowed to silently revise that bar's high or
close after the fact, every calculation built on top of it would now be
wrong, with no way for anything downstream to know it needed to redo the
work. Worse than wrong: an indicator that already consumed the bar would
be fed the same window twice. A published fact has to stay a fact. A late
tick is dropped and counted, not silently absorbed — the same instinct as
returning `null` instead of inventing a value.

The same guard runs one level in, against the bar currently open: a tick
older than the open bar's own start is dropped too, on identical
reasoning.

Where do late ticks even come from? Two places. A venue can deliver out
of order — and, as the next section builds, qkt itself is about to become
the second source.

## Quiet markets need a nudge that ticks alone can't give

Here's a genuine wrinkle worth sitting with. A bar closes, in the design
above, when a *new* tick arrives that belongs to the next window. That's
fine for an actively traded symbol. But what if a symbol goes quiet — no
trading, no ticks — for a stretch that spans an entire bar window?
Nothing arrives to trigger the close.

Follow that through to what it actually costs, because it's worse than a
cosmetic gap. The last bar of a thin session never closes. Every rule
waiting on that bar never evaluates. A strategy that trades the close of
each bar simply stops trading, and nothing anywhere reports an error —
the system is behaving exactly as designed, and is silently dead.

That situation is specific to live trading. During a historical replay,
the tick stream *is* the entire notion of time — there's no independent
clock ticking in the background, so there's nothing to distinguish "no
ticks arrived because the market is quiet" from "no ticks arrived
because we haven't gotten there yet." But live trading has both: a real
wall clock running continuously, independent of whether any particular
symbol happens to be trading at this moment. So live trading adds a
periodic nudge — a heartbeat — that checks whether wall-clock time has
moved past any open bar's end, and closes it even with no new tick to
prompt it:

```kotlin
fun flushClosed(nowMs: Long) {
    val it = open.entries.iterator()
    while (it.hasNext()) {
        val (_, state) = it.next()
        if (nowMs >= state.endTime) {
            emitClosed(state)
            it.remove()
        }
    }
}
```

And now the two halves meet. The heartbeat is precisely what makes the
previous section's rule load-bearing: a window can now be closed on the
clock while ticks belonging to it are still queued somewhere behind it.
The late tick isn't a hypothetical venue misbehaviour any more — the
system's own liveness mechanism manufactures it. One feature creates the
exact condition the other exists to survive, which is why neither can be
removed on its own.

This is also one of the rare, deliberate places where live and backtest
genuinely can't run identical code. The difference isn't papered over or
left implicit — it's a distinct method, called only where a real clock
exists to drive it.

![A tick arrives and one of three things happens: no bar is open so one starts; the tick is inside the open bar so it updates; the tick belongs to the next window so the finished bar is published and a fresh one starts. A fourth, red branch drops a tick older than the last closed bar, and a note explains the live-only heartbeat](/diagrams/chapter-04/one-tick-in-the-builder.png)

*Figure 4.2 — everything one tick can do to the candle builder, and the one thing that isn't a tick. Only the red branch throws information away, and it counts what it drops.*

## Replaying a bar that was never a tick stream

One more situation to handle, and it's the one a backtest lives in.
Historical data usually arrives as bars, already built — every serious
venue will send you OHLC, and qkt keeps a store of them on disk. So what
happens when the input is a bar and everything downstream expects ticks?

The bar gets turned back into ticks. Four of them — open, the two
extremes, close — at strictly increasing timestamps inside the window,
pushed through the *same* aggregator every live tick goes through:

```kotlin
fun candleToTicks(candle: Candle): List<Tick> { /* open, low, high, close */ }
```

Run the round trip and you land exactly where you started: first tick
becomes the open, the max becomes the high, the min becomes the low, the
last becomes the close. The bar in equals the bar out.

The work is worth doing because of the sentence from Chapter 1 that
decides everything. Feeding stored bars straight to a strategy would mean
live builds its bars from ticks while a backtest inherits someone else's,
and "the same strategy sees the same bars" drops from a property to a
hope — two sets of boundary rules, two definitions of what a five-minute
bar even is. Routing everything through one aggregator keeps that claim
structural: there is exactly one piece of code in the system that decides
what a bar is.

What the reconstruction cannot do is invent the path back. Those four
ticks are a fiction — a real five-minute window might contain nine
hundred price changes that wandered up, collapsed and recovered, and the
replay says it went open, low, high, close, calmly, four times. The four
numbers a bar records genuinely do not contain the sequence that produced
them.

## Four numbers, and what they threw away

A candle builder turns out to be a `TickEvent` subscriber that remembers
a little more than most: instead of reacting to each tick alone, it holds
a running summary open until a window ends, then publishes that summary
as a fact of its own — one that, once published, is never allowed to
change again.

What that bought is a single definition of "a bar" for the entire
system, one that holds identically whether the ticks came from a live
venue or a file on disk, plus a compression that turns thousands of noisy
facts into the four numbers every piece of trading vocabulary is actually
built on.

What it cost is a small pile of deliberate imprecision, all of it chosen
rather than stumbled into. Bars are anchored to the epoch, so they won't
line up with a broker's session-daily chart. Late ticks are thrown away
rather than reconciled, and the system's own heartbeat is one of the
things that creates them. And a bar replayed from storage is a plausible
reconstruction of a window, not a recording of it.

Every one of those is the same trade: give up a little fidelity to the
individual tick, and get back one definition of the truth that behaves
the same way everywhere. For a system whose entire claim rests on
backtest and live seeing the same world, that's the trade worth making —
but it's worth knowing you made it.
