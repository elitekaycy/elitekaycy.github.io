---
title: "The Risk Engine"
excerpt: "A strategy's logic is built to answer one question, over and over: given what the market just did, should I buy, sell, or wait? It is not built to answer a very different question: *am I currently in..."
date: 2026-07-06
order: 6
draft: false
---

## The problem no strategy can solve about itself

A strategy's logic is built to answer one question, over and over: given what the market just did, should I buy, sell, or wait? It is not built to answer a very different question: *am I currently in the process of doing something disastrous, and should I be stopped?* Those two questions look similar but are nothing alike. A strategy that has drifted into a regime it was never designed for doesn't know it's drifted — its indicators still compute, its rules still fire, its logic is still internally consistent. It will keep entering, keep losing, and keep believing each new signal is a fresh, independent opportunity, because nothing in its own code is watching the *cumulative* damage. Asking a strategy to notice its own malfunction is asking a system to grade its own exam while it's actively failing it.

So something else has to watch — a supervisor that sits outside every strategy's own logic, sees the actual money (not the signals that produced it), and has the authority to say *no* regardless of what any individual strategy currently believes is a good idea. That's the risk engine's whole job. It is deliberately dumb about trading strategy and extremely strict about arithmetic: it doesn't know what a moving average crossover is, and it doesn't need to — it only needs to know how much has been lost, how fast, and against what limit.

## Two different questions need two different mechanisms

The risk engine actually runs two separate checks, and it's worth being precise about why they're separate rather than one unified thing.

The first kind of check looks at **one proposed order** and asks whether it, by itself, is reasonable — is this position too large, does this order's **notional value** — the cash value of what it controls, price times quantity times contract size, rather than the smaller margin actually posted — exceed a sane cap for the account. This is a `RiskRule`: stateless with respect to the check itself, evaluated synchronously the instant an order is about to be submitted, and it either approves or rejects that one order.

```kotlin
interface RiskRule {
    fun evaluate(request: OrderRequest, positions: PositionProvider): Decision
}
```

The second kind of check doesn't care about any specific order at all. It asks a question about the *account's condition*: has this strategy, or the account as a whole, crossed a line that means trading should stop entirely, right now, independent of whether an order happens to be arriving at this exact moment? This is a `HaltRule`, and its answer isn't "reject this," it's "change the account's state" — flip a switch that then blocks every subsequent order until something clears it:

```kotlin
interface HaltRule {
    fun evaluate(riskState: RiskState): HaltDecision
}
sealed class HaltDecision {
    data object Continue : HaltDecision()
    data class Halt(val reason: String, val strategyId: String? = null, val scope: HaltScope = HaltScope.PERSISTENT) : HaltDecision()
}
```

You genuinely cannot collapse these into one mechanism, because they run on different triggers — one only has something to check when an order shows up, the other has to be checked continuously whether or not one does:

![Two independent risk questions: approve(request) triggered by an order, evaluateHaltRules() triggered by every tick and fill](/diagrams/chapter-06/two-questions-risk-answers.png)
*Figure 6.1 — The same `RiskEngine`, answering two different questions on two different triggers. Approving an order can also reject risk-reducing exceptions on the way — see the next section — but the two paths never merge into one.*

`approve` runs once per order, right before it leaves the pipeline — a question about *this* order. `evaluateHaltRules` runs on every tick and every fill — a standing question about the account's condition, asked whether or not anyone is currently trying to trade. `RiskEngine` owns both, but they're independent paths through it.

## What "equity" and "drawdown" actually mean here

Ask a trader how much money they have and you should get a pause, because there are two honest answers. There's what's been banked — positions closed, profit or loss finalized, nothing left to argue about. And there's what the account would be worth if every position still open were closed right now, at whatever the market is quoting this second. A supervisor watching only the first number is structurally blind to a strategy that is bleeding out in real time and simply hasn't closed anything yet.

So the two numbers underneath almost every halt rule deserve to be defined precisely rather than assumed. **Equity** is the account's true value at this instant — not just realized, banked profit, but realized profit plus the current floating gain or loss on everything still open. This matters because a position that's deep underwater but hasn't been closed yet is still real, spendable risk: if the market keeps moving against it, that unrealized loss becomes a realized one, and a risk system that only counted closed trades would be structurally blind to a strategy actively bleeding out in real time. `EquityTracker` computes exactly this, on demand, from the same realized and unrealized figures Chapter 5 built:

```kotlin
fun update(): Boolean {
    val total = startingBalance.add(pnl.realizedTotal()).add(pnl.unrealizedTotal())
    currentTotalEquity = total
    if (total <= peakTotalEquity) return false
    peakTotalEquity = total
    return true
}
```

That `peakTotalEquity` is the account's **high-water mark** — the best equity it has ever reached — and it only ever moves upward. **Drawdown** is how far current equity has fallen from that peak, expressed as a fraction: lose 10% off your best-ever point, that's a 10% drawdown, whether the account started at $10,000 or $1,000,000. This is the standard vocabulary traders and, especially, proprietary trading firms use to describe "how bad has it gotten" — and it's deliberately relative to the account's own best moment, not to where it started, because giving back a large chunk of hard-won profit is a real, distinct kind of danger from simply being down overall.

There's a second, different way to measure the same underlying idea, and qkt supports both because real risk mandates actually ask for either one depending on who's setting the rule. **Trailing** drawdown, described above, measures against the peak — it protects against giving back profit. **Static** drawdown measures against the account's original starting balance instead, ignoring how high it climbed in between — this is exactly how a prop trading firm typically defines its hard "max loss" rule: lose more than a fixed percentage of what you started with, and the account is done, full stop, regardless of how much profit was made and given back along the way. One number, two legitimate readings of it, because two different real-world contracts ask two different questions:

```kotlin
fun globalDrawdown(): BigDecimal {  // trailing — vs. peak
    val peak = equityTracker.peakEquity()
    return peak.subtract(equityTracker.currentEquity()).divide(peak, ...)
}
fun globalStaticDrawdown(initialBalance: BigDecimal): BigDecimal {  // static — vs. starting balance
    val loss = initialBalance.subtract(equityTracker.currentEquity())
    return loss.divide(initialBalance, ...)
}
```

## A bad day is not the same failure as a bad account

Drawdown answers "how far below your best have you ever gotten." A separate, narrower question is "how much have you lost *today*" — reset every day, independent of the longer trailing history. This exists as its own check because a strategy can be entirely within its lifetime drawdown budget and still be, right now, in the middle of one genuinely bad session — and a lot of real risk practice (again, prop-firm rules are the clearest named example, but the instinct predates them) treats a single day's damage as its own hard boundary, separate from the cumulative picture, because a trader who keeps digging on a bad day compounds a recoverable loss into an unrecoverable one.

```kotlin
class MaxDailyLoss(private val maxLoss: BigDecimal) : HaltRule {
    override fun evaluate(riskState: RiskState): HaltDecision {
        val realized = riskState.dailyPnLTracker.globalRealizedToday()
        return if (realized.negate() > maxLoss) HaltDecision.Halt("...", scope = HaltScope.DAILY) else HaltDecision.Continue
    }
}
```

This particular rule is deliberately **realized-only** — it watches money that's actually been banked as a loss, not open positions still floating underwater. A position down heavily all day that never closes won't trip it. That's a real, named scope decision, not an oversight: a firm that also wants to catch intraday floating losses configures the equity-based daily-drawdown variant instead, which marks positions on every tick rather than waiting for a fill. Two tools for two shapes of the same worry, chosen deliberately rather than picking one and pretending it covers everything.

## One account, many strategies: what a tick actually does

It's worth walking through exactly what happens on a single tick, because "global" and "per-strategy" risk aren't two separate systems — they're the same tracking machinery running twice, once folded across everything and once per strategy, feeding two separate populations of halt rules:

![One price update fans out into a whole-account measurement and a per-strategy measurement, both compared against limits, ending in one of three outcomes: stop everything, stop one strategy, or carry on](/diagrams/chapter-06/tick-risk-fanout.png)

*Figure 6.2 — what one tick sets in motion. The same money gets measured twice — once for the whole account, once per strategy — and the same limit-check can end three ways. Notice the middle outcome: only strategy A stops; B and C never notice.*

Nothing here is a different code path bolted on for "multi-strategy support" — it's the same `EquityTracker`/`DrawdownTracker` pair, just asked the question once with a symbol-agnostic global fold and once per strategy id, and a `HaltRule` list where each rule already knows which population it's answering for. Configure one `MaxStrategyDrawdown` instance per strategy that needs its own limit, and each evaluates and trips completely independently of its siblings — the shared tracker underneath is what makes that cheap rather than requiring N separate risk subsystems for N strategies.

## Why a halt has to know how to heal

Not every halt should behave the same way once it's tripped, because not every breach means the same thing. A daily-loss halt clears itself automatically at the next UTC midnight — the very definition of "today" resets, so the budget legitimately resets with it, and there's no reason to make an operator manually clear something that the calendar itself already resolved. A total or trailing drawdown breach is a different animal: it doesn't heal with the passage of time, because it isn't measuring "today," it's measuring "how far has this account ever fallen" — the day changing doesn't make that number smaller. That kind of halt has to stay in force until a human actually looks at the account and decides what to do, because a breach that severe usually means something structural is wrong, not just that variance had a rough patch.

```kotlin
enum class HaltScope { DAILY, PERSISTENT, TRANSIENT }
```

![A tripped HaltRule healing three different ways depending on its scope: auto-resume, stay halted, or never persist](/diagrams/chapter-06/halt-scope-healing.png)
*Figure 6.3 — Same trip, three different fates. A daily-loss halt heals with the calendar; a drawdown halt waits for a human; a transient halt simply doesn't survive a restart.*

`DAILY` auto-resumes at the next UTC day boundary. `PERSISTENT` stays halted until an operator explicitly clears it. `TRANSIENT` is narrower still — it exists only for the current running session and is deliberately never persisted, so a restart begins clean rather than inheriting a state that no longer describes reality.

The scope isn't just a label on a live halt, though — it's what makes a *restart* safe, and that's where it earns its place. When the daemon comes back up it has to decide which halts to reimpose, and there are two ways to get that wrong in opposite directions. Forget a `PERSISTENT` drawdown halt and a blown account quietly resumes trading. Faithfully restore yesterday's `DAILY` loss halt and the account is stuck behind a limit the calendar already cleared, permanently, because every restart revives it again. So restoration reads the scope: a `DAILY` halt from a past UTC day is deliberately *not* restored, while a `PERSISTENT` halt and a same-day `DAILY` halt come back exactly as they were. The three scopes exist so that sentence can be written at all.

Halts also come in two granularities, matching the two things a limit can legitimately be *about* — visible directly in the diagram above: a per-strategy halt stops one strategy while its siblings on the same account keep trading, appropriate when the problem is that one specific system is malfunctioning, not the whole portfolio; a global halt stops everything, appropriate when the account itself, in aggregate, has crossed a line, at which point which individual strategy contributed most to it stops being the relevant question.

## The one thing a halt must never do: trap you in a position

Here's a failure mode worth sitting with directly. Imagine a strategy trips its drawdown halt while it's holding an open, losing position. If a halt simply blocked *every* order for that strategy, the very position that caused the halt could now never be closed — the supervisor meant to protect the account would instead be actively preventing it from getting out of the exact danger it just flagged. That would be worse than doing nothing.

This isn't qkt being clever, either — it's codified industry practice. The Futures Industry Association's guidance on automated trading risk controls says the same thing: a kill switch has to stop new exposure without stranding a trader inside the position it just flagged. qkt's rule is that principle written as a function.

So a halt only blocks *new* risk, never the way out. Before rejecting anything, the engine checks whether the incoming order can only shrink exposure — a close targeting a specific venue ticket, or an opposite-side order no larger than the position currently held:

```kotlin
fun isRiskReducing(request: OrderRequest, positions: PositionProvider): Boolean {
    if (request is OrderRequest.Market && request.closesTicket != null) return true
    val net = positions.positionFor(request.symbol)?.quantity ?: return false
    val opposes = (net.signum() > 0 && request.side == Side.SELL) || (net.signum() < 0 && request.side == Side.BUY)
    return opposes && request.quantity <= net.abs()
}
```

![A halted strategy's order tested for risk-reducing before rejecting: a close-by-ticket or same-or-smaller opposite side gets through, everything else is rejected](/diagrams/chapter-06/halted-but-not-locked-in.png)
*Figure 6.4 — A halt blocks new exposure, not the way out. An opposite-side order still has to fit inside the open position, or it stops being an exit and starts being a reversal.*

The size check matters as much as the direction check. An opposite-side order *larger* than the current position wouldn't just close it — it would flip the account from long to short (or back), which is genuinely *new* exposure in a different direction, not an exit, and that's correctly still blocked while halted. Only an order that can do no more than bring the position toward flat is let through. A halt, in other words, is a one-way valve on new risk — never a lock on the door.

## What this buys, and where it stops

The design choice underneath all of this is that risk supervision has to live *outside* the thing being supervised, evaluated on a fixed, independent cadence rather than only when a strategy happens to ask permission. A strategy could, in principle, be trusted to check its own drawdown before every signal — but that's exactly the self-grading problem from the opening of this chapter: a strategy malfunctioning badly enough to need stopping is also the strategy least likely to correctly notice it needs stopping. Making the check external, running on every tick regardless of what any strategy is currently doing, means the account's safety doesn't depend on the very logic that might be the thing going wrong.

This chapter deliberately stayed at the level the title promises — equity, drawdown, daily loss, and the halt mechanism that enforces them. It is not the entire risk surface qkt has: there's a separate layer that paces entries after a losing streak, a portfolio-wide controller that can de-risk a whole book of strategies together, and pre-trade caps on position size and order notional that live alongside the halt rules described here. All of them are built from the same two primitives this chapter introduced — a stateless per-order check, and continuously-evaluated account state that can flip a switch no strategy gets to argue with. Once you have "adult supervision that can say no" as a first-class citizen in the system, everything else that watches for trouble is just another voice added to the same conversation.
