# Runbook: incidents (a GPU overheat, handled in #incidents)

A local app raises an alert. The runtime posts it in `#incidents`, and `incident-remi` wakes on it, checks with `/sh`, says what it found and the next step, and @-mentions a human when it can't fix it. Contract: CONTRACT.md §5 (`incident` trigger), §6 (`incident` kind), §8 (local incident intake).

```
gpu_watch ──POST 127.0.0.1:7077/incident──▶ runtime intake ──post_message(kind=incident, system)──▶ #incidents
                                                                                       │ incident trigger
                                                                                       ▼
                                                                    incident-remi: /sh …, then a triage reply
```

**The fast way** runs it all as a test on a real local SpacetimeDB (about 10 s; only the model is scripted):

```bash
cd backend/runtime
REMI_M1=1 uv run pytest -s tests/test_incident_e2e.py -k real_stack
```

Without SpacetimeDB or Docker, `uv run pytest tests/test_incident_e2e.py` runs the same path against the mocks.

## By hand

1. **Stack:** steps 0–3 of [runbook-m1.md](runbook-m1.md): SpacetimeDB, publish the module, make yourself admin (`TOKEN`), and a model server.
2. **Runtime:** start it as in runbook-m1 step 4. The intake listens on `127.0.0.1:7077` (`REMI_INCIDENT_PORT`, `0` = off) and creates `#incidents` at start. The log shows `incident intake on 127.0.0.1:7077`.
3. **The bot:** create it from the fixture (admin, so it can carry `read`):
   ```bash
   NODE_ID=$(spacetime sql --server local remi "SELECT id FROM node" | tail -1 | tr -d ' ')
   spacetime call --server local remi create_agent "$(cat fixtures/agentfiles/incident-remi.yaml)" $NODE_ID
   ```
   Or paste the fixture into the console's Agentfile editor.
4. **Raise an alert:**
   ```bash
   cd backend/runtime
   uv run python -m remi.incidents.gpu_watch --fake ramp --every 3   # 70 → 95 → 70 °C, no GPU needed
   uv run python -m remi.incidents.gpu_watch                         # the real thing: nvidia-smi every 10 s
   ```
   Any app can do the same with one call:
   ```bash
   curl -s 127.0.0.1:7077/incident -d '{"source":"gpu-watch","check":"gpu_temp","severity":"critical",
     "summary":"GPU 0 at 92 °C (threshold 85 °C)","value":92,"threshold":85,"unit":"°C","host":"pc"}'
   ```

## What you should see in #incidents

```
[incident] system: GPU 0 at 92 °C (threshold 85 °C)
[tool_call] incident-remi: /sh nvidia-smi --query-gpu=temperature.gpu,fan.speed --format=csv
[tool_result] incident-remi: …
[chat] incident-remi: <what it found>. Next step: <…>. @ryan …
```

The ramp gives `warning` (84 °C), `critical` (88 °C), `warning` (82 °C) and `resolved` (76 °C). The bot wakes on each one, and on `resolved` it posts an all-clear. The bot reads each alert as one line, e.g. `ALERT [critical] gpu-watch:gpu_temp on pc: GPU 0 at 92 °C (threshold 85 °C)`.

## Gotchas

- **GPU verification pending (2026-11-08, #75).** Container setup, recreation and failure handling pass local tests; real GPU passthrough and incident-remi's temperature read still need verification on the GPU PC.
- **GPU access is opt-in.** On the GPU node, install/configure the NVIDIA Container Toolkit for Docker and start the runtime with `REMI_SANDBOX_GPUS=all`. Agent `/sh` containers then receive `--gpus all`, including the toolkit-mounted `nvidia-smi`; tool proposal dry runs never receive GPUs. Unset the variable on CPU/Mac nodes. Changing this setting recreates existing agent containers on their next use and resets `/workspace` (logged). Verify with `gpu_watch --fake 92` and confirm incident-remi posts the real `/sh nvidia-smi` temperature in `#incidents`.
- **Repeats are quiet.** The same key and severity are posted once per 5 min (`INCIDENT_REPEAT_S`), and a severity change always posts. A watcher that stays hot reminds every 5 min.
- **Localhost only, no auth.** Don't publish port 7077 out of the box.
- **Rendering:** the console shows `incident` messages as plain system lines. An incident card would be lane:web work.
