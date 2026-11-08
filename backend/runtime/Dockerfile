# REMi node: the runtime + trainer on the official vLLM image. The runtime starts vLLM itself (REMI_SERVE=1) and
# stops/starts it around training, the same as on a hand-set-up box. Build context = repo root (see docker-compose.yml).
FROM vllm/vllm-openai:v0.33.0

# Trainer stack, pinned to what runs on the 5070 Ti (pyproject.toml `gpu` extra). torch comes from the vLLM image.
RUN pip install --no-cache-dir peft==0.21.2 transformers==5.20.2 trl==1.17.1 datasets==5.1.0 \
    "pyyaml>=6.0.2" "jsonschema>=4.23.0"
# /sh sandboxes are sibling containers on the host's Docker (socket mounted by compose).
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker

COPY contract /repo/contract
COPY backend/runtime/remi /repo/backend/runtime/remi
# Sleep REMi's purpose: remi.trainer.curricula renders its training prompts from it
COPY fixtures/agentfiles /repo/fixtures/agentfiles
WORKDIR /repo/backend/runtime
ENV PYTHONPATH=/repo/backend/runtime PYTHONUNBUFFERED=1 REMI_SERVE=1 REMI_STORE=/store \
    VLLM_ALLOW_RUNTIME_LORA_UPDATING=True
ENTRYPOINT ["python3", "-m", "remi"]
