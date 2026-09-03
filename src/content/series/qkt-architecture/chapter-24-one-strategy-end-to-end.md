---
title: "One Strategy, End to End"
excerpt: "Every chapter so far has taken the system apart along a different plane. Here is the event bus. Here is the ledger. Here is what a bracket becomes on a venue that has never heard of brackets."
date: 2026-11-09
order: 24
draft: false
---

## Twenty-three cross-sections, one longitudinal cut

Every chapter so far has taken the system apart along a different plane.
Here is the event bus. Here is the ledger. Here is what a bracket becomes
on a venue that has never heard of brackets.

That is the right way to explain a machine, and it has one weakness: you
have never seen the whole thing move. A reader could finish Chapter 23
understanding twenty-three components individually and still not know what
it actually *feels like* to take an idea and push it toward real money.

So this chapter does the other thing. One strategy, one dataset, one
sitting — followed from a text file to the moment something tells you it
is not ready. No new machinery; every part of this has already been
explained. What is new is the sequence.

![Seven stages from writing a strategy to asking whether it is fit to run, each tagged with the chapter that explained it](/diagrams/chapter-24/one-strategy-end-to-end.png)

*Figure 24.1 — the path. Each step is a command, and each command's output in this chapter is the real thing, not an illustration.*

Everything printed below came out of an actual run while writing this
chapter. Where a number appeared earlier in the book, you will see it
arrive here from the tool that produced it.

## 1. Write it

The strategy is the one from Chapter 12, and it is still thirteen lines:

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

Buy when the fast average crosses above the slow one and we hold nothing;
close when it crosses back. That is the entire idea, and the rest of this
chapter is the distance between having it and trusting it.

## 2. Have it refused, then accepted

Before running anything, ask the compiler whether the file means what it
looks like it means.

I did not plan the first result. While preparing this walkthrough I wrote
a variant with a `PARAM` block — and put it in the wrong place, above
`SYMBOLS` instead of below it:

```
$ qkt parse momentum_sweep.qkt
momentum_sweep.qkt:6:1 — unexpected 'SYMBOLS' after the last recognized block
  — everything from here on would be silently ignored
```

That is Chapter 13's end-of-input guard catching me in the act, and the
error message says exactly what was at stake: *everything from here on
would be silently ignored.* Without that check the file would have
compiled. It would have contained no rules. It would have deployed, warmed
up, received every tick, and never traded — and the only symptom would
have been an account that never moved.

Ten seconds to fix, once told. The interesting part is the counterfactual.

With the block in the right place:

```
$ qkt parse momentum_sweep.qkt
ok
```

`ok` here is a stronger word than it looks. Chapter 13's list of refusals
has all been run: every stream resolves, every indicator exists with the
right arity, no bracket is half-built, no comparison is ambiguous.

## 3. Find out the data has holes

Now it needs history. My dataset is two hours of synthetic one-minute BTC
— a clean climb, a fall, then a longer climb — and two hours is not a day:

```
$ qkt backtest momentum.qkt --from 2024-01-15 --to 2024-01-16 ...

qkt: tick coverage BTCUSDT 0/1 trading days
qkt: error: incomplete data for BTCUSDT:
  2024-01-15  incomplete (empty hours 3,4,5,6,7,8,...,22)
  re-run with --allow-incomplete to proceed anyway
```

Chapter 15's refusal, on my own data, and it is *correct*: I asked for a
day and supplied two hours. The system will not quietly average over the
twenty hours I do not have.

For a deliberately toy dataset the honest move is to say so and continue,
which is what the flag is for. Note what happens when I use it — the
refusal does not disappear, it changes register:

```
qkt: WARNING — running with incomplete data:
incomplete data for BTCUSDT:
  2024-01-15  incomplete (empty hours 3,4,5,...,22)
```

It prints *above the results*, every run, so the caveat travels with the
number rather than living in my memory of how I produced it.

## 4. Watch one signal become one fill

Now the run. This is Chapter 1's loop — the one drawn as a circle in
Figure 1.2 — printed by the engine as it happens:

```
INFO  com.qkt.dsl.strategy.momentum  - long entry
INFO  com.qkt.app.TradingPipeline    - submit Market ORD-0 BACKTEST:BTCUSDT BUY GTC
                                       qty=0.1  lastPrice=42280.00000000
INFO  com.qkt.app.OrderManager       - order accepted order_id=ORD-0 strategy_id=momentum
INFO  com.qkt.app.OrderManager       - order filled order_id=ORD-0 strategy_id=momentum
                                       symbol=BACKTEST:BTCUSDT side=BUY qty=0.1
                                       price=42280.00000000
```

Four lines, and the whole book is in them.

The strategy **logged an intent** — it did not place an order, because
Chapter 1 established that a strategy only ever expresses intent. The
pipeline **submitted** one, having passed the risk checks of Chapter 6.
The order manager moved it to **accepted**, then to **filled** — two of
the states from Chapter 18's machine, in order, each one a separate event
on Chapter 3's bus. `ORD-0` is the counter from Chapter 8: first order of
the run, deterministically, so a second run produces the identical id.

And the fill price is `42280.00000000` — eight decimal places, exact,
because Chapter 7. That is the same fill you saw plotted in Figure 1.3, at
the same price, from the same series. It has been the same trade the whole
time.

## 5. Distrust the number it gives back

```
Trades:           1
Final unrealized: 132.00000000
Total PnL:        132.00000000
Sharpe (annual):  434.96078838
Sortino (annual): n/a
Calmar:           n/a
Max drawdown:     0.00000000
```

There is the +$132 from Chapter 1 and the notorious 434.96 from Chapter 9,
produced together, from one command. If you want to see what an
untrustworthy number looks like arriving in the wild, this is it: a Sharpe
two hundred times what a serious fund would be proud of, sitting in a
report that is otherwise entirely correct.

Chapter 9 dismantled it — 434.96 ÷ 725 ≈ 0.60, an unremarkable per-bar
ratio multiplied by the square root of a year. What is worth adding here
is that the tool does not let the number stand alone:

```
Assumptions & conventions
  Execution:  paper — fills at mid price; no spread, no slippage modeled
  Commission: none modeled — set commissionPerLot in instruments.yaml
  Swap:       none accrued
  Calmar:     total return / max drawdown (NOT annualized)
  Sharpe:     annualized from average sample spacing; risk-free rate 0
```

Every run prints its own limitations underneath its own results. And two
of the four headline ratios refuse to appear at all — `Sortino` and
`Calmar` are `n/a` because this run had no losing bar and no drawdown, so
both denominators are genuinely zero. Chapter 9's discipline, visible: the
report would rather say nothing than say something impressive.

## 6. Search, then check the search

The obvious next move is to look for better parameters. Six combinations
of the two averages:

```
$ qkt sweep momentum_sweep.qkt --param emaFast=5,9,13 --param emaSlow=21,34 --rank sharpe

trials: 6   selected metric: sharpe   provenance: sweep.rank(desc)
rank  sharpe        trades  totalPnL      label
1     455.50328912  1       140.00000000  emaFast=5,emaSlow=21
2     437.35609431  1       132.00000000  emaFast=9,emaSlow=21
3     428.30589970  1       128.00000000  emaFast=5,emaSlow=34
4     419.26342642  1       124.00000000  emaFast=13,emaSlow=21
5     410.22249156  1       120.00000000  emaFast=9,emaSlow=34
6     392.11912712  1       112.00000000  emaFast=13,emaSlow=34
```

A tidy ranking, a clear winner, and Chapter 10's trap fully sprung. Every
one of those six is absurd. The sweep did not fix the problem from step 5
— it produced six instances of it and sorted them, and the top row is
simply the configuration that fit this particular two hours most snugly.

So grade them on data they never saw:

```
$ qkt walkforward momentum_sweep.qkt --train 40m --test 20m --step 20m ...

folds: 4   mean IS sharpe: 321.61877548   mean OOS sharpe: 413.44491801
winner stability: emaFast=5,emaSlow=21×4

fold 1: train 00:00..00:40  test 00:40..01:00  winner emaFast=5,emaSlow=21  IS n/a  OOS n/a
fold 2: train 00:20..01:00  test 01:00..01:20  winner emaFast=5,emaSlow=21  IS n/a  OOS n/a
fold 3: train 00:40..01:20  test 01:20..01:40  winner emaFast=5,emaSlow=21  IS n/a  OOS 413.44491801
fold 4: train 01:00..01:40  test 01:40..02:00  winner emaFast=5,emaSlow=21  IS 321.61877548  OOS n/a
```

`winner stability: emaFast=5,emaSlow=21×4` — the same configuration won
every fold. On a real study that repetition would be the finding worth
having; here it mostly reflects a series with one obvious trend in it.

Look instead at how many cells say `n/a`. Most of these folds could not
produce a ratio at all, because most of these windows contained no trade.
Four folds, and exactly one out-of-sample number. Chapter 10's point,
arriving as lived experience: the honest output of a study this small is
mostly an admission that it was too small.

## 7. Ask whether it is fit to run

At this point the strategy looks, by every number produced so far,
excellent. Here is the question none of those numbers answered:

```
$ qkt preflight momentum.qkt

PASS runtime.mode: dev
PASS strategy.parse: momentum v1
PASS strategy.compile: momentum v1
PASS state.persistence: ~/.local/state/qkt/state
PASS journal.append_only: ~/.local/state/qkt/state/journal
PASS state.disk_headroom: 19 GB free
WARN risk.config: production mode requires an explicit risk block
WARN broker.config: production mode requires at least one broker profile
PASS broker.metadata: no MT5 profile to validate
WARN notify.alerts: no enabled alert channel
WARN symbol.metadata: missing instrument metadata for BACKTEST:BTCUSDT
PASS symbol.calendar: 1 symbol(s) on a matching calendar
PASS data.fields: close/price only
```

This is the most useful output in the chapter, and it is the only one that
is not about performance at all.

The strategy is fine. The *system around it* is not. There is no risk
block, so none of Chapter 6's halts exist — nothing would stop this
strategy after a bad day. There is no broker profile, so Chapter 17 has
nothing to route to. There is no alert channel, so Chapter 22's journals
would fill up with nobody watching. And there is **no instrument
metadata**, which is the one to sit with: Chapter 15 showed that a missing
contract size makes a backtest refuse to start, because every P&L figure
on that symbol would be silently mispriced.

Nothing here contradicts the backtest. The `+$132` was real. What preflight
is saying is that a profitable strategy and a system fit to run one are
different achievements, and only the first one has happened.

## What the walkthrough shows that the chapters could not

Three things, and none of them are visible from any single chapter.

**The refusals outnumber the results.** Across seven steps, the system
declined to proceed or declined to answer five separate times: a
mis-ordered block, incomplete data, two undefined ratios, and four
production warnings. Exactly one step produced a profit figure. That
ratio is the honest shape of working on a trading system, and reading the
chapters one at a time understates it — each chapter has one refusal in
it, so it reads as a feature. In sequence it reads as the *dominant
activity*, which is what it actually is.

**Every number is reproducible.** The `42,280` fill from Chapter 1, the
`434.96078838` Sharpe from Chapter 9, the six sweep rows and the four
folds from Chapter 10 — all of it came out of one dataset in one sitting,
matching what those chapters printed. That is Chapter 8's determinism
being useful rather than theoretical: the book can be checked.

**The gap at the end is the real subject.** Steps 1 through 6 are a
research loop, and a good one — write, validate, run, distrust, search,
verify. Step 7 is where a different question starts, and everything from
Chapter 16 onward exists to answer it. Deploying this strategy would mean
a live runtime that reconciles before it trades, a broker that knows what
it cannot do, orders whose exits survive a restart, and a parity claim
worth making. None of that is reachable by getting a better Sharpe.

The most valuable thing a walkthrough like this can teach is where its own
path stops. A backtest that says `+$132` is the beginning of the work.
Preflight, printing four warnings about a strategy that just reported an
extraordinary result, is the system telling you the same thing this book
has been saying for twenty-three chapters: **the strategy was never the
hard part.**
