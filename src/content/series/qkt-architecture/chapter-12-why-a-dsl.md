---
title: "Why a DSL"
excerpt: "Here is a complete trading idea, stated the way a trader would state it to another trader: *buy when the nine-bar average crosses above the twenty-one bar average, and get out when it crosses back.*"
date: 2026-08-17
order: 12
draft: false
---

## The strategy is the easy part

Here is a complete trading idea, stated the way a trader would state it to
another trader: *buy when the nine-bar average crosses above the twenty-one
bar average, and get out when it crosses back.*

That is genuinely the whole idea. Two sentences, no ambiguity, and any
trader reading them knows exactly what is meant. Now make a machine do it,
every minute, for a year, with real money — and notice how quickly the
sentence stops being the hard part.

The obvious move is to write a program. Define a class, give it two
exponential-moving-average objects, feed it every candle, compare the two
numbers, emit a signal. That works, and for a single strategy on a single
symbol it is genuinely fine. qkt could have stopped there — the `Strategy`
interface from Chapter 1 is exactly that shape, and it still exists
underneath everything in this chapter.

But somewhere between "this runs" and "I would leave this unattended with
my own money," a set of questions shows up that a program is very bad at
answering.

## The question you cannot ask a program

Start with the one that matters most, because it decides the rest.

**How many bars of history does this strategy need before it is safe to
trade?**

That is not an idle question. An exponential average with a period of
twenty-one does not produce a meaningful number from three bars — it
produces *a* number, a real one, computed from a buffer that is still
filling. Nothing about it looks wrong. It is not null, it does not throw,
it will happily sit on the left-hand side of a comparison and cause an
order to be sent. A strategy that starts trading before its indicators
have seen enough data is not broken in a way anyone will notice until the
account statement arrives.

![A price series with the first thirty-four bars shaded as a warmup period, a red marker where a rule would fire on a half-filled indicator, and a green marker after the gate opens](/diagrams/chapter-12/warmup-is-not-optional.png)

*Figure 12.1 — the same rule, fired at two moments. The left one reads a real number computed from not enough data. Nothing distinguishes it from the right one except how much history had accumulated.*

So: how many bars? For a single average, easy — the period. For
`MACD(12, 26, 9)`, the answer is thirty-four, not the twenty-six the
largest number suggests, because the signal line is an average *of* the
MACD line and cannot start until that line exists. For an average of an
average — `ema(ema(close, 9), 21)` — the requirements add rather than
max out: thirty bars, not twenty-one. For a rule comparing a one-minute
stream against a five-minute one, the answer is two different numbers,
one per stream, in each stream's own bars.

Now ask a program that question. Not "run it and find out" — *ask it*,
statically, before anything trades. You cannot. Answering it means
knowing every indicator the code will construct, with what parameters,
composed how, across which streams, along every branch it might take. For
arbitrary Kotlin, that is equivalent to running it. The information is in
there, but it is not *reachable*.

This is the argument for a language rather than an API, and it is not
about elegance or terseness. It is that a closed, enumerable notation can
be *interrogated*, and a general-purpose program cannot.

## What that notation looks like

Here is the entire momentum strategy — the same one whose fill you saw at
the end of Chapter 1 — as qkt actually expresses it:

```
STRATEGY momentum VERSION 1

SYMBOLS
    btc = BACKTEST:BTCUSDT EVERY 1m

RULES
    WHEN ema(btc.close, 9) CROSSES ABOVE ema(btc.close, 21)
     AND POSITION.btc = 0
    THEN BUY btc SIZING 0.1 ; LOG "long entry"

    WHEN ema(btc.close, 9) CROSSES BELOW ema(btc.close, 21)
     AND POSITION.btc > 0
    THEN CLOSE btc ; LOG "exit"
```

Read it against the two-sentence version of the idea and almost nothing
has been added except precision. `EVERY 1m` says which bars. `POSITION.btc
= 0` is the guard that stops a second entry stacking on the first —
the detail a trader leaves implicit and a machine must be told.
`CROSSES ABOVE` is a relationship between two series over two bars, not a
greater-than.

It would be fair to suspect a language this readable can only express toy
ideas. It can't be — a real qkt file reaches considerably further:
declaring defaults, restricting trading to certain hours, firing an
either-or pair of entries where either or both may fill, attaching a
bracket to each, expiring an unfilled order after ten minutes, and adding
to a winning position in tiers as it moves in your favour. That is dense,
genuinely professional trading logic, and it fits in about thirty lines
because every one of those concepts is a first-class word in the
language rather than an object you assemble.

## What being closed buys

Because the set of constructs is fixed and every one of them is
enumerable, the whole file can be walked before anything runs. That single
property is what pays for the language.

![One .qkt file feeding four consumers: exact warmup computation, editor completion, deploy-time validation, and the running strategy](/diagrams/chapter-12/one-source-four-questions.png)

*Figure 12.2 — the same parsed file answering four questions. Each of them requires knowing the complete set of things the strategy can do, which is exactly what a closed language guarantees and an open one cannot.*

Warmup, first. qkt walks every rule condition, every action, every sizing
expression, every bracket child price, every `LET` binding and every
sequence stage, collects the indicators each one constructs, and asks each
indicator how many bars it actually needs — `MACD(12, 26, 9)` answers
thirty-four because it computes `slow + signal - 1` rather than reporting
its largest argument. Requirements compose across nesting, and convert
across timeframes. The result is a per-stream bar count, known before the
first tick, and rules simply do not fire until every stream they reference
has cleared it.

Second, the editor. Completion and hover in the language server read from
the same indicator registry the compiler validates against, so what an
editor offers cannot drift from what the compiler accepts — they are
literally the same table.

Third, refusal. A strategy that names an indicator that doesn't exist is
rejected before it ever reaches a broker:

```
$ qkt parse strategies/broken.qkt
strategies/broken.qkt:1:1 — Unknown indicator: emaa
1 error
```

That is `qkt parse` running the identical pipeline a deploy runs, which is
also the pipeline the editor's squiggles come from. One implementation,
three surfaces.

And the compiler's refusals go past spelling. A `BRACKET` missing either
its stop or its target is rejected by name — an entry that reaches a venue
with only half its protection attached is precisely the kind of thing that
must not be discoverable at runtime. An order aimed at a read-only
synthetic series is rejected. A basket built out of another basket is
rejected. Chained comparisons are rejected outright rather than quietly
picking an interpretation:

```
$ qkt parse strategies/chained.qkt
strategies/chained.qkt:1:1 — Chained comparisons are not supported; combine explicit comparisons with AND
1 error
```

`1 < btc.close < 5` reads as one obvious thing to a mathematician and to
Python, and as something else entirely in most languages. qkt declines to
have an opinion and makes you write the `AND`.

The project's own reference documentation states the governing attitude
in a single line: *"The parser is strict by design. A strategy file that
compiles is one where the engine knows exactly what to do — there's no
'interpret loosely and hope' mode."*

## What it cost

A closed language is closed. That is the whole bargain, and the bill comes
in a specific and occasionally irritating form.

**There are no loops.** `FOR EACH` looks like one and isn't — it is a
compile-time macro that copies a rule body across a static list of
streams, so one written rule becomes N independent rules before anything
runs. It cannot iterate a list computed at runtime, cannot nest to produce
a cross product, and cannot filter. Everything it expands over must be
written out literally in the file.

**There are no user-defined functions and no recursion.** The indicator
catalogue and the math function table are fixed, compiled registries. A
strategy author who wants a genuinely new indicator does not write it in
the DSL — they add it to the catalogue in Kotlin and rebuild. The language
has no extension point, on purpose, because an extension point is exactly
the hole through which un-analysable code would enter.

**Some things must be declared that could in principle be inferred.**
Warmup derivation covers indicators thoroughly, but a rule reaching back
by index — `stream.close[N]` — is not yet walked for its own lookback, so
that case wants an explicit `WARMUP N BARS`. The documentation says so
plainly rather than letting the gap sit undiscovered, which is the right
call, but it is still a place where the reader has to know something the
compiler could have worked out.

**And it is one more thing to learn.** A Kotlin developer arriving at qkt
already knows Kotlin; they do not know this. The syntax has to be
documented, the errors have to be legible, the editor tooling has to
exist — the language server in the package list back in Chapter 2 is not a
nice-to-have, it is part of the cost of having chosen a language at all.

What the bargain buys, in exchange for every one of those, is that
"compiles" means something. Not "the syntax was acceptable" but *this
strategy is fully specified: every stream resolves, every indicator exists
with the right arity, every bracket is complete, and the exact number of
bars it needs before it may trade is a number I can print for you now.*
For code that will run unattended against real money, that is a
substantially stronger guarantee than a program can offer about itself —
and it is the reason the next chapter's pipeline is allowed to be as
strict as it is.
