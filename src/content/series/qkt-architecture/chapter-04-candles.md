---
title: "Candles"
excerpt: "Anyone who has ever glanced at a stock or crypto chart has seen candles, even without knowing the word for the underlying object. Each one of those small red or green shapes on the chart is a summary of everything tha..."
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
of trading vocabulary — a moving average, a breakout, a candlestick
pattern — is defined in terms of these compressed bars, not raw ticks.
Bars are the unit trading actually thinks in.

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

The four OHLC fields map directly onto the chart shape described above.
`startTime`/`endTime` pin down exactly which window this bar covers —
necessary for the same audit-trail reason `Order` and `Trade` carried
timestamps back in the first chapter: a bar is a claim about a specific
slice of history, and that claim needs to be checkable. `bid`/`ask`
carry over from the last tick seen in the window, for the same reason a
`Tick` optionally carries them — not every price feed reports both sides
of the market, so it stays optional rather than pretending a value
exists when it doesn't.

## Building one bar at a time

The component doing the accumulating tracks one open, in-progress bar
per symbol at once — a map, not a single value, because a live system is
typically watching more than one instrument simultaneously, and each one
closes its own windows independently:

```kotlin
private val open = mutableMapOf<String, MutableCandle>()
```

Handling one tick comes down to three cases: there's no bar open yet for
this symbol (start one), the tick still belongs to the currently open
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
to reopen it, even if a late tick shows up afterward claiming to belong
to that window.

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
work. A published fact has to stay a fact. A late tick is dropped and
counted, not silently absorbed — the same instinct as returning `null`
instead of inventing a value: an unusual condition gets represented
explicitly rather than papered over.

## Quiet markets need a nudge that ticks alone can't give

Here's a genuine wrinkle worth sitting with. A bar closes, in the design
above, when a *new* tick arrives that belongs to the next window. That's
fine for an actively traded symbol. But what if a symbol goes quiet — no
trading, no ticks — for a stretch that spans an entire bar window?
Nothing arrives to trigger the close. The bar just sits open
indefinitely, and anything waiting on that bar closing waits with it.

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

This is one of the rare, deliberate places where live and backtest
genuinely can't run identical code — live has a real clock to check
against; a replay doesn't have an equivalent notion of "time passing
with nothing happening." The difference isn't papered over or left
implicit — it's a distinct method, called only where a real clock exists
to drive it.

## Naming a window without repeating a number everywhere

One last small piece worth showing, because it's a good example of a
narrow idiom doing real work. Bar durations — one minute, five minutes,
one hour — show up constantly through the system, and every one of them
is fundamentally the same thing: a number of milliseconds. Rather than
passing raw `Long` millisecond counts around everywhere (easy to mix up,
easy to misread), there's a small dedicated type for it:

```kotlin
@JvmInline
value class TimeWindow(val durationMs: Long) {
    ...
    fun windowStartFor(timestamp: Long): Long = (timestamp / durationMs) * durationMs
}
```

`@JvmInline value class` is a Kotlin feature that gives `TimeWindow` its
own name and its own methods — so a five-minute window is written and
read as `TimeWindow(300_000L)` or `TimeWindow.parse("5m")`, not a bare
number that could be milliseconds, seconds, or a mistake — while
compiling down to a plain `Long` underneath, with no extra object
allocated at runtime. `windowStartFor` is the actual bucketing math:
integer-divide a timestamp by the window size, then multiply back, and
you get the start of whichever window that timestamp falls into. It's
the one line of arithmetic the whole chapter has been building toward —
the rule that decides which bar any given tick belongs to.

---

A candle builder is nothing more than a `TickEvent` subscriber that
remembers a little more than most: instead of reacting to each tick
alone, it holds a running summary open until a window ends, then
publishes that summary as a fact of its own — one that, once published,
is never allowed to change again.
