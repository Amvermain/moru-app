"""Async job manager backing the sidecar's /jobs API.

The desktop GUI starts long-running work (scan / translate / export)
through ``POST /jobs`` and follows it over a WebSocket. Every job keeps a
full event history, so a subscriber that connects after events already
fired first replays the past, then streams live frames.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any

from platformdirs import user_data_dir
from pydantic import ValidationError

from .. import __version__
from ..handlers.base import create_default_registry
from ..output import (
    OVERRIDES_DIRNAME,
    RESOURCEPACK_DIRNAME,
    create_zip_from_directory,
)
from ..pipeline import (
    PipelineConfig,
    PipelineResult,
    apply_entry_edits,
    output_root,
    run_pipeline,
)
from ..scanner import ScanResult, scan_modpack
from ..scanner.pack_identity import PackIdentity, detect_pack_identity
from . import upload

if TYPE_CHECKING:
    from collections.abc import Coroutine, Mapping
    from ..models import LanguageFilePair
    from .sessions import SessionStore

logger = logging.getLogger(__name__)

#: Concurrent handler.extract() calls during the scan parse pass.
PARSE_CONCURRENCY = 8
#: Sample entries included per file in the enriched scan payload.
SAMPLE_ENTRIES = 3
#: Sample values are truncated to this many characters.
SAMPLE_TEXT_LIMIT = 160

#: Upper bound on files folded into the cached-scan staleness signal, so a
#: pathological tree cannot make the freshness check cost more than a scan.
_SCAN_SIGNATURE_MAX_ENTRIES = 200_000
#: Enriched scan results retained per process before FIFO eviction. Each one
#: holds per-file entry samples, so this is a memory bound, not a hit-rate knob.
SCAN_CACHE_LIMIT = 20


@dataclass
class FileParseMeta:
    """Per-source-file untranslated volumes from the scan parse pass."""

    entry_count: int = 0
    char_count: int = 0
    sample: dict[str, str] = field(default_factory=dict)
    parsed: bool = False


@dataclass
class EnrichedScanResult:
    """Scan discovery plus parsed entry volumes (desktop scan-result screen).

    ``files`` is keyed by ``str(pair.source_path)``; files whose handler
    failed to parse stay at zero counts rather than failing the scan.
    ``identity`` is the launcher-metadata match used to prefill the
    upload form (contracts/engine-api.yaml ScanResult.identity).
    """

    scan: ScanResult
    identity: PackIdentity | None = None
    files: dict[str, FileParseMeta] = field(default_factory=dict)


def scan_result_payload(enriched: EnrichedScanResult) -> dict[str, Any]:
    """Contract ScanResult: translatable source files grouped by category.

    Groups the scanner's translation *pairs* (actual translation units), so
    target-locale files never show up as separate rows. Volumes come from
    the scan job's parse pass; a file the parse pass could not read keeps
    zero counts.
    """
    scan = enriched.scan
    category_by_path = {
        str(Path(tf.input_path)): (tf.category or tf.file_type, tf.file_type)
        for tf in scan.translation_files
    }
    groups: dict[tuple[str, str], list[tuple[str, FileParseMeta]]] = {}
    for pair in scan.all_translation_pairs:
        path = str(pair.source_path)
        name, handler = category_by_path.get(path, ("", ""))
        if not name:
            name, handler = "Other", "other"
        meta = enriched.files.get(path) or FileParseMeta()
        # Successfully parsed files with no untranslated entries are already
        # complete in the target locale and should not inflate scan totals.
        if meta.parsed and meta.entry_count == 0:
            continue
        groups.setdefault((name, handler), []).append((path, meta))
    categories = [
        {
            "name": name,
            "handler": handler,
            "file_count": len(files),
            "entry_count": sum(m.entry_count for _, m in files),
            "char_count": sum(m.char_count for _, m in files),
            "files": [
                {
                    "path": path,
                    "entry_count": meta.entry_count,
                    "char_count": meta.char_count,
                    "sample": meta.sample,
                }
                for path, meta in files
            ],
        }
        for (name, handler), files in sorted(groups.items())
    ]
    return {
        "modpack_path": str(scan.modpack_path),
        "categories": categories,
        # Launcher-metadata identity for upload prefill / CurseForge linking;
        # always present (folder-name fallback), null only for legacy records.
        "identity": asdict(enriched.identity) if enriched.identity else None,
    }


#: Event types that end a job's stream; the manager emits exactly one of
#: these as the final frame of every job.
TERMINAL_EVENT_TYPES = frozenset({"done", "failed", "cancelled"})


class JobError(Exception):
    """Base class for job-manager errors mapped to HTTP responses."""


class UnknownJobError(JobError):
    """Referenced job id does not exist (HTTP 404)."""


class JobStateError(JobError):
    """Job exists but is in the wrong state for the operation (HTTP 409)."""


class JobParamsError(JobError):
    """Job parameters failed validation (HTTP 422)."""


class JobType(str, Enum):
    SCAN = "scan"
    TRANSLATE = "translate"
    EXPORT = "export"
    UPLOAD = "upload"


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class JobRecord:
    """One job: contract-facing fields plus execution internals."""

    id: str
    type: JobType
    params: dict[str, Any]
    status: JobStatus = JobStatus.PENDING
    error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    #: Stored outcome: EnrichedScanResult (scan), PipelineResult (translate),
    #: dict with zip metadata (export). Preserved on cancellation.
    result: object | None = None
    #: Extra payload merged into the terminal ``done`` frame (e.g. pipeline
    #: stats, export zip path).
    done_payload: dict[str, Any] | None = None

    cancel_requested: bool = False
    finished: bool = False
    history: list[dict[str, Any]] = field(default_factory=list)
    subscribers: set[asyncio.Queue[dict[str, Any] | None]] = field(
        default_factory=set
    )
    task: asyncio.Task[None] | None = None

    def to_public(self) -> dict[str, Any]:
        """Contract ``Job`` schema representation."""
        return {
            "id": self.id,
            "type": self.type.value,
            "status": self.status.value,
            "error": self.error,
            "created_at": self.created_at.isoformat(),
        }


def _default_export_dir() -> Path:
    return Path(user_data_dir("moru", "moru")) / "exports"


_FILENAME_UNSAFE_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def _export_stem(result: PipelineResult, identity: PackIdentity) -> str:
    """Filename stem for the export zips.

    The resource-pack UI titles a zip pack by its filename, so
    "All the Mods 10 2.32 한국어 (moru)" beats a job UUID.
    """
    locale = result.config.target_locale
    parts = [
        identity.name or result.config.modpack_path.name,
        identity.version,
        "한국어" if locale == "ko_kr" else locale,
        "(moru)",
    ]
    stem = _FILENAME_UNSAFE_RE.sub(" ", " ".join(p for p in parts if p))
    return " ".join(stem.split()) or "moru-pack"


def _tree_has_files(tree: Path) -> bool:
    """True when the output tree exists and holds at least one file."""
    return tree.is_dir() and any(p.is_file() for p in tree.rglob("*"))


def _sha256_and_size(path: Path) -> tuple[str, int]:
    """Streaming digest for one archive: (hex sha256, byte size)."""
    sha = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha.update(chunk)
    return sha.hexdigest(), path.stat().st_size


class JobManager:
    """Creates, runs, cancels, and streams jobs on the server event loop."""

    def __init__(
        self,
        glossary_store_dir: Path | None = None,
        session_store: SessionStore | None = None,
    ) -> None:
        self._jobs: dict[str, JobRecord] = {}
        #: Enriched scan results keyed by pack path, locales, and a cheap
        #: tree signature, so an edited pack rescans instead of replaying
        #: stale counts into the cost estimate.
        self._scan_cache: dict[str, EnrichedScanResult] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        #: Injected by the app so pipeline runs read the same user glossary
        #: store (hub manual terms + synced community terms) the HTTP
        #: endpoints write.
        self._glossary_store_dir = glossary_store_dir
        if session_store is None:
            # Deferred: sessions imports JobRecord/JobStatus/JobType from here.
            from .sessions import SessionStore as _SessionStore

            session_store = _SessionStore()
        self._session_store: SessionStore = session_store

    @property
    def session_store(self) -> SessionStore:
        """Persistent session store backing restore/export/import."""
        return self._session_store

    # -- lookup --------------------------------------------------------------

    def get(self, job_id: str) -> JobRecord:
        """In-memory job, else one restored from its persisted session file."""
        if job_id in self._jobs:
            return self._jobs[job_id]
        restored = self._session_store.load_job_session(job_id)
        if restored is not None:
            self._jobs[job_id] = restored
            return restored
        raise UnknownJobError(f"unknown job: {job_id}")

    def register_job(self, record: JobRecord) -> None:
        """Adopt a record built outside the manager (session import)."""
        self._jobs[record.id] = record

    def forget_job(self, job_id: str) -> None:
        """Drop a record from memory; its session file is left alone."""
        self._jobs.pop(job_id, None)

    # -- creation ------------------------------------------------------------

    def create_job(self, type_: str, params: Mapping[str, Any]) -> JobRecord:
        """Validate params, register the job, and start it as a task.

        Must be called from within the running event loop (route handlers).
        """
        job_type = JobType(type_)
        record = JobRecord(
            id=self._resolve_job_id(params), type=job_type, params=dict(params)
        )
        runner: Coroutine[Any, Any, object]
        if job_type is JobType.SCAN:
            self._require_modpack_path(record.params)
            runner = self._run_scan(record)
        elif job_type is JobType.TRANSLATE:
            self._require_modpack_path(record.params)
            try:
                config = PipelineConfig(**record.params)
            except ValidationError as exc:
                raise JobParamsError(f"invalid translate params: {exc}") from exc
            if config.glossary_store_dir is None:
                config.glossary_store_dir = self._glossary_store_dir
            self._attach_scan_payload(record)
            runner = self._run_translate(record, config)
        elif job_type is JobType.EXPORT:
            source = self._resolve_translate_source(record.params, "export")
            runner = self._run_export(record, source)
        else:  # JobType.UPLOAD
            if not record.params.get("modpack_name"):
                raise JobParamsError("params.modpack_name is required")
            curseforge_id = record.params.get("curseforge_id")
            if curseforge_id is not None and (
                isinstance(curseforge_id, bool)
                or not isinstance(curseforge_id, int)
                or curseforge_id <= 0
            ):
                raise JobParamsError(
                    "params.curseforge_id must be a positive integer"
                )
            source = self._resolve_translate_source(record.params, "upload")
            runner = self._run_upload(record, source)

        self._jobs[record.id] = record
        record.task = asyncio.create_task(
            self._run(record, runner), name=f"moru-job-{record.id}"
        )
        return record

    @staticmethod
    def _require_modpack_path(params: Mapping[str, Any]) -> None:
        path = params.get("modpack_path")
        if not path:
            raise JobParamsError("params.modpack_path is required")
        if not Path(str(path)).exists():
            raise JobParamsError(f"modpack_path does not exist: {path}")

    def _resolve_job_id(self, params: Mapping[str, Any]) -> str:
        """Job id, taken from a caller-supplied ``session_id`` when present.

        The id becomes a session filename, so only UUID-shaped values are
        accepted. Reusing a *live* job's id would leave its task running
        with no owner and drop its subscribers, so that is refused; reusing
        a finished session's id is how a retry keeps its history row.
        """
        supplied = params.get("session_id")
        if not supplied:
            return str(uuid.uuid4())
        try:
            job_id = str(uuid.UUID(str(supplied)))
        except ValueError as exc:
            raise JobParamsError(
                f"params.session_id must be a UUID: {supplied!r}"
            ) from exc
        existing = self._jobs.get(job_id)
        if existing is not None and not existing.finished:
            raise JobStateError(f"job {job_id} is still running")
        return job_id

    def _attach_scan_payload(self, record: JobRecord) -> None:
        """Copy the scan-screen payload onto the translate record.

        Only translate jobs are persisted and the scan job keeps its own
        id, so reopening a session can replay the scan screen only if the
        payload rides along on the translate record.
        """
        if record.params.get("scan_result"):
            return
        enriched: EnrichedScanResult | None = None
        scan_job_id = record.params.get("scan_job_id")
        if scan_job_id:
            scan_record = self._jobs.get(str(scan_job_id))
            if scan_record is not None and scan_record.type is JobType.SCAN:
                cached = scan_record.params.get("scan_result")
                if cached:
                    record.params["scan_result"] = cached
                    return
                if isinstance(scan_record.result, EnrichedScanResult):
                    enriched = scan_record.result
        if enriched is None:
            enriched = self._scan_cache.get(self._scan_cache_key(record.params))
        if enriched is not None:
            record.params["scan_result"] = scan_result_payload(enriched)

    def _scan_cache_key(self, params: Mapping[str, Any]) -> str:
        modpack_path = Path(str(params["modpack_path"])).resolve()
        return ":".join(
            (
                str(modpack_path),
                str(params.get("source_locale", "en_us")),
                str(params.get("target_locale", "ko_kr")),
                self._scan_tree_signature(modpack_path),
            )
        )

    @staticmethod
    def _scan_tree_signature(modpack_path: Path) -> str:
        """Staleness signal for one pack's cached scan.

        Walks the pack with ``os.scandir`` and folds file count, newest
        mtime, and total size into one string. Stat-only, so it costs a
        fraction of a scan (which extracts every jar and parses the files
        inside), yet still notices a mod added deep in the tree.

        Dot-directories are skipped: the scanner unpacks archives into the
        pack's own ``.mct_cache``, and counting that would change the
        signature on every scan and defeat the cache entirely.
        """
        count = 0
        newest = 0
        total = 0
        stack = [modpack_path]
        while stack and count < _SCAN_SIGNATURE_MAX_ENTRIES:
            try:
                entries = list(os.scandir(stack.pop()))
            except OSError:
                continue
            for entry in entries:
                if entry.name.startswith("."):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(Path(entry.path))
                        continue
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                count += 1
                newest = max(newest, stat.st_mtime_ns)
                total += stat.st_size
        return f"{count}:{newest}:{total}"

    def _resolve_translate_source(
        self, params: Mapping[str, Any], purpose: str
    ) -> JobRecord:
        """Resolve a completed or user-cancelled translate job with results."""
        translate_job_id = params.get("translate_job_id")
        if not translate_job_id:
            raise JobParamsError("params.translate_job_id is required")
        source = self.get(str(translate_job_id))
        if source.type is not JobType.TRANSLATE:
            raise JobStateError(
                f"job {source.id} is a {source.type.value} job, not translate"
            )
        if source.status not in (JobStatus.DONE, JobStatus.CANCELLED) or not isinstance(
            source.result, PipelineResult
        ):
            raise JobStateError(
                f"translate job {source.id} is {source.status.value}; "
                f"{purpose} requires a completed translate job"
            )
        return source

    # -- cancellation ----------------------------------------------------------

    def cancel(self, job_id: str) -> JobRecord:
        """Request cancellation; partial results stay on the record."""
        record = self.get(job_id)
        record.cancel_requested = True
        if record.task is not None and not record.task.done():
            record.task.cancel()
        return record

    async def aclose(self) -> None:
        """Cancel every running job (server shutdown)."""
        tasks = [
            r.task
            for r in self._jobs.values()
            if r.task is not None and not r.task.done()
        ]
        for record in self._jobs.values():
            record.cancel_requested = True
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # -- event stream ----------------------------------------------------------

    def subscribe(
        self, job_id: str
    ) -> tuple[list[dict[str, Any]], asyncio.Queue[dict[str, Any] | None] | None]:
        """Return (history snapshot, live queue).

        The queue is None when the job already finished: history then ends
        with the terminal frame and there is nothing live to wait for.
        Registration and snapshot happen in one synchronous step on the
        event loop thread, so no frame can fall between them.
        """
        record = self.get(job_id)
        history = list(record.history)
        if record.finished:
            return history, None
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        record.subscribers.add(queue)
        return history, queue

    def unsubscribe(
        self, job_id: str, queue: asyncio.Queue[dict[str, Any] | None]
    ) -> None:
        record = self._jobs.get(job_id)
        if record is not None:
            record.subscribers.discard(queue)

    def _emit(
        self, record: JobRecord, event_type: str, payload: Mapping[str, object]
    ) -> None:
        """Append a frame to history and fan it out to live subscribers.

        Pipeline/scanner ``on_event`` callbacks fire synchronously from
        coroutines running on this process's single event loop, so touching
        the history list and calling ``Queue.put_nowait`` directly is safe:
        we are already on the loop thread and nothing else can interleave.
        ``asyncio.Queue`` is *not* thread-safe, though, so if a callback ever
        arrives from a worker thread (code under ``asyncio.to_thread``), we
        hop back onto the loop with ``call_soon_threadsafe`` instead.
        """
        frame: dict[str, Any] = {"type": event_type, **payload}
        loop = self._loop
        try:
            running: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is None or running is loop:
            self._deliver(record, frame)
        else:
            loop.call_soon_threadsafe(self._deliver, record, frame)

    @staticmethod
    def _deliver(record: JobRecord, frame: dict[str, Any]) -> None:
        record.history.append(frame)
        for queue in record.subscribers:
            queue.put_nowait(frame)

    # -- execution ---------------------------------------------------------------

    async def _run(
        self, record: JobRecord, runner: Coroutine[Any, Any, object]
    ) -> None:
        self._loop = asyncio.get_running_loop()
        record.status = JobStatus.RUNNING
        terminal_type: str
        terminal: dict[str, Any]
        try:
            result = await runner
        except asyncio.CancelledError:
            # Both task.cancel() and the pipeline's cancel_check land here.
            record.status = JobStatus.CANCELLED
            terminal_type, terminal = "cancelled", {"status": "cancelled"}
            logger.info("Job %s (%s) cancelled", record.id, record.type.value)
        except Exception as exc:
            record.status = JobStatus.FAILED
            record.error = str(exc)
            terminal_type = "failed"
            terminal = {"status": "failed", "error": str(exc)}
            logger.exception("Job %s (%s) failed", record.id, record.type.value)
        else:
            record.result = result
            if record.cancel_requested:
                record.status = JobStatus.CANCELLED
                terminal_type, terminal = "cancelled", {"status": "cancelled"}
            else:
                record.status = JobStatus.DONE
                terminal_type, terminal = "done", {"status": "done"}
            if record.done_payload:
                terminal.update(record.done_payload)
        self._emit(record, terminal_type, terminal)
        record.finished = True
        if record.type is JobType.TRANSLATE:
            try:
                self._session_store.save_job_session(record)
            except Exception:
                logger.exception("Failed to save session for job %s", record.id)
        for queue in record.subscribers:
            queue.put_nowait(None)  # stream-end sentinel for live listeners

    async def _run_scan(self, record: JobRecord) -> EnrichedScanResult:
        params = record.params

        def progress(stage: str, current: int, total: int, message: str) -> None:
            self._emit(
                record,
                "progress",
                {
                    "stage": stage,
                    "current": current,
                    "total": total,
                    "message": message,
                },
            )

        cache_key = self._scan_cache_key(params)
        if cache_key in self._scan_cache:
            progress("scan", 1, 1, "cached")
            progress("parse", 1, 1, "cached")
            logger.info("Serving cached scan result for %s", cache_key)
            return self._scan_cache[cache_key]

        scan = await scan_modpack(
            params["modpack_path"],
            source_locale=str(params.get("source_locale", "en_us")),
            target_locale=str(params.get("target_locale", "ko_kr")),
            progress_callback=progress,
        )

        # Launcher metadata (CurseForge/Modrinth/Prism files) tells us which
        # published pack this folder is; a handful of fixed-path reads, run
        # off-loop so a slow disk never stalls event delivery.
        identity = await asyncio.to_thread(
            detect_pack_identity, Path(str(params["modpack_path"]))
        )

        # Parse pass: entry/char counts + samples per source file, so the
        # scan screen can show real volumes and cost estimates before any
        # LLM call. Parse failures degrade to zero counts, never fail scan.
        registry = create_default_registry()
        pairs = scan.all_translation_pairs
        enriched = EnrichedScanResult(scan=scan, identity=identity)
        semaphore = asyncio.Semaphore(PARSE_CONCURRENCY)
        parsed_count = 0

        async def parse_one(pair: LanguageFilePair) -> None:
            nonlocal parsed_count
            source_path = pair.source_path
            meta = FileParseMeta()
            async with semaphore:
                handler = registry.get_handler(source_path)
                if handler is not None:
                    try:
                        source_data = await handler.extract(source_path)
                    except Exception as exc:  # noqa: BLE001 — parse-only pass
                        logger.warning("Scan parse failed for %s: %s", source_path, exc)
                    else:
                        pending_data = source_data
                        if pair.target_path is not None:
                            try:
                                existing = await handler.extract(pair.target_path)
                            except Exception as exc:  # noqa: BLE001 — count all source
                                logger.warning(
                                    "Target scan parse failed for %s: %s",
                                    pair.target_path,
                                    exc,
                                )
                            else:
                                pending_data = {
                                    key: value
                                    for key, value in source_data.items()
                                    if not existing.get(key, "").strip()
                                }
                        meta.parsed = True
                        meta.entry_count = len(pending_data)
                        meta.char_count = sum(len(v) for v in pending_data.values())
                        meta.sample = {
                            key: value[:SAMPLE_TEXT_LIMIT]
                            for key, value in list(pending_data.items())[:SAMPLE_ENTRIES]
                        }
            enriched.files[str(source_path)] = meta
            parsed_count += 1
            progress("parse", parsed_count, len(pairs), source_path.name)

        if pairs:
            progress("parse", 0, len(pairs), "")
            await asyncio.gather(*(parse_one(pair) for pair in pairs))
        while len(self._scan_cache) >= SCAN_CACHE_LIMIT:
            self._scan_cache.pop(next(iter(self._scan_cache)))
        self._scan_cache[cache_key] = enriched
        return enriched

    async def _run_translate(
        self, record: JobRecord, config: PipelineConfig
    ) -> PipelineResult:
        def on_event(event: str, payload: dict[str, object]) -> None:
            if event == "done":
                # The pipeline's own "done" {stats} would collide with the
                # manager's terminal frame; stash it so the terminal
                # {type: done, status: done} carries the stats instead.
                record.done_payload = dict(payload)
                return
            self._emit(record, event, payload)

        def cancel_check() -> bool:
            return record.cancel_requested

        result = await run_pipeline(
            config, on_event=on_event, cancel_check=cancel_check
        )
        # Normal and partial-cancelled results expose the same cumulative
        # counters to the desktop terminal frame.
        record.done_payload = {"stats": result.stats.model_dump()}
        return result

    async def _apply_review_edits(
        self, source: JobRecord, stage: str
    ) -> PipelineResult:
        """Fold review-screen edits (manual PATCH / AI retranslate) back
        into the output trees so export/upload archives carry the
        reviewed state."""
        result = source.result
        assert isinstance(result, PipelineResult)  # _resolve_translate_source
        rewritten = await apply_entry_edits(result)
        if rewritten:
            logger.info(
                "%s: re-applied review edits to %d files", stage, rewritten
            )
        return result

    async def _run_export(
        self, record: JobRecord, source: JobRecord
    ) -> dict[str, Any]:
        """Build the installable archives from the generated output trees.

        Two artifacts: ``<name>.zip`` — the resource pack, droppable into
        the game's ``resourcepacks/`` folder as-is — and
        ``<name>_overrides.zip`` — files to merge over the modpack root
        (kubejs/, config/, ftbquests/ …). Either is null when the run
        produced no files for that tree.
        """
        result = await self._apply_review_edits(source, "export")
        root = output_root(result.config)
        pack_dir = root / RESOURCEPACK_DIRNAME
        overrides_dir = root / OVERRIDES_DIRNAME

        output_zip = record.params.get("output_zip")
        if output_zip:
            zip_path = Path(str(output_zip))
        else:
            # Off-loop like the scan: identity probes launcher JSON on disk.
            identity = await asyncio.to_thread(
                detect_pack_identity, result.config.modpack_path
            )
            zip_path = (
                _default_export_dir() / f"{_export_stem(result, identity)}.zip"
            )
        overrides_zip = zip_path.with_name(f"{zip_path.stem}_overrides.zip")

        self._emit(
            record,
            "progress",
            {"stage": "export", "current": 0, "total": 2},
        )

        def build() -> dict[str, Any]:
            payload: dict[str, Any] = {
                "zip_path": None,
                "overrides_zip_path": None,
                "file_count": len(result.output_files),
            }
            if _tree_has_files(pack_dir):
                create_zip_from_directory(pack_dir, zip_path)
                payload["zip_path"] = str(zip_path)
            if _tree_has_files(overrides_dir):
                create_zip_from_directory(overrides_dir, overrides_zip)
                payload["overrides_zip_path"] = str(overrides_zip)
            return payload

        # Zip construction is blocking I/O; keep the loop responsive.
        payload = await asyncio.to_thread(build)
        self._emit(
            record,
            "progress",
            {"stage": "export", "current": 2, "total": 2},
        )
        record.done_payload = dict(payload)
        return payload

    async def _run_upload(
        self, record: JobRecord, source: JobRecord
    ) -> dict[str, Any]:
        """Publish a completed translate job's pack to the moru web platform.

        Sequence (contracts/web-api.yaml): build one reviewed zip per
        output tree (resource pack / overrides), request presigned upload
        slots, PUT each archive, then register the pack. ``api_token`` is
        forwarded as a Bearer header when present; without it the upload
        is anonymous (desktop-only - the X-Moru-Client marker is what the
        web platform accepts in place of an account).
        """
        params = record.params
        web_url = str(params.get("web_url") or "https://moru.gg").rstrip("/")
        api_token = params.get("api_token") or None

        result = await self._apply_review_edits(source, "pack")
        root = output_root(result.config)
        trees = {
            "resource_pack": root / RESOURCEPACK_DIRNAME,
            "overrides": root / OVERRIDES_DIRNAME,
        }

        staging = Path(tempfile.mkdtemp(prefix="moru-upload-"))
        try:
            self._emit(
                record, "progress", {"stage": "pack", "current": 0, "total": 1}
            )

            def build() -> dict[str, Path]:
                """One installable zip per non-empty tree, staged locally."""
                archives: dict[str, Path] = {}
                for kind, tree in trees.items():
                    if _tree_has_files(tree):
                        zip_path = staging / f"{kind}.zip"
                        create_zip_from_directory(tree, zip_path)
                        archives[kind] = zip_path
                return archives

            # Zip construction is blocking I/O; keep the loop responsive.
            archives = await asyncio.to_thread(build)
            if not archives:
                raise upload.WebUploadError(
                    "translate job produced no uploadable files"
                )
            self._emit(
                record, "progress", {"stage": "pack", "current": 1, "total": 1}
            )
            digests = {
                kind: await asyncio.to_thread(_sha256_and_size, zip_path)
                for kind, zip_path in archives.items()
            }

            def step(current: int, message: str) -> None:
                self._emit(
                    record,
                    "progress",
                    {
                        "stage": "upload",
                        "current": current,
                        "total": 3,
                        "message": message,
                    },
                )

            step(0, "requesting upload slots")
            slots = await upload.request_upload_slots(
                web_url,
                api_token,
                [
                    {"kind": kind, "size": size, "sha256": sha256}
                    for kind, (sha256, size) in digests.items()
                ],
            )
            step(1, "uploading archives")
            for kind, zip_path in archives.items():
                await upload.put_archive(str(slots[kind]["url"]), zip_path)
            step(2, "registering pack")
            registered = await upload.register_pack(
                web_url,
                api_token,
                self._pack_payload(
                    record, source, {kind: slots[kind] for kind in archives}
                ),
            )
            step(3, "registered")
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        payload = {
            "pack_id": str(registered["pack_id"]),
            "url": str(registered["url"]),
        }
        record.done_payload = dict(payload)
        return payload

    @staticmethod
    def _pack_payload(
        record: JobRecord,
        source: JobRecord,
        slots: Mapping[str, Mapping[str, Any]],
    ) -> dict[str, Any]:
        """web-api.yaml TranslationPackCreate body from the translate result."""
        result = source.result
        assert isinstance(result, PipelineResult)  # _resolve_translate_source
        stats = result.stats
        params = record.params
        payload: dict[str, Any] = {
            "modpack_name": str(params["modpack_name"]),
            "target_lang": result.config.target_locale,
            "source_lang": result.config.source_locale,
            "files": [
                {"kind": kind, "object_key": slot["object_key"]}
                for kind, slot in slots.items()
            ],
            "engine_version": __version__,
            "stats": {
                "total_entries": stats.total_entries,
                "translated_entries": stats.translated_entries,
                "failed_entries": stats.failed_entries,
                "coverage_percent": stats.coverage_percent,
                "quality_score": stats.quality_score,
                "tm_hits": stats.tm_hits,
                "model": result.config.model,
                "duration_seconds": stats.duration_seconds,
            },
        }
        if stats.categories:
            payload["stats"]["categories"] = stats.categories
        if result.artifact_id:
            payload["artifact_id"] = result.artifact_id
        for key in ("modpack_version", "description", "changelog"):
            value = params.get(key)
            if value:
                payload[key] = str(value)
        # Validated as a positive int in create_job; lets the web platform
        # link the pack to its CurseForge project page.
        curseforge_id = params.get("curseforge_id")
        if curseforge_id:
            payload["curseforge_id"] = int(curseforge_id)
        return payload

