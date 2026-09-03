---
title: "Historical Data"
excerpt: "Every number Chapters 8 through 11 produced rested on an assumption nobody stated: that the data underneath was actually there."
date: 2026-09-07
order: 15
draft: false
---

## The backtest that was quietly wrong

Every number Chapters 8 through 11 produced rested on an assumption nobody
stated: that the data underneath was actually there.

Picture a backtest over January. It runs, it reports a Sharpe ratio and a
drawdown and a trade count, and every one of those numbers is computed
correctly by the machinery already built. Now suppose the eighteenth of
January is missing three hours in the middle of the session — a fetch that
half-failed weeks ago, a file that exists and is short.

Nothing complains. The replay reads what is there. The strategy sees a
market that went quiet for three hours and then jumped, which is a market
that did not exist. Whatever it did in response is now in the report,
indistinguishable from a real result.

This is a different failure from the ones in Chapter 11. There the
ambiguity was in the *format* — four numbers cannot record a path.
Here the data is simply absent, and absence has no representation at all.
A missing hour looks exactly like an hour in which nothing happened.

So the job of this chapter is narrower than "storage" and more important
than it sounds: **knowing what you have.**

## Presence is not coverage

Start with the distinction the whole design turns on.

The store keys its knowledge on *files*. One file per symbol per UTC day.
Asking "do I have the eighteenth?" is a question about whether a file
exists, which is fast, simple, and completely insufficient — because a
file that exists can be empty, truncated, or missing the middle of the
session.

The word for "the file is there" is **presence**. The word for "the data
in it is actually the day" is **coverage**, and only the second one is
worth anything.

![Three trading days shown hour by hour: a complete day, a day with one quiet hour that is accepted, and a day with five consecutive empty hours that is flagged](/diagrams/chapter-15/presence-is-not-coverage.png)

*Figure 15.1 — the same question asked of three files that all exist. Coverage is checked hour by hour against the trading calendar, and the session's first and last hours are exempt because they are legitimately thin.*

Notice what the validator tolerates and what it doesn't, because that line
is a genuine piece of domain knowledge rather than a threshold someone
picked. **One isolated empty interior hour is accepted.** Metals and FX
halt for roughly an hour every session, and at the data layer a
maintenance break is indistinguishable from a hole. Refusing to run on
that would refuse to run on every normal day of gold data.

**Several consecutive empty hours are not accepted**, because that is what
a genuinely failed or partial fetch actually looks like. The tolerance is
sized to let the routine thing through and catch the broken thing, which
is what a threshold is for.

The wall calendar is the wrong calendar for this, too. A Saturday with no
ticks is not a hole. Coverage is checked against a *trading* calendar, so
weekends and closures are absences the system expects rather than
absences it reports.

## What happens when a day is missing

With coverage established, the rest of the pipeline follows.

![Six steps: a backtest asks for a range, the store checks which days exist, missing days are fetched, coverage is validated hour by hour, holes trigger one repair attempt and then a refusal, and only then does the run start](/diagrams/chapter-15/how-a-backtest-gets-its-data.png)

*Figure 15.2 — the provisioning path. The interesting step is the fifth, which is the one that declines to continue.*

Missing days get fetched. That part is ordinary except for one detail with
a nice shape to it: **a day that genuinely has no ticks still gets a file
written** — a header and nothing else. Without that, a quiet day would be
absent, absence would mean "not fetched," and every future run would try
to fetch it again, forever. Writing the empty file is how the store
records *"I asked, and the answer was nothing."*

Then coverage is checked, and if there are holes the system gets exactly
one repair attempt: delete the suspect days, fetch them again, re-check.
Once. If holes remain after that, the run stops:

```
$ qkt backtest strategies/momentum.qkt --from 2024-01-15 --to 2024-01-16 ...

qkt: tick coverage BTCUSDT 0/1 trading days
qkt: error: incomplete data for BTCUSDT:
  2024-01-15  incomplete (empty hours 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22)
  re-run with --allow-incomplete to proceed anyway
```

That refusal is the chapter's whole argument, and it is worth noticing what
it does *not* do. It does not silently proceed. It does not quietly
interpolate. It names the symbol, names the day, lists the hours it
couldn't account for, and tells you the flag that overrides it.

The override exists, and it should. There are legitimate reasons to run on
partial data — you know the gap is real, you are testing something
unrelated to that window, you want a rough answer now. Passing
`--allow-incomplete` downgrades the refusal to a loud warning, printed
above the results so it travels with them. What the design refuses to do
is make that the default, because a default that runs on whatever happens
to be on disk produces exactly the confidently-wrong report this chapter
opened with.

There is a smaller, related guard worth mentioning: a freshly fetched day
that looks empty, truncated, or gappy triggers a warning rather than a
retry. The reasoning is stated plainly in the source — a genuinely quiet
day is legitimately empty, and auto-refetching it would loop forever. Warn,
don't spin.

## What the bytes look like

The storage format is worth a short detour, because the choice is
unusually legible.

Ticks and bars are stored in a compact binary layout: a small header —
a magic marker, a version, the scale, the timeframe, the symbol — and then
the data as **columns of 64-bit integers**. All the timestamps, then all
the opens, then all the highs, and so on, rather than a row per bar with
mixed types.

Two decisions are packed in there. The first is that prices are stored as
scaled integers rather than as text or floating point: a price of
`1850.50000000` is stored as `185050000000`, the unscaled value at
Chapter 7's fixed scale of eight decimal places. Reading it back is an
exact reconstruction — no parsing, no rounding, no float drift. Chapter 7's
discipline reaches all the way down to the disk.

The second is the columnar layout, which exists because of how the data is
read. A day of bars is tens of kilobytes, so the whole file is read in one
go and decoded column by column, and after the first read it is served
from the operating system's page cache. Tick files go further and are
memory-mapped, which means several backtests running at once share the
same physical pages rather than each loading their own copy — a benefit
that never shows up in a single-run benchmark and matters enormously when
a parameter sweep fans out across processes.

What it costs is legibility. A CSV can be opened, eyeballed, and edited
with a text editor; this cannot. And the version in the header is checked
strictly rather than migrated — a format change is a hard read failure, not
a best-effort upgrade. That is the same instinct as everything else here:
refuse clearly rather than proceed on data you might be misreading.

## Bringing your own data

There is no import command, and that is deliberate rather than missing.
Putting your own history in is a matter of writing files where the store
expects them: one file per UTC day, under the symbol's directory, named by
date.

What is not relaxed is the format. The header must match exactly, every
row must have all eight columns, and timestamps must be non-decreasing. A
file that violates any of those does not get skipped or partially read —
it throws, immediately, naming the file and the line. The source states the
philosophy in one line: *bad data should fail loud, not silently corrupt
the backtest.*

> [!WARNING]
> A file you place by hand is *present*, but the store's manifest — its
> record of what it has fetched — does not know about it. A later run can
> therefore consider that day un-fetched and overwrite your file with a
> fresh download. Run with `--no-fetch` to avoid it.

That trap follows directly from the presence-versus-coverage split at the
top of the chapter: coverage is keyed on one thing and fetch history on
another, and a hand-placed file satisfies the first without appearing in
the second.

## Refusing to run, and what that costs

What it bought is that a backtest either runs on data the system can
account for, or does not run. Chapters 9 and 10 spent their length on ways
a report can mislead you with numbers that are computed correctly; this
chapter closes the gap underneath all of them, where the numbers are
computed correctly from a month that was never fully there.

What it cost shows up in three places. Validation is not free — every run
walks its date range hour by hour before any strategy logic executes, and
on a long range that is real time spent before the first tick. The
tolerance for a single quiet hour is a heuristic tuned to how metals and
FX actually trade, which means it is right for those and could be wrong for
an instrument that behaves differently. And the binary format that makes
reads fast and exact is the format that makes a bad day impossible to
inspect by hand.

The through-line is the same one as Chapter 7's refusal to invent a
contract size and Chapter 14's refusal to invent an indicator value. A
system that will happily proceed on whatever it happens to have will
eventually hand you a number that is wrong for a reason you cannot see —
and by then the number is in a report, and the report is a decision.
