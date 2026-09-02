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
XAUUSD" — gold, priced in US dollars — is a signal. It carries no order id, no timestamp, no confirmation
it will ever actually happen — it's a wish, not a commitment.

**An order** is the wish turned into a formal request — the kind of object
you could hand to an actual broker. It has an identity (an order id), a
timestamp (when the wish was formalized), a type, and a price if one is
needed. The type says *how* you want to be filled: a **market** order says
"fill me now, at whatever the price is"; a **limit** order says "only at this
price or better, and wait otherwise"; a **stop** order says "do nothing until
the price crosses this level, then fill me at market." Each is a different
bargain between certainty of getting filled and certainty of the price. The gap between *signal* and *order* is where
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
now," "this call returns instantly," "the price I see is the price I get" (a
real venue quotes a slightly higher price to buyers than to sellers, and
that gap — the **spread** — is a cost the simulator has to model or admit
it doesn't) — you have
built two different systems that happen to share a strategy file. Your
backtest results become a beautiful, convincing lie about a system that
doesn't actually exist. This is why, as we go deeper, you'll notice an
almost obsessive amount of engineering effort spent making sure backtest
and live run through *literally the same code path*, with only the edges
(where data comes from, how orders actually get filled) swapped out. That's
not paranoia. That's the actual job.

Plenty of trading operations do run two systems — research in Python,
execution on a separate engine — and hold them in agreement through
testing and reconciliation. That works right up until it doesn't, because
"the backtest and the live system agree" is then a claim maintained by
ongoing effort rather than a property enforced by construction, and claims
like that decay one small divergence at a time, invisibly, in a domain
where the divergence surfaces as money. qkt takes the trade the other way:
one code path, and a research experience meaningfully slower than a
notebook, in exchange for never having to wonder.

![Two sources of ticks on the left, historical and live, feed one shared engine in the middle; the engine hands orders to one of two brokers on the right, a simulator or the real venue](/diagrams/chapter-01/backtest-and-live-share-the-middle.png)

*Figure 1.1 — the whole design tension in one picture. The ticks can come from a file or from the live market; the orders can go to a simulator or a real venue. Everything between those edges is one code path, and the entire trustworthiness of a backtest rests on it staying that way.*

## The loop, made concrete

So: a trading engine's job is to run this loop —

![Seven boxes in a loop: the price moves, the strategy decides, it states an intent, the wish is checked, the broker tries, reality comes back, the books update, and the next tick arrives](/diagrams/chapter-01/the-trading-loop.png)

*Figure 1.2 — the loop, with each step named three ways: what a trader would call it, what it is as software, and the qkt type that holds it. Every chapter from here on lives somewhere on this circle.*

— identically, whether the ticks are coming from a historical file being
replayed at whatever speed you like, or from a live feed arriving in real
time, forever, from a venue that doesn't care about your feelings.

Here is the same loop on a real run — qkt's own momentum example, on a short
BTC price series. The line is the ticks. The strategy watches a fast moving
average and a slow one; when the fast one crosses above the slow one it
states an intent to buy, the order is checked and sent, the simulated broker
fills it at the price it just saw, and from that moment the books carry a
position whose worth rises and falls with every new tick:

![A price line with a fill marked where the strategy bought, a shaded region showing the position open afterwards, and a second panel beneath showing the open profit growing from zero to one hundred and thirty-two dollars](/diagrams/chapter-01/the-loop-on-a-price-chart.png)

*Figure 1.3 — the loop on a real chart. One signal, one order, one fill at 42,280, and then the books update on every tick: by the end of the series the open position is worth +$132.*

Everything else in a trading system — risk management, position sizing,
portfolios of multiple strategies, a language for describing strategies
without hand-writing code, observability so a human can tell what's
happening — is *elaboration* on this one loop. Nothing you'll learn from
here forward is a new idea; it's this loop, extended.

## qkt as the test subject

qkt is one particular, real answer to "how do you actually build this loop
so it holds up." It's written in Kotlin, and it's built the way you'd want
any serious piece of infrastructure built: the smallest shape that can run
the loop, proven, then grown — never the other way around, where you build
something sprawling and hope determinism falls out by accident. It won't.
It has to be designed in from the first line.

Strip the engine down to the smallest thing that could run the loop and it
looks like this. Treat it as a sketch — the real engine is larger — but
every line of the sketch corresponds to something real:

```kotlin
interface Strategy {                       // a decision function
    fun onTick(tick: Tick, emit: (Signal) -> Unit)
}

interface Broker {                         // whoever can make an order real
    fun execute(order: Order): Trade?      // null = "could not fill"
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

Read it against the table above and it reads almost like plain English: a
tick comes in, the price tracker is told about it, the strategy is asked
"anything to do?", whatever it says becomes an order, the broker tries to
fill it, and if it worked, the world is told about the trade. And the real
`Strategy` interface in qkt today is that same idea, with one more argument
— a context object through which the strategy can read its own positions and
risk state without being able to change them:

```kotlin
interface Strategy {
    /** Called for every published tick. Emit signals via [emit] — never block. */
    fun onTick(tick: Tick, ctx: StrategyContext, emit: (Signal) -> Unit)
}
```

Two small design choices in that snippet are doing enormous, quiet work,
and they're worth calling out now because they pay off again and again as
the system grows:

**The strategy talks back through a callback (`emit`), not a return
value.** This means the strategy never actually calls the broker, never
actually places an order — it just describes intent to whatever function
is standing on the other end of `emit`. That's the seam where risk
management, portfolio-level gating, and eventually a whole rules engine get
inserted later, without a single strategy file ever needing to change. The
strategy never even finds out those things exist.

**The broker's answer is allowed to be "no."** In the sketch that's the
nullable `Trade?`: `null` isn't an error, it's a legitimate, expected
outcome — "I could not fill this." In the real engine the answer arrives a
moment later as an event rather than a return value, but the principle is
identical: rejection is not an exceptional case bolted on afterward, it's
baked into the shape from the start, because in real markets "I tried to buy
something and couldn't" is not rare, it's Tuesday.

## Going one layer deeper: the order and the trade

The sketch waved at `Order` and `Trade` without showing them. Worth actually
looking at them, because the fields chosen aren't arbitrary — each one
answers a specific audit question a real trading system has to be able to
answer later. `Trade` below is qkt's real type, field for field; `Order` is
the sketch's simplification of a larger family of order requests.

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
- Every price and quantity is a `BigDecimal`, never a `Double`. The short
  version, which gets its own chapter's worth of consequences later: the
  ordinary decimal type every language hands you cannot represent a value
  like `0.1` exactly, and a system that multiplies money thousands of
  times a session will drift away from what the broker's own books say.
  For money, exact beats fast.

## Determinism, made concrete

"Backtest and live must reach the same decision" is the requirement. What
enforces it is deceptively small: the two places nondeterminism most easily
sneaks in — "what time is it" and "what is the next order's id" — are never
answered by the engine itself. Time is a value the engine is *handed*: the
live session hands it the real clock, a backtest hands it a clock that
answers with whatever timestamp the tick being replayed carries, and the
code asking cannot tell the difference. Order ids come from a plain counter
— first order is always order zero — rather than anything random, so two
runs of the same data produce byte-identical output and any difference at
all means a code change altered behavior. Boring on purpose. Determinism
isn't a feature added afterward; it either holds at every layer — time, ids,
randomness — or it doesn't hold at all.

Which brings us back to where this chapter started. Hand the software
yesterday's market data and it will make yesterday's decisions, in
yesterday's order, for reasons you can step through — that was the claim,
and everything above is what the claim costs. Not one impressive
mechanism, but a series of small refusals: a clock that gets handed to the
engine rather than consulted by it, ids that come from a counter instead
of from anywhere interesting, a strategy that may only ever describe
intent, a broker allowed to answer "no."  None of them is clever. Each one
closes a door that nondeterminism would otherwise walk straight through.

And it is worth being clear-eyed that this is a tax. An engine written
without any of it would be shorter, quicker to build, and would happily
produce a backtest full of confident-looking numbers. Those numbers just
wouldn't describe anything that could be made to happen twice.
