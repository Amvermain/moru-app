"""Model-string plumbing shared by the CLI providers.

A leaf module so the handlers can import it without cycling back through
the package ``__init__``.

LiteLLM's ``completion()`` dispatch tests the BARE model name against its
built-in OpenAI table *before* it ever consults ``custom_provider_map``::

    elif (
        model in litellm.open_ai_chat_completion_models
        or custom_llm_provider == "custom_openai"
        ...

The Codex SKUs are genuine OpenAI model names, so ``codex/gpt-5.6-luna``
resolved to provider ``codex`` and was then handed to the OpenAI client
anyway — failing with "Missing credentials ... OPENAI_API_KEY" and never
reaching our handler. Inserting a marker segment keeps the bare name out
of that table; the handlers strip it back off. Public ids (catalog,
settings, UI, uploads) stay unprefixed.
"""

from __future__ import annotations

#: Segment inserted between the provider and the model on the wire.
WIRE_MARKER = "@"
_WIRE_PREFIX = f"{WIRE_MARKER}/"


def strip_wire_marker(model: str) -> str:
    """Wire model id -> the slug the provider's API expects."""
    if model.startswith(_WIRE_PREFIX):
        return model[len(_WIRE_PREFIX) :]
    return model
