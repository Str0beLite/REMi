# Results: what training did, in numbers

Raw data for slides. Every number here comes from a JSON file in this folder; regenerate charts from those, not from
this page. Setup for all of it: Nemotron 3 Nano 4B (BF16) on one RTX 5070 Ti 16 GB, LoRA rank 16, lr 2e-4.

**How we score.** Exact match of the next command a REMi sends, on **unseen** prompts: the paths, services, agents,
datasets, adapter names, people and wordings in the test set never appear in training. Each adapter is compared with
the base model on the same prompts (paired test: difference, 95% bootstrap CI, McNemar p, verdict).

## Sleep REMi's adapters (2026-11-08): `sleep-adapters.json`

Two LoRAs from `remi.trainer.curricula`:
- **tooluse**: any REMi's tool use. Check before answering, read the result, recover from errors, answer plainly.
- **sleepops**: Sleep REMi's job. Pick a dataset, write a train spec, sleep, judge on unseen data, adopt or reject,
  and report, copying names and versions from results.

| Training | examples | steps | minutes | loss first → last |
|---|---|---|---|---|
| tooluse@1 | 360 conversations (674 trained turns) | 84 | 8.4 | 1.635 → 0.0007 |
| sleepops@1 | 240 conversations (1,089 trained turns) | 132 | 34.3 | 0.692 → 0.0001 |

Full loss curves: `train.runs.<name>.loss` (one `[step, loss]` per step).

**Unseen tool-use prompts (n = 120)**

| model | exact | vs base | 95% CI | p | verdict |
|---|---|---|---|---|---|
| base | 14 (12%) | | | | |
| **tooluse@1** | **108 (90%)** | **+78 pts** | [+71, +86] | < 1e-6 | STRONG GO |
| sleepops@1 | 24 (20%) | +8 | [+2, +16] | 0.04 | WEAK GO |
| both, weight 1 each | 91 (76%) | +64 | [+55, +73] | < 1e-6 | STRONG GO |

**Unseen Sleep REMi prompts (n = 120)**

| model | exact | vs base | 95% CI | p | verdict |
|---|---|---|---|---|---|
| base | 59 (49%) | | | | |
| tooluse@1 | 29 (24%) | −25 pts | [−33, −17] | < 1e-6 | **NO-GO** |
| **sleepops@1** | **112 (93%)** | **+44 pts** | [+36, +53] | < 1e-6 | STRONG GO |
| both, weight 1 each | 79 (66%) | +17 | [+8, +26] | 0.0008 | STRONG GO |

By skill, base → trained (from `by_family`):

| skill | base | trained |
|---|---|---|
| check before answering (tool use) | 8/71 | 61/71 |
| fix a command from its error | 6/19 | 19/19 |
| adapt after a failed check | 0/12 | 11/12 |
| full train → eval → adopt chain (Sleep REMi) | 30/51 | 50/51 |
| judge a candidate and adopt/reject | 12/23 | 22/23 |
| say "no dataset teaches that" instead of guessing | 0/5 | 5/5 |

**The story for a slide:**
1. A specialized LoRA turns a 4B model that mostly can't use its tools (12%) into one that mostly can (90%), from
   about 8 minutes of training on one desktop GPU.
2. Specialists interfere. The tool-use adapter cut Sleep REMi's own job from 49% to 24%, and live it started claiming
   it had no `/say`. Mixing both adapters at full weight cost each one about 15–25 points. So each REMi gets the
   adapter for its own job (Sleep REMi runs `sleepops@1` alone), and the next step is training one adapter on both
   datasets instead of mixing two.
3. A near-zero training loss said nothing about any of this. Only the unseen test showed it.

## Reasoning (CoT) adapter, a negative result: `cot-gsm8k.json`

GSM8K worked solutions as `/think` traces (#61): base 90/100, adapter 76/100 (−14 pts, p = 0.009, NO-GO). It learned
to think half as long (458 → 214 characters per trace). Lesson: train reasoning only on traces in the model's own style.
