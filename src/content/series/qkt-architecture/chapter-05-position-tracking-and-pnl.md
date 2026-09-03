---
title: "Position Tracking and P&L"
excerpt: "The last four chapters built the half of the loop that *observes*: ticks arrive, an event bus orders them, a candle builder compresses them. None of it touches money. A strategy watching all of that..."
date: 2026-06-29
order: 5
draft: false
---

## What do you actually own?

The last four chapters built the half of the loop that *observes*: ticks
arrive, an event bus orders them, a candle builder compresses them. None
of it touches money. A strategy watching all of that has still not bought
anything.

This is where that stops. From here to the end of Part II the subject is
what happens once a decision becomes a position — what you own, what it is
worth, and who is allowed to say so.

Say a strategy buys 0.1 lots of gold. A moment later, does it own 0.1 lots of gold? Obviously — that's what a fill means. Now say the same strategy, five minutes later, sells 0.1 lots of gold. Does it now own nothing? Or does it own two positions — a long that's still open and a short that's still open, sitting there side by side, each earning or losing money independently until each is separately closed?

The honest answer is: it depends entirely on which broker you're trading with, and that dependency is not a footnote — it changes what "position" even means as a data structure. Some venues **net**: every execution on a symbol folds into one running number, so a buy and an equal sell cancel out and you're flat, full stop. Other venues **hedge**: a long and a short on the same symbol are two entirely separate tickets that coexist, each with its own entry price, its own stop-loss, its own profit or loss, until you close each one by name.

This split isn't arbitrary, and it isn't just a technical curiosity either broker happened to build. US-regulated forex accounts are legally required to net, first-in-first-out — a rule aimed at stopping traders from disguising a losing position by opening an offsetting one instead of just closing it. Retail MT5 accounts outside that jurisdiction very often hedge instead, and traders genuinely want that: imagine running two independent systems on the same instrument — one a breakout system that just went long gold, one a mean-reversion system that just went short gold on the same move. On a netting account those two signals partially or fully cancel into one blended number, and you lose the ability to tell which system is actually working. On a hedging account they're two real, separately-tracked positions, each judged on its own merits. The tradeoff is capital. **Margin** is the cash a venue makes you set aside to hold a leveraged position — not the cost of the trade, but a deposit held against it while it is open, and released when you close. A hedging account generally has to post margin against both sides (brokers often give a discount for the fact that the combined risk is bounded, but rarely erase it entirely), where a netting account only ever posts margin against the one net exposure. Faster feedback and cleaner attribution, at the cost of tying up more capital — a real decision a trader makes when choosing a broker, not an implementation detail underneath one.

So the position model has to be honest about which world it's in, and it has to know that per venue, because a portfolio can — and does — trade several brokers with different rules at once. If qkt modeled every account as if it netted, a hedging strategy deliberately holding a winning long and a losing short at the same time, on purpose, would be lied to about its own risk the moment the engine collapsed those into one number.

![The same two fills read on a netting account and on a hedging account](/diagrams/chapter-05/two-fills-two-worlds.png)
*Figure 5.1 — The same two fills, read two different ways. A netting account has nothing left after the sell — the position is the diff. A hedging account still has two separate open tickets after it, each quietly accruing its own cost.*

## One position isn't the shape of the truth

Before getting to netting versus hedging, there's a shape problem underneath both. A strategy in qkt doesn't just enter and exit once. It can pyramid — add to a winning position in stages via a `STACK_AT` clause, each stage carrying its own bracket, each capable of surviving after an earlier stage has already closed. It can straddle — fire two opposite brackets at once via an OCO, genuinely expecting either or *both* to fill, each becoming its own real position rather than one net number. None of that fits into a single `Position(symbol, quantity, avgEntryPrice)` struct. You need to track *legs* — plural, individually addressable pieces of exposure that can each be opened, adjusted, and closed on their own schedule.

qkt's leg is deliberately small:

```kotlin
data class PositionLeg(
    val legId: String,
    val symbol: String,
    val side: Side,
    val quantity: BigDecimal,
    val entryPrice: BigDecimal,
    val openedAt: Long,
    val role: LegRole,
    val parentLegId: String? = null,
    val brokerTicket: String? = null,
)
```

That `brokerTicket` field deserves its own explanation, because it's not a qkt invention — it's borrowed straight from how these venues actually work. When a broker fills an order, especially on an MT5-style hedging venue, it doesn't just silently add to "your position." It opens a distinct, numbered position — a **ticket** — that exists independently of the order that created it and stays addressable by that number for as long as it's open. This matters enormously on a hedging account, where a strategy might have three separate long tickets open on the same symbol at once, each from a different stack tier or a different straddle leg. "Sell 0.3 lots of gold" doesn't tell the venue which of those three to close — on a hedging account it doesn't even *try* to net against them, it just opens a brand-new short ticket, now sitting alongside the three longs, accruing its own spread and commission cost while doing nothing the strategy actually wanted. The only unambiguous way to exit one specific position on a venue like this is to name it: "close ticket 3170102568." That's the real-world mechanic `brokerTicket` exists to carry — it's how a leg in qkt's ledger stays pointed at the one exact position it's supposed to represent, so a close can target it correctly instead of guessing by quantity and side.

Every leg also carries a `role`, and the role is the vocabulary for *why* this leg exists as a separate thing:

- **PRIMARY** — the strategy's ordinary, single entry. At most one per symbol per strategy.
- **STACK** — a pyramided add-on, carrying `parentLegId` back to the primary that spawned it. It survives after the primary closes.
- **INDEPENDENT** — a leg that coexists with others on the same symbol without netting into them at all: each side of a straddle, or any entry on a hedging venue where the venue itself keeps positions separate.

Those roles aren't merely descriptive labels, either — the book enforces the one that has to be unique. Adding a second PRIMARY to a book that already has one is refused outright, loudly, rather than accepted. The failure it's guarding against is quiet rather than dramatic: with two legs both claiming to be the strategy's single netting position, two different code paths can each average fills into a different record, and one logical position ends up with its cost basis split across two disagreeing numbers. Nothing crashes. The P&L is just wrong from then on. A rejected write is the cheapest possible version of that problem.

A collection of these for one (strategy, symbol) pair is a `LegBook`. Most of the time a book holds exactly one leg — a strategy that never stacks or straddles never notices any of this — but the shape is there for when it needs to be, without every ordinary strategy paying for it.

![Three legs on one symbol, each carrying a role and, for the stack, a link back to its parent](/diagrams/chapter-05/one-strategy-three-legs.png)
*Figure 5.2 — One strategy, one symbol, three legs open at once: an ordinary entry, a pyramided add-on that knows which leg spawned it, and an independent leg that never nets with either.*

## The real question: what does a fill *mean*?

Here's where the actual difficulty lives. An execution arrives from the broker — a symbol, a quantity, a price, a side. That's a fact. What it's *supposed to do* to the position ledger is not a fact contained in the fill itself; it's a decision. Does this fill open a brand-new leg? Extend an existing one? Close (or partially close) one specific leg, realizing its P&L? Or net into the strategy's one primary position the classic way? The same raw fill event could mean any of those four things depending on context — the venue's accounting mode, what order produced it, whether it's closing something the strategy already holds.

And on a hedging venue, "closing" is a genuinely different operation from "opening," not just the opposite sign of the same action. On a netting venue there's no separate close verb at all — sending an opposite-side order *is* how you close, because the venue folds it straight into the running total; buy 0.1, sell 0.1, you're flat, that's the entire mechanism. On a hedging venue, sending a plain opposite-side market order does not close anything — it opens a brand-new counter-position, leaving you holding both a long and a short ticket at once, each still costing you spread and commission, neither one gone. Actually exiting a specific position there requires telling the venue which ticket to close, by number. This is exactly why `LegIntent.Close` carries an optional venue `ticket` alongside the qkt-side leg id, and why an order that's meant to exit on a hedging account is built to close-by-ticket rather than just fire the opposite trade — it's not a data-modeling nicety, it's the only correct way to actually exit there.

The tempting shortcut is to have the fill handler *guess*, on the spot, using whatever transient bookkeeping happens to be lying around — a set of "orders I remember submitting," a flag for "this ticket is mine." That shortcut has an ugly failure mode: transient state is exactly the kind of thing that goes missing at the worst moment — a daemon restart, a slow reconnect, a late duplicate report from the venue — and a wrong guess there doesn't throw an exception, it silently miscounts real money.

qkt's answer is to stop guessing and start *deciding* — once, in advance, and to make that decision travel with the thing that will produce the fill, rather than living off to the side where it can rot or vanish. That decision is called `LegIntent`, and it's a field on the order itself:

```kotlin
sealed interface LegIntent {
    data class Open(val legId: String, val role: LegRole, val parentLegId: String? = null) : LegIntent
    data class Close(val legId: String? = null, val ticket: String? = null, val partial: Boolean = false) : LegIntent
    data object Net : LegIntent
    data object Unplanned : LegIntent
}
```

Every leaf order request in qkt — a market order, a bracket, a stop — carries one of these. By the time an order actually reaches a broker, it is never `Unplanned`; something has decided, in advance, exactly what a fill of this specific order will do to the ledger. The fill handler doesn't interpret anything. It reads the answer that was already written down.

## Deciding once, at the moment of intent

That decision is made by a single object, `LegIntentPlanner`, and it's made exactly once per order — at the moment a strategy's signal turns into an order request, before it ever reaches a broker. The planner's whole job is to look at the venue's accounting mode and the shape of the order, and stamp the right `LegIntent` onto it:

```kotlin
private fun entryIntent(legId: String, mode: PositionAccountingMode): LegIntent =
    if (mode == PositionAccountingMode.HEDGING) {
        LegIntent.Open(legId, LegRole.INDEPENDENT)
    } else {
        LegIntent.Net
    }
```

On a hedging venue, a plain entry is stamped `Open` with an `INDEPENDENT` role — it will become its own leg, coexisting with whatever else the strategy holds on that symbol. On a netting venue (or one whose mode couldn't be confirmed, which the planner treats conservatively as netting), the same entry is stamped `Net` — it will fold into the classic single running position the old-fashioned way. One order, two possible destinies, decided by which world it's actually trading in.

There's one shape that always gets `Open` regardless of venue mode: the two brackets inside a straddle. If a strategy fires an OCO of two opposite brackets expecting either — or genuinely both — to fill, each leg is independent on *every* venue, hedging or not, because a filled long and a filled short from that straddle really are two separate positions, not one that should collapse to net zero the instant both land. The venue's netting behavior would otherwise erase real information the strategy explicitly wanted to keep.

A close carries its own intent, naming exactly which leg it targets — by qkt-side leg id, by the venue's own ticket number, or both — set at the moment the exit order is built, not inferred later.

## Recovering intent at the fill

Planning happens once, on the order, before submission. But the fill itself can arrive through more than one path — the normal "your order filled" event, or a venue-side close the broker detected independently (an MT5 poller noticing a position vanished, for instance, with no qkt order id attached to it at all beyond the ticket). `LegIntentResolver` is the piece that recovers the intent at the moment a fill actually lands, and it does so with a fixed precedence, cheapest and most-authoritative signal first:

```kotlin
fun resolve(fill: BrokerEvent.OrderFilled): Resolution {
    val order = orderFor(fill.clientOrderId)
    if (order != null) {
        val intent = order.openingLegIntent()
        if (intent is LegIntent.Open && fill.side != order.side) {
            return Resolution(LegIntent.Close(legId = intent.legId, ticket = ticket), Source.ORDER)
        }
        if (intent != LegIntent.Unplanned) return Resolution(intent, Source.ORDER)
    }
    // ... venue ticket, then venue default
}
```

First: the order's own planned intent, if the fill can still be traced back to the order that produced it — the ordinary path, and it survives a restart cleanly because pending orders persist to disk carrying their intent, not just their price and quantity. There's a neat wrinkle here: if an order that opened a leg somehow reports an execution on the *opposite* side, that can only mean one thing — the venue closed that leg out from under the engine (a stop-out, a margin call, anything venue-initiated) — so the resolver reinterprets it as a close of the very leg that order opened, without needing a separate signal to say so.

![The resolver's three questions in order, with the middle one branching by venue mode into three different meanings for the same ticket](/diagrams/chapter-05/what-a-ticket-means.png)

*Figure 5.3 — the precedence, and the branch inside it. Steps 1 and 3 are simple; step 2 is where the same ticket means three different things depending on the venue.*

Second, when the order trail is gone: whether the strategy already owns a leg carrying this fill's venue ticket. A ticket is not always "one position," though — that depends on the venue mode too. On a hedging account a ticket genuinely is one isolated position, whoever it belongs to. On a netting account the PRIMARY leg *is* the venue's one netted position, and it keeps the same ticket across a reversal — so an execution reported against it means "net this in," not "close this leg." Only a STACK or INDEPENDENT leg on a netting account still maps one ticket to one position. The resolver encodes exactly that distinction rather than treating "has a ticket" as a universal rule.

Third, and last: if neither the order nor a known ticket says anything, fall back to the venue's default — hedging opens a fresh independent leg, everything else nets. This is the same decision the planner would have made in advance; the resolver just has to be able to make it live, for the rare fill that genuinely carries no other trace.

![The five steps from a strategy's decision to a booked leg, decided once and read back rather than guessed](/diagrams/chapter-05/meaning-decided-before-the-fill.png)
*Figure 5.4 — Intent travels with the order, not around it. Steps 1–2 happen before anything reaches a broker; step 4 only ever reads what step 2 already decided.*

## The ledger: one writer, one truth

All three intent kinds converge on a single method, on a single object: `StrategyPositionTracker.applyFillDetailed`. This is the ledger. It is the *only* place a fill ever changes what a strategy is holding, and its handling of the three intents is an exhaustive `when` — there is no fourth path, no fallback that silently does something else:

```kotlin
val application = when (intent) {
    is LegIntent.Open -> openLeg(event, intent, cumulativeFilled)
    is LegIntent.Close -> closeLeg(event, intent)
    LegIntent.Net -> netIntoPrimary(event)
    LegIntent.Unplanned -> error("execution ... reached the ledger unplanned")
}
```

Each path enforces an invariant that makes the ledger robust to the messy realities of live trading, not just the happy path of a single fill arriving once, cleanly.

`openLeg` treats a venue ticket as something that belongs to exactly one leg. If the same ticket reports again — a duplicate delivery, a late re-send after a reconnect — the ledger recognizes it already owns that ticket under that leg and, rather than blindly adding the reported quantity again, books only whatever the venue's *cumulative* figure says is genuinely new since last time. A re-report that adds nothing new adds nothing to the position. This is what lets the ledger shrug off a duplicate fill instead of quietly doubling a position that was only ever opened once.

`closeLeg` enforces the opposite discipline: a close can only ever *reduce* exposure, never invent it. If the intent names a leg or ticket the book doesn't actually hold, nothing gets booked — the fill is logged and left alone rather than realized against the wrong leg or manufactured out of nothing. A close that can't find its target books zero, not a guess.

`netIntoPrimary` is the familiar single-position case: same side averages the entry price in, the opposite side realizes P&L against the existing entry and reduces, flattens, or flips the position, exactly the way a netting venue itself would compute it.

Every path funnels through one method call. There is no second component anywhere in the engine that also has an opinion about what a strategy holds — which matters more than it might sound, because the moment you have two independent writers of the same fact, you also have the possibility that they disagree.

## The account view: derived, never written

That last point is worth dwelling on, because it's tempting to build the opposite way. A trading engine also needs to know the *account's* aggregate exposure per symbol — the sum across every strategy, which is what a broker actually sees and what account-wide risk caps need to reason about. The obvious-looking design is to have the fill handler update two things: the strategy's position, and, separately, the account's position. Two updates, same event, two places that now both claim to know the truth.

qkt doesn't do that. The account view is not a second thing anyone writes to — it's a read-only projection folded out of the one ledger that already exists:

```kotlin
class AccountPositionView internal constructor(
    private val ledger: StrategyPositionTracker,
) : LegExposureProvider {
    override fun positionFor(symbol: String): Position? = ledger.accountPositionFor(symbol)
    override fun forEachLeg(symbol: String, action: (PositionLeg) -> Unit) = ledger.forEachLeg(symbol, action)
}
```

Underneath, the ledger keeps a small index — one net `Position` per symbol, folded across every strategy's leg books — and rebuilds just that one symbol's entry the instant any leg on it changes. Reading the account's exposure is then a plain map lookup, not a fold over every strategy every time someone asks. The account never has its own opinion to fall out of sync with the ledger's, because it isn't an opinion at all — it's a cached answer to a question the ledger can always re-derive.

That rebuild is where the bill arrives, and it's worth being precise about it rather than presenting the design as free. Every fill re-folds every leg every strategy holds on that symbol, rather than adjusting the cached number by the amount that just changed. An incremental update would be a single addition; this is a loop whose length grows with how many strategies trade the symbol and how many legs each one holds. The reason to accept that is the failure it makes impossible: an incremental update is a second place that computes the account's position, and the instant it disagrees with the ledger — one missed edge case, one path that forgot to adjust — nothing in the system can tell you which of the two numbers is the real one. Re-deriving is slower and can only ever produce one answer.

This is the same shape you'll see again in the next chapter for risk state, and it's worth naming as a general principle now: when a quantity can be *computed* from another quantity that's already the single source of truth, don't give it a second, independently-mutated home. Derive it, and derive it eagerly enough that reading it stays cheap.

## Unrealized P&L has to walk legs, not net numbers

There's a sharp, easy-to-miss consequence of all this for open (unrealized) profit and loss. Picture a strategy on a hedging venue holding a long that's up nicely and a short on the same symbol that's down — two real, separate positions, each with its own margin and its own risk, that happen to *net* to a small or even zero combined quantity. That's called a **locked position** — equal and opposite exposure on the same instrument, held at the same time. It's genuinely useful in some situations (a trader keeping a losing position open without adding to its risk while deciding what to do, or exactly the two-independent-strategies scenario from the start of this chapter), but "locked" does not mean "risk-free," and it's worth being precise about why. Net directional risk really is zero — if the price moves, whatever the long gains, the short loses, dollar for dollar. But every other cost of trading is still very much alive: you paid the spread crossing into both positions, you're paying commission on both, and any overnight financing charge accrues on both legs too — often asymmetrically, since a broker's swap rate for holding long rarely mirrors its rate for holding short exactly, so a locked pair isn't a free pause button, it quietly bleeds cost the longer it sits.

If unrealized P&L were computed from the net position alone — "quantity times price move" — a flat-net hedge like that would report zero open risk and hide that bleed completely from anything watching for it. So unrealized P&L walks legs directly rather than the net view, whenever the position provider exposes legs to walk:

```kotlin
if (positions is LegExposureProvider) {
    var sum = Money.ZERO
    positions.forEachLeg(symbol) { leg ->
        val signedQty = if (leg.side == Side.BUY) leg.quantity else leg.quantity.negate()
        sum = sum.add(price.subtract(leg.entryPrice).multiply(signedQty).multiply(contractSize))
    }
    sum
}
```

Every open leg contributes its own mark-to-market independently, and the strategy or account figure is the sum of those individual truths — never a shortcut through a blended net quantity that could hide two real, opposite risks behind one deceptively small number.

![Five days of a locked long and short: the net line stays flat at zero while spread, commission, and swap keep bleeding money underneath it](/diagrams/chapter-05/locked-position-still-bleeds.png)
*Figure 5.5 — A simulated locked position: 0.1 lot bought and 0.1 lot sold on the same symbol at the same price. The net directional risk really is zero. The cost of holding both legs open is not.*

That `contractSize` multiplier in the middle of the formula is doing real work and deserves its own word. A "lot" in forex and CFD trading is not one unit of the thing you're trading — a standard lot of EUR/USD represents 100,000 units of euros, a lot of gold might represent 100 troy ounces, and every instrument defines its own multiplier. A one-dollar move in the quoted price of gold is not one dollar of profit or loss; it's one dollar times the contract size times however many lots you hold. Skip that multiplier, or get it wrong for one instrument, and every single trade on that symbol is silently mispriced by a fixed, wrong factor — which is why the engine looks the instrument up rather than assuming quantity and price difference alone tell the whole story.

## Realized P&L: a fold, not a scattered set of counters

Position tracking answers "what do I hold." The other half of this chapter's job is "what did I make or lose" — realized P&L — and it has its own version of the same one-writer discipline, applied to a different kind of quantity: not a position, but an *event stream*.

A single execution touches a surprising number of downstream things: the account's overall realized total, the specific strategy's realized total, the trade history log, the position-sizing pacer that watches entries and outcomes, a runaway-loss breaker, and the risk engine's halt evaluation, which needs to see the fresh number before anything with a real-world side effect gets a chance to act on stale numbers. If each of those consumers independently recomputed "what did this fill actually realize" — reapplying contract size, currency conversion, and commission netting on its own — you'd be trusting five separate pieces of arithmetic to agree with each other by discipline alone. They might. Discipline erodes; separate implementations drift.

qkt collapses that into one pricing step and one broadcast. `bookExecution` is the only place a fill's dollar amount gets computed, and three real-world costs get netted out of the raw price-times-quantity number before anything downstream sees it. **Commission** is the fee the broker charges for executing the trade at all — usually per lot or a percentage of notional — money that leaves the account regardless of whether the trade wins or loses, and if it isn't subtracted out, a strategy that trades often and pays heavy commissions can look healthier on paper than it actually is. **Venue costs** cover what the broker itself reports back about the trade — MT5's own commission and swap figures, for instance — which can differ from what the engine modeled and should win when they're available, since the venue's own number is closer to the truth than a local estimate. Both get subtracted, once, here:

```kotlin
private fun bookExecution(e: BrokerEvent.OrderFilled, cumulativeFilled: BigDecimal?, partial: Boolean): AccountedExecution? {
    val application = strategyPositions.applyFillDetailed(e, legIntentResolver.resolve(e).intent, cumulativeFilled)
    if (application.unbooked) return null
    val native = application.realized.multiply(contractSize)
    val converted = accounting.convertPnl(symbol = e.symbol, nativeAmount = native, ...)
    val net = converted.account.amount.subtract(costs)
    return AccountedExecution(FillAccountedEvent(... netAccountRealized = net, netStrategyAccountRealized = net, ...), ...)
}
```

Every consumer of that final number is now a *subscriber* to one event, not an independent computer of its own version of the same fact:

```kotlin
private fun foldAccounted(a: FillAccountedEvent) {
    pnl.recordRealized(a.netAccountRealized)
    strategyPnL.recordRealized(a.strategyId, a.netStrategyAccountRealized)
    if (a.kind == FillAccountingKind.EXECUTION) {
        tradeHistory.recordTrade(a.strategyId, a.executedAt, a.netStrategyAccountRealized, a.symbol)
        // pacer, runaway breaker
    }
    riskState.onFill(a.strategyId, a.netStrategyAccountRealized)
    riskEngine.evaluateHaltRules()
}
```

This is genuinely just publish/subscribe applied to accounting rather than to price ticks — the same pattern the event bus already gave the system, pointed at a new kind of fact. And it buys the same thing it always buys: every subscriber sees the identical, already-computed number, in a fixed order, with the risk-relevant ones (halt evaluation) guaranteed to run before anything that has an external side effect. Nobody downstream re-derives "what happened here" — they're told, once, by the one place authorized to have decided it.

![One fill, priced once through three steps, then fanned out to five subscribers that never recompute it themselves](/diagrams/chapter-05/priced-once-told-to-everyone.png)
*Figure 5.6 — `bookExecution` prices a fill exactly once. Every downstream consumer — including the halt check, which runs last on purpose — reads that one number instead of recomputing its own.*

The event also carries a `kind` — an ordinary execution, a **financing accrual** (the overnight swap charge mentioned above, applied even on days the position doesn't trade at all, purely for holding it past the venue's daily rollover), or a reconcile of value the venue realized while the daemon wasn't running to see it happen live. All three still enter through the same fold, so the account's lifetime P&L is honest about money the strategy actually made or lost — but a reconcile of history from before this session correctly counts toward *lifetime* totals without corrupting *today's* loss budget, since a risk rule watching for a bad day shouldn't be tripped by yesterday's outcome arriving late.

## The price of one true position

Step back and look at the shape of the whole design. A `LegIntent` decided once and carried on the order, rather than reconstructed from scratch at fill time. One ledger with an exhaustive handler for every intent, rather than several mutation paths that each hope to stay consistent with the others. An account view that's derived, never separately written. Realized P&L computed once and fanned out to subscribers, rather than recomputed independently wherever it's needed.

None of that was free. It's more machinery than a single mutable `Position` field would have been, and a strategy that never stacks, never straddles, and only ever trades a netting account pays for leg books and intent resolution it will never visibly need. The alternative — one flat position per symbol, updated wherever a fill lands — is simpler to read and would work fine for exactly that strategy. It falls apart the moment a second writer needs to know the same fact, or a fill's meaning genuinely depends on context the fill itself doesn't carry, or two real, opposite positions need to be told apart instead of quietly cancelled. A trading engine that intends to run hedging and netting venues side by side, run strategies that pyramid and straddle, and keep every number — position, unrealized, realized — provably consistent with the same underlying event stream doesn't get to choose the simpler shape. The complexity here isn't decoration; it's what "one true position, honestly derived" costs to actually build.
