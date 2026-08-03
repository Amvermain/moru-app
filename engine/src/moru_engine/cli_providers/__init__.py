"""Local coding-CLI providers: Claude Code, OpenAI Codex, Gemini CLI.

Each is registered as a LiteLLM custom provider, so the whole engine
addresses them with the same model-string contract as every hosted
provider (``claude-code/claude-sonnet-4-6``, ``codex/gpt-5.6-codex``,
``gemini-cli/gemini-3.5-flash``) and ``build_lm`` needs no special case.

Auth is the CLI's own OAuth grant read off disk — no API key, no login
flow of our own. See ``credentials`` for the stores.
"""

from __future__ import annotations

import logging
from typing import Any

import litellm

from .claude_code import ClaudeCodeLLM
from .codex import CodexLLM
from .credentials import STORES, CliAuthError
from .gemini_cli import GeminiCliLLM

logger = logging.getLogger(__name__)

__all__ = [
    "CLI_PROVIDER_CATALOG",
    "CLI_PROVIDER_IDS",
    "CliAuthError",
    "provider_models",
    "provider_status",
    "register_cli_providers",
]

#: Catalog entries in the same shape as the engine's hosted-provider table.
#: ``env`` is None: these never take an API key.
CLI_PROVIDER_CATALOG: tuple[dict[str, Any], ...] = (
    {
        "id": "claude-code",
        "name": "Claude Code (구독)",
        "env": None,
        "auth": "cli",
        "login_hint": "claude login",
        "models": [
            "claude-code/claude-sonnet-4-6",
            "claude-code/claude-haiku-4-5",
            "claude-code/claude-opus-4-8",
        ],
    },
    {
        "id": "codex",
        "name": "OpenAI Codex (구독)",
        "env": None,
        "auth": "cli",
        "login_hint": "codex login",
        "models": [
            "codex/gpt-5.6-codex",
            "codex/gpt-5.6-codex-mini",
        ],
    },
    {
        "id": "gemini-cli",
        "name": "Gemini CLI (구독)",
        "env": None,
        "auth": "cli",
        "login_hint": "gemini",
        "models": [
            "gemini-cli/gemini-3.5-flash",
            "gemini-cli/gemini-3.1-pro-preview",
            "gemini-cli/gemini-3.1-flash-lite",
        ],
    },
)

CLI_PROVIDER_IDS: frozenset[str] = frozenset(p["id"] for p in CLI_PROVIDER_CATALOG)

_HANDLERS = {
    "claude-code": ClaudeCodeLLM,
    "codex": CodexLLM,
    "gemini-cli": GeminiCliLLM,
}

_registered = False


def register_cli_providers() -> None:
    """Install the handlers into ``litellm.custom_provider_map`` once."""
    global _registered
    if _registered:
        return
    existing = {entry.get("provider") for entry in litellm.custom_provider_map}
    for provider, handler in _HANDLERS.items():
        if provider in existing:
            continue
        litellm.custom_provider_map = litellm.custom_provider_map + [
            {"provider": provider, "custom_handler": handler()}
        ]
    _registered = True
    logger.debug("Registered CLI providers: %s", ", ".join(_HANDLERS))


def provider_status(provider_id: str) -> dict[str, Any]:
    """Auth status for one CLI provider (connected / email / expiry)."""
    store = STORES.get(provider_id)
    if store is None:
        return {"connected": False, "error": f"unknown provider: {provider_id}"}
    status = store.status()
    status["login_hint"] = store.login_hint
    status["path"] = str(store.path)
    return status


def provider_models(provider_id: str) -> list[str]:
    """Static model list for a CLI provider.

    These are subscription surfaces with a fixed lineup — there is no
    ``/models`` endpoint to enumerate, so the catalog is the source of
    truth.
    """
    for entry in CLI_PROVIDER_CATALOG:
        if entry["id"] == provider_id:
            return list(entry["models"])
    return []
