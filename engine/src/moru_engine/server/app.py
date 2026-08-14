"""FastAPI application factory for the Moru engine sidecar.

Electron main spawns ``python -m moru_engine.server --port N --token T``,
polls GET /health, then talks to every other route with the session token
(``Authorization: Bearer <token>``). The server binds 127.0.0.1 only.

Implements moru-app/contracts/engine-api.yaml. Known deviations are
documented inline on each route.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import signal
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from platformdirs import user_config_dir
from pydantic import BaseModel, Field, field_validator
from starlette.websockets import WebSocketDisconnect

from .. import __version__
from ..cli_providers import (
    CLI_PROVIDER_CATALOG,
    CLI_PROVIDER_IDS,
    provider_models,
    provider_status,
)
from ..community import sync_community
from ..dspy_modules import build_lm
from ..pipeline import (
    EntryStatus,
    PipelineResult,
    RetranslateError,
    TranslationPipeline,
)
from ..tm import LocalTM
from .jobs import (
    JobManager,
    JobParamsError,
    JobStateError,
    JobStatus,
    JobType,
    UnknownJobError,
    scan_result_payload,
)
from .live_models import LIVE_MODEL_PROVIDERS, fetch_live_models
from .sessions import SessionStore

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from ..pipeline import EntryResult
    from .jobs import JobRecord

logger = logging.getLogger(__name__)

_LOCALE_RE = re.compile(r"[A-Za-z0-9_-]{1,32}")

#: Static provider catalog. Model ids are LiteLLM strings usable directly
#: as PipelineConfig.model. has_key only reflects env-var presence; the
#: desktop keeps real keys in safeStorage and passes them per-job.
_PROVIDER_CATALOG: tuple[dict[str, Any], ...] = (
    {
        "id": "openai",
        "name": "OpenAI",
        "env": "OPENAI_API_KEY",
        "models": [
            "openai/gpt-5.6-sol",
            "openai/gpt-5.6-terra",
            "openai/gpt-5.6-luna",
            "openai/gpt-4.1",
            "openai/gpt-4.1-mini",
        ],
    },
    {
        "id": "anthropic",
        "name": "Anthropic",
        "env": "ANTHROPIC_API_KEY",
        "models": [
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-haiku-4-5",
            "anthropic/claude-opus-4-8",
        ],
    },
    {
        "id": "gemini",
        "name": "Google Gemini",
        "env": "GEMINI_API_KEY",
        "models": [
            "gemini/gemini-3.1-pro-preview",
            "gemini/gemini-3.5-flash",
            "gemini/gemini-3.1-flash-lite",
        ],
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "env": "DEEPSEEK_API_KEY",
        "models": ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
    },
    {
        "id": "xai",
        "name": "xAI",
        "env": "XAI_API_KEY",
        "models": ["xai/grok-4", "xai/grok-3", "xai/grok-3-mini"],
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "env": "OPENROUTER_API_KEY",
        "models": [
            "openrouter/anthropic/claude-sonnet-4.6",
            "openrouter/anthropic/claude-haiku-4.5",
            "openrouter/openai/gpt-5.6-luna",
            "openrouter/google/gemini-3.5-flash",
            "openrouter/deepseek/deepseek-chat-v3-0324",
        ],
    },
    {
        "id": "ollama",
        "name": "Ollama (local)",
        "env": None,
        "models": [
            "ollama_chat/qwen3:8b",
            "ollama_chat/llama3.1:8b",
            "ollama_chat/gemma3:12b",
        ],
    },
    {
        # Any OpenAI-compatible server: LM Studio, llama.cpp, vLLM, ...
        # No static models — the lineup is whatever the user's server
        # loaded; the desktop lists it live via POST /providers/models
        # with the server's base URL.
        "id": "openai-compatible",
        "name": "OpenAI Compatible",
        "env": None,
        "models": [],
    },
) + CLI_PROVIDER_CATALOG


class JobRequest(BaseModel):
    type: Literal["scan", "translate", "export", "upload"]
    params: dict[str, Any]


class EntryPatch(BaseModel):
    translated_text: str
    #: Disambiguates a key that appears in more than one source file. Older
    #: clients omit it and keep the historical first-match behaviour.
    file: str | None = None


class RetranslateRequest(BaseModel):
    file: str | None = None


class GlossaryTerm(BaseModel):
    source: str
    target: str
    origin: Literal["vanilla", "extracted", "manual", "community"] = "manual"


class GlossaryDoc(BaseModel):
    source_lang: str
    target_lang: str
    terms: list[GlossaryTerm] = Field(default_factory=list)


class CommunitySyncRequest(BaseModel):
    web_url: str
    source_lang: str = "en_us"
    target_lang: str


class ProviderTestRequest(BaseModel):
    provider: str
    api_key: str | None = None
    model: str | None = None
    api_base: str | None = None


class ProviderModelsRequest(BaseModel):
    provider: str
    api_key: str | None = None
    api_base: str | None = None


class SessionExportRequest(BaseModel):
    output_path: str

    @field_validator("output_path")
    @classmethod
    def validate_path(cls, v: str) -> str:
        p = Path(v)
        if not p.is_absolute():
            raise ValueError("output_path must be an absolute path")
        if p.suffix.lower() not in (".moru", ".json"):
            raise ValueError("output_path must end with .moru or .json")
        return v


class SessionImportRequest(BaseModel):
    input_path: str

    @field_validator("input_path")
    @classmethod
    def validate_path(cls, v: str) -> str:
        p = Path(v)
        if not p.is_absolute():
            raise ValueError("input_path must be an absolute path")
        if p.suffix.lower() not in (".moru", ".json"):
            raise ValueError("input_path must end with .moru or .json")
        return v


def _atomic_write_json(path: Path, data: object) -> None:
    """Write JSON via a sibling temp file + os.replace (atomic on POSIX/NTFS)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(tmp, path)


def _read_json(path: Path) -> Any | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.exception("Failed to read %s", path)
        return None


def _validate_locale(value: str, name: str) -> str:
    if not _LOCALE_RE.fullmatch(value):
        raise HTTPException(status_code=422, detail=f"invalid {name}: {value!r}")
    return value.lower()


def _entry_payload(entry: EntryResult) -> dict[str, Any]:
    # Deviation: contract requires translated_text as a plain string, but the
    # engine keeps None for untranslated entries -> coerced to "". The engine
    # also has a "skipped" status the contract enum does not list; it is
    # passed through as-is (only reachable with filter=all).
    return {
        "key": entry.key,
        "file": entry.file,
        "source_text": entry.source_text,
        "translated_text": entry.translated_text or "",
        "status": entry.status.value,
        "errors": list(entry.errors),
    }


def _find_entry(
    result: PipelineResult, key: str, file: str | None = None
) -> EntryResult | None:
    """Locate one review entry; ``file`` splits a key shared by two files."""
    return next(
        (
            e
            for e in result.entries
            if e.key == key and (file is None or e.file == file)
        ),
        None,
    )


def create_app(
    token: str,
    *,
    config_dir: Path | None = None,
    tm_db_path: Path | None = None,
    shutdown_handler: Callable[[], None] | None = None,
    shutdown_delay: float = 0.2,
) -> FastAPI:
    """Build the sidecar app bound to one session token.

    Args:
        token: Session token required on every route except /health.
        config_dir: Override for the platformdirs config root (tests).
        tm_db_path: Override for the local TM database path (tests).
        shutdown_handler: Override for the POST /shutdown action (tests).
        shutdown_delay: Seconds between the 202 response and the shutdown
            action, so the HTTP response can flush first.
    """
    if not token:
        raise ValueError("a non-empty session token is required")

    config_root = config_dir or Path(user_config_dir("moru", "moru"))
    config_path = config_root / "engine.json"
    glossary_dir = config_root / "glossaries"
    session_store = SessionStore(sessions_dir=config_root / "sessions")
    manager = JobManager(glossary_store_dir=glossary_dir, session_store=session_store)
    tm_holder: dict[str, LocalTM] = {}

    def get_tm() -> LocalTM:
        tm = tm_holder.get("tm")
        if tm is None:
            tm = LocalTM(tm_db_path)
            tm_holder["tm"] = tm
        return tm

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await manager.aclose()
        tm = tm_holder.pop("tm", None)
        if tm is not None:
            tm.close()

    app = FastAPI(title="Moru Engine API", version=__version__, lifespan=lifespan)
    # The renderer runs on a foreign origin (file:// in the packaged app,
    # http://localhost:* in dev/browser mode). The server binds loopback and
    # every route still requires the per-session bearer token, so a blanket
    # allow-origin is safe and lets the authorization preflight through.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["authorization", "content-type"],
    )
    app.state.job_manager = manager

    def _token_matches(candidate: str | None) -> bool:
        return candidate is not None and secrets.compare_digest(candidate, token)

    def _bearer_value(header: str | None) -> str | None:
        if header is None:
            return None
        scheme, _, credentials = header.partition(" ")
        if scheme.lower() != "bearer" or not credentials:
            return None
        return credentials.strip()

    async def require_token(request: Request) -> None:
        if not _token_matches(_bearer_value(request.headers.get("authorization"))):
            raise HTTPException(
                status_code=401, detail="invalid or missing bearer token"
            )

    api = APIRouter(dependencies=[Depends(require_token)])

    # -- health / lifecycle ----------------------------------------------------

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    def _default_shutdown() -> None:
        server = getattr(app.state, "uvicorn_server", None)
        if server is not None:
            server.should_exit = True  # graceful uvicorn drain
        else:
            os.kill(os.getpid(), signal.SIGTERM)

    @api.post("/shutdown", status_code=202)
    async def shutdown() -> dict[str, str]:
        handler = shutdown_handler or _default_shutdown
        # Delay lets the 202 response flush before the process starts exiting.
        asyncio.get_running_loop().call_later(shutdown_delay, handler)
        logger.info("Shutdown scheduled in %.1fs", shutdown_delay)
        return {"status": "shutting down"}

    # -- jobs --------------------------------------------------------------------

    @api.post("/jobs", status_code=201)
    async def create_job(body: JobRequest) -> dict[str, Any]:
        try:
            record = manager.create_job(body.type, body.params)
        except UnknownJobError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except JobStateError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except JobParamsError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return record.to_public()

    @api.get("/jobs/{job_id}")
    async def get_job(job_id: str) -> dict[str, Any]:
        try:
            record = manager.get(job_id)
        except UnknownJobError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return record.to_public()

    @api.post("/jobs/{job_id}/cancel", status_code=202)
    async def cancel_job(job_id: str) -> dict[str, Any]:
        try:
            record = manager.cancel(job_id)
        except UnknownJobError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"id": record.id, "status": record.status.value}

    @app.websocket("/jobs/{job_id}/events")
    async def job_events(websocket: WebSocket, job_id: str) -> None:
        # WS auth: ?token= query param OR Authorization header. Closing
        # before accept() rejects the handshake.
        supplied = websocket.query_params.get("token") or _bearer_value(
            websocket.headers.get("authorization")
        )
        if not _token_matches(supplied):
            await websocket.close(code=1008, reason="unauthorized")
            return
        try:
            history, queue = manager.subscribe(job_id)
        except UnknownJobError:
            await websocket.close(code=1008, reason=f"unknown job: {job_id}")
            return
        await websocket.accept()
        try:
            for frame in history:
                await websocket.send_json(frame)
            if queue is not None:
                while True:
                    frame = await queue.get()
                    if frame is None:  # terminal sentinel from JobManager
                        break
                    await websocket.send_json(frame)
            await websocket.close(code=1000)
        except WebSocketDisconnect:
            logger.debug("Events subscriber for %s disconnected", job_id)
        finally:
            if queue is not None:
                manager.unsubscribe(job_id, queue)

    # -- scan / translate results -------------------------------------------------

    def _get_typed_job(job_id: str, expected: JobType) -> JobRecord:
        try:
            record = manager.get(job_id)
        except UnknownJobError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if record.type is not expected:
            raise HTTPException(
                status_code=404,
                detail=f"job {job_id} is {record.type.value}, not {expected.value}",
            )
        return record

    @api.get("/scan/{job_id}/result")
    async def scan_result(job_id: str) -> dict[str, Any]:
        try:
            record = manager.get(job_id)
        except UnknownJobError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        # Translate records carry the payload of the scan they came from, so
        # a session reopened after a sidecar restart can still replay the
        # scan screen. Only a scan job can compute one on demand.
        cached = record.params.get("scan_result")
        if cached:
            return cached
        if record.type is not JobType.SCAN:
            raise HTTPException(
                status_code=404,
                detail=f"job {job_id} is {record.type.value}, not scan",
            )
        if record.status is not JobStatus.DONE or record.result is None:
            raise HTTPException(
                status_code=409,
                detail=f"scan job {job_id} is {record.status.value}, not done",
            )
        payload = scan_result_payload(record.result)  # type: ignore[arg-type]
        record.params["scan_result"] = payload
        return payload

    def _get_pipeline_result(job_id: str) -> tuple[JobRecord, PipelineResult]:
        record = _get_typed_job(job_id, JobType.TRANSLATE)
        result = record.result
        if result is None:
            raise HTTPException(
                status_code=409,
                detail=f"translate job {job_id} is {record.status.value}; "
                "no result available",
            )
        return record, result  # type: ignore[return-value]

    @api.get("/translate/{job_id}/entries")
    async def translate_entries(
        job_id: str,
        filter: Literal["all", "failed", "warning", "modified"] = "all",
        page: int = Query(1, ge=1),
        page_size: int = Query(100, ge=1, le=500),
        search: str = Query("", max_length=200),
    ) -> dict[str, Any]:
        """One page of review entries.

        `search` filters across the WHOLE result set before paginating, so
        the review screen can find an entry that lives on any page — a
        client-side filter would only ever see the 100 rows it fetched.
        """
        _, result = _get_pipeline_result(job_id)
        entries = result.entries
        if filter != "all":
            entries = [e for e in entries if e.status.value == filter]
        needle = search.strip().casefold()
        if needle:
            entries = [
                e
                for e in entries
                if needle in e.key.casefold()
                or needle in (e.source_text or "").casefold()
                or needle in (e.translated_text or "").casefold()
            ]
        start = (page - 1) * page_size
        page_entries = entries[start : start + page_size]
        return {
            "total": len(entries),
            "page": page,
            "entries": [_entry_payload(e) for e in page_entries],
        }

    async def _persist_session(record: JobRecord) -> None:
        """Persist a post-run edit without failing the request that made it.

        Serializing a large session is slow enough to stall the event loop,
        so it runs off-loop, and a disk error must not discard an edit the
        caller already applied in memory.
        """
        try:
            await asyncio.to_thread(
                manager.session_store.save_job_session, record
            )
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            logger.warning("Failed to save session %s: %s", record.id, exc)

    @api.patch("/translate/{job_id}/entries/{entry_key:path}")
    async def patch_entry(
        job_id: str, entry_key: str, body: EntryPatch
    ) -> dict[str, Any]:
        record, result = _get_pipeline_result(job_id)
        entry = _find_entry(result, entry_key, body.file)
        if entry is None:
            raise HTTPException(
                status_code=404, detail=f"unknown entry: {entry_key}"
            )
        entry.translated_text = body.translated_text
        entry.status = EntryStatus.MODIFIED
        await _persist_session(record)
        return _entry_payload(entry)

    @api.post("/translate/{job_id}/entries/{entry_key:path}/retranslate")
    async def retranslate_entry(
        job_id: str, entry_key: str, body: RetranslateRequest | None = None
    ) -> dict[str, Any]:
        """One-entry AI retranslation for the review screen.

        Builds a fresh pipeline from the job's own config (model, api_key,
        locales) and awaits the single LLM round-trip inline - seconds, not
        a job. 422 carries LM/config errors or a failed retranslation of a
        previously passing entry.
        """
        record, result = _get_pipeline_result(job_id)
        if not record.finished:
            raise HTTPException(
                status_code=409,
                detail=f"translate job {job_id} is still running",
            )
        target_file = body.file if body is not None else None
        if _find_entry(result, entry_key, target_file) is None:
            raise HTTPException(
                status_code=404, detail=f"unknown entry: {entry_key}"
            )
        try:
            pipeline = TranslationPipeline(result.config)
        except Exception as exc:  # noqa: BLE001 — bad model/key config
            raise HTTPException(
                status_code=422, detail=f"cannot build translator: {exc}"
            ) from exc
        try:
            entry = await pipeline.retranslate_entry(
                result, entry_key, file=target_file
            )
        except RetranslateError as exc:
            raise HTTPException(
                status_code=422, detail=f"retranslation failed: {exc}"
            ) from exc
        finally:
            pipeline.close()

        await _persist_session(record)
        return _entry_payload(entry)

    # -- sessions -------------------------------------------------------------------

    @api.get("/sessions")
    async def list_sessions() -> list[dict[str, Any]]:
        # Parses every stored payload, so it runs off-loop; a large session
        # store must not stall event delivery for a live job.
        return await asyncio.to_thread(manager.session_store.list_sessions)

    @api.post("/sessions/{session_id}/restore")
    async def restore_session(session_id: str) -> dict[str, Any]:
        try:
            record = manager.get(session_id)
        except UnknownJobError as exc:
            raise HTTPException(
                status_code=404, detail=f"session {session_id} not found"
            ) from exc
        return record.to_public()

    @api.post("/sessions/{session_id}/export")
    async def export_session(
        session_id: str, body: SessionExportRequest
    ) -> dict[str, Any]:
        # Flush in-memory review edits first so the exported file matches
        # the session the user is looking at.
        try:
            record = manager.get(session_id)
        except UnknownJobError:
            pass
        else:
            await _persist_session(record)
        try:
            exported = await asyncio.to_thread(
                manager.session_store.export_session_file,
                session_id,
                Path(body.output_path),
            )
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=404,
                detail=f"session_file_not_found: {session_id}",
            ) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail=f"export failed: {exc}"
            ) from exc
        return {"status": "ok", "path": str(exported)}

    @api.post("/sessions/import")
    async def import_session(body: SessionImportRequest) -> dict[str, Any]:
        try:
            record = await asyncio.to_thread(
                manager.session_store.import_session_file, Path(body.input_path)
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (ValueError, OSError) as exc:
            raise HTTPException(
                status_code=422, detail=f"import failed: {exc}"
            ) from exc
        manager.register_job(record)
        result = record.result if isinstance(record.result, PipelineResult) else None
        summary = manager.session_store.summarize_session(
            {
                "id": record.id,
                "modpack_name": record.params.get("modpack_name", ""),
                "modpack_path": record.params.get("modpack_path", ""),
                "source_locale": record.params.get("source_locale", "en_us"),
                "target_locale": record.params.get("target_locale", "ko_kr"),
                "model": record.params.get("model", ""),
                "status": record.status.value,
                "created_at": record.created_at.isoformat(),
                "entries": (
                    [{"status": e.status.value} for e in result.entries]
                    if result is not None
                    else []
                ),
                "stats": result.stats.model_dump() if result is not None else {},
                "done_payload": record.done_payload,
            }
        )
        return {"status": "ok", "session": summary, "job": record.to_public()}

    @api.delete("/sessions/{session_id}")
    async def delete_session(session_id: str) -> dict[str, str]:
        manager.forget_job(session_id)
        if not manager.session_store.delete_session(session_id):
            raise HTTPException(
                status_code=404, detail=f"session {session_id} not found"
            )
        return {"status": "ok", "id": session_id}

    # -- glossary -------------------------------------------------------------------

    def _glossary_path(source_lang: str, target_lang: str) -> Path:
        source = _validate_locale(source_lang, "source_lang")
        target = _validate_locale(target_lang, "target_lang")
        return glossary_dir / f"{source}_{target}.json"

    @api.get("/glossary")
    async def get_glossary(source_lang: str, target_lang: str) -> dict[str, Any]:
        stored = _read_json(_glossary_path(source_lang, target_lang))
        if isinstance(stored, dict):
            return stored
        return {
            "source_lang": source_lang,
            "target_lang": target_lang,
            "terms": [],
        }

    @api.put("/glossary")
    async def put_glossary(body: GlossaryDoc) -> dict[str, Any]:
        path = _glossary_path(body.source_lang, body.target_lang)
        data = body.model_dump()
        _atomic_write_json(path, data)
        return data

    # -- tm / community / providers / config --------------------------------------------

    @api.post("/community/sync")
    async def community_sync(body: CommunitySyncRequest) -> dict[str, Any]:
        """Pull the latest community TM/glossary snapshots from the web
        platform into the local TM and the user glossary store."""
        source = _validate_locale(body.source_lang, "source_lang")
        target = _validate_locale(body.target_lang, "target_lang")
        try:
            return await sync_community(
                body.web_url, source, target, get_tm(), glossary_dir
            )
        except Exception as exc:  # noqa: BLE001 — network/payload errors -> 502
            raise HTTPException(
                status_code=502, detail=f"community sync failed: {exc}"
            ) from exc

    @api.get("/tm/stats")
    async def tm_stats() -> dict[str, Any]:
        # Deviation: LocalTM does not count lookup hits yet -> hits is
        # always 0. by_origin is an additive extra for the GUI.
        stats = get_tm().stats()
        return {
            "entries": stats.total_entries,
            "hits": 0,
            "last_sync_version": stats.last_shared_version,
            "by_origin": stats.by_origin,
        }

    @api.get("/providers")
    async def providers() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for p in _PROVIDER_CATALOG:
            entry: dict[str, Any] = {
                "id": p["id"],
                "name": p["name"],
                "models": list(p["models"]),
                "has_key": p["env"] is None or bool(os.environ.get(p["env"])),
            }
            if p["id"] in CLI_PROVIDER_IDS:
                # No API key exists for these: "ready" means the user's own
                # CLI is logged in and its grant is readable.
                status = await asyncio.to_thread(provider_status, p["id"])
                entry["auth"] = "cli"
                entry["has_key"] = bool(status.get("connected"))
                entry["connected"] = bool(status.get("connected"))
                entry["login_hint"] = status.get("login_hint")
                entry["account"] = status.get("email")
            out.append(entry)
        return out

    @api.post("/providers/test")
    async def providers_test(body: ProviderTestRequest) -> dict[str, Any]:
        catalog = {p["id"]: p for p in _PROVIDER_CATALOG}
        model = body.model
        if model is None:
            entry = catalog.get(body.provider)
            if entry is None or not entry["models"]:
                return {
                    "ok": False,
                    "error": f"no default model for provider: {body.provider}"
                    " (pass a model)",
                }
            model = entry["models"][0]

        def probe() -> None:
            # Minimal 1-token completion; cache off so a cached success can
            # never mask a revoked key.
            lm = build_lm(
                model,
                api_key=body.api_key,
                api_base=body.api_base,
                max_tokens=1,
                cache=False,
            )
            lm("ping")

        try:
            await asyncio.to_thread(probe)
        except Exception as exc:
            logger.info("Provider test failed for %s: %s", body.provider, exc)
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "error": None}

    @api.post("/providers/models")
    async def providers_models(body: ProviderModelsRequest) -> dict[str, Any]:
        """Live model list for one provider, static catalog as fallback."""
        catalog = {p["id"]: p for p in _PROVIDER_CATALOG}
        entry = catalog.get(body.provider)
        if entry is None:
            raise HTTPException(
                status_code=404, detail=f"unknown provider: {body.provider}"
            )
        # Desktop-saved key wins; otherwise fall back to the engine's env var
        # (matches has_key in GET /providers).
        env_name = entry["env"]
        if body.provider in CLI_PROVIDER_IDS and body.provider not in LIVE_MODEL_PROVIDERS:
            # Subscription surfaces with no /models endpoint to enumerate,
            # so the catalog is authoritative. Codex does publish one and
            # gates SKUs per plan, so it goes down the live path below.
            return {
                "provider": body.provider,
                "models": provider_models(body.provider),
                "source": "static",
                "error": None,
            }
        api_key = body.api_key or (os.environ.get(env_name) if env_name else None)
        try:
            models = await fetch_live_models(
                body.provider, api_key=api_key, api_base=body.api_base
            )
        except Exception as exc:
            logger.info("Live model fetch failed for %s: %s", body.provider, exc)
            return {
                "provider": body.provider,
                "models": list(entry["models"]),
                "source": "static",
                "error": str(exc),
            }
        if not models:
            return {
                "provider": body.provider,
                "models": list(entry["models"]),
                "source": "static",
                "error": "provider returned no models",
            }
        return {
            "provider": body.provider,
            "models": models,
            "source": "live",
            "error": None,
        }

    @api.get("/config")
    async def get_config() -> dict[str, Any]:
        stored = _read_json(config_path)
        return stored if isinstance(stored, dict) else {}

    @api.put("/config")
    async def put_config(body: dict[str, Any]) -> dict[str, Any]:
        _atomic_write_json(config_path, body)
        return body

    app.include_router(api)
    return app
