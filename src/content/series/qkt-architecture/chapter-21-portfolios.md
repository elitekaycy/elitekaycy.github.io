---
title: "Portfolios"
excerpt: "A strategy that makes money in a trending market usually loses it in a ranging one. That is not a flaw in the strategy — it is what \"a strategy\" means. A momentum system is a bet that moves continue;..."
date: 2026-10-19
order: 21
draft: false
---

## The problem with a strategy that works

A strategy that makes money in a trending market usually loses it in a
ranging one. That is not a flaw in the strategy — it is what "a strategy"
means. A momentum system is a bet that moves continue; a mean-reversion
system is a bet that they don't. Both are right sometimes.

Which suggests an obvious answer: run both. And that suggestion contains
every hard question in this chapter.

Run both *how*? Both at full size, so the account carries twice the risk?
Switch between them, so you are always wrong for however long it takes to
notice the market changed? Split the capital evenly and accept that half
of it is always deployed against the current conditions? And whichever you
pick — who decides, how often, and what happens to a position that is
already open when the decision changes?

## What a portfolio actually declares

A portfolio in qkt is its own kind of file. It imports strategies as
children, gives each an alias, and declares how the market is to be read
and how capital is to be divided:

```
PORTFOLIO regime_adaptive VERSION 1 CAPITAL 10000

SYMBOLS
    btc = BACKTEST:BTCUSDT EVERY 1h

IMPORT 'trend.qkt'   AS trend
IMPORT 'meanrev.qkt' AS meanrev

REGIMES
    NAME market_regime
    STATE trend WHEN adx(btc, 14) > 25
    STATE range DEFAULT

ALLOCATE
    METHOD regime_weighted
    trend -> trend 0.8, meanrev 0.2
    range -> trend 0.2, meanrev 0.8

RULES
    RUN trend
    RUN meanrev
```

`adx` is the Average Directional Index — a standard measure of how
*strongly* a market is trending, regardless of direction. It runs roughly
0 to 100, and a reading above about 25 is the conventional line between
"drifting" and "genuinely trending." That threshold is a convention, not
a law, which is exactly why it sits in the strategy file where it can be
changed rather than buried in the engine.

Read the `RULES` block and notice what it does *not* say. Both children
simply run. There is no condition switching one off. The regime is not
deciding *whether* each strategy trades — it is deciding **how much of the
book each one is allowed to risk.**

![Two capital bars: in a trending market trend gets 80% and mean-reversion 20%; in a ranging market the split reverses](/diagrams/chapter-21/tilting-not-switching.png)

*Figure 21.1 — the same two children in both regimes, with the dial turned rather than a switch flipped.*

That is a meaningfully different design from "detect the regime, run the
matching strategy," and the reason is a problem every regime-switching
system has: **regime detection is late.** By the time an indicator
confirms a trend, some of the trend has happened. A hard switch means the
strategy that was about to be right is the one you just turned off. A tilt
degrades instead of cutting — the out-of-favour child keeps a smaller
allocation, so being wrong about the regime costs you some efficiency
rather than the whole position.

The declaration is validated at parse time, and the checks are exactly the
ones that would otherwise become expensive misunderstandings. Weights are
all-or-none across the children, so a portfolio cannot half-specify its
allocation. Each weight sits in `(0, 1]`. And the weights must **sum to at
most one** — the source's phrase for this is *no implicit leverage*. Three
children at sixty per cent each is not a portfolio, it is 1.8× the account
without anybody having typed a leverage figure.

## One dial, two hands on it

The allocation weight is not the only thing scaling a child's orders.
Chapter 6's risk machinery also produces a de-risk factor when the book is
in drawdown, and the two **multiply into a single scalar** applied to each
new order.

That composition is the interesting part. A regime favouring a child does
not exempt it from the book's drawdown response. A child can be
simultaneously the right strategy for current conditions and required to
trade smaller because the account as a whole is having a bad week. One
number, two independent authorities feeding it.

And one exception, which is Chapter 6's rule arriving in a new place:
**orders that reduce a position always pass at full size**, whatever the
scale. A child whose weight has gone to zero can still close what it
holds. Scaling down new risk must never become an inability to exit — the
same principle as a halt being a one-way valve rather than a lock.

## Two switches, and only one of them is automatic

Capital tilting is the normal case. Sometimes a child genuinely needs to
stop, and that is where a nice piece of state design shows up.

Each child carries **two independent flags**, and it trades only when both
allow it.

![The regime gate and the operator stop, ANDed into whether a child is effectively active](/diagrams/chapter-21/two-switches-one-child.png)

*Figure 21.2 — one automatic switch and one human switch, which cannot overwrite each other.*

The **regime gate** is set by the portfolio on every closed candle. It
moves whenever the market does.

The **operator stop** is set by a human and is sticky. No amount of
regime change clears it.

Keeping them separate solves a problem that a single boolean cannot. If
there were one flag, an operator disabling a misbehaving child would have
their decision silently reversed the next time the regime evaluated — the
machine overwriting a human's judgement without anybody noticing. Two
flags ANDed means the automatic system can move its own switch freely and
never touch the human's.

The command to bring a child back is precise in a way worth pointing at:
`qkt start <portfolio>/<child>` clears **only** the operator stop. It does
not force the child active. It hands control back to the regime, which
will decide on the next candle. Resuming means *stop overriding*, not
*start trading*.

Deactivation by the regime also has a choice attached. By default a
deactivated child is flattened — positions closed, risk removed. But a
child imported with `hold` keeps managing what it already has, running its
exits without opening anything new. The distinction matters because
flattening a position because a moving average crossed is itself a trading
decision, and not always the one you want.

## Stopping a child is not stopping the portfolio

There is a deliberate asymmetry in the operator surface that is easy to
miss and important in practice.

Stopping a **child** is a reversible flag flip. The child process keeps
running, keeps receiving ticks, keeps its state — it simply is not active.
Bringing it back is one command, and it is cheap because nothing was torn
down.

Stopping the **portfolio** is a destructive teardown. Children are
flattened, the supervisor stops, everything is closed, and coming back
requires a redeploy.

Deploy is atomic in the same spirit: if any child fails to start, every
child already started is closed before the failure propagates. There is no
half-deployed portfolio, because a book missing one of its children is not
the book anybody configured — it is an unbalanced allocation nobody chose.

## The same gate in both worlds

One structural detail is what makes any of this trustworthy: the component
that evaluates regimes is the *same class* in backtest and in live. It
compiles the `WHEN` conditions with full indicator binding, keeps its own
candle aggregation, and produces a deterministic decision on every closed
candle.

That is Chapter 20's first invariant applied one level up. A portfolio
whose regime logic ran differently in backtest would produce allocation
histories that could never be reproduced — and allocation *is* a trading
decision, just a slower one.

Worth noting: the gate is candle-driven, not tick-driven. Regimes change
on closed bars. For a decision about market character measured over
fourteen hourly bars, that is correct, and it means the allocation cannot
flicker between two ticks.

## One book, shared

What it bought is a book that adapts without anyone editing a file: two
strategies, both running, with the balance between them following measured
market conditions, and the whole thing behaving identically in a backtest
so the adaptation can be tested rather than hoped for.

What it cost begins with the risk caps. They are **book-wide, not per
child** — three children do not get three times the daily loss limit.
That is unambiguously right, and it means children genuinely compete for
one budget, so a child having a bad morning consumes room the others might
have wanted.

There is a subtler cost in the layering. Because a portfolio wraps its
children, anything the wrapper does not explicitly pass through does not
reach them — and the source records a case where exactly that happened:
warmup seeding was keyed to a capability the wrapper did not expose, so
children ran unseeded in one mode and seeded in the other. Delegation
forwards what it declares and silently drops the rest, which makes a
wrapper a place where two modes can quietly diverge.

And the surface has honest edges. Portfolios do not nest. Certain
constructs available in a strategy's rules are not available in a
portfolio's regime conditions, and are refused rather than half-supported.
The engine underneath knows several allocation methods; the language
currently exposes one.

Each of those is a boundary drawn where the guarantees stop, stated rather
than discovered — which by this point in the book is the most reliable
signal that a piece of a trading system was designed rather than
accumulated.
