# Runtime (lane:core, lane:gpu)

Python 3.12 with [uv](https://docs.astral.sh/uv/). Interfaces are in `remi/contract.py` (contract file, Ryan merges changes).

```bash
uv sync
uv run pytest            # what CI runs (GPU tests skipped)
uv run pytest -m gpu     # lane:gpu, on the 5070 Ti PC
```

GPU setup (WSL), the vLLM launcher and its measured numbers: [remi/serving/README.md](remi/serving/README.md).

Mocks for building before the real pieces exist ([CONTRACT.md §11](../../CONTRACT.md)):

```bash
uv run python -m remi.mocks.stdb --port 3999   # SpacetimeDB HTTP API
uv run python -m remi.mocks.vllm --port 8999   # vLLM OpenAI-compatible server
```

Env: `STDB_URL`, `STDB_DB`, `STDB_TOKEN`, `VLLM_URL`, `BASE_MODEL`, `REMI_STORE` (defaults in `remi/contract.py`). Never commit `.env`.
