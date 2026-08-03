"""Gemini CLI (Google Cloud Code Assist) LiteLLM provider.

Ported from oh-my-pi ``packages/ai/src/providers/google-gemini-cli.ts`` —
the ``CloudCodeAssistRequest`` envelope, the Gemini CLI user-agent headers
and the ``streamGenerateContent`` SSE shape.

Talks to ``cloudcode-pa.googleapis.com`` with the OAuth grant the user's own
``gemini`` CLI holds, so a Code Assist entitlement translates modpacks
without an API key.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable

import httpx
from litellm import CustomLLM
from litellm.types.utils import Choices, Message, ModelResponse, PromptTokensDetails, Usage

from .wire import strip_wire_marker
from .credentials import CODE_ASSIST_ENDPOINT, GEMINI_CLI_STORE, CliAuthError, gemini_cli_headers

logger = logging.getLogger(__name__)

API_PATH = "/v1internal:streamGenerateContent?alt=sse"

_MODEL_ALIASES = {
    "default": "gemini-3.1-pro-preview",
    "pro": "gemini-3.1-pro-preview",
    "flash": "gemini-3.5-flash",
    "flash-lite": "gemini-3.1-flash-lite",
}

_FINISH_REASONS = {
    "STOP": "stop",
    "MAX_TOKENS": "length",
    "SAFETY": "content_filter",
    "RECITATION": "content_filter",
    "PROHIBITED_CONTENT": "content_filter",
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
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)
    return "" if content is None else str(content)


def build_payload(
    model: str,
    messages: list[dict[str, Any]],
    optional_params: dict[str, Any],
    project: str,
) -> dict[str, Any]:
    """OpenAI chat messages -> Cloud Code Assist request envelope."""
    system_prompts: list[str] = []
    contents: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        text = _text_of(msg.get("content"))
        if role in ("system", "developer"):
            if text.strip():
                system_prompts.append(text)
        elif role in ("user", "assistant"):
            contents.append(
                {"role": "model" if role == "assistant" else "user", "parts": [{"text": text}]}
            )
    if not contents:
        contents = [
            {"role": "user", "parts": [{"text": system_prompts.pop() if system_prompts else "."}]}
        ]

    generation_config: dict[str, Any] = {}
    temperature = optional_params.get("temperature")
    if temperature is not None:
        generation_config["temperature"] = temperature
    max_tokens = optional_params.get("max_tokens")
    if max_tokens is not None:
        generation_config["maxOutputTokens"] = int(max_tokens)
    top_p = optional_params.get("top_p")
    if top_p is not None:
        generation_config["topP"] = top_p
    # DSPy's JSONAdapter asks for a JSON object; Gemini enforces it natively.
    response_format = optional_params.get("response_format") or {}
    if isinstance(response_format, dict) and response_format.get("type") in (
        "json_object",
        "json_schema",
    ):
        generation_config["responseMimeType"] = "application/json"
    effort = optional_params.get("reasoning_effort")
    if effort in ("low", "medium", "high"):
        generation_config["thinkingConfig"] = {
            "includeThoughts": False,
            "thinkingBudget": {"low": 1024, "medium": 8192, "high": 24576}[effort],
        }

    request: dict[str, Any] = {"contents": contents}
    if system_prompts:
        request["systemInstruction"] = {"parts": [{"text": t} for t in system_prompts]}
    if generation_config:
        request["generationConfig"] = generation_config

    return {"project": project, "model": resolve_model(model), "request": request}


class _StreamState:
    def __init__(self) -> None:
        self.text: list[str] = []
        self.usage: dict[str, Any] = {}
        self.finish = "stop"

    def feed(self, event: dict[str, Any]) -> None:
        response = event.get("response") or event
        for candidate in response.get("candidates") or []:
            if not isinstance(candidate, dict):
                continue
            for part in (candidate.get("content") or {}).get("parts") or []:
                # `thought` parts are reasoning traces, never output text.
                if isinstance(part, dict) and "text" in part and not part.get("thought"):
                    self.text.append(str(part["text"]))
            reason = candidate.get("finishReason")
            if reason:
                self.finish = _FINISH_REASONS.get(reason, "stop")
        usage = response.get("usageMetadata")
        if isinstance(usage, dict):
            self.usage = usage


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
            logger.debug("gemini-cli: unparseable SSE payload: %.120s", data)


def _fill_response(
    model_response: ModelResponse, model: str, state: _StreamState
) -> ModelResponse:
    model_response.choices = [
        Choices(
            index=0,
            message=Message(role="assistant", content="".join(state.text)),
            finish_reason=state.finish,
        )
    ]
    model_response.model = f"gemini-cli/{resolve_model(model)}"
    usage = state.usage or {}
    cached = int(usage.get("cachedContentTokenCount") or 0)
    prompt = int(usage.get("promptTokenCount") or 0)
    thinking = int(usage.get("thoughtsTokenCount") or 0)
    completion = int(usage.get("candidatesTokenCount") or 0) + thinking
    model_response.usage = Usage(  # type: ignore[attr-defined]
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=int(usage.get("totalTokenCount") or (prompt + completion)),
        prompt_tokens_details=PromptTokensDetails(cached_tokens=cached),
    )
    return model_response


def _check_status(status: int, body: str) -> None:
    if status == 200:
        return
    if status in (401, 403):
        GEMINI_CLI_STORE.invalidate()
        raise CliAuthError(
            f"Gemini CLI 인증이 거부되었습니다. `gemini`를 실행해 다시 로그인해 "
            f"주세요. ({status}) {body[:300]}"
        )
    if status == 429:
        raise RuntimeError(f"Gemini CLI 사용량 한도에 도달했습니다. ({status}) {body[:300]}")
    raise RuntimeError(f"Gemini CLI request failed ({status}): {body[:400]}")


class GeminiCliLLM(CustomLLM):
    """LiteLLM provider for ``gemini-cli/<model>``."""

    def completion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        model = kwargs["model"]
        token = GEMINI_CLI_STORE.token()
        project = GEMINI_CLI_STORE.project()
        payload = build_payload(
            model, kwargs["messages"], kwargs.get("optional_params") or {}, project
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            **gemini_cli_headers(resolve_model(model)),
        }
        state = _StreamState()
        url = f"{CODE_ASSIST_ENDPOINT}{API_PATH}"
        with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
            with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    _check_status(resp.status_code, resp.read().decode(errors="replace"))
                parse_sse(resp.iter_lines(), state)
        return _fill_response(kwargs["model_response"], model, state)

    async def acompletion(self, *args: Any, **kwargs: Any) -> ModelResponse:
        model = kwargs["model"]
        token = GEMINI_CLI_STORE.token()
        project = GEMINI_CLI_STORE.project()
        payload = build_payload(
            model, kwargs["messages"], kwargs.get("optional_params") or {}, project
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            **gemini_cli_headers(resolve_model(model)),
        }
        state = _StreamState()
        url = f"{CODE_ASSIST_ENDPOINT}{API_PATH}"
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode(errors="replace")
                    _check_status(resp.status_code, body)
                async for line in resp.aiter_lines():
                    parse_sse([line], state)
        return _fill_response(kwargs["model_response"], model, state)
