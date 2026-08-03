"""Claude Code (Anthropic OAuth) LiteLLM provider.

Ported from oh-my-pi ``packages/ai/src/providers/anthropic.ts`` — the OAuth
branch of ``buildAnthropicHeaders``, the Claude Code system-block layout,
and the ``cch`` billing attestation (``createClaudeBillingHeader`` +
``patchCch`` + ``wrapFetchForCch``).

Talks to ``api.anthropic.com/v1/messages`` with the subscription grant the
user's own ``claude`` CLI holds, so a Pro/Max plan translates modpacks
without an API key.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import Any

import httpx
import xxhash
from litellm import CustomLLM
from litellm.types.utils import Choices, Message, ModelResponse, PromptTokensDetails, Usage

from .wire import strip_wire_marker
from .credentials import CLAUDE_CODE_STORE, CliAuthError

logger = logging.getLogger(__name__)

API_URL = "https://api.anthropic.com/v1/messages"

#: Claude runtime version bundled by the current Cowork desktop release.
CLAUDE_CODE_VERSION = "2.1.220"
#: User-Agent emitted by Cowork's `claude-desktop` inference entrypoint.
COWORK_USER_AGENT = f"claude-cli/{CLAUDE_CODE_VERSION} (external, claude-desktop)"
#: Identity block prepended by Cowork's Claude runtime. Anthropic keys OAuth
#: inference off this being the first non-billing system block.
CLAUDE_CODE_SYSTEM_INSTRUCTION = (
    "You are a Claude agent, built on Anthropic's Claude Agent SDK."
)

#: Betas the real client advertises on a non-agent ("utility") OAuth call.
#: Translation sends no tools, so this is the utility profile verbatim.
COWORK_UTILITY_BETAS = (
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "structured-outputs-2025-12-15",
)

_BILLING_PREFIX = "x-anthropic-billing-header:"
_CCH_PLACEHOLDER = b"cch=00000"
_CCH_SEED = 0x4D659218E32A3268
_BILLING_MARKER = f'"system":[{{"type":"text","text":"{_BILLING_PREFIX}'.encode()
_CCH_SEARCH_WINDOW = 150

#: CLI-style aliases the `claude` CLI accepts, mapped to wire model ids.
_MODEL_ALIASES = {
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-8",
    "haiku": "claude-haiku-4-5",
    "default": "claude-sonnet-4-6",
}

#: Cowork's per-request output-token ceiling.
MAX_OUTPUT_TOKENS = 64000


def resolve_model(model: str) -> str:
    """Wire id or CLI alias -> the slug this backend expects."""
    model = strip_wire_marker(model)
    return _MODEL_ALIASES.get(model.strip().lower(), model)


def create_billing_header(first_user_message: str) -> str:
    """Claude Code's ``x-anthropic-billing-header`` system block.

    Fingerprint: ``SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]``,
    matching CC's ``computeFingerprint``. ``cch=00000`` is a placeholder the
    caller replaces with the real attestation once the body is serialized.
    """
    k = "".join(
        first_user_message[i] if len(first_user_message) > i else "0"
        for i in (4, 7, 20)
    )
    suffix = hashlib.sha256(
        f"59cf53e54c78{k}{CLAUDE_CODE_VERSION}".encode()
    ).hexdigest()[:3]
    return (
        f"{_BILLING_PREFIX} cc_version={CLAUDE_CODE_VERSION}.{suffix}; "
        f"cc_entrypoint=claude-desktop; cch=00000;"
    )


def patch_cch(body: bytearray) -> str:
    """Patch the ``cch`` attestation into a serialized request body.

    ``XXHash64(body_with_placeholder, seed)`` low 20 bits as 5 hex chars,
    written over the placeholder in place — the same order CC uses, so the
    hash covers the body exactly as it will go on the wire.

    Returns "patched", "no-billing-header" or "unanchored".
    """
    marker = body.find(_BILLING_MARKER)
    if marker == -1:
        return "no-billing-header"
    search_from = marker + len(_BILLING_MARKER)
    idx = body.find(_CCH_PLACEHOLDER, search_from)
    if idx == -1 or idx - search_from > _CCH_SEARCH_WINDOW:
        return "unanchored"
    digest = xxhash.xxh64_intdigest(bytes(body), _CCH_SEED)
    cch = format(digest & 0xFFFFF, "05x")
    body[idx + 4 : idx + 9] = cch.encode()
    return "patched"


def _text_of(content: object) -> str:
    """Flatten an OpenAI-style content field to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)
    return "" if content is None else str(content)


def build_payload(
    model: str, messages: list[dict[str, Any]], optional_params: dict[str, Any]
) -> dict[str, Any]:
    """OpenAI-shaped messages -> Anthropic Messages body, CC system layout."""
    system_prompts: list[str] = []
    turns: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        text = _text_of(msg.get("content"))
        if role == "system" or role == "developer":
            if text.strip():
                system_prompts.append(text)
        elif role in ("user", "assistant"):
            turns.append({"role": role, "content": text})
    if not turns:
        # Anthropic rejects an empty messages array.
        turns = [{"role": "user", "content": system_prompts.pop() if system_prompts else "."}]
    # Anthropic requires the conversation to open on a user turn.
    if turns[0]["role"] != "user":
        turns.insert(0, {"role": "user", "content": "."})

    first_user = next((t["content"] for t in turns if t["role"] == "user"), "")
    system_blocks = [
        {"type": "text", "text": create_billing_header(first_user)},
        {"type": "text", "text": CLAUDE_CODE_SYSTEM_INSTRUCTION},
    ]
    system_blocks.extend({"type": "text", "text": p} for p in system_prompts)

    max_tokens = optional_params.get("max_tokens") or 8192
    payload: dict[str, Any] = {
        "model": resolve_model(model),
        "max_tokens": min(int(max_tokens), MAX_OUTPUT_TOKENS),
        "system": system_blocks,
        "messages": turns,
        "stream": False,
    }

    effort = optional_params.get("reasoning_effort")
    if effort in ("low", "medium", "high"):
        budget = {"low": 2048, "medium": 8192, "high": 16384}[effort]
        # Thinking needs headroom inside max_tokens and forbids sampling knobs.
        payload["max_tokens"] = min(
            max(int(max_tokens), budget + 1024), MAX_OUTPUT_TOKENS
        )
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget}
    else:
        temperature = optional_params.get("temperature")
        if temperature is not None:
            payload["temperature"] = temperature
        top_p = optional_params.get("top_p")
        if top_p is not None:
            payload["top_p"] = top_p
    stop = optional_params.get("stop")
    if stop:
        payload["stop_sequences"] = [stop] if isinstance(stop, str) else list(stop)
    return payload


def serialize(payload: dict[str, Any]) -> bytes:
    """Serialize + attest. Compact separators keep the cch marker anchored."""
    raw = bytearray(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    )
    outcome = patch_cch(raw)
    if outcome == "unanchored":
        logger.warning(
            "claude-code: cch placeholder present but unanchored; sending unattested"
        )
    return bytes(raw)


def build_headers(token: str) -> dict[str, str]:
    """OAuth branch of oh-my-pi's ``buildAnthropicHeaders``."""
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "User-Agent": COWORK_USER_AGENT,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ",".join(COWORK_UTILITY_BETAS),
        "anthropic-dangerous-direct-browser-access": "true",
        "Authorization": f"Bearer {token}",
        "x-app": "cli",
        "x-client-request-id": str(uuid.uuid4()),
    }


def _fill_response(
    model_response: ModelResponse, model: str, data: dict[str, Any]
) -> ModelResponse:
    text = "".join(
        block.get("text", "")
        for block in data.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    )
    stop_reason = data.get("stop_reason")
    finish = {
        "end_turn": "stop",
        "stop_sequence": "stop",
        "max_tokens": "length",
        "refusal": "content_filter",
    }.get(stop_reason or "", "stop")
    model_response.choices = [
        Choices(
            index=0,
            message=Message(role="assistant", content=text),
            finish_reason=finish,
        )
    ]
    model_response.model = f"claude-code/{resolve_model(model)}"
    usage = data.get("usage") or {}
    cache_read = int(usage.get("cache_read_input_tokens") or 0)
    prompt = int(usage.get("input_tokens") or 0) + cache_read
    completion = int(usage.get("output_tokens") or 0)
    model_response.usage = Usage(  # type: ignore[attr-defined]
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
        prompt_tokens_details=PromptTokensDetails(cached_tokens=cache_read),
    )
    return model_response


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code == 200:
        return
    body = resp.text[:500]
    if resp.status_code in (401, 403):
        CLAUDE_CODE_STORE.invalidate()
        raise CliAuthError(
            "Claude Code 인증이 거부되었습니다. `claude login`으로 다시 "
            f"로그인해 주세요. ({resp.status_code}) {body}"
        )
    raise RuntimeError(f"Claude Code request failed ({resp.status_code}): {body}")


class ClaudeCodeLLM(CustomLLM):
    """LiteLLM provider for ``claude-code/<model>``."""

    def completion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        model = kwargs["model"]
        payload = build_payload(model, kwargs["messages"], kwargs.get("optional_params") or {})
        content = serialize(payload)
        headers = build_headers(CLAUDE_CODE_STORE.token())
        with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
            resp = client.post(API_URL, headers=headers, content=content)
        _raise_for_status(resp)
        return _fill_response(kwargs["model_response"], model, resp.json())

    async def acompletion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        model = kwargs["model"]
        payload = build_payload(model, kwargs["messages"], kwargs.get("optional_params") or {})
        content = serialize(payload)
        headers = build_headers(CLAUDE_CODE_STORE.token())
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
            resp = await client.post(API_URL, headers=headers, content=content)
        _raise_for_status(resp)
        return _fill_response(kwargs["model_response"], model, resp.json())
