---
title: "The Live Runtime"
excerpt: "Everything so far has run in a world that waits. A backtest reads the next tick when it is ready for one. If a computation takes a second, history politely pauses. Nothing arrives unasked, nothing..."
date: 2026-09-14
order: 16
draft: false
---

## The part where it stops being a simulation

Everything so far has run in a world that waits. A backtest reads the next
tick when it is ready for one. If a computation takes a second, history
politely pauses. Nothing arrives unasked, nothing arrives twice, and
nothing arrives while something else is halfway through.

Live trading is the same engine with all of those courtesies withdrawn.
Prices arrive whether or not anything is ready. A venue answers a question
asked ninety seconds ago on a thread nobody created. A network drops in
the middle of a fill. And the account on the other side of it is real,
which means the interesting question is no longer "is the logic right" but
**what is this system's relationship with a world that does not wait?**

Two answers carry this chapter, and both are about refusing something.

## One thread, and everything else waiting in line

The first refusal: however many things are happening at once outside, only
one thread is ever allowed inside.

![Timers, broker pollers and the feed thread feeding two queues, both drained by a single engine thread](/diagrams/chapter-16/three-threads-one-consumer.png)

*Figure 16.1 — three kinds of producer, two queues, one consumer. Strategies, risk, the ledger and the order manager all run on that single thread and nowhere else.*

Chapter 3 established why: one thread means one order, and one order is
what makes a replay reproduce. What this chapter adds is the machinery
that keeps that true when the outside world is genuinely concurrent.

A **feed thread** does nothing but block on the next tick and hand it over
without blocking. **Broker pollers and sockets** publish venue events from
threads the engine never started. **Timers** fire a heartbeat every second
and poll account equity every five. None of them touch engine state. Each
one puts a message in a queue.

The engine thread then does something deliberately unbalanced: it drains
the **control queue first, always**, and only then waits — briefly, about
25 milliseconds — for a tick. Control means heartbeats, operator queries,
a flatten instruction, a shutdown. The reasoning is that a tick is
information and a control message is an *intention*, and when both are
pending, the intention should not sit behind a thousand price updates. An
operator asking a wedged session to stop should not have to wait for the
backlog to clear.

The tick queue is bounded, at ten thousand. It only ever fills if the
engine is consuming slower than the market is producing — a burst around a
news release, a subscriber that got slow, a long garbage-collection pause.
At a few thousand ticks a second, ten thousand is a couple of seconds of
headroom before a decision has to be made.

What it does when that headroom runs out is worth pausing on: **it drops
the oldest tick, not the newest.** That is
the opposite of what a queue usually does, and it is right here. If the
engine has fallen so far behind that ten thousand ticks are waiting, the
oldest ones describe a market that no longer exists. A trading decision
made on a price from four minutes ago is worse than no decision. So the
stale end is discarded and the system stays close to now, at the cost of
silently losing history it was too slow to process — which is a real cost,
and the reason the number is ten thousand rather than ten.

There is one hand-carved exception to control-first ordering, and it is a
nice example of two mechanisms interacting. A heartbeat exists to close
bars on wall-clock time when a symbol goes quiet — Chapter 4's mechanism.
But a heartbeat that jumps the queue can overtake ticks that arrived
*before* it, and those ticks would then be evaluated against a bar the
heartbeat already closed — arriving late, and dropped by Chapter 4's own
closed-bar rule. So a heartbeat, uniquely, drains the pending ticks first.
The rule that control comes first is right, and the one place it would
cause the system to discard good data is carved out explicitly.

## Nothing trades before the books agree

The second refusal is larger. Before the engine thread takes a single
tick, the session must establish what it actually owns.

![Five startup steps: arm the queue, connect the brokers, reconcile the book against the venue, restore orders from disk, and only then warm up and take ticks](/diagrams/chapter-16/nothing-trades-before-reconcile.png)

*Figure 16.2 — the startup order. Step 3 is synchronous and is allowed to refuse.*

Step one is subtle enough to miss. The queue is armed *before the brokers
are built*, because a broker starts polling the moment it is constructed —
and a poller that publishes before the engine loop exists would otherwise
dispatch its event inline, on its own thread, into a half-assembled
pipeline. Arming the queue first means those early events are held rather
than mishandled. It closes a window measured in milliseconds that happens
exactly once per start, and is precisely the kind of thing that would be
found the hard way.

Step three is the important one. The session reads what the venue actually
holds, compares it against the position book persisted on disk, and if
those two disagree in a way it cannot resolve, **it refuses to start.**

The reasoning is stated bluntly in the source, and it is worth quoting
because it names the failure mode exactly: never reconcile against assumed
state, because *a transient broker error that reads as "no open positions"
lets the session start flat while holding leveraged positions.*

Sit with that scenario. A gateway hiccups. The read returns an empty list —
not an error, an empty list, which is a perfectly valid answer meaning
"you have nothing open." The engine believes it, starts flat, and begins
trading. Meanwhile the account holds real leveraged positions that no
component in the system knows about, with no stops being managed by
anything, while the strategy happily opens more. Everything downstream —
risk, exposure caps, P&L — is reasoning about a book that is missing the
positions that can actually hurt you.

Against that, refusing to start is obviously correct, and the cost is
equally obvious: a strategy that will not deploy when its venue is having
a bad minute. That is a real operational cost, paid in exchange for never
trading on a fiction. The escape hatch is explicit rather than automatic —
an operator can say *adopt what the venue reports and proceed*, and when
they do, the adopted positions come with a persistent halt attached, so
exits work but no new risk is opened until a human clears it. Fail closed,
then let a person open it deliberately.

## Staying honest while running

Reconciliation is not a one-time gate. Once ticks flow, the venue keeps
being the authority.

A poller keeps diffing the venue's positions against the ledger, which is
how a position closed by the venue itself — a stop-out, a margin call, a
manual close from someone's phone — gets booked. Account equity is polled,
and if that read goes stale beyond a few intervals, the session says so
rather than continuing to report a number it hasn't refreshed. An
unreachable gateway explicitly *suspends* reconciliation rather than
concluding everything closed, because a failed read means unknown, not
zero — the same distinction Chapter 7 made about `null` versus `0`, now
worth an account.

Market data gets the same treatment. A gate watches for staleness,
outliers, and clock skew, and the reason it must is worth stating plainly:
protective stops the engine holds itself can only trigger when ticks
arrive. A feed that has quietly stopped is not a monitoring problem, it is
an unprotected position.

## Reading a running system

Because everything happens on one thread, asking a live session a question
is not a matter of reading a field from outside. It is a message like any
other: a query goes into the control queue, the engine thread answers it
between ticks, and the answer comes back — with a timeout, so an operator
whose session is genuinely wedged gets an error rather than a hang.

```
$ qkt status --deep

qkt: HEALTHY

DAEMON       running (uptime 3d4h)
CONTROL      reachable
STRATEGIES
  momentum-btc         running, 42 trades, up 3d4h
```

The command exits non-zero when anything is unhealthy, which is what makes
it usable from a cron job or a monitor rather than only by a human reading
output. The same shape as `qkt reconcile`: the exit code is the alert.

## What one thread is worth

What the single-consumer design bought is that every guarantee from the
first half of this book survives contact with concurrency. One order of
events, one writer for the ledger, one authority for time and sequence —
all of it holds while three other threads push work at the engine,
because none of them are ever inside.

What it cost is that the engine is only as fast as its slowest subscriber,
and there is nowhere to hide a slow handler. A subscriber that blocks
stops trading — not its own feature, everything. That is the bill Chapter 3
warned about, now being paid in an environment where the queue behind the
blockage is filling with real prices, and where the overflow policy will
start throwing the oldest of them away.

And what fail-closed startup cost is availability, deliberately. A system
that refuses to trade when it cannot establish the truth will sometimes
refuse to trade when you badly want it to. The alternative is a system
that always starts, and is occasionally confidently wrong about what it
owns. For a process that will run unattended against a real account, the
first failure is one you find immediately and the second is one you find
in a statement.
