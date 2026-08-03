"""Live model-list fetchers for the provider catalog.

Each fetcher queries the provider's model-list endpoint and returns
LiteLLM-prefixed model ids (e.g. "openai/gpt-4o-mini"). Any failure —
missing key, network, HTTP error, unexpected payload — raises; the
caller falls back to the static catalog.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import aiohttp

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

_TIMEOUT = aiohttp.ClientTimeout(total=10)

#: OpenAI /v1/models lists every model family; keep only chat completions.
_OPENAI_CHAT_PREFIXES = ("gpt-", "o1", "o3", "o4", "chatgpt-")
_OPENAI_EXCLUDES = (
    "-audio",
    "-realtime",
    "-transcribe",
    "-tts",
    "-search",
    "-image",
    "instruct",
)

#: Gemini list includes embedding/TTS/image variants that cannot chat.
_GEMINI_EXCLUDES = ("-embedding", "aqa", "-tts", "-image")


def _require_key(api_key: str | None) -> str:
    if not api_key:
        raise ValueError("api key required")
    return api_key


async def _get_json(url: str, headers: dict[str, str] | None = None) -> Any:
    async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
        async with session.get(url, headers=headers) as resp:
            resp.raise_for_status()
            return await resp.json()


async def _fetch_openai(api_key: str | None, api_base: str | None) -> list[str]:
    key = _require_key(api_key)
    payload = await _get_json(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    ids = (m["id"] for m in payload["data"])
    return [
        f"openai/{i}"
        for i in ids
        if i.startswith(_OPENAI_CHAT_PREFIXES)
        and not any(x in i for x in _OPENAI_EXCLUDES)
    ]


async def _fetch_anthropic(api_key: str | None, api_base: str | None) -> list[str]:
    key = _require_key(api_key)
    payload = await _get_json(
        "https://api.anthropic.com/v1/models",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
    )
    return [f"anthropic/{m['id']}" for m in payload["data"]]


async def _fetch_gemini(api_key: str | None, api_base: str | None) -> list[str]:
    key = _require_key(api_key)
    payload = await _get_json(
        "https://generativelanguage.googleapis.com/v1beta/models"
        f"?key={key}&pageSize=200"
    )
    models: list[str] = []
    for m in payload["models"]:
        if "generateContent" not in m.get("supportedGenerationMethods", []):
            continue
        name = m["name"].removeprefix("models/")
        if any(x in name for x in _GEMINI_EXCLUDES):
            continue
        models.append(f"gemini/{name}")
    return models


async def _fetch_deepseek(api_key: str | None, api_base: str | None) -> list[str]:
    key = _require_key(api_key)
    payload = await _get_json(
        "https://api.deepseek.com/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    return [f"deepseek/{m['id']}" for m in payload["data"]]


async def _fetch_xai(api_key: str | None, api_base: str | None) -> list[str]:
    key = _require_key(api_key)
    payload = await _get_json(
        "https://api.x.ai/v1/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    return [f"xai/{m['id']}" for m in payload["data"]]


async def _fetch_openrouter(api_key: str | None, api_base: str | None) -> list[str]:
    # Key optional: the model list is public, a key just lifts rate limits.
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    payload = await _get_json("https://openrouter.ai/api/v1/models", headers=headers)
    # ids are already "vendor/model" (e.g. "anthropic/claude-sonnet-4.5").
    return [f"openrouter/{m['id']}" for m in payload["data"]]


async def _fetch_ollama(api_key: str | None, api_base: str | None) -> list[str]:
    base = (api_base or "http://localhost:11434").rstrip("/")
    payload = await _get_json(f"{base}/api/tags")
    return [f"ollama_chat/{m['name']}" for m in payload["models"]]


async def _fetch_openai_compatible(
    api_key: str | None, api_base: str | None
) -> list[str]:
    """Any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, ...).

    api_base is the OpenAI-style base including /v1 (e.g.
    http://localhost:1234/v1); the key is optional — most local servers
    ignore auth. Ids come back "hosted_vllm/"-prefixed: LiteLLM's generic
    OpenAI-compatible route, which honors api_base and substitutes a fake
    key when none is given.
    """
    if not api_base:
        raise ValueError("api base required")
    base = api_base.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    payload = await _get_json(f"{base}/models", headers=headers)
    return [f"hosted_vllm/{m['id']}" for m in payload["data"]]


async def _fetch_codex(api_key: str | None, api_base: str | None) -> list[str]:
    """Codex reads its own OAuth grant; the api_key argument is unused."""
    from ..cli_providers.codex import fetch_models

    return await fetch_models()


_FETCHERS: dict[str, Callable[[str | None, str | None], Awaitable[list[str]]]] = {
    "openai": _fetch_openai,
    "anthropic": _fetch_anthropic,
    "gemini": _fetch_gemini,
    "deepseek": _fetch_deepseek,
    "xai": _fetch_xai,
    "openrouter": _fetch_openrouter,
    "codex": _fetch_codex,
    "ollama": _fetch_ollama,
    "openai-compatible": _fetch_openai_compatible,
}

#: Providers with a real model-list endpoint. CLI subscriptions not listed
#: here fall back to the static catalog in POST /providers/models.
LIVE_MODEL_PROVIDERS: frozenset[str] = frozenset(_FETCHERS)


async def fetch_live_models(
    provider: str, *, api_key: str | None = None, api_base: str | None = None
) -> list[str]:
    """Fetch the provider's current model list as LiteLLM model ids.

    Raises ValueError for unknown providers or a missing required key, and
    aiohttp errors for network/HTTP failures. The caller (POST
    /providers/models) turns any failure into a static-catalog fallback.
    """
    fetcher = _FETCHERS.get(provider)
    if fetcher is None:
        raise ValueError(f"unknown provider: {provider}")
    return await fetcher(api_key, api_base)
