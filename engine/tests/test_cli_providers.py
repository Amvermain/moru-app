"""Coding-CLI provider tests.

The wire details here are ported from oh-my-pi, so the assertions pin the
behaviour that a real Claude Code / Codex / Gemini CLI client produces —
notably the ``cch`` attestation, whose golden vector was cross-checked
against the original Bun implementation (``Bun.hash.xxHash64``).
"""

from __future__ import annotations

import json

import pytest

from moru_engine.cli_providers import claude_code, codex, credentials, gemini_cli

# --------------------------------------------------------------------------
# Claude Code — billing header + cch attestation
# --------------------------------------------------------------------------

FIRST_USER = "Translate these Minecraft modpack strings into Korean."

#: Produced by the oh-my-pi TypeScript implementation for the payload built
#: in `_golden_payload`. Any drift here means the port diverged.
GOLDEN_BILLING = (
    "x-anthropic-billing-header: cc_version=2.1.220.3a0; "
    "cc_entrypoint=claude-desktop; cch=00000;"
)
GOLDEN_CCH = "ad4c2"


def _golden_payload() -> dict[str, object]:
    return {
        "model": "claude-sonnet-4-6",
        "max_tokens": 8192,
        "system": [
            {"type": "text", "text": claude_code.create_billing_header(FIRST_USER)},
            {"type": "text", "text": claude_code.CLAUDE_CODE_SYSTEM_INSTRUCTION},
            {"type": "text", "text": "너는 마인크래프트 번역가다."},
        ],
        "messages": [{"role": "user", "content": FIRST_USER}],
        "stream": False,
    }


def test_billing_header_matches_claude_code_fingerprint() -> None:
    assert claude_code.create_billing_header(FIRST_USER) == GOLDEN_BILLING


def test_billing_header_pads_short_messages() -> None:
    # Fingerprint reads msg[4], msg[7], msg[20]; missing chars become "0".
    short = claude_code.create_billing_header("hi")
    assert short.startswith("x-anthropic-billing-header: cc_version=2.1.220.")
    assert short != GOLDEN_BILLING


def test_cch_attestation_matches_bun_reference() -> None:
    body = bytearray(
        json.dumps(_golden_payload(), ensure_ascii=False, separators=(",", ":")).encode()
    )
    assert claude_code.patch_cch(body) == "patched"
    assert f"cch={GOLDEN_CCH}".encode() in bytes(body)
    # The hash covers the body with the placeholder still in place, so the
    # patched bytes must differ from a re-hash of themselves.
    assert b"cch=00000" not in bytes(body)


def test_cch_skips_bodies_without_a_billing_header() -> None:
    body = bytearray(b'{"system":[{"type":"text","text":"plain"}]}')
    assert claude_code.patch_cch(body) == "no-billing-header"


def test_cch_reports_unanchored_placeholder() -> None:
    # Placeholder present but pushed beyond the search window after the marker.
    filler = "x" * 300
    body = bytearray(
        f'{{"system":[{{"type":"text","text":"x-anthropic-billing-header:{filler}cch=00000"}}]}}'.encode()
    )
    assert claude_code.patch_cch(body) == "unanchored"


def test_serialize_is_compact_so_the_marker_anchors() -> None:
    raw = claude_code.serialize(_golden_payload())
    # Pretty-printed JSON would break the byte marker the attestation needs.
    assert b'"system":[{"type":"text","text":"x-anthropic-billing-header:' in raw
    assert f"cch={GOLDEN_CCH}".encode() in raw


# --------------------------------------------------------------------------
# Claude Code — payload shape
# --------------------------------------------------------------------------


def test_claude_payload_puts_identity_block_before_user_system_prompts() -> None:
    payload = claude_code.build_payload(
        "sonnet",
        [
            {"role": "system", "content": "번역가 지침"},
            {"role": "user", "content": "hello"},
        ],
        {"max_tokens": 1024, "temperature": 0.3},
    )
    texts = [block["text"] for block in payload["system"]]
    assert texts[0].startswith("x-anthropic-billing-header:")
    assert texts[1] == claude_code.CLAUDE_CODE_SYSTEM_INSTRUCTION
    assert texts[2] == "번역가 지침"
    assert payload["model"] == "claude-sonnet-4-6"  # alias resolved
    assert payload["messages"] == [{"role": "user", "content": "hello"}]
    assert payload["temperature"] == 0.3


def test_claude_payload_opens_on_a_user_turn() -> None:
    payload = claude_code.build_payload(
        "claude-haiku-4-5", [{"role": "assistant", "content": "prior"}], {}
    )
    assert payload["messages"][0]["role"] == "user"


def test_claude_thinking_drops_sampling_and_reserves_budget() -> None:
    payload = claude_code.build_payload(
        "sonnet",
        [{"role": "user", "content": "hi"}],
        {"max_tokens": 2048, "temperature": 0.7, "reasoning_effort": "medium"},
    )
    assert payload["thinking"] == {"type": "enabled", "budget_tokens": 8192}
    # Anthropic rejects temperature alongside extended thinking.
    assert "temperature" not in payload
    assert payload["max_tokens"] > payload["thinking"]["budget_tokens"]


def test_claude_headers_carry_the_oauth_fingerprint() -> None:
    headers = claude_code.build_headers("tok-123")
    assert headers["Authorization"] == "Bearer tok-123"
    assert headers["User-Agent"] == claude_code.COWORK_USER_AGENT
    assert headers["x-app"] == "cli"
    assert headers["anthropic-version"] == "2023-06-01"
    assert "structured-outputs-2025-12-15" in headers["anthropic-beta"]


# --------------------------------------------------------------------------
# Codex
# --------------------------------------------------------------------------


def test_codex_payload_omits_every_sampling_parameter() -> None:
    payload = codex.build_payload(
        "gpt-5.6-terra",
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
        ],
        {"temperature": 0.3, "max_tokens": 4096, "top_p": 0.9},
    )
    # The ChatGPT backend 400s on any of these.
    for forbidden in ("temperature", "top_p", "max_output_tokens", "max_completion_tokens"):
        assert forbidden not in payload
    assert payload["store"] is False
    assert payload["stream"] is True
    assert payload["instructions"] == "sys"
    assert payload["input"][0]["content"][0]["type"] == "input_text"


def test_codex_defaults_to_low_reasoning_and_honors_overrides() -> None:
    base = codex.build_payload("gpt-5.6-terra", [{"role": "user", "content": "x"}], {})
    assert base["reasoning"] == {"effort": "low"}
    high = codex.build_payload(
        "gpt-5.6-terra", [{"role": "user", "content": "x"}], {"reasoning_effort": "high"}
    )
    assert high["reasoning"] == {"effort": "high"}


def test_codex_extra_system_prompts_become_developer_items() -> None:
    payload = codex.build_payload(
        "default",
        [
            {"role": "system", "content": "first"},
            {"role": "system", "content": "second"},
            {"role": "user", "content": "hi"},
        ],
        {},
    )
    assert payload["instructions"] == "first"
    assert payload["input"][0]["role"] == "developer"
    assert payload["input"][0]["content"][0]["text"] == "second"
    assert payload["model"] == "gpt-5.6-terra"  # alias resolved


def test_codex_aliases_resolve_to_real_gpt56_skus() -> None:
    """The GPT-5.6 Codex lineup is luna/terra/sol.

    Shipping an invented slug ("gpt-5.6-codex-mini") made the backend 400
    every chunk with "model is not supported"; pin the real ids.
    """
    assert {codex.resolve_model(a) for a in ("default", "fast", "balanced", "best")} == {
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
    }
    # An unknown alias must pass through untouched, never silently remap.
    assert codex.resolve_model("gpt-5.1-codex") == "gpt-5.1-codex"


def test_codex_discovery_orders_by_priority_and_drops_hidden() -> None:
    models = codex._normalize_models(
        {
            "models": [
                {"slug": "gpt-5.6-sol", "priority": 3},
                {"slug": "gpt-5.6-luna", "priority": 1},
                {"slug": "internal-preview", "priority": 0, "visibility": "hidden"},
                {"id": "gpt-5.6-terra", "priority": 2},
                {"display_name": "no slug at all"},
            ]
        }
    )
    assert models == [
        "codex/gpt-5.6-luna",
        "codex/gpt-5.6-terra",
        "codex/gpt-5.6-sol",
    ]


def test_codex_discovery_accepts_the_data_envelope() -> None:
    assert codex._normalize_models({"data": [{"slug": "gpt-5.6-luna"}]}) == [
        "codex/gpt-5.6-luna"
    ]
    assert codex._normalize_models({}) == []
    assert codex._normalize_models("nope") == []


def test_codex_unsupported_model_error_names_the_fix() -> None:
    body = (
        '{"detail":"The \'gpt-5.6-codex-mini\' model is not supported when '
        'using Codex with a ChatGPT account."}'
    )
    with pytest.raises(RuntimeError) as excinfo:
        codex._check_status(400, body)
    message = str(excinfo.value)
    assert "모델 목록을 새로고침" in message
    assert not isinstance(excinfo.value, credentials.CliAuthError)


def test_codex_stream_state_collects_text_and_usage() -> None:
    state = codex._StreamState()
    codex.parse_sse(
        [
            'data: {"type":"response.output_text.delta","delta":"안녕"}',
            'data: {"type":"response.output_text.delta","delta":"하세요"}',
            'data: {"type":"response.completed","response":{"usage":'
            '{"input_tokens":120,"output_tokens":8,"input_tokens_details":{"cached_tokens":100}}}}',
            "data: [DONE]",
        ],
        state,
    )
    assert "".join(state.text) == "안녕하세요"
    assert state.usage["input_tokens"] == 120


def test_codex_falls_back_to_final_output_when_no_deltas_streamed() -> None:
    state = codex._StreamState()
    codex.parse_sse(
        [
            'data: {"type":"response.completed","response":{"output":'
            '[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{}}}'
        ],
        state,
    )
    assert "".join(state.text) == "done"


def test_codex_surfaces_stream_errors() -> None:
    state = codex._StreamState()
    codex.parse_sse(['data: {"type":"response.failed","error":{"message":"quota"}}'], state)
    assert state.error == "quota"


# --------------------------------------------------------------------------
# Gemini CLI
# --------------------------------------------------------------------------


def test_gemini_payload_wraps_in_the_code_assist_envelope() -> None:
    payload = gemini_cli.build_payload(
        "flash",
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "prior"},
        ],
        {"temperature": 0.3, "max_tokens": 2048},
        "my-project",
    )
    assert payload["project"] == "my-project"
    assert payload["model"] == "gemini-3.5-flash"  # alias resolved
    request = payload["request"]
    assert request["systemInstruction"] == {"parts": [{"text": "sys"}]}
    assert request["contents"][0] == {"role": "user", "parts": [{"text": "hi"}]}
    # OpenAI's "assistant" is Gemini's "model".
    assert request["contents"][1]["role"] == "model"
    assert request["generationConfig"]["maxOutputTokens"] == 2048


def test_gemini_maps_json_response_format_to_mime_type() -> None:
    payload = gemini_cli.build_payload(
        "flash",
        [{"role": "user", "content": "hi"}],
        {"response_format": {"type": "json_object"}},
        "p",
    )
    assert payload["request"]["generationConfig"]["responseMimeType"] == "application/json"


def test_gemini_stream_state_skips_thought_parts() -> None:
    state = gemini_cli._StreamState()
    gemini_cli.parse_sse(
        [
            'data: {"response":{"candidates":[{"content":{"parts":['
            '{"text":"reasoning","thought":true},{"text":"answer"}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}],'
            '"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":3,'
            '"cachedContentTokenCount":10,"totalTokenCount":53}}}',
        ],
        state,
    )
    assert "".join(state.text) == "answer"
    assert state.finish == "stop"
    assert state.usage["promptTokenCount"] == 50


def test_gemini_cli_headers_identify_as_the_real_cli() -> None:
    headers = gemini_cli.gemini_cli_headers("gemini-3.5-flash")
    assert headers["User-Agent"].startswith("GeminiCLI/")
    assert "gemini-3.5-flash" in headers["User-Agent"]
    assert headers["Client-Metadata"].startswith("ideType=")


# --------------------------------------------------------------------------
# Credential stores
# --------------------------------------------------------------------------


@pytest.fixture
def claude_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    return tmp_path


def test_claude_store_reports_disconnected_without_a_file(claude_home) -> None:
    store = credentials.ClaudeCodeStore()
    assert store.available() is False
    assert store.status()["connected"] is False


def test_claude_store_ignores_a_logged_out_credential(claude_home) -> None:
    (claude_home / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": {"accessToken": "", "refreshToken": "", "expiresAt": 0}})
    )
    assert credentials.ClaudeCodeStore().available() is False


def test_claude_store_refreshes_and_writes_back_preserving_other_keys(
    claude_home, monkeypatch
) -> None:
    path = claude_home / ".credentials.json"
    path.write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": "old-access",
                    "refreshToken": "old-refresh",
                    "expiresAt": 1,  # long expired
                    "subscriptionType": "max",
                },
                # Unrelated block the CLI owns; a write must not drop it.
                "mcpOAuth": {"figma": {"accessToken": "keep-me"}},
            }
        )
    )
    store = credentials.ClaudeCodeStore()
    monkeypatch.setattr(
        store,
        "_post_json",
        lambda *a, **kw: {
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 3600,
            "account": {"uuid": "acc-1", "email_address": "me@example.com"},
        },
    )

    creds = store.credentials()
    assert creds.access == "new-access"
    assert creds.email == "me@example.com"

    written = json.loads(path.read_text())
    assert written["claudeAiOauth"]["accessToken"] == "new-access"
    assert written["claudeAiOauth"]["refreshToken"] == "new-refresh"
    # Rotation must not clobber the CLI's own unrelated state.
    assert written["mcpOAuth"]["figma"]["accessToken"] == "keep-me"
    assert written["claudeAiOauth"]["subscriptionType"] == "max"


def test_claude_store_keeps_a_live_token_untouched(claude_home, monkeypatch) -> None:
    path = claude_home / ".credentials.json"
    path.write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": "live",
                    "refreshToken": "r",
                    "expiresAt": credentials._now_ms() + 60 * 60 * 1000,
                }
            }
        )
    )
    store = credentials.ClaudeCodeStore()

    def _boom(*a, **kw):
        raise AssertionError("must not refresh a live token")

    monkeypatch.setattr(store, "_post_json", _boom)
    assert store.token() == "live"


def test_credentials_are_stale_inside_the_refresh_skew() -> None:
    inside = credentials.OAuthCredentials(
        access="a", refresh="r", expires=credentials._now_ms() + 60_000
    )
    assert inside.stale() is True
    outside = credentials.OAuthCredentials(
        access="a", refresh="r", expires=credentials._now_ms() + 30 * 60_000
    )
    assert outside.stale() is False
    # Unknown expiry must not trigger a refresh on every call.
    assert credentials.OAuthCredentials(access="a", refresh="r", expires=0).stale() is False


def test_codex_store_reads_tokens_and_jwt_claims(tmp_path, monkeypatch) -> None:
    import base64

    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    claims = {
        "exp": 2_000_000_000,
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct-9"},
        "https://api.openai.com/profile": {"email": "me@example.com"},
    }
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    (tmp_path / "auth.json").write_text(
        json.dumps(
            {
                "OPENAI_API_KEY": None,
                "auth_mode": "chatgpt",
                "tokens": {"access_token": f"h.{body}.s", "refresh_token": "r"},
            }
        )
    )
    creds = credentials.CodexStore().credentials()
    assert creds.account_id == "acct-9"
    assert creds.email == "me@example.com"
    assert creds.expires == 2_000_000_000 * 1000


def test_missing_credentials_raise_an_actionable_error(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    with pytest.raises(credentials.CliAuthError) as excinfo:
        credentials.CodexStore().credentials()
    assert "codex login" in str(excinfo.value)


# --------------------------------------------------------------------------
# LiteLLM routing
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "expected_provider", "expected_model"),
    [
        ("claude-code/claude-sonnet-4-6", "claude-code", "claude-sonnet-4-6"),
        ("codex/gpt-5.6-luna", "codex", "gpt-5.6-luna"),
        ("gemini-cli/gemini-3.5-flash", "gemini-cli", "gemini-3.5-flash"),
    ],
)
def test_models_route_to_the_cli_handler_without_a_prior_sync_call(
    model: str, expected_provider: str, expected_model: str
) -> None:
    """Registration must reach LiteLLM's provider_list, not just the map.

    LiteLLM folds custom_provider_map into provider_list inside
    custom_llm_setup(), which only its SYNC wrapper calls. acompletion
    resolves the provider before that, so an unregistered prefix fell
    through to name heuristics: "codex/gpt-5.6-luna" went to OpenAI and
    failed with "Missing credentials ... OPENAI_API_KEY". The engine
    translates over the async path, so this is the path that matters.
    """
    from litellm.litellm_core_utils.get_llm_provider_logic import get_llm_provider

    from moru_engine.cli_providers import to_wire_model

    resolved_model, provider, _, _ = get_llm_provider(model=to_wire_model(model))
    assert provider == expected_provider
    # The handler strips the wire marker back off before calling the API.
    assert resolved_model.endswith(expected_model)


def test_cli_providers_are_registered_in_litellms_provider_list() -> None:
    import litellm

    for provider in ("claude-code", "codex", "gemini-cli"):
        assert provider in litellm.provider_list
        assert provider in litellm._custom_providers


def test_wire_marker_keeps_codex_out_of_litellms_openai_table() -> None:
    """Codex SKUs share OpenAI's model names, and LiteLLM dispatches on those.

    `completion()` tests `model in litellm.open_ai_chat_completion_models`
    BEFORE it consults custom_provider_map, so a bare "codex/gpt-5.6-luna"
    was handed to the OpenAI client and died on a missing OPENAI_API_KEY.
    """
    import litellm

    from moru_engine.cli_providers import to_wire_model

    # Precondition: these really are OpenAI names, so the hazard is real.
    assert "gpt-5.6-luna" in litellm.open_ai_chat_completion_models

    wire = to_wire_model("codex/gpt-5.6-luna")
    assert wire == "codex/@/gpt-5.6-luna"
    bare = wire.split("/", 1)[1]
    assert bare not in litellm.open_ai_chat_completion_models

    # Round-trips to the slug the backend expects.
    assert codex.resolve_model(bare) == "gpt-5.6-luna"


def test_to_wire_model_leaves_non_cli_models_alone() -> None:
    from moru_engine.cli_providers import to_wire_model

    for untouched in ("openai/gpt-5.6-luna", "ollama_chat/qwen3:8b", "gpt-4.1", ""):
        assert to_wire_model(untouched) == untouched
    # Idempotent: re-wrapping an already-wired id must not double the marker.
    assert to_wire_model("codex/@/gpt-5.6-luna") == "codex/@/gpt-5.6-luna"


def test_every_catalogued_cli_model_survives_the_wire_round_trip() -> None:
    """No catalog entry may resolve to a name LiteLLM would hijack."""
    import litellm

    from moru_engine.cli_providers import CLI_PROVIDER_CATALOG, to_wire_model

    resolvers = {
        "claude-code": claude_code.resolve_model,
        "codex": codex.resolve_model,
        "gemini-cli": gemini_cli.resolve_model,
    }
    for entry in CLI_PROVIDER_CATALOG:
        for public in entry["models"]:
            bare = to_wire_model(public).split("/", 1)[1]
            assert bare not in litellm.open_ai_chat_completion_models, public
            assert resolvers[entry["id"]](bare) == public.split("/", 1)[1]
