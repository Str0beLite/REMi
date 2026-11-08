# Training notes: what we've learned about training and serving LoRAs on REMi

A running log, kept while building the gpu lane. It's raw material for Sleep REMi: later it gets distilled into a **Skill** (the rules, as text Sleep REMi reads) and a **LoRA** (examples of good decisions). Each entry has a **rule**, the **why**, and the **evidence** we measured. Add entries as we learn; correct old ones instead of stacking contradictions.

Setup for all numbers: Nemotron 3 Nano 4B BF16, RTX 5070 Ti 16 GB (WSL2), vLLM 0.33.0, transformers 5.20.2, PEFT 0.21.2, TRL 1.17.1, PyTorch Mamba path (no `mamba_ssm` kernels).

## Recipe

**1. On small datasets, count optimizer steps, not epochs.**
- Rule: an adapter needs on the order of 30 optimizer steps to learn a narrow skill. Below 512 examples, use batches of 4 with no gradient accumulation (the trainer does this automatically since 2026-11-08).
- Why: epochs are capped at 3. With 4 × 4 = 16 examples per step, a 60-example set gets only 8 steps in 2 epochs: too few updates to learn anything.
- Evidence (2026-11-08, `sre` from `fixtures/dataset.jsonl`, rank 16, lr 2e-4): 8 steps → loss 1.87 → 0.79, **0/16** held-out exact. 30 steps → loss 1.85 → 0.001, **16/16** held-out and 5/5 seen. 40 steps: same 21/21.

**2. The final training loss tells you if it learned.**
- Rule: on a narrow, templated task (one command format), final loss should end near 0. If it ends above ~0.3, it's undertrained; add steps before judging the adapter.
- Evidence: loss 0.79 → 0/16; loss ≤ 0.001 → 16/16 (see 1).

**3. A few templated examples teach a format, and it generalizes to new values and rewordings.**
- Rule: 10 distinct examples, each with one clear pattern, are enough to teach an exact output format. The adapter then fills in values it never saw and handles reworded questions.
- Evidence: trained on 5 paths and 5 services (each repeated 6 times). Then 12/12 on new paths/services (`/boot`, `redis`, `homeassistant`…) and 4/4 on rewordings ("I can't reach redis anymore, is it running?" → `/sh systemctl status redis …`).
- Caveat: the held-out set was close to the training patterns. We haven't tested yet what happens to unrelated tasks (forgetting).

**4. The base model doesn't follow our command format on its own; that's what a LoRA buys.**
- Evidence: base 0/21 exact. It answers in prose with the right idea ("Check with: `df -h /tmp`") but never the `/sh …` line our grammar needs. Same system prompt in both cases.

**4b. Without the adapter, the base model makes up answers it can't know; with it, it checks.**
- Evidence (2026-11-08, M3 dry run): asked "Is /var/backups running out of space?", the base 4B said "Yes, /var/backups is running out of space." without looking. After adopting `sre@1` it answered `/sh df -h /var/backups`. That's the behaviour we want Sleep REMi to train for: run the check instead of guessing.

**5. Train and serve with the same chat template, thinking off.**
- Rule: render prompts with `enable_thinking=False` in training. vLLM serves with `--default-chat-template-kwargs '{"enable_thinking": false}'`. Put loss on assistant turns only: one prompt/completion pair per assistant turn.
- Why: a mismatch between the training and serving templates silently costs accuracy.

**6. Target the attention and MLP linears, never the Mamba mixer.**
- Rule: in `nemotron_h`, target `q_proj k_proj v_proj o_proj` (attention) and `up_proj down_proj` (MLP; this model has no `gate_proj`). Never Mamba `in_proj`/`out_proj`.

## Judging an adapter

**7. Score exact output on three held-out groups, then run the paired test.**
- Rule: (a) same wording with new values, (b) reworded questions, (c) a few seen examples as a sanity check. Score the exact command (string match) for base and candidate on the same prompts. Use `remi.trainer.stats.paired(candidate, base)` → `verdict`.
- Evidence: 21 prompts, +100 points, 95% CI [+100, +100], McNemar p ≈ 1e-6 → STRONG GO.
- Note: with 300 examples and no real difference, the 95% CI reaches about −5 points, so "no change" can come out NO-GO at a 5-point margin. Small eval sets give wide intervals.

## Hardware and time (5070 Ti)

**8. Training and vLLM can't share the GPU; train in a separate process with vLLM stopped.**
- Evidence: vLLM at `--gpu-memory-utilization 0.85` uses 13.5 of 15.9 GiB (weights 8.66 GiB, KV cache 3.93 GiB = 165k tokens). Training the 4B needs the card to itself. A fresh process also frees every byte before vLLM restarts.

**9. A sleep is short; most of it is the vLLM restart.**
- Evidence: 30 steps take about 30 s including model load. A full sleep (stop vLLM → train 4 steps → register → restart vLLM) took 1.7 min, and vLLM's cold start takes about 1.5–4 min (CUDA graph compile). Decode speed is 93.7 tokens/s single-stream.

**10. vLLM's default memory setting fails on a desktop GPU.**
- Rule: use `--gpu-memory-utilization 0.85`. The default 0.92 needs 14.6 GiB free, but Windows already used ~1.3 GiB (Wallpaper Engine alone was ~0.27 GiB).

## Serving and mixing

**11. LoRAs loaded at runtime serve exactly like PEFT.**
- Evidence: vLLM vs PEFT on a rank-64 adapter, 8 prompts × 16 tokens: mean logprob gap 0.011, argmax agreement 100%. A check like this needs an adapter that really changes the output (B weights at std 0.01 only moved logprobs by 0.03; std 0.05 moved them by 0.15).

**12. Mixing adds ranks; past 64 it's cut back.**
- Rule: a `cat` mix's rank is the sum of its adapters' ranks (16 + 32 → 48). vLLM's cap is 64, so bigger sums are cut to their best rank-64 approximation. It's exact when the adapters share directions, lossy otherwise. Prefer ranks that sum to ≤ 64 for adapters that will be mixed.
- Evidence: the merge is done from the files with no base model, in under a second, and matches PEFT `add_weighted_adapter(cat)` exactly.

## Running it

**13. Training runs in a spawned subprocess, so anything that starts it needs a main guard.**
- Rule: a script that calls `/sleep` or `cycle.run` must keep its top-level code under `if __name__ == "__main__":`. `python -m remi` already does.
- Why: the spawned trainer re-imports the parent's main script. Without the guard, it re-runs the whole script and exits with code 1.
- Evidence (2026-11-08): the first M3 dry run hit this. The cycle still woke everyone and reported "trainer exited with code 1", so the recovery path works for real.

**14. The whole nightly loop is minutes on the 5070 Ti.**
- Evidence: `/sleep` on 60 examples (30 steps, loss 1.85 → 0.001) took 2.1 min asleep, most of it the vLLM restart. Then `/adapter eval` on 10 held-out examples: 10/10 against base 0/10, STRONG GO (McNemar p = 0.002).

## Agents in the loop (first live chats, 2026-11-08)

**15. Agent turns run at temperature 0; `/think` runs at 0.6.**
- Rule: tool-calling turns are greedy. Thinking (`/think`) samples at 0.6 / top_p 0.95, the usual reasoning-mode settings.
- Why: the model's default is temperature 1.0, which invented commands that don't exist (`/toh`, `/toad`, `/toaom`) and gave three different answers to one question. At temperature 0 those were gone.
- Evidence: same homelab prompt, 3 samples each. Default: "98% of 25G", "/var/backups /var/backups …", "is full". Temperature 0: the same answer every time.

**16. The base 4B is fragile at "check before you answer"; an adapter fixes it.**
- Evidence: at temperature 0, "@homelab-remi, is /var/backups running out of space?" (with a comma) got a made-up answer, while the same question without the comma got `/sh df -h /var/backups`. 3 of 4 questions used `/sh` without the comma. A worked example in the prompt changed nothing. The `sre` adapter answered `/sh …` every time (see 4b).
- Rule: don't rely on the purpose prompt alone for behaviour that matters; train it.

**17. A stuck greedy model repeats itself, so stop after the same failure twice.**
- Evidence: Sleep REMi sent `/adapter adopt homelab-remi@sre0 …` about 30 times with the same error, until its 40-turn budget ran out.
- Rule: the loop ends a run when one command fails twice with the same error, and posts a help request (`family: stuck`).

**18. Errors should show the right form and the real names; a small model copies them.**
- Evidence (the chat mistakes): `/read @general`, `base=homelab-remi-base`, a made-up dataset `srerank-one`, two commands on one line, `homelab-remi@sre0`.
- Rule: every usage error ends with "right form: …" and lists what exists (channels, agents, datasets, specs, adapters). An unknown command lists the agent's own tools. Whether this fixes the mistakes is checked live after the change.

**19. An adapter learns exactly the turns you train, so include what happens after the command.**
- Evidence (2026-11-08, live): after adopting `sre@1`, homelab-remi ran `/sh df -h /var/backups` instead of guessing. But the sandbox has no `/var/backups`, `df` failed, and it sent the same command again; the stuck detector ended the run. `homelab-fixes` only has the first command, never "tool result → read it → answer or try something else".
- Rule: build multi-turn examples: the command, its real output as a `user` turn, then the answer, including at least some where the first check fails and the agent adapts.

**20. Old garbage in history and notes gets copied at temperature 0.**
- Evidence: after the fixes, Sleep REMi did the whole train → sleep → eval → adopt chain right, but ended each run with "Ryan is not present in API. /note All adapters must be at version 0 to exit.". That's text from its own earlier failed runs, still in #ops history and its saved notes.
- Rule: bad runs pollute later prompts. Curating notes (`/memory edit`) is part of Sleep REMi's job, and a fresh channel gives a fair test.

**21. With temperature 0, teaching errors and a step-by-step purpose, the 4B ran the whole loop itself.**
- Evidence (live, 2026-11-08): from one chat request, Sleep REMi sent `/train_spec` (all fields right) → `/sleep` (asleep 2.5 min, loss 1.85 → 0.001) → `/adapter eval` (10/10 vs 0/10, STRONG GO) → `/adapter adopt` onto homelab-remi, each right the first time. Before the fixes, the same request ended in 30 repeats of a bad command. `/read @general` failed once, then it copied the right form from the error.
