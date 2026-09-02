---
title: "qkt — Architecture Notes"
excerpt: "A chapter-by-chapter walkthrough of trading systems in general, and qkt — an event-driven trading engine in Kotlin — as the running example."
date: 2026-06-01
tags: ["trading", "systems-design", "kotlin"]
draft: false
parts:
  - title: "Foundations"
    chapters:
      - chapter-01-what-a-trading-engine-is
      - chapter-02-qkt-as-a-subject
      - chapter-03-the-event-bus
      - chapter-04-candles
  - title: "Money, Risk, and Truth"
    chapters:
      - chapter-05-position-tracking-and-pnl
      - chapter-06-the-risk-engine
      - chapter-07-exact-arithmetic
  - title: "Proving It Works: Backtesting"
    chapters:
      - chapter-08-deterministic-replay
      - chapter-09-backtest-reporting
      - chapter-10-parameter-sweeps-and-walk-forward-analysis
---

A chapter-by-chapter walkthrough of trading systems in general, and `qkt` — an
event-driven trading engine written in Kotlin — as the running, real-code
example. Each chapter shows real code, weighs the tradeoff space against what
else could have been built, and explains why the actual design won.

This is a book in progress, written the way it's meant to be read: in order,
front to back.
