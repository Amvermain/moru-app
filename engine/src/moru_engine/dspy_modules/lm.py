"""LM factory and engine-wide DSPy configuration.

Any provider is addressed by a single LiteLLM model string
("openai/gpt-5.6-luna", "anthropic/...", "ollama_chat/qwen3:8b", ...);
no per-provider adapter code is needed.

The locally installed coding CLIs (Claude Code, OpenAI Codex, Gemini CLI)
join that contract through LiteLLM custom providers registered at import —
"claude-code/...", "codex/...", "gemini-cli/..." resolve to handlers that
ride the CLI's own OAuth grant instead of an API key.
"""

from __future__ import annotations

import logging

import dspy

from ..cli_providers import register_cli_providers

logger = logging.getLogger(__name__)

register_cli_providers()

DEFAULT_TEMPERATURE = 0.3
DEFAULT_MAX_TOKENS = 8192


def build_lm(
    model: str,
    *,
    api_key: str | None = None,
    api_base: str | None = None,
    temperature: float = DEFAULT_TEMPERATURE,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    cache: bool = True,
    **extra: object,
) -> dspy.LM:
    """Build a dspy.LM from a LiteLLM model string.

    Args:
        model: LiteLLM model identifier, e.g. "openai/gpt-5.6-luna" or
            "ollama_chat/qwen3:8b".
        api_key: Provider API key; falls back to provider env vars.
        api_base: Override base URL (Ollama, proxies).
        temperature: Sampling temperature.
        max_tokens: Completion token cap.
        cache: Enable the DSPy disk cache (free re-runs of identical batches).
        extra: Passed through to litellm (e.g. reasoning_effort).
    """
    kwargs: dict[str, object] = {
        "temperature": temperature,
        "max_tokens": max_tokens,
        "cache": cache,
    }
    # GPT-5-family models (direct "openai/gpt-5*" or via OpenRouter) accept
    # only the default temperature: LiteLLM's gpt-5 transformation raises
    # UnsupportedParamsError for temperature != 1 on ids missing from its
    # bundled model map (e.g. the 5.6 family). temperature=None is never
    # forwarded (dspy keeps the key, LiteLLM skips None), so the provider
    # default applies.
    if model.rsplit("/", 1)[-1].lower().startswith("gpt-5"):
        kwargs["temperature"] = None
    if model.startswith("ollama") and "reasoning_effort" not in extra:
        # Local thinking models (qwen3 family) burn the whole completion
        # budget on reasoning_content and return empty text. Translation
        # batches need the tokens for output; litellm maps
        # reasoning_effort="disable" to Ollama think=false. Override by
        # passing reasoning_effort explicitly.
        extra["reasoning_effort"] = "disable"
    kwargs.update(extra)
    if api_key:
        kwargs["api_key"] = api_key
    if api_base:
        kwargs["api_base"] = api_base
    logger.info("Building LM: %s", model)
    return dspy.LM(model, **kwargs)


def configure_engine(lm: dspy.LM, *, json_adapter: bool = True) -> None:
    """Configure global DSPy settings for the engine process.

    JSONAdapter keeps dict-typed fields robust on small models
    (structured-output where the provider supports it).
    """
    adapter = dspy.JSONAdapter() if json_adapter else None
    dspy.configure(lm=lm, adapter=adapter)


def _usage_value(usage: object, key: str) -> object:
    """Read a usage field from either a dict or a pydantic-style object."""
    if isinstance(usage, dict):
        return usage.get(key)
    return getattr(usage, key, None)


def _cached_tokens(usage: object) -> int:
    """Provider-cached prompt tokens from a LiteLLM usage payload.

    OpenAI-compatible providers nest the count under
    prompt_tokens_details.cached_tokens; Anthropic reports
    cache_read_input_tokens at the top level. Either level may be a dict or
    a pydantic model, so read both ways and take whichever is non-zero.
    """
    details = _usage_value(usage, "prompt_tokens_details")
    cached = _usage_value(details, "cached_tokens")
    if not cached:
        cached = _usage_value(usage, "cache_read_input_tokens")
    try:
        return max(int(cached or 0), 0)
    except (TypeError, ValueError):
        return 0


def token_usage(lm: dspy.LM) -> dict[str, int]:
    """Aggregate prompt/completion token usage from an LM's call history.

    cached_tokens is the cumulative share of prompt_tokens served from the
    provider prompt cache, clamped per call so it can never exceed
    prompt_tokens.
    """
    prompt = 0
    completion = 0
    cached = 0
    for entry in getattr(lm, "history", None) or []:
        usage = entry.get("usage") or {}
        entry_prompt = int(_usage_value(usage, "prompt_tokens") or 0)
        prompt += entry_prompt
        completion += int(_usage_value(usage, "completion_tokens") or 0)
        cached += min(_cached_tokens(usage), entry_prompt)
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "cached_tokens": cached,
    }
