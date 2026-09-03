---
title: "Parsing and Compiling"
excerpt: "At the end of the last chapter there was a text file and a promise. The file said `WHEN ema(btc.close, 9) CROSSES ABOVE ema(btc.close, 21)`, and the promise was that \"compiles\" would mean something..."
date: 2026-08-24
order: 13
draft: false
---

## Between a file and a decision

At the end of the last chapter there was a text file and a promise. The
file said `WHEN ema(btc.close, 9) CROSSES ABOVE ema(btc.close, 21)`, and
the promise was that "compiles" would mean something stronger than "the
syntax was acceptable" — that a file which passes is one where the engine
knows exactly what to do.

This chapter is how that promise gets kept. It is a short journey with an
unusual amount of refusing in it.

Start with what has to happen at all. A file is a sequence of characters.
An engine is a loop that receives candles and decides things. Something in
between has to turn one into the other, and the interesting question is
not *how* — the mechanics are ordinary — but *where the checking goes* and
what happens when a check fails.

![Six stages left to right: raw text, tokens, a tree, expanded rules, checked and bound, and objects that run](/diagrams/chapter-13/text-to-running-strategy.png)

*Figure 13.1 — the whole pipeline. Steps 1 and 2 turn characters into words, step 3 into structure, step 4 rewrites that structure, step 5 decides whether the file is allowed to exist, and step 6 is a graph of objects a running engine drives.*

## Characters, then words, then shape

The first two steps are the least surprising in the book, and worth
covering quickly because they set up everything that follows.

A **lexer** walks the file character by character and groups characters
into words — what a compiler calls tokens. `WHEN` is a keyword,
`btc` is a name, `9` is a number, `"long entry"` is a string. One token
type here is worth noticing because it is a domain decision hiding in the
plumbing: a **duration**. `10m` is not a number followed by a name — it is
a single token meaning ten minutes, and the lexer only accepts a whole
number with an `s`, `m`, `h` or `d` suffix. `10.5m` is not a duration.
That restriction exists because a trading window that is not a whole
number of minutes is almost always a typo, and it is cheaper to refuse it
in the lexer than to reason about it later.

A **parser** then turns that flat stream of tokens into a tree — the
structure the file was always describing. `a AND b > c` becomes an `AND`
whose right-hand side is a comparison, because the parser knows comparison
binds tighter than `AND`. This is standard, and qkt's is a plain
hand-written *recursive-descent* parser rather than anything generated —
meaning one small function per grammar rule, each calling the functions
for the pieces it is made of, so the shape of the code mirrors the shape
of the language.

One decision here is not standard, and it shows up the first time you make
two mistakes at once. **The parser collects errors instead of throwing on
the first one.** A file with a typo on line 7 and another on line 30
reports both, in one run. The alternative — stop at the first problem — is
easier to write, and it produces the fix-one-thing-rerun-fix-the-next-
thing loop that anyone who has used a strict compiler knows. Collecting
errors costs real complexity: the parser has to recover from a bad
construct and resynchronise well enough to keep walking, which is
genuinely fiddly. It is spent on the reader's behalf.

## The check that stops a file from ending early

There is one guard in the parser worth pulling out on its own, because
what it prevents is so much worse than what it looks like.

After every recognised block has been parsed, qkt checks that **every
token was consumed**. Not "the file parsed" — that every last token was
used by something.

Think about what happens without that check. A strategy file has a typo in
a section header: `RULE` instead of `RULES`. The parser reads the header,
the symbols, and then reaches a token it does not recognise as the start
of any block. With no end-of-input check, the natural behaviour is to stop
and report success — everything it *did* parse was valid. The file
compiles. It deploys. And it deploys with no rules in it at all, which is
to say: a strategy that connects to a broker, warms up, receives every
tick, and never trades, with nothing anywhere reporting a problem.

That is the worst failure shape in this entire book — not a crash, not a
wrong number, but a silent nothing that looks exactly like a strategy
whose conditions simply have not been met yet.

Here is the check doing its job, on a real file with its blocks in the
wrong order:

```
$ qkt parse momentum_sweep.qkt
momentum_sweep.qkt:6:1 — unexpected 'SYMBOLS' after the last recognized block
  — everything from here on would be silently ignored
```

Read the second half of that message again: *everything from here on would
be silently ignored.* The error does not merely say the file is wrong. It
says what the alternative would have been, which is the difference between
a diagnostic that helps and one that only complains. One `require`-style
check at the end of parsing is what stands between a misplaced block and a
week of wondering why the account never moved.

## Rewriting the tree before checking it

Two passes then rewrite the tree, and both are worth understanding because
they explain why some of the language's limits exist.

`FOR EACH` is the first. It looks like a loop and it is not one — it is a
copy machine. One rule body written against an iteration variable becomes
N separate, independent rules, one per named stream, before anything runs.
The substitution walks every shape a rule can contain: conditions,
sizing, order prices, brackets, stack tiers, exit hooks. After it runs,
nothing downstream knows a `FOR EACH` was ever there.

That is exactly why Chapter 12's restrictions on it hold. There is no
runtime iteration to be had, because there is no iteration at all — you
cannot loop over a list computed while trading for the same reason you
cannot copy-paste at runtime. And it is why the expansion has to happen
before checking rather than after: the compiler validates the rules that
will actually run, not the abbreviation someone wrote.

`LET` is the second, and it works the same way — a named expression is
substituted into the places that reference it. Both passes are *pure
rewrites*: they produce a tree that could have been written by hand, and
everything after this point sees only that tree.

## The stage that says no

Now the interesting part. With a fully expanded tree, the compiler walks
it and decides whether this file is allowed to exist.

![One accepted-by-the-parser strategy fanning into six distinct compile-time refusals](/diagrams/chapter-13/what-the-compiler-refuses.png)

*Figure 13.2 — every one of these files parses. None of them compiles. The distinction is the whole point of the stage: syntax is not the same as being fully specified.*

Some of these are ordinary. An indicator that does not exist is caught
because the registry is closed — `emaa` is not a name anyone can add at
runtime, so a typo is a compile error rather than a call that silently
returns nothing:

```
$ qkt parse strategies/broken.qkt
strategies/broken.qkt:1:1 — Unknown indicator: emaa
1 error
```

Others are trading decisions wearing compiler clothing. **A bracket
missing either its stop or its target is refused by name.** Not warned
about — refused. The reasoning is the one from Chapter 6: protection that
is *supposed* to be attached and isn't is worse than protection that was
never claimed, because everything downstream reasons as though the
position is covered. Discovering that at runtime means discovering it with
a position open.

**An order aimed at a read-only series is refused** — an account-equity
series or an external macro series can be read by a condition but never
traded, and the compiler knows which streams are which. **A basket built
out of another basket is refused**, because nesting composites is not
supported and saying so is better than computing a plausible, wrong index.

And then there is the one that is purely about ambiguity:

```
$ qkt parse strategies/chained.qkt
strategies/chained.qkt:1:1 — Chained comparisons are not supported; combine explicit comparisons with AND
1 error
```

`1 < btc.close < 5` is read by a mathematician and by Python as "between
one and five." Most programming languages read it as `(1 < btc.close) < 5`
— comparing a true/false value against five, which is either a type error
or, worse, quietly meaningful. There is no reading qkt could pick that is
not surprising to half its readers, so it picks none and makes you write
the `AND`. The error costs a few seconds. The wrong guess costs a strategy
that trades on a condition its author misread.

## Counting bars before anything trades

The last thing the compiler does is the one Chapter 12 built its whole
argument around: work out how much history this strategy needs.

The walk is exhaustive by necessity. Every rule condition, every action —
sizing expressions, order prices, bracket child prices, stack tier
specifications — every `LET` binding and every sequence stage gets
visited, and each indicator found along the way is asked how many bars
*it* needs. Not inferred from its arguments: asked. `MACD(12, 26, 9)`
answers thirty-four, because the signal line is an average of the MACD
line and cannot begin until that line exists, so the requirement is
`slow + signal - 1` and not the twenty-six a reader would guess from the
biggest number.

Requirements compose the way the expressions do. An average of an average
adds rather than maxes. A rule comparing a one-minute stream against a
five-minute one produces two separate numbers, each in its own stream's
bars. The result is a per-stream bar count, and rules do not fire until
every stream a rule mentions has cleared its own count.

There is a small, elegant consequence in how that gate is checked. Warmth
only ever increases — a stream that has seen enough bars cannot later have
seen fewer — so once a particular set of streams is warm, the answer is
latched and the per-stream walk is skipped from then on. A monotonic fact
only needs computing once.

## What compiling produces, and what it costs

The output is not bytecode, and it is not a tree that gets walked and
interpreted on every tick. It is a graph of ordinary objects: compiled
conditions, bound indicator instances, compiled actions, a warmup gate.
The event loop drives those directly. The text is gone by the time
anything trades.

What all this bought is the guarantee the last chapter promised, made
concrete: a file that compiles has every stream resolved, every indicator
existing with the right arity, every bracket complete, and a known number
of bars before it may act. The editor's squiggles, `qkt parse`, and a
deploy all run this identical pipeline, so what an editor tells you and
what production tells you cannot disagree.

What it costs is that strictness has no volume knob. There is no
permissive mode, no `--force` that says compile it anyway, no warning
level that downgrades a refusal into a note. A strategy that is ninety
per cent right does not run at ninety per cent — it does not run. For
someone iterating quickly on an idea, that is genuinely worse than a
language that lets a half-finished file limp along, and it is a real cost
paid every day by the person writing strategies.

The trade is that the failure it prevents is the one that does not
announce itself. A permissive compiler moves the discovery of a mistake
from your editor to your account statement, and only one of those two
places charges for the lesson.
