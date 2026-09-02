---
title: "Indicators"
excerpt: "An indicator is the most familiar object in trading software. A moving average is an average. A Bollinger band is a mean plus so many standard deviations. Ask anyone who has used a charting package..."
date: 2026-08-31
order: 14
draft: false
---

## The layer everyone assumes is simple

An indicator is the most familiar object in trading software. A moving
average is an average. A Bollinger band is a mean plus so many standard
deviations. Ask anyone who has used a charting package and they will tell
you an indicator is a formula, and they will be right.

The formula is not where the difficulty is. The difficulty is that an
indicator is a *stateful thing living in a stream of time*, and almost
every interesting problem in this chapter comes from that sentence rather
than from any of the maths.

Three of those problems are worth the chapter. When is an indicator's
answer allowed to be trusted? What happens when the answer doesn't exist?
And what happens when a rule wants to compare two streams that don't tick
at the same time?

## An answer, or the absence of one

Start with the smallest piece. Every indicator in qkt exposes the same
tiny surface: feed it an input, ask it for a value, ask whether it is
ready.

The interesting part is the return type — the value is allowed to be
**absent**, and the source says exactly how to treat that: *"`null` from
`value` means 'not yet computable'... Callers should treat null as a hard
'skip this bar' rather than coalescing to zero."*

That instruction is the same discipline Chapter 7 spent a whole chapter
on, arriving in a new place. An average of three bars when twenty-one are
required is not zero, and it is not "close enough" — it is *no answer*,
and the difference between representing that honestly and flattening it to
a number is a rule that fires on a value nobody computed.

The absence shows up again from an unexpected direction: arithmetic that
has no answer. The square root of a negative number, a logarithm of zero,
a division by zero — each returns nothing rather than throwing or
substituting. Because the language has a way to test for that, a strategy
can say *if this is undefined, do something else* rather than crashing or,
much worse, trading on a fabricated value.

## Seeding: where the first number comes from

An exponential moving average has a recursive definition — today's value
depends on yesterday's. Which raises the obvious question: what is the
value on the first day, when there is no yesterday?

qkt's answer is the classical one, and worth seeing because it explains
the shape of every warmup number in this book. The first `period` inputs
are accumulated as a plain running sum, and the first reading emitted is
their simple average. Only from input `period + 1` onward does the
exponential recurrence actually run.

So an `ema(close, 21)` does not produce a *meaningful* value until it has
seen twenty-one bars, and — critically — it does not produce a *wrong*
value before that. It produces nothing.

That is why Chapter 13's warmup arithmetic asks each indicator how many
bars it needs rather than inferring from its arguments. The indicator
knows, because the indicator is the thing doing the seeding. `MACD(12, 26,
9)` answers thirty-four rather than twenty-six because its signal line is
an average of the MACD line, and cannot begin until that line exists.
Nothing outside the indicator could have worked that out without
re-deriving the maths.

## The subtlest bug in the chapter

Now the interesting one, and it is a case of two entirely reasonable
decisions colliding.

Decision one: when a bar closes, every indicator is updated with it, and
*then* rules are evaluated. Update, then fire. This is obviously right —
a rule should see the freshest possible state, and any other order would
mean rules reading yesterday's indicators.

Decision two: `highest(close, N)` means what it says — the highest close
over the last N bars.

Put those together and write the single most common breakout rule in
trading: *buy when the close exceeds the highest close of the last twenty
bars.*

![Two panels showing the same seven bars: on the left the rolling window includes the bar that just closed, so close can never exceed the highest; on the right the window covers the bars before it, and the breakout is detected](/diagrams/chapter-14/why-highest-lags-one-bar.png)

*Figure 14.1 — the same closing bar, and the same rule, differing only in whether the window contains the bar being compared against it.*

The bar closes at 113. It is pushed into the indicator. The indicator's
window now *includes* 113, so the highest close over the window is 113.
The rule asks whether 113 is greater than 113. It is not. It never will
be — not for this bar, not for any bar, not ever, because a value cannot
exceed a maximum it is itself a member of. The rule is not merely wrong;
it is *unsatisfiable*, and it fails silently, forever, on a strategy that
looks completely reasonable.

qkt's fix is to make `HIGHEST` and `LOWEST` — and only those two — report
the extreme over the N bars *before* the current one. The breakout rule
then means what its author intended: 113 against a prior high of 111 is a
breakout, and the rule fires.

Two things about this are worth sitting with. The first is that the fix
lives in the indicator rather than in the documentation, because the
alternative is asking every strategy author to remember to lag the window
by hand, forever, and to notice when they forget — which is exactly the
class of problem no one notices, since the symptom is *nothing happening*.

The second is that this is a genuine asymmetry, and it should be known
rather than discovered. Every other rolling function in the catalogue
includes the current bar. These two do not. That is defensible — it is
what the trading vocabulary means by "breakout" — but it is a special case,
and a reader who assumes uniformity will eventually be surprised by it.

## What the catalogue is, and why it's closed

The catalogue is broad: moving averages in several flavours, oscillators,
volatility measures, statistical functions — z-scores, regression slopes,
percentile ranks, skew — plus candle-shape oscillators, volume measures,
bands, directional movement, session-anchored measures like pivots and
session VWAP, and cross-series measures like correlation and beta.

And it is closed. There is no way to define a new indicator from inside a
`.qkt` file. A genuinely new one is written in Kotlin, added to the
registry, and shipped in a build.

This is Chapter 12's bargain arriving at its most concrete point. The
registry is what makes the warmup walk possible — each entry knows its own
bar requirement, so the compiler can ask. It is what makes the editor's
completions provably correct, because the editor reads the same table the
compiler validates against. An extension point in the DSL would break both
properties on the day someone used it.

There is a small, honest cost inside the catalogue worth naming. An
indicator with several outputs — a MACD line, its signal, and their
histogram — is exposed as several separate entries, and each one quietly
runs *its own* private instance underneath. Referencing the MACD line and
its signal in the same rule computes MACD twice. It is duplicated work in
exchange for every catalogue entry being a simple, independent thing that
binds the same way as any other. On the scale these run at, the trade is
easy; it is still real, and a reader inspecting a profile would rather
know than deduce it.

## Two streams that don't tick together

The last problem is the one that arrives the moment a strategy stops
looking at a single instrument.

Say a rule compares a one-minute stream against a five-minute one. The
one-minute stream closes a bar every minute. The five-minute stream closes
one every five. What should the rule do on the four one-minute closes that
have no matching five-minute close?

Evaluating anyway is the tempting answer and it is wrong: the rule would
fire against a five-minute bar that hasn't finished forming, which is a
value that will still change. So qkt buffers instead. Closed bars are
collected, keyed by their end time, and the rule fires exactly once —
when every stream in the group has reported for that window.

![A one-minute stream and a five-minute stream on one timeline, with the rule firing only where both close together](/diagrams/chapter-14/aligning-two-timeframes.png)

*Figure 14.2 — a rule spanning two timeframes waits for the slower one. The intermediate bars are buffered, and no rule ever evaluates against a half-formed window.*

That leaves one question the design has to answer honestly: what if the
slower stream never prints? A venue goes quiet, a feed drops, and a window
sits half-complete forever.

qkt lets a group carry a timeout. With one set, a window that falls too
far behind is dropped — no rule fires for it, and the memory is released.
With no timeout set, the partial window is kept indefinitely, which is
correct when both streams reliably print and a slow leak when they don't.
The source says as much in plain terms rather than pretending the
unbounded case is safe.

There is a second way to combine instruments that avoids the problem
entirely, and it's worth knowing it exists: a **basket** — several
instruments composited into one synthetic index, equal-weighted on log
returns, based at 100. Because a basket *is* a stream, everything
downstream treats it as one series and the alignment question never
arises. Its first aligned window only establishes the baseline, so the
first real value lands on the second window — a one-window warmup built
into the maths rather than configured.

## What this bought, and what it cost

What the indicator layer bought is that a number a rule reads is either
right or absent. It is never approximately right, never a partially-seeded
value that looks plausible, and never a fabricated zero standing in for an
answer that doesn't exist. Every indicator knows its own warmup, which is
what lets the compiler compute the strategy's, which is what lets rules be
gated before they can act.

What it cost is a closed catalogue, some duplicated computation for
multi-output indicators, and one deliberate asymmetry a reader has to
carry: the two rolling-extreme functions lag by a bar while nothing else
does. And where two streams meet, it costs a choice — bound memory and
occasionally drop a window, or keep every window and trust the feed.

That last one is the honest shape of most decisions in this book. There
was no option that was safe in both directions; there was only the
question of which failure the system should be built to survive, and
whether the reader would be told which one was chosen.
