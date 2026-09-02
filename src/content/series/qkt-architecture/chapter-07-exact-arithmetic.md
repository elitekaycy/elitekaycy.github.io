---
title: "Exact Arithmetic"
excerpt: "Every number this book has discussed so far — a fill price, a position's quantity, a realized gain, an account's equity — is, underneath, just a number stored in a computer's memory. And there is a..."
date: 2026-07-13
order: 7
draft: false
---

## The problem hiding inside every trading system

Every number this book has discussed so far — a fill price, a position's quantity, a realized gain, an account's equity — is, underneath, just a number stored in a computer's memory. And there is a genuinely dangerous trap waiting for anyone who reaches for the obvious tool to store it: the ordinary `Double` (or `Float`) that almost every programming language hands you by default for "a number with a decimal point."

Here's the trap, as a software concept from first principles. A computer stores a `Double` in binary — base 2. Decimal fractions that look perfectly clean to a person, like `0.1`, often have no exact binary representation, the same way `1/3` has no exact *decimal* representation (it's `0.333...`, forever). So the computer stores the *closest* binary approximation it can, which is very close to `0.1` but not exactly `0.1`. Do enough arithmetic with these approximations and the tiny errors don't cancel out — they accumulate. This isn't a rare edge case; it's the normal behavior of floating-point math. `0.1 + 0.2` in almost any mainstream language does not equal `0.3` — it equals `0.30000000000000004`.

For most software, that sliver of error is irrelevant — a rendering coordinate off by a billionth of a pixel changes nothing anyone will ever notice. For a trading engine, it's disqualifying. Every number this system produces is, eventually, a real dollar amount someone will compare against a broker's own statement, or a real order size a venue will either accept or reject to the exact decimal. An error too small to see in one calculation, multiplied across thousands of fills a day, becomes a P&L figure that quietly disagrees with the broker's own books — and worse, a place where a strategy could be silently over- or under-sized by an amount nobody can trace back to a cause. So qkt never uses `Double` for anything that represents money, price, or quantity. It uses `BigDecimal` — Java's arbitrary-precision, exact decimal type — everywhere, from the raw tick to the smallest fraction of a lot.

## Two different kinds of "how precise," for two different jobs

Switching to an exact decimal type sounds like the end of the story. It isn't, and the place it stops being enough is worth seeing, because it's the first thing anyone hits.

Being *exact* doesn't mean every operation is automatically well-defined. Addition, subtraction, and multiplication of two exact decimals always produce another exact decimal — no ambiguity there. Division is different, and this is worth understanding as its own software concept: dividing two exact decimals doesn't always produce a *terminating* decimal. `1 ÷ 3` is exactly `0.333...`, forever — there's no finite decimal that equals it exactly. Ask `BigDecimal` to divide without telling it how to handle that, and it doesn't guess; it throws an exception, because silently picking an arbitrary cutoff would be exactly the kind of hidden imprecision this whole design exists to avoid. You are required to say, at the moment of dividing, how much precision you actually want.

qkt keeps one small, central object that answers that question consistently everywhere:

```kotlin
object Money {
    val CONTEXT: MathContext = MathContext.DECIMAL64
    const val SCALE: Int = 8
    val ROUNDING: RoundingMode = RoundingMode.HALF_EVEN
}
```

These are two genuinely different tools, for two different moments. `SCALE` + `ROUNDING` is **fixed-point** precision — "keep exactly 8 digits after the decimal point" — the right answer for a value that's about to be *stored or reported*, like a final account balance. `CONTEXT` is **significant-digit** precision — "keep 16 meaningful digits, wherever the decimal point falls" — the right answer *during* a division, especially one whose result might be a very small or very large number (an FX rate can be `0.0067`, a notional can be millions), where a fixed 8 decimal places would either throw away real precision or waste space on digits that don't matter. Division reaches for `CONTEXT`; a value about to be persisted or displayed reaches for `SCALE`.

## Why round to even, not round up

We all learned one rounding rule in school, and we all learned the same one: when it lands exactly on a half, round up. 2.5 becomes 3. It's simple, it's symmetric-looking, and it is quietly the wrong rule for money.

qkt rounds ties to whichever neighbour is *even* — 2.5 becomes 2, 3.5 becomes 4. That's "banker's rounding," `HALF_EVEN`, and the choice isn't arbitrary. `HALF_UP` sounds harmless for any one number, but apply it across millions of genuinely-tied roundings — and a system processing this many trades will hit exact ties constantly — and it introduces a small, *systematic* bias: every tie nudges the aggregate slightly upward, in the same direction, forever. `HALF_EVEN` instead rounds a tie to whichever neighbor is even, which means across a large population of ties, roughly half round up and half round down. The two rules look identical on any single number and behave completely differently in aggregate — which is exactly the property that matters for a system whose output gets summed, over and over, into an account balance. This is the same reason real accounting and financial systems use `HALF_EVEN` rather than the rule taught for everyday arithmetic.

## Round once, at the boundary — never in the middle

Precision, once thrown away by rounding, cannot be recovered. That means *where* in a chain of calculations you round matters as much as *how*. Round too early, in the middle of a computation, and a value that would have landed cleanly on one side of a later rounding boundary can instead land on the other side — the error doesn't just shrink the precision, it can change the final answer. The discipline qkt follows is simple to state and easy to see in real code: carry full precision through every intermediate step, and round exactly once, at the very last moment, when the number is about to be stored, displayed, or compared.

Currency conversion is the clearest place this shows up. Computing an FX rate from a raw price uses `CONTEXT` — significant digits, not a fixed scale — precisely because a rate like one U.S. dollar's worth of Japanese yen, inverted, is an awkward fraction that a hasty 8-decimal-place rounding could distort before it's ever multiplied into anything:

```kotlin
val rate = when (direction) {
    Direction.DIRECT -> price
    Direction.INVERSE -> BigDecimal.ONE.divide(price, Money.CONTEXT)
}
```

That rate then multiplies straight through the conversion with no rounding in between, and only the very last step — building the final account-currency amount that will actually be reported — calls `setScale` at all:

```kotlin
val scaledNative = native.amount.setScale(Money.SCALE, Money.ROUNDING)
```

![Five steps from an exact native amount to a stored, reported figure, with exactly one setScale at the very end](/diagrams/chapter-07/round-once-at-the-boundary.png)
*Figure 7.1 — Full precision survives every intermediate step. `setScale` — the only place this value is ever rounded — happens once, at step 4, right before the number leaves the system.*

The same shape appears wherever qkt averages an entry price across several fills: total notional divided by total quantity at full `CONTEXT` precision, and only the resulting average gets `setScale`d once, on the way out. One rounding, at the edge — not one every time a number changes hands internally.

## Exact arithmetic meets a venue that only speaks in fixed steps

Precision discipline isn't just an accounting nicety — it collides directly with a real mechanical constraint every trading venue enforces. A venue doesn't let you trade in arbitrary fractions of anything. Prices move in fixed increments called **tick size** (sometimes "point size") — gold might only be quotable in cent increments, so a price of `$2400.003` isn't a price the venue's own order book can even represent, and it will simply reject an order that isn't aligned to that grid. Order size works the same way, governed by a **volume step** — MT5 venues commonly only accept lot sizes in `0.01` increments, with a hard minimum below which an order is rejected outright.

qkt quantizes an order to the venue's actual grid *before* sending it, both to avoid a pointless round trip to get rejected and to give the strategy a clear, structured reason instead of an opaque venue error:

```kotlin
val quantizedVolume =
    if (rules.volumeStep.signum() > 0) {
        wire.volume.divide(rules.volumeStep, 0, RoundingMode.DOWN).multiply(rules.volumeStep)
    } else {
        wire.volume
    }
fun roundPrice(p: BigDecimal?): BigDecimal? = p?.setScale(digits, RoundingMode.HALF_EVEN)
```

Notice the two rounding modes are deliberately different, and the difference is the whole point. Volume rounds **down**, never `HALF_EVEN` — because size has a genuine "safe direction." Rounding a requested size *up* would silently hand the strategy more risk than it asked for; rounding down at worst slightly under-fills the request, which is always the safer failure. Price has no such safe direction — a price can legitimately need to move either up or down to land on the venue's grid, so the unbiased `HALF_EVEN` rule from earlier applies there too. The rounding rule isn't chosen once for the whole system; it's chosen per quantity, based on what rounding in the wrong direction would actually cost:

![A raw order quantized down to the venue's volume step, then its price rounded to the venue's tick grid, rejecting at two different checkpoints along the way](/diagrams/chapter-07/quantize-to-the-venue-grid.png)
*Figure 7.2 — Volume only ever rounds down, on the theory that under-filling is the safe failure. Price rounds to the nearest tick either way, because a price has no safe direction to favor.*

## The alarm that cries wolf, and the alarm that never rings

Say you're building the thing every trading operation eventually wants: an alarm that shouts at a human the moment a live position is sitting there with no protective stop attached. Reasonable ask. Somebody's account is exposed, somebody should know.

You go to read the stop-loss off the position, and it's typed `BigDecimal?` — a `BigDecimal`, or nothing at all. And here's the trap: `null` and `0` both *look* like "there's no stop here" if you're skimming. Treat them as the same thing, and you've just built one of two alarms — and both of them are useless in exactly the way an alarm is not allowed to be useless.

Collapse `null` into "definitely no stop, sound the alarm," and think about what happens on a venue that simply doesn't have the *concept* of a server-side stop at all — say, a spot exchange where protective levels aren't a thing the venue tracks. Every single position there reports `null`, structurally, forever, whether it's actually protected by the strategy's own logic or not. Your alarm fires on every position, all day, every day. Within a week, whoever's watching that dashboard has muted the channel. The one time a position on a *stop-supporting* venue is genuinely, dangerously naked, the alarm for it lands in the same pile of noise nobody reads anymore. You built the boy who cried wolf, and you built him out of a type error.

Now collapse it the other way — treat `0` as "field's just not populated, nothing to see, skip the check." On a venue that *does* support stops, a position can report a perfectly real `0`, meaning: this position has a stop-loss field, and its current value is genuinely nothing, no protection at all. That's not a missing measurement — that's the measurement, and it's the exact case the alarm exists for. Swallow it as "eh, probably just unsupported" and the position rides completely naked, silently, and your alarm — the thing whose entire job was to catch this — never makes a sound.

```kotlin
/** Venue-side protective levels; null when unsupported, zero when absent on MT5. */
val stopLoss: BigDecimal? = null,
```

That one doc comment is the whole fix: `null` means *this venue doesn't have this concept*, full stop — don't even ask the question here. `0` means *this venue does have the concept, and the answer, right now, is nothing* — which is exactly when the alarm should ring. Two states, two completely different facts, and Kotlin was handing you the tool to keep them apart the entire time — a `BigDecimal?` already distinguishes "no value exists" from "the value is zero" for free. The only way to lose that distinction is to actively throw it away by treating the nullable type as if it were just a fancy zero. Don't. The type system is doing you a favor; the least you can do is not undo it.

![Reading the same nullable stopLoss field two ways: null means the venue has no concept of a stop, zero means it does and the position is genuinely naked](/diagrams/chapter-07/null-versus-zero-stop.png)
*Figure 7.3 — Same field, same query, two entirely different facts. Collapsing them either direction breaks the one job this alarm has.*

That instinct — refuse rather than quietly produce a number that looks fine — runs deeper than nullable stop-losses. A backtest that can't resolve an instrument's contract size doesn't fall back to a sensible-looking `1` and carry on; it declines to run at all, on the grounds that a silently wrong multiplier would misprice every trade on that symbol for the entire run and nothing downstream would ever flag it. Refusing to start is a worse user experience and a far better outcome.

(You'll hit this same fork wherever a `BigDecimal?` shows up — Chapter 5's account book has its own version: no leg book for a symbol at all is `null`, a book whose legs happen to net to exactly flat is a real `Position` sitting at quantity `0`. Same fork, same fix: ask which fact you're actually holding before you decide what to do with it.)

## What this costs, and why it's worth it

None of this is free, and it's worth saying so plainly rather than pretending it's a free lunch. `BigDecimal` arithmetic is measurably slower than native floating-point math. Every division site has to stop and make an explicit choice about precision instead of getting a plausible-looking answer for nothing. A `null` and a `0` that could have been quietly treated as interchangeable now have to be told apart, every time, on purpose. A system with lower stakes — a dashboard, a game, most ordinary software — would rightly take the faster, simpler tool and never notice the difference.

A trading engine doesn't get that luxury, because somewhere downstream of every number this system produces is a person with a bank statement and a spreadsheet, and that person is not going to accept "floating-point rounding" as an explanation for a missing cent. The extra ceremony — `CONTEXT` here, `SCALE` there, a `RoundingMode` spelled out instead of assumed, a `null` respected instead of flattened into `0` — is the price of a system whose numbers are allowed to be trusted completely, rather than merely close enough. For a system whose entire output is other people's money, "close enough" was never actually on the table.
