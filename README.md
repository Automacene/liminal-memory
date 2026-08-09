<p align="center">
  <img src="assets/banner.svg" alt="Liminal Memory" width="100%">
</p>

[![GitHub Repo stars](https://img.shields.io/github/stars/Automacene/liminal-memory?style=flat&color=gold)](https://github.com/Automacene/liminal-memory)
[![GitHub forks](https://img.shields.io/github/forks/Automacene/liminal-memory?style=flat&color=blue)](https://github.com/Automacene/liminal-memory)
[![license](https://img.shields.io/badge/license-Apache%202.0-green)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)]()
[![platform](https://img.shields.io/badge/platform-browser%20%7C%20node.js-blue)]()

> **Being rewritten.** The library is mid-refactor and has no public API right now.
> See [refactor-strategy.md](refactor-strategy.md) for the packaging targets. Documentation
> returns when the API lands.

## What is Liminal Memory?

A small library for deterministic recall over a pool of nodes.

Language models have two problems with long conversations. The obvious one is capacity — the
window fills and older material falls out. The less obvious one is that a bigger window does not
fix it: the model still has to locate the relevant part on its own, softly and unpredictably.

Liminal Memory takes the finding step out of the model. You keep your content as nodes in memory,
search them with ordinary relevance math, and hand the model only what matched. The same pool and
the same query return the same nodes every time, and you can point at the reason any node came
back.

It manages the lifecycle of those nodes and nothing else. Tagging, graph traversal, and the
content itself are yours to define — with a working default for each, so the simple case stays
simple.
