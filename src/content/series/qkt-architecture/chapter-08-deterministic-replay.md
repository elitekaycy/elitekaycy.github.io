---
title: "Deterministic Replay"
excerpt: "Suppose someone hands you a change that touches twelve lines deep inside the order-fill handler — the same handler the last three chapters spent time inside. How do you know, for certain, that every..."
date: 2026-07-20
order: 8
draft: false
---

## The question a diff can't answer

Suppose someone hands you a change that touches twelve lines deep inside the order-fill handler — the same handler the last three chapters spent time inside. How do you know, for certain, that every strategy this engine has ever run still behaves exactly the way it used to? Not "probably fine," not "I read it carefully and it looks right" — certain.

You don't get there by reading the diff. Trading logic accumulates too much state and touches too many branches for a human to trace every path a twelve-line change might affect. The only answer that actually holds up is mechanical: take a long stretch of real historical market data, run it through the engine before the change, run the identical data through the engine after the change, and compare the two outputs — every fill price, every position, every dollar of realized P&L — down to the byte. If they match exactly, the change didn't alter trading behavior, full stop, no matter how deep it reached. If even one number differs, something changed, and now you have a very specific, very small question to answer: why did *this* number move?

That trick only works if a "backtest" is **deterministic** — a term worth pinning down precisely, because the whole chapter rests on it. A process is deterministic if, given the same input, it produces exactly the same output every single time, with zero variation, on any machine, run any number of times. This is a much stronger claim than "the backtest is realistic." It's a claim about reproducibility. And it turns out getting a piece of software to actually be deterministic — genuinely, provably, byte-for-byte — takes real, deliberate engineering. Nothing about a computer program is deterministic by default.

## Time has to stop being real

Here's the first thing that breaks determinism without anyone trying to break it: the clock. Ordinary software reads `System.currentTimeMillis()` whenever it wants to know "what time is it," and that's obviously fine for a live system — it's supposed to know the real time. But run the same backtest twice, an hour apart, and if anything inside it reads the real clock even once, the two runs are no longer comparable. A daily-loss halt's UTC-midnight boundary, a time-based exit, a candle window closing — any of these touching real wall time means the same historical data could behave differently depending on when you happened to press "run."

qkt's answer is to make time itself a value the engine is handed, not a fact it goes and looks up:

```kotlin
interface Clock { fun now(): Long }
interface MutableClock : Clock { fun advanceTo(timestampMs: Long) }

class SystemClock : Clock {
    override fun now(): Long = System.currentTimeMillis()
}
class FixedClock(var time: Long = 0L) : MutableClock {
    override fun now(): Long = time
    override fun advanceTo(timestampMs: Long) { time = timestampMs }
}
```

A live session uses `SystemClock` — genuinely reads the real world, because it's trading in it. A backtest uses `FixedClock`, and here's the mechanism that makes it deterministic rather than just "not the real clock": every time a tick is ingested, the clock is set *directly* to that tick's own recorded timestamp, before anything else runs:

```kotlin
fun ingest(tick: Tick) {
    currentTimestamp = tick.timestamp
    clock.time = tick.timestamp
    pipeline.ingest(tick)
}
```

The clock doesn't count forward on its own between events, the way a real clock does. It teleports to wherever the data says "now" is, the instant a new piece of data arrives. Every timestamp-dependent decision inside the engine sees exactly the same sequence of "now" values on every single run of the same data, because those values are *read out of the data itself*, never out of the machine running it.

## Ties need a tiebreaker

Time solves ordering for events that happen at different instants. It doesn't solve it for events that land at the exact same millisecond — which happens constantly on a fast market, or the instant a candle boundary produces several downstream events at once. If two events share an identical timestamp, "sort by time" gives no answer at all about which one processed first, and if that answer isn't fixed, two runs of the same data could quietly disagree about ordering without either one being wrong about time.

This is where Chapter 3's event bus earns a second job. Every event it publishes gets stamped with a strictly increasing sequence number the instant it's published — a plain counter, nothing clever:

```kotlin
class MonotonicSequenceGenerator : SequenceGenerator {
    private var counter = 0L
    override fun next(): Long = counter++
}
```

A tie in time is never a tie in sequence. Determinism isn't really about the clock at all — it's about *total order*: a fixed, reproducible answer to "what happened, in what exact order" for every possible input, with no ambiguity left for the runtime to resolve differently on different days.

## What actually flows through the pipeline

Put the clock and the sequencer together and you get a single, honest picture of what "replaying history" actually does, one tick at a time:

![One historical tick moving through the deterministic pipeline: the feed, the teleporting clock, the stamped event, its subscribers, and the resulting simulated fill](/diagrams/chapter-08/one-tick-through-the-pipeline.png)
*Figure 8.1 — Every one of these four steps is a pure function of the tick just handed to it and state built from earlier ticks in this same run — nothing reaches outside that sequence.*

Nothing in that diagram makes a network call, reads the system clock, or depends on wall time anywhere. Every box is a pure function of the tick it was just handed and whatever state the run has already accumulated from *earlier* ticks in the same deterministic sequence — never from anything outside it. Feed it the same file twice, you get the same diagram traced the same way twice.

## The twist: there is no second engine

Here's the part worth sitting with. It would be entirely reasonable to assume "the backtest" is its own simulator — a lighter-weight reimplementation of the trading logic, built for speed, that approximates what the real engine does. That is not what qkt does, and the reason is that a second implementation is exactly the thing that would make byte-identical comparison meaningless: two independent codebases can drift apart from each other in ways nobody notices until the numbers stop matching for real money.

`Backtest.run()` doesn't contain trading logic at all. It's a configuration object that builds and hands off to `ReplayEngine`:

```kotlin
fun run(): BacktestResult = toEngine().runToEnd()
```

And `ReplayEngine` isn't backtest-only machinery — it's the same deterministic driver used by the tooling that checks a real live trading session against what history says should have happened. `Engine`, the tiny object that turns a tick into a `TickEvent` on the bus, says as much directly in its own documentation: *"the backtest replay engine and the live `TickFeed` are the two production producers"* feeding it ticks. Two front doors, one engine behind both of them:

![Two different questions — a backtest and a live-parity replay — feeding two different tick sources into the same unmodified ReplayEngine](/diagrams/chapter-08/one-engine-two-front-doors.png)
*Figure 8.2 — A research question and an audit question, answered by literally the same code path. Only the tick source at the top changes.*

The strategy code, the position ledger, the risk engine, the accounting fold — none of it is reimplemented, simplified, or approximated for backtesting. It's the identical code path a real account runs, fed a different, deterministic source instead of a live one. Even the smallest guardrails carry that discipline through on purpose. The pipeline's tick-validation gate — the one that drops a malformed price before it can poison an indicator — says it outright in its own comment: *"Identical in backtest and live so the gate itself cannot cause divergence."* Not "similar." Identical.

This has a price, and it's a large one worth naming rather than glossing. Every replayed tick goes through the full production dispatch path — the event bus, a dozen synchronous subscribers, the risk engine, the order manager — virtual call by virtual call. A purpose-built backtester doing bulk operations over whole price arrays, which is how research tooling in this field usually works, is comfortably an order of magnitude faster, and that speed is not a luxury once a parameter search is running hundreds of backtests. qkt spends it anyway, because what the money buys is that no second implementation of a stop trigger, a fill rule, a halt condition or a rounding decision exists to drift away from the live one while nobody is watching. A faster backtest that answers a slightly different question than the live engine isn't a faster backtest; it's a confident answer to a question you didn't ask.

## The one honest exception

There is exactly one place this symmetry has to break, because there's no way around it: something has to stand in for the venue itself, since a backtest has no real market to send an order to and wait on. That's `PaperBroker` — and it's worth being honest about what it is rather than pretending it's a hidden, realistic venue simulator. Its own documentation says so plainly: market orders fill at the tracker's latest price, limits and stops resolve as ticks print through, and — deliberately — *"no slippage model, no rejection model, no latency."*

You don't have to take the source code's word for it. The tool says the same thing, out loud, every time you run it:

```
$ qkt backtest examples/tutorial/momentum.qkt --from 2024-01-15 --to 2024-01-16 \
    --starting-balance 10000 --data-root src/test/resources/cli/data --no-fetch

...
Assumptions & conventions
  Execution:  paper — fills at mid price; no spread, no slippage modeled
  Commission: none modeled — set commissionPerLot in instruments.yaml for cost-realistic PnL
  ...

Run evidence
  execution: paper-fast (paper)
  latency:   zero
  slippage:  zero
  rejects:   none
  ...

qkt: note: paper broker fills at mid with no spread/slippage — results are optimistic.
Use --broker mt5-sim and set commissionPerLot + slippagePoints in instruments.yaml
for cost-realistic backtests.
```

That bareness is a choice, not a gap left unfinished, and the report doesn't let you forget it — every run prints its own disclosure and names the actual escape hatch (`--broker mt5-sim`, `commissionPerLot`, `slippagePoints`) rather than silently pretending to be realistic. A backtest broker that quietly modeled slippage and latency by default would be lying about how confident you should be in its numbers; a backtest broker that announces its own limitations, every single time, tells you exactly what isn't accounted for, so nobody mistakes "the strategy is profitable in backtest" for "the strategy is profitable against real market friction." Everything upstream of the broker stays identical between live and backtest; the broker is the one deliberately, visibly different thing, and the tool makes sure you're told so.

## Why byte-identical, and not just "close"

Step back to the opening question. The entire payoff of building the clock, the sequencer, the feed, and the pipeline this way is that "did this change alter trading behavior" stops being a question a person has to reason their way through and becomes a question a computer can answer in seconds, with no ambiguity: run the same history twice, diff the output, done. "Close enough" would have been a much cheaper thing to build — approximate timing, best-effort ordering, a simulator that's *roughly* like the real engine. It would also have been useless for the one thing this machinery actually exists to prove: that a change to a live trading system did, or didn't, change what it does with real money. Determinism isn't a nice property a backtest happens to have. It's the entire reason a backtest is trustworthy at all.
