---
title: "Backtest Fidelity"
excerpt: "Here is a trade. You are short one lot of something at 100, with a stop-loss at 103 to cap the damage and a take-profit at 97 to bank the win. Ordinary, unremarkable, the kind of bracket a strategy..."
date: 2026-08-10
order: 11
draft: false
---

## A coin flip you never see land

Here is a trade. You are short one lot of something at 100, with a stop-loss
at 103 to cap the damage and a take-profit at 97 to bank the win. Ordinary,
unremarkable, the kind of bracket a strategy places a hundred times a week.

Now here is the bar that follows: it opened at 100, ran as high as 110, fell
as low as 90, and closed at 105.

Read those four numbers again and notice what just happened. The price
touched 103 at some point, so your stop was hit. The price also touched 97 at
some point, so your target was hit. Both of them. The bar is perfectly happy
to report this, and it is not a broken bar or an exotic edge case — a wide
bar containing both sides of a bracket is completely routine.

So which one filled? If the price ran down to 97 first, you banked a winner
and were flat long before it climbed anywhere near 103. If it ran up to 103
first, you were stopped out for a loss and were flat long before it ever fell
to 97. Same four numbers. Opposite outcomes. Opposite signs on your P&L.

The bar cannot tell you which happened, because a bar is not a recording of
what the price did. It is four facts about where the price had been, with the
order thrown away.

![Left: one candle with open 100, high 110, low 90, close 105, and a stop at 103 and target at 97 drawn across it. Right: two possible intra-bar price paths through those same four numbers — one that reaches the target first and wins, one that reaches the stop first and loses](/diagrams/chapter-11/bar-hides-a-coin-flip.png)

*Figure 11.1 — the same open, high, low and close, and two paths through them that a backtest would have to score in opposite directions. Once the position is flat, everything the bar does afterwards is irrelevant — which is exactly why the order of the extremes decides the trade.*

## The gap between what you stored and what happened

This is the honest centre of backtest fidelity, and it's worth stating
plainly before any code appears: **a backtest is only ever as truthful as the
resolution of the data underneath it.**

Chapter 4 built the compression that gets us here. A five-minute window
containing nine hundred price changes becomes four numbers, and those four
numbers are genuinely the ones trading vocabulary is built on. What Chapter 4
noted in passing, this chapter has to confront: the compression is lossy in
exactly the dimension that decides trades. Open, high, low and close survive.
*Sequence* does not.

For a strategy that only ever acts on closes — buy when this average crosses
that one — the loss doesn't matter, because the decision is made at the close
and the close is preserved exactly. The moment a strategy places anything
that can trigger *inside* a bar, the missing sequence becomes the whole
outcome. Stops trigger intra-bar. Targets trigger intra-bar. Brackets are two
intra-bar triggers pointed in opposite directions, and the one that fires
first cancels the other.

And a real venue has no such ambiguity. It watched the path happen, tick by
tick, and it knows precisely which level was touched first because it was
there. The ambiguity is not in the market. It is in your storage.

## What qkt does with a bar it cannot trust

Chapter 4 showed the mechanism already: a stored bar is not fed to strategies
as a bar, it is turned back into four synthetic ticks — open, the two
extremes, then close — and pushed through the same aggregator and the same
engine that live ticks flow through. What Chapter 4 deliberately left alone
is the interesting part. *In which order do the two extremes come out?*

That question is the coin flip, and qkt answers it the same way every time:

```kotlin
// Decided once per bar, here rather than at bar start: the Open tick above has
// already been processed, so an entry filled on this bar's open steers its own
// extremes toward the adverse-first order.
highFirst = positionSign(bar.symbol) < 0
```

The adverse extreme goes first. If the position on that symbol is long, the
**low** is emitted before the high — the stop underneath gets tested before
the target above. If the position is short, the **high** comes first — again
the stop, which for a short sits above, gets tested before the target below.
Flat, with nothing to lose, the low simply goes first as a default.

Two details in that snippet repay a second look. The order is decided *after*
the bar's opening tick has already been processed, not before the bar starts —
which means a position entered on this very bar's open immediately steers its
own bar toward the pessimistic ordering, rather than getting a free
favourable pass on the bar it was born in. And the decision is cached for the
bar rather than re-read per tick, because the first extreme may well fill the
stop and flatten the position; without caching, the sign would flip
mid-bar and the second extreme could come out wrong.

## Why the pessimistic answer is the only defensible one

There are three ways to resolve a coin flip you cannot observe, and only one
of them is safe.

You could resolve it **favourably** — target first, stop second. Every
bracket that straddles a bar's range becomes a winner. A backtest built this
way doesn't just run slightly optimistic; it systematically converts the
strategy's worst, most volatile bars — precisely the ones where both levels
get hit — into its best results. The wider the bar, the more likely both
levels are inside it, and the more the lie compounds. You would be building a
report that gets *more* wrong exactly as conditions get *more* dangerous.

You could resolve it **randomly**, fifty-fifty. This is more defensible than
it sounds, and it has an honest claim: over many trades the errors wash out
and the average is roughly right. It fails on a different requirement
entirely — the one Chapter 8 spent its whole length establishing. A random
resolution makes the backtest nondeterministic. Run it twice, get two answers,
and the ability to prove that a code change did or did not alter behaviour is
gone. You would trade a known, correctable bias for the loss of
reproducibility, which is a much worse deal than it first appears.

So qkt resolves it **adversely**, every time. The reasoning is not that
pessimism is more accurate — it isn't. The true answer is genuinely unknown,
and adverse-first will be wrong roughly as often as it is right. The
reasoning is about which direction the error should point when you cannot
eliminate it. A backtest that is systematically a
little worse than reality produces strategies that survive contact with a
real venue. A backtest that is systematically a little better produces
confident numbers and unpleasant surprises. When you must be wrong, be wrong
in the direction that costs you an opportunity rather than an account.

## The problem that pessimism then creates

Here is where two features collide, and the collision is worth watching
because neither piece is wrong on its own.

Adverse-first ordering means a long position's stop is tested by a tick
carrying the bar's **low**. Now ask what price that stop actually fills at.
The natural answer — the one that is correct on real tick data — is "the
price of the tick that triggered it," because with dense real ticks the
triggering print sits essentially right at the level.

On synthetic bar ticks it isn't. The only prints inside the bar are the four
extremes, so the tick that triggers a stop at 1.09 is the one carrying the
bar's low of 1.085, and filling at the tick books the exit at 1.085. That is
half a pip of loss the strategy never actually took, invented by the
reconstruction. And it gets worse as bars get wider: the phantom loss scales
with the bar's range, so a volatile session manufactures losses in proportion
to its volatility. Worse still, it directly contradicts what the simulator
claims about itself — this is the broker that documents having *no* slippage
model, quietly applying slippage that grows with bar size.

So the bar-research path flips the rule: a triggered stop or limit fills at
**its own price level**, not at the price of the tick that triggered it. Stop
at 1.09, bar dips to 1.085, the fill books at 1.09. On real tick data the
switch stays off, because there the two answers already agree.

Notice the shape of this, because it's the same shape Chapter 4's heartbeat
had. One deliberate decision — resolve the coin flip adversely — created the
exact condition that a second deliberate decision exists to correct. Neither
is a patch on a bug. They are two halves of one coherent answer to "what
should a bar-driven fill mean," and removing either one on its own leaves the
simulation wrong.

There is one place the optimism is withdrawn again, and it's a good instinct
to see: when the gap between one bar and the next is large enough to identify
a genuine session break, a stop that the market gapped straight through does
*not* get the friendly fill at its own level. It fills at the adverse opening
print, because that is what actually happens to a stop when a market reopens
past it. The concession to reconstruction accuracy applies to ordinary bars,
not to the one situation where real slippage is guaranteed.

## What the backtest admits it isn't modelling

Fidelity isn't only about fills. Chapter 8 made the point that the paper
broker models no spread, no slippage, no latency and no rejections, and that
it says so in its own output rather than letting you assume otherwise. This
chapter is where that disclosure earns its place, because there are now
several fidelity tiers and the difference between them is exactly what a
reader needs to know before trusting a number.

The fast paper tier is explicit that it offers *optimistic fills: no spread,
slippage, latency, rejection, queue, or partial-fill model.* A more realistic
venue-simulating tier models spread, slippage and the venue's own sizing
rules, while still not reproducing strict stop-distance or latency stress.
A stress tier deliberately fills adversely throughout, and labels itself as
being for robustness testing rather than as a base-case expectation.

The important design decision isn't that these tiers exist — most systems
have something similar. It's that the disclaimer is attached to the
*result*, machine-readable, and travels with it. A number produced under the
optimistic tier carries its own statement of what it did not model,
everywhere that number goes. You cannot end up holding a Sharpe ratio and
have to remember which execution assumptions produced it, because the
assumptions are stapled to the ratio.

And one limit deserves naming directly, because it is the quietest failure in
this chapter.

> [!DANGER]
> A strategy whose rules read the **spread** — the gap between what buyers
> are bidding and what sellers are asking — has nothing to read on a feed
> synthesised from bars, because bars do not carry both sides of the market.
> Those rules do not error. They evaluate as undefined and never fire, so a
> backtest of a spread-aware strategy on bar data reports that it took no
> trades rather than that it could not be tested.

qkt detects the combination and warns, which is the best available answer,
but the warning *is* the fix — there is no way to reconstruct a bid/ask
spread from four mid prices.

## An honest fiction

What all this bought is a backtest whose fills are defensible. Every
intra-bar ambiguity resolves the same way on every run, so results reproduce;
it resolves against the strategy, so the numbers understate rather than
flatter; and the one place that resolution invents a cost that never existed
is corrected rather than quietly tolerated. A strategy that looks profitable
under these rules has cleared a bar set slightly higher than reality.

What it cost is that none of it makes the underlying ambiguity go away. The
four-tick reconstruction is still a fiction, and the fiction is still chosen
rather than observed. Adverse-first is a policy, not a measurement — on any
individual trade it may be exactly wrong, and a strategy whose edge depends
on the true intra-bar path is not being tested by this at all; it is being
tested against a convention. Spread-sensitive logic cannot be evaluated here
at all. And every one of those limits is a reason the tiering exists: the
honest use of a bar-driven backtest is to reject bad strategies cheaply, not
to certify good ones.

The only real cure is better data. Replay actual ticks and the ambiguity
disappears, because the sequence was never discarded in the first place —
which is why the ordering machinery in this chapter checks whether it's
looking at real ticks and quietly steps aside when it is. Everything here is
scaffolding for the case where the truth was thrown away before you got to
it, and the most valuable thing scaffolding can do is be honest about being
scaffolding.
