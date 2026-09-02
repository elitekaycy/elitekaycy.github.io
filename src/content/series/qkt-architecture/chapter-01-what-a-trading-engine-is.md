---
title: "What a Trading Engine Actually Is"
excerpt: "Strip away the mystique. Trading is a loop, repeated relentlessly, forever:"
date: 2026-06-01
order: 1
draft: false
---

## Before qkt: what is "trading," mechanically?

Strip away the mystique. Trading is a loop, repeated relentlessly, forever:

> Watch a price. Decide something. Maybe act. See what happened. Repeat.

Every trader who ever lived — a floor trader screaming into a phone, a quant
with a spreadsheet, a piece of software running at three in the morning — is
executing that loop. What changes between them is *speed*, *discipline*, and
*what "decide" means*. A trading engine is nothing more than a piece of
software that runs that loop mechanically, without fatigue, without emotion,
and — crucially — in a way you can *replay*.

That last word, replay, is the whole ballgame, and it's worth sitting with
before we touch a line of code.

If a human trader made a bad decision yesterday, you can ask them why, and
get a fuzzy, reconstructed, possibly self-serving answer. If a piece of
software made a bad decision yesterday, and it was built correctly, you can
hand it yesterday's exact market data again and it will make the *exact same
decision*, in the *exact same order*, and you can step through precisely
what it saw and why it did what it did. This property — **determinism** — is
what separates a serious trading system from a toy. It is also the single
hardest property to actually achieve, and the thing most systems get
subtly wrong.

## The vocabulary of markets, translated into software nouns

Before we can talk architecture, we need a shared vocabulary — and the
useful trick is that market vocabulary maps almost one-to-one onto software
concepts, once you see it.

**A tick** is the smallest unit of market truth: "at this instant, this
symbol was worth this price." That's it. A stream of ticks is a stream of
facts arriving over time — which, if you've built any kind of software
before, should immediately smell like an *event stream*. That's not a
coincidence; it's the correct mental model. The market doesn't hand you a
database snapshot you can query — it hands you one fact at a time, in
order, and never lets you go back and ask again.

**A strategy** is a decision function. Given everything it knows — the
current tick, its own memory of past ticks, whatever indicators it's
tracking — it answers one question: *do I want to do anything right now?*
Most of the time the answer is no. Occasionally the answer is "I want to
buy" or "I want to sell." Note carefully what a strategy is *not*: it is not
the thing that sends the order, checks if you can afford it, or decides how
big it should be. A strategy only ever expresses **intent**.

**A signal** is that intent, captured as data. "I want to buy 1 unit of
XAUUSD" is a signal. It carries no order id, no timestamp, no confirmation
it will ever actually happen — it's a wish, not a commitment.

**An order** is the wish turned into a formal request — the kind of object
you could hand to an actual broker. It has an identity (an order id), a
timestamp (when the wish was formalized), a type (market? limit? stop?), and
a price if one is needed. The gap between *signal* and *order* is where
every piece of adult supervision in a trading system lives — risk checks,
position sizing, "wait, are we even allowed to trade right now."

**A broker** is whoever can actually make the order real — a simulator
standing in for a real exchange, or the real exchange itself. It takes the
order and returns one of two kinds of truth: it worked (a fill) or it
didn't (a rejection).

**A trade** (or a fill) is the broker's answer when it worked: here's the
actual price you got, the actual quantity, the actual time. Reality, as
opposed to intent.

**A position** is what accumulates once trades start happening — "I
currently hold 3 units of XAUUSD, bought at an average price of X." **P&L**
(profit and loss) is what that position is worth right now compared to what
it cost — the number everyone actually cares about, and the number that's
surprisingly easy to compute wrong if you're sloppy about the math.

Here's the map, side by side:

| The market's language | The software's noun |
|---|---|
| "the price just moved" | a tick — an event |
| "I want to do something" | a strategy — a decision function |
| "here's my intent" | a signal — a value, not yet acted on |
| "here's my formal request" | an order — identity + timestamp + terms |
| "here's what actually happened" | a trade / fill — reality |
| "here's what I now own" | a position |
| "here's what it's worth" | P&L |

Once you see this table, you understand why a trading engine has the shape
it does — it's not an arbitrary software architecture bolted onto trading,
it's the market's own causal chain, made explicit and typed.

## Backtest vs. live: the sentence that decides everything

Here is the single most important design tension in any trading system,
stated as plainly as I can:

> The same strategy must produce the same decisions whether it's looking at
> historical data played back in a simulator, or at real prices arriving
> from the real market, right now.

This sounds obvious. It is *ferociously* hard to actually guarantee, and
almost every subtle, expensive bug in a trading system traces back to
violating it somewhere. Why is it hard? Because "backtest" and "live" differ
in almost everything *except* the shape of the data:

- In a backtest, time is a fiction — you control it, you can fast-forward,
  you know the future because it already happened.
- In live trading, time is real, ticks arrive whenever the market feels
  like sending them, and you have no idea what happens next.
- In a backtest, "sending an order" means asking a simulator to look up a
  price and pretend to fill it, instantly, in the same function call.
- In live trading, sending an order means a network round-trip to a real
  venue that might take 200 milliseconds, might fail, might partially
  fill, might get rejected for a reason you didn't anticipate.

If your strategy code, or your engine's plumbing, leans on *any* assumption
that's only true in one of these two worlds — "the current time is roughly
now," "this call returns instantly," "this price has no spread" — you have
built two different systems that happen to share a strategy file. Your
backtest results become a beautiful, convincing lie about a system that
doesn't actually exist. This is why, as we go deeper, you'll notice an
almost obsessive amount of engineering effort spent making sure backtest
and live run through *literally the same code path*, with only the edges
(where data comes from, how orders actually get filled) swapped out. That's
not paranoia. That's the actual job.

## The loop, made concrete

So: a trading engine's job is to run this loop —

```
tick arrives
    → strategy sees it, maybe emits a signal
        → signal becomes an order (with adult supervision applied)
            → broker attempts to fill it
                → a trade happens, or a rejection happens
                    → position and P&L update
                        → next tick arrives, repeat
```

— identically, whether the ticks are coming from a historical file being
replayed at whatever speed you like, or from a live feed arriving in real
time, forever, from a venue that doesn't care about your feelings.

Everything else in a trading system — risk management, position sizing,
portfolios of multiple strategies, a language for describing strategies
without hand-writing code, observability so a human can tell what's
happening — is *elaboration* on this one loop. Nothing you'll learn from
here forward is a new idea; it's this loop, extended.

## qkt as the test subject

qkt is one particular, real answer to "how do you actually build this loop
so it holds up." It's written in Kotlin, and it was built the way you'd
want any serious piece of infrastructure built: smallest possible version
first, prove the shape works, then grow it — never the other way around,
where you build something sprawling and hope determinism falls out by
accident. It won't. It has to be designed in from the very first line.

Its very first version was, almost word for word, that loop above, with
nothing else:

```kotlin
interface Strategy {
    fun onTick(tick: Tick, emit: (Signal) -> Unit)
}

interface Broker {
    fun execute(order: Order): Trade?
}

class Engine(/* strategy, broker, clock, id generator, price tracker */) {
    fun onTick(tick: Tick) {
        priceTracker.update(tick.symbol, tick.price)
        strategy.onTick(tick) { signal -> route(signal) }
    }
    private fun route(signal: Signal) {
        val order = signal.toOrder(idGenerator.next(), clock.now())
        val trade = broker.execute(order) ?: return
        onTrade(trade)
    }
}
```

Read it against the table above and it should now read almost like plain
English: a tick comes in, the price tracker is told about it, the strategy
is asked "anything to do?", whatever it says becomes an order, the broker
tries to fill it, and if it worked, the world is told about the trade.

Two small design choices in that snippet are doing enormous, quiet work,
and they're worth calling out now because we'll watch them pay off again
and again as the system grows:

**The strategy talks back through a callback (`emit`), not a return
value.** This means the strategy never actually calls the broker, never
actually places an order — it just describes intent to whatever function
is standing on the other end of `emit`. That's the seam where risk
management, portfolio-level gating, and eventually a whole rules engine get
inserted later, without a single strategy file ever needing to change. The
strategy never even finds out those things exist.

**The broker returns a nullable result — `Trade?` — not a guaranteed
answer.** `null` here isn't an error, it's a legitimate, expected outcome:
"I could not fill this." Rejection is not an exceptional case bolted on
afterward; it's baked into the type from the start, because in real
markets, "I tried to buy something and couldn't" is not rare, it's
Tuesday.

## Going one layer deeper: the order and the trade

The snippet above waved at `Order` and `Trade` without showing them. Worth
actually looking at them, because the fields chosen aren't arbitrary — each
one answers a specific audit question a real trading system has to be able
to answer later.

```kotlin
data class Order(
    val id: String,
    val symbol: String,
    val side: Side,
    val quantity: BigDecimal,
    val type: OrderType,
    val price: BigDecimal? = null,
    val timestamp: Long
)

data class Trade(
    val orderId: String,
    val symbol: String,
    val price: BigDecimal,
    val quantity: BigDecimal,
    val side: Side,
    val timestamp: Long
)
```

- `id` — if two orders go out on the same symbol in the same millisecond,
  how do you know which fill belongs to which order? You need a unique
  handle *before* you know the outcome.
- `timestamp` — not "when did this run," but "when was this decided." If
  anyone — a regulator, an auditor, future-you — ever asks "why did the
  system buy here," the timestamp is what lets you reconstruct exactly
  what the price feed showed at that instant.
- `price: BigDecimal?` on the order — nullable, and the nullability is
  meaningful, not sloppy. A market order has no price attached because
  "fill me at whatever the market is" is the entire point of a market
  order. A limit order *must* have one. The type is encoding a business
  rule directly, rather than leaving it as an unenforced comment.
- `Trade.orderId` is the join key back to the `Order` that caused it — the
  same instinct as a foreign key in a database. Without that link, you'd
  have a stream of fills with no way to explain why any of them happened.
  "Audit trail" isn't a log message; it's data that's structurally
  incapable of being disconnected from its cause.

## Why prices aren't `Double`

Worth explaining from first principles, because it trips up a lot of
people writing their first financial system.

`Double` is binary floating-point. It cannot represent `0.1` exactly — the
closest it can get is something like
`0.1000000000000000055511151231257827021181583404541015625`. For a single
comparison you'd never notice. But a trading system adds, subtracts, and
multiplies money thousands of times per session. Each operation on a
`Double` introduces a tiny rounding error, and those errors **compound**.
Run a strategy that opens and closes a thousand positions, and your
reported P&L can end up a few cents off from what actually happened — not
because of a bug, but because floating-point math is lossy by design.

The fix is a type that represents a number as an exact decimal — digits
plus a scale — with no binary approximation involved. It's slower and
more verbose to work with than raw arithmetic, but it's *exact*. For
money, exact beats fast, full stop — which is why every field in `Order`
and `Trade` above holding a price or a quantity is that exact-decimal
type, not a plain floating-point number. The full discipline this demands
— rounding only once, at a boundary, never mid-calculation, and treating
"I don't know this value yet" as a distinct fact from "this value is
zero" — is enough of its own topic to earn a dedicated look later; the
short version is: never let money math be approximate anywhere but the
final printed digit.

## Determinism, made concrete

"Backtest and live must reach the same decision" is the requirement.
What actually enforces it is two small abstractions, applied to the two
places nondeterminism most easily sneaks in: "what time is it," and
"what's the next order's id."

Instead of code asking the operating system for the current time
directly, "what time is it" becomes an injectable fact: production asks
the real wall clock, a backtest asks a clock that answers with whatever
timestamp the historical tick currently being replayed carries. The code
doing the asking has no idea which one it's talking to, and doesn't need
to — but it also never accidentally leaks today's real date into a replay
of last year's prices, which is exactly the failure mode the "backtest
vs. live" tension above described.

The same logic applies to order ids. Why not generate a random unique id
for every order? Because running the same backtest twice should produce
*identical* output — identical order ids, identical everything — so two
runs can be diffed and any difference immediately means a code change
altered behavior. A random id is different every single run by
construction, which makes two otherwise-identical backtests look
different in every diff even when nothing that matters changed. A
predictable, counting id generator — first order is always order zero,
second is always order one — is boring, and that's exactly the point.
Determinism isn't a feature bolted on afterward; it's a property that
either holds at every layer — time, ids, randomness — or doesn't hold at
all.
