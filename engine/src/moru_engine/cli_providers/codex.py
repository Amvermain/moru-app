"""OpenAI Codex (ChatGPT subscription) LiteLLM provider.

Ported from oh-my-pi ``packages/ai/src/providers/openai-codex-responses.ts``
and ``openai-codex/request-transformer.ts``.

Talks to the ChatGPT backend's Responses endpoint with the OAuth grant the
user's own ``codex`` CLI holds, so a Plus/Pro plan translates modpacks
without an API key.

The backend rejects every sampling parameter (``temperature``, ``top_p``,
``max_output_tokens``, ...) with a 400 ``Unsupported parameter``, so the
transformer drops them — see the note in oh-my-pi's ``RequestBody``.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Iterable

import httpx
from litellm import CustomLLM
from litellm.types.utils import Choices, Message, ModelResponse, PromptTokensDetails, Usage

from .wire import strip_wire_marker
from .credentials import CODEX_STORE, CliAuthError

logger = logging.getLogger(__name__)

BASE_URL = "https://chatgpt.com/backend-api"
API_URL = f"{BASE_URL}/codex/responses"

#: Pinned Codex client version (matches the `@openai/codex` release).
CODEX_CLIENT_VERSION = "0.144.1"
#: Originator the real Codex CLI sends. oh-my-pi substitutes its own id here;
#: moru rides the Codex subscription, so it keeps the CLI's value.
ORIGINATOR = "codex_cli_rs"

#: Codex SKU aliases. The GPT-5.6 Codex lineup is luna/terra/sol — there is
#: no "gpt-5.6-codex" or "-codex-mini"; asking for a slug the plan cannot
#: serve fails the whole run with a 400, so prefer `fetch_models()` and keep
#: this map to the three ids the backend actually publishes.
_MODEL_ALIASES = {
    "default": "gpt-5.6-terra",
    "fast": "gpt-5.6-luna",
    "balanced": "gpt-5.6-terra",
    "best": "gpt-5.6-sol",
}


def resolve_model(model: str) -> str:
    """Wire id or CLI alias -> the slug this backend expects."""
    model = strip_wire_marker(model)
    return _MODEL_ALIASES.get(model.strip().lower(), model)


def _text_of(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") in ("text", "input_text", "output_text"):
                parts.append(str(part.get("text", "")))
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)
    return "" if content is None else str(content)


def build_payload(
    model: str, messages: list[dict[str, Any]], optional_params: dict[str, Any]
) -> dict[str, Any]:
    """OpenAI chat messages -> Codex Responses body."""
    instructions: list[str] = []
    items: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        text = _text_of(msg.get("content"))
        if role in ("system", "developer"):
            if text.strip():
                instructions.append(text)
            continue
        if role not in ("user", "assistant"):
            continue
        items.append(
            {
                "type": "message",
                "role": role,
                "content": [
                    {
                        "type": "output_text" if role == "assistant" else "input_text",
                        "text": text,
                    }
                ],
            }
        )

    if not items:
        # Every request needs at least one visible (non-developer) item.
        items = [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": instructions.pop() if instructions else "."}],
            }
        ]

    payload: dict[str, Any] = {
        "model": resolve_model(model),
        "input": items,
        # store/stream are fixed by the transport, not caller options.
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
        "text": {"verbosity": "medium"},
    }
    if instructions:
        payload["instructions"] = instructions[0]
        # Any further system prompts ride as leading developer items.
        extra = [
            {
                "type": "message",
                "role": "developer",
                "content": [{"type": "input_text", "text": text}],
            }
            for text in instructions[1:]
        ]
        if extra:
            payload["input"] = extra + payload["input"]

    # Codex ids are reasoning models; the server defaults to medium effort.
    # Translation batches are latency-bound, so default low and let callers
    # override through reasoning_effort.
    effort = optional_params.get("reasoning_effort")
    payload["reasoning"] = {"effort": effort if effort in ("minimal", "low", "medium", "high") else "low"}
    return payload


def build_headers(token: str, account_id: str | None, session_id: str) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Authorization": f"Bearer {token}",
        "OpenAI-Beta": "responses=experimental",
        "originator": ORIGINATOR,
        "version": CODEX_CLIENT_VERSION,
        "session_id": session_id,
        "conversation_id": session_id,
        "User-Agent": f"codex_cli_rs/{CODEX_CLIENT_VERSION}",
    }
    if account_id:
        headers["chatgpt-account-id"] = account_id
    return headers


class _StreamState:
    """Accumulates text + usage across Responses SSE events."""

    def __init__(self) -> None:
        self.text: list[str] = []
        self.usage: dict[str, Any] = {}
        self.finish = "stop"
        self.error: str | None = None

    def feed(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "response.output_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str):
                self.text.append(delta)
        elif kind in ("response.completed", "response.incomplete"):
            response = event.get("response") or {}
            self.usage = response.get("usage") or {}
            if not self.text:
                self.text.append(_text_from_output(response.get("output")))
            if kind == "response.incomplete":
                self.finish = "length"
        elif kind in ("response.failed", "error"):
            err = event.get("error") or (event.get("response") or {}).get("error") or {}
            self.error = err.get("message") if isinstance(err, dict) else str(err)


def _text_from_output(output: object) -> str:
    if not isinstance(output, list):
        return ""
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for block in item.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "output_text":
                parts.append(str(block.get("text", "")))
    return "".join(parts)


def parse_sse(lines: Iterable[str], state: _StreamState) -> None:
    for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            state.feed(json.loads(data))
        except ValueError:
            logger.debug("codex: unparseable SSE payload: %.120s", data)


def _fill_response(
    model_response: ModelResponse, model: str, state: _StreamState
) -> ModelResponse:
    if state.error:
        raise RuntimeError(f"Codex request failed: {state.error}")
    model_response.choices = [
        Choices(
            index=0,
            message=Message(role="assistant", content="".join(state.text)),
            finish_reason=state.finish,
        )
    ]
    model_response.model = f"codex/{resolve_model(model)}"
    usage = state.usage or {}
    cached = int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0)
    prompt = int(usage.get("input_tokens") or 0)
    completion = int(usage.get("output_tokens") or 0)
    model_response.usage = Usage(  # type: ignore[attr-defined]
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
        prompt_tokens_details=PromptTokensDetails(cached_tokens=cached),
    )
    return model_response


def _check_status(status: int, body: str) -> None:
    if status == 200:
        return
    if status in (401, 403):
        CODEX_STORE.invalidate()
        raise CliAuthError(
            f"Codex 인증이 거부되었습니다. `codex login`으로 다시 로그인해 "
            f"주세요. ({status}) {body[:300]}"
        )
    if status == 429:
        raise RuntimeError(f"Codex 사용량 한도에 도달했습니다. ({status}) {body[:300]}")
    if status == 400 and "not supported" in body:
        # The plan gates which SKUs it may call, so name the fix instead of
        # echoing a bare 400 into a per-chunk failure.
        raise RuntimeError(
            "이 ChatGPT 계정에서 지원하지 않는 Codex 모델입니다. 번역 설정에서 "
            "모델 목록을 새로고침한 뒤 다시 선택해 주세요. "
            f"({status}) {body[:200]}"
        )
    raise RuntimeError(f"Codex request failed ({status}): {body[:400]}")


def _normalize_models(payload: object) -> list[str]:
    """Codex discovery payload -> ordered LiteLLM model ids."""
    if not isinstance(payload, dict):
        return []
    entries = payload.get("models") or payload.get("data") or []
    if not isinstance(entries, list):
        return []
    ranked: list[tuple[float, str]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        slug = entry.get("slug") or entry.get("id")
        if not isinstance(slug, str) or not slug:
            continue
        if str(entry.get("visibility") or "").lower() in ("hide", "hidden"):
            continue
        priority = entry.get("priority")
        rank = float(priority) if isinstance(priority, (int, float)) else float("inf")
        ranked.append((rank, slug))
    ranked.sort(key=lambda item: (item[0], item[1]))
    return [f"codex/{slug}" for _, slug in ranked]


async def fetch_models() -> list[str]:
    """Models this ChatGPT plan may actually call.

    The backend gates SKUs per plan and rejects anything else with a 400
    that kills the whole translate run, so the live list is the only
    authority — a hardcoded guess is how "gpt-5.6-codex-mini" shipped.
    """
    creds = CODEX_STORE.credentials()
    headers = build_headers(creds.access, creds.account_id, str(uuid.uuid4()))
    headers["Accept"] = "application/json"
    params = {"client_version": CODEX_CLIENT_VERSION}
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for path in ("/codex/models", "/models"):
            try:
                resp = await client.get(f"{BASE_URL}{path}", headers=headers, params=params)
            except httpx.HTTPError:
                continue
            if resp.status_code != 200:
                continue
            try:
                models = _normalize_models(resp.json())
            except ValueError:
                continue
            if models:
                return models
    return []


class CodexLLM(CustomLLM):
    """LiteLLM provider for ``codex/<model>``."""

    def completion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        model = kwargs["model"]
        creds = CODEX_STORE.credentials()
        payload = build_payload(model, kwargs["messages"], kwargs.get("optional_params") or {})
        headers = build_headers(creds.access, creds.account_id, str(uuid.uuid4()))
        state = _StreamState()
        with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
            with client.stream("POST", API_URL, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    _check_status(resp.status_code, resp.read().decode(errors="replace"))
                parse_sse(resp.iter_lines(), state)
        return _fill_response(kwargs["model_response"], model, state)

    async def acompletion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        model = kwargs["model"]
        creds = CODEX_STORE.credentials()
        payload = build_payload(model, kwargs["messages"], kwargs.get("optional_params") or {})
        headers = build_headers(creds.access, creds.account_id, str(uuid.uuid4()))
        state = _StreamState()
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
            async with client.stream("POST", API_URL, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode(errors="replace")
                    _check_status(resp.status_code, body)
                async for line in resp.aiter_lines():
                    parse_sse([line], state)
        return _fill_response(kwargs["model_response"], model, state)
