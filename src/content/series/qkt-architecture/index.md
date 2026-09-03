---
title: "qkt — Architecture Notes"
excerpt: "My record of building qkt, an event-driven trading engine in Kotlin — the decisions, the tradeoffs behind them, and what it taught me about trading and about building systems."
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
      - chapter-11-backtest-fidelity
  - title: "The DSL"
    chapters:
      - chapter-12-why-a-dsl
      - chapter-13-parsing-and-compiling
      - chapter-14-indicators
  - title: "Data"
    chapters:
      - chapter-15-historical-data
  - title: "Going Live"
    chapters:
      - chapter-16-the-live-runtime
      - chapter-17-brokers
      - chapter-18-the-order-lifecycle
      - chapter-19-resilience
      - chapter-20-backtest-live-parity
  - title: "Portfolios and Operations"
    chapters:
      - chapter-21-portfolios
      - chapter-22-observability
      - chapter-23-performance
  - title: "Close"
    chapters:
      - chapter-24-one-strategy-end-to-end
      - chapter-25-what-this-teaches
---

A chapter-by-chapter walkthrough of trading systems in general, and `qkt` — an
event-driven trading engine written in Kotlin — as the running, real-code
example. Each chapter shows real code, weighs the tradeoff space against what
else could have been built, and explains why the actual design won.

This is a book in progress, written the way it's meant to be read: in order,
front to back.

It's also my own record of the thing: the decisions, the tradeoffs behind them,
the direction the system took, and what building it taught me about trading and
about building systems. Enjoy — and hopefully we all learn a thing or two along
the way.
