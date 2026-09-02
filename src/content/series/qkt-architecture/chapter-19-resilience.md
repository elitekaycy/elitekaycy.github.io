---
title: "Resilience"
excerpt: "Everything built so far lives in memory. The ledger from Chapter 5, the risk state from Chapter 6, the order tree from Chapter 18 — all of it is objects in a running process, and every one of those..."
date: 2026-10-05
order: 19
draft: false
---

## The process is not the system

Everything built so far lives in memory. The ledger from Chapter 5, the
risk state from Chapter 6, the order tree from Chapter 18 — all of it is
objects in a running process, and every one of those chapters quietly
assumed the process keeps running.

It doesn't. A daemon gets restarted for a deploy. A host reboots. A
process is killed. And the thing that makes this genuinely hard is that
the *market does not participate in your outage*. While the process is
down, a stop can trigger. A position can close. A pending order can fill.
The venue carries on, and when the process comes back it has to work out
what happened while it wasn't looking.

The uncomfortable version of that: **restarting is the one moment when the
engine's belief about the world and the world itself are guaranteed to be
out of date.** This chapter is about how a system earns the right to keep
trading after that gap.

## Writing down what matters, and when

Recovery is only possible if something was written down, so start there.

A running strategy persists its position ledger, its risk state, its
realized P&L, its trade history, its pending orders, its OCO pairings, its
bracket relationships, and its trailing-stop high-water marks. Each in its
own file, each carrying a schema version that is checked rather than
coerced on read.

The interesting decision is not *what* is written but **how urgently**.
There are two paths, and they behave differently on purpose.

Most writes are **best-effort and asynchronous**. A position changed, a
number moved — queue it, let a background thread write it. The reasoning
is Chapter 16's: the engine thread must not block, and a disk that hiccups
must not stall trading. The cost is stated plainly in the source rather
than hidden: a crash between the mutation and the queue draining loses
whatever was in flight, a window of well under a second.

One write is not best-effort. Before an order is submitted to a broker,
the record of that intent is flushed to disk **synchronously**, draining
the queue first so nothing can overtake it. The invariant it buys is worth
stating exactly: *the venue can never accept an order the engine has no
durable record of.* Get that wrong and a crash at precisely the wrong
moment leaves a live order at the venue that the restarted engine has
never heard of — an order that can fill, into a position nobody is
managing.

The writing itself is done carefully in the ordinary way: write to a
unique temporary file, force the bytes to the device, then rename over the
target. A rename is atomic, so a crash mid-write leaves the old file
intact and a reader always sees a complete document. Forcing before the
rename is what stops a host crash from leaving a durable *name* pointing
at non-durable *content*.

And when a persist fails, it is logged as an error rather than a warning —
because a session that restarts after failed writes reconciles against
stale state, which is exactly the situation this whole chapter exists to
prevent. The disk failing is not a background inconvenience; it is a
future incident announcing itself early.

Reading has a matching rule: state that exists but cannot be read, parsed
or validated **aborts startup**. It does not fall back to empty. Treating
an unreadable risk file as "no halts" would let a restart quietly clear a
halt and reset a daily loss budget, which is the failure this chapter's
sibling chapters spent their length preventing.

## Comparing two accounts of the world

With state on disk and a venue that has been running without supervision,
the restart has one question to answer: do these two agree?

![Four outcomes of comparing the persisted ledger against what the venue reports: both empty, disk only, venue only, and a mismatch](/diagrams/chapter-19/what-a-restart-has-to-decide.png)

*Figure 19.1 — the reconciliation. Three of the four outcomes are either trivial or a refusal.*

Both empty is nothing. Disk has state and the venue has no positions is
also easy, but for a reason worth noticing — the persisted book is *wiped*,
because positions that are gone from the venue are gone.

The venue reporting positions when the ledger has none is a **refusal**.
There is no honest way to invent the history of a position: qkt does not
know what strategy opened it, at what price it was entered, what it has
already realized, or what protection it was supposed to have. Attaching to
it would mean fabricating all of that.

And the fourth case — both sides have something, and they do not line
up — is a refusal too. Matching is attempted first, position by position,
on side and quantity and entry price within a tolerance. Anything left
unmatched on either side ends the deploy.

Underneath all of that sits one rule, stated in the source as bluntly as
anything in this book: **never reconcile against assumed state.** The
failure it names is a transient broker error that reads as "no open
positions" — a perfectly valid-looking answer that would let a session
start flat while holding leveraged risk.

## The one case that resolves itself

There is a single exception, and it is a good example of a distinction
worth making carefully.

A leg in the ledger whose venue ticket is *definitively absent* from the
venue's position list did not drift. Its position closed — a stop, a
target, someone closing it by hand — while the engine was down. That is a
completed lifecycle observed late, not a disagreement.

So it is retired: dropped from the book, with its realized P&L booked
through the ordinary path, and the deploy continues.

Notice how narrow the conditions are. This only applies when the venue
exposes tickets *and* the leg recorded one *and* the full ticket list was
read successfully. A ticketless leg, a venue that does not expose tickets,
or a partial read all fall back to refusing. The automatic resolution is
available exactly where the evidence is unambiguous, and nowhere else.

When an operator does decide to adopt what the venue holds, the adoption
is deliberately not a clean slate. The positions come in carrying their
venue tickets so they can be closed precisely later, and **the strategy
starts under a persistent halt** — exits work, new entries don't, until a
human clears it. Adopted positions have no coherent history behind them,
so the system accepts them and simultaneously refuses to build on them.

## Positions that vanish while running

Reconciliation is not only a startup concern, and the running version has a
subtler problem.

A poller compares the venue's positions against the ledger continuously.
When a leg's ticket stops appearing, the natural conclusion is that the
position closed and the ledger should retire it.

That conclusion is wrong often enough to matter, because of a race: a
position opened moments ago may be missing from a snapshot that was
already in flight when it opened. Retiring on the first miss would book a
close for a position that is alive and well.

![Two polling sequences: one where a ticket reappears after a single miss and is kept, one where two consecutive misses retire the leg](/diagrams/chapter-19/two-misses-before-retiring.png)

*Figure 19.2 — one miss is a race. Two consecutive clean misses is evidence.*

So retirement requires **two consecutive clean misses**, and the word
clean is doing work: a failed read does not count. A failed read means
*unknown*, not *everything closed* — the same distinction as Chapter 7's
`null` versus `0`, and the consequence of getting it wrong here would be
spectacular. Diffing an outage snapshot would synthesise a close for every
open position at once.

There is a related disambiguation running alongside. When the engine
itself has just submitted a close, the resulting drop in venue volume is
*expected*, and must not be published a second time as an independent
venue-side event. The poller tracks whether a close is engine-initiated
and pending, engine-initiated and already confirmed, or genuinely nobody's
doing — and only the last one gets booked as a venue close.

## Detecting is not acting

One structural choice deserves its own mention, because it is what keeps
all of this safe.

The component that builds flatten orders is deliberately, almost
aggressively dumb. It takes a leg and produces one opposite-side market
order carrying the intent to close *that* leg, naming its ticket. It has
no opinions about whether flattening is a good idea.

All the detection machinery — reconciliation, orphan detection, the
vanished-ticket poller — **reports drift. It never flattens.** Closing a
position happens only from an explicit path: a strategy stopping, a kill
switch, an operator command.

That separation is the reason a reconciliation bug is a *reporting* bug.
If detection could act, a false positive at startup would close real
positions automatically, and the blast radius of a subtle comparison error
becomes other people's money. Keeping the two apart means the worst case
is a wrong report that a human reads.

## What this bought, and what it cost

What it bought is that a restart is an ordinary event. The engine comes
back, establishes what it actually owns, retires what closed while it was
away, refuses when the evidence is ambiguous, and resumes — with realized
P&L, risk state, and halts intact rather than silently reset.

What it cost is availability, again, and this time repeatedly. A strategy
that will not start on an ambiguous book is a strategy that sometimes will
not start. Every refusal in this chapter is a page for a human at an
inconvenient hour, and the alternative — start anyway, sort it out later —
is genuinely tempting right up until the once it is catastrophic.

It also cost a real amount of durable state and the discipline to keep it
correct. Every per-order map must be torn down when its order dies, or it
leaks for the life of the process. Every schema must be versioned, or a
restart after an upgrade reads yesterday's shape as today's.

And two honest gaps are worth carrying out of the chapter. A trailing stop
resumes from the last high-water mark that reached disk, so favourable
price movement during the outage is simply lost to the trail. And where
several strategies share one account, ownership of a venue position can be
genuinely ambiguous — the system says so and declines to guess rather than
attributing a position to a strategy that may not own it.
