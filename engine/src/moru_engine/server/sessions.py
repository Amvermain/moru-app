"""Session persistence and import/export format (.moru) for translation sessions."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from platformdirs import user_data_dir

from ..pipeline import (
    EntryResult,
    EntryStatus,
    PipelineConfig,
    PipelineResult,
    PipelineStats,
)
from .jobs import JobRecord, JobStatus, JobType

logger = logging.getLogger(__name__)

SESSION_FORMAT_VERSION = "1.0"

#: A session id reaches the filesystem as "<id>.moru". Ids arrive from the
#: desktop (params.session_id) and from inside imported files, so everything
#: outside this set is replaced before the id is ever joined to a path.
_UNSAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
#: Statuses a persisted session may claim. A restored record is always
#: finished=True, so a non-terminal status would advertise a reopenable job
#: with no task behind it.
_TERMINAL_STATUSES = frozenset(
    {JobStatus.DONE, JobStatus.CANCELLED, JobStatus.FAILED}
)


def _safe_session_id(session_id: str) -> str:
    """Filesystem-safe stem for a session id (no separators, no traversal)."""
    stem = _UNSAFE_ID_RE.sub("-", session_id).strip("-")
    return stem[:120] or "session"


def _default_session_dir() -> Path:
    return Path(user_data_dir("moru", "moru")) / "sessions"


def _atomic_write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        if tmp.is_file():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise


def _read_json(path: Path) -> Any | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.exception("Failed to read session json from %s", path)
        return None


class SessionStore:
    """Manages persistent translation sessions on disk and handles import/export (.moru files)."""

    def __init__(self, sessions_dir: Path | None = None) -> None:
        self.sessions_dir = sessions_dir or _default_session_dir()
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    def _session_file_path(self, session_id: str) -> Path:
        return self.sessions_dir / f"{_safe_session_id(session_id)}.moru"

    def save_job_session(self, record: JobRecord) -> Path | None:
        """Serialize a completed/cancelled translate JobRecord and persist to disk."""
        if record.type is not JobType.TRANSLATE or not isinstance(record.result, PipelineResult):
            return None

        res: PipelineResult = record.result
        config = res.config

        # Extract pack identity if present
        identity_dict = None
        if record.params.get("identity"):
            identity_dict = record.params["identity"]
        elif res.scan_result and hasattr(res.scan_result, "identity") and res.scan_result.identity:
            identity_dict = asdict(res.scan_result.identity)

        # Extract entry results
        entries_data = [
            {
                "key": e.key,
                "file": e.file,
                "source_text": e.source_text,
                "translated_text": e.translated_text,
                "status": e.status.value,
                "errors": list(e.errors),
            }
            for e in res.entries
        ]

        config_data = {
            "modpack_path": str(config.modpack_path),
            "output_dir": str(config.output_dir) if config.output_dir else None,
            "source_locale": config.source_locale,
            "target_locale": config.target_locale,
            "model": config.model,
            "temperature": config.temperature,
            "batch_size": config.batch_size,
            "max_concurrent": config.max_concurrent,
            "max_refine": config.max_refine,
            "reasoning_effort": config.reasoning_effort,
            "use_tm": config.use_tm,
            "use_vanilla_glossary": config.use_vanilla_glossary,
            "extract_glossary": config.extract_glossary,
            "glossary_max_terms": config.glossary_max_terms,
            "include_categories": config.include_categories,
        }

        stats_source = res.stats
        if res.stats.total_entries == 0 and res.entries:
            # Recompute onto a copy: a save is a read from the caller's point
            # of view and must not mutate the result the live job still shares.
            stats_source = res.stats.model_copy(deep=True)
            stats_source.total_entries = len(res.entries)
            stats_source.translated_entries = sum(1 for e in res.entries if e.status in (EntryStatus.PASSED, EntryStatus.MODIFIED))
            stats_source.failed_entries = sum(1 for e in res.entries if e.status == EntryStatus.FAILED or e.errors)
            stats_source.tm_hits = sum(1 for e in res.entries if e.status == EntryStatus.TM_HIT)
            stats_source.skipped_entries = sum(1 for e in res.entries if e.status == EntryStatus.SKIPPED)
            stats_source.finalize()

        stats_data = stats_source.model_dump()

        modpack_name = record.params.get("modpack_name") or config.modpack_path.name
        if identity_dict and identity_dict.get("name"):
            modpack_name = identity_dict["name"]

        session_payload = {
            "version": SESSION_FORMAT_VERSION,
            "id": record.id,
            "modpack_name": modpack_name,
            "modpack_path": str(config.modpack_path),
            "source_locale": config.source_locale,
            "target_locale": config.target_locale,
            "model": config.model,
            "status": record.status.value,
            "created_at": record.created_at.isoformat(),
            "finished_at": datetime.now(UTC).isoformat(),
            "stats": stats_data,
            "config": config_data,
            "identity": identity_dict,
            "scan_result": record.params.get("scan_result"),
            "entries": entries_data,
            "done_payload": record.done_payload,
        }

        path = self._session_file_path(record.id)
        _atomic_write_json(path, session_payload)
        logger.info("Saved translation session %s to %s", record.id, path)
        return path

    def _find_session_file(self, session_id: str) -> Path | None:
        path = self._session_file_path(session_id)
        if path.is_file():
            return path
        alt_path = self.sessions_dir / f"{session_id}.json"
        if alt_path.is_file():
            return alt_path
        if self.sessions_dir.is_dir():
            for f in self.sessions_dir.glob("*"):
                if f.is_file() and f.suffix in (".moru", ".json"):
                    data = _read_json(f)
                    if isinstance(data, dict) and data.get("id") == session_id:
                        return f
        return None

    def load_job_session(self, session_id: str) -> JobRecord | None:
        """Load a persisted .moru session file from disk into a JobRecord."""
        path = self._find_session_file(session_id)
        if path is None:
            return None

        data = _read_json(path)
        if not isinstance(data, dict) or "entries" not in data:
            return None

        try:
            return self.deserialize_job_session(data)
        except (ValueError, KeyError):
            logger.exception("Ignoring unusable session file %s", path)
            return None

    def deserialize_job_session(self, data: dict[str, Any]) -> JobRecord:
        """Convert a session payload dict into a JobRecord."""
        raw_id = data.get("id")
        session_id = _safe_session_id(str(raw_id)) if raw_id else str(uuid.uuid4())
        config_data = data.get("config") or {}

        config = PipelineConfig(
            modpack_path=Path(config_data.get("modpack_path") or data.get("modpack_path") or "."),
            output_dir=Path(config_data["output_dir"]) if config_data.get("output_dir") else None,
            source_locale=config_data.get("source_locale") or data.get("source_locale") or "en_us",
            target_locale=config_data.get("target_locale") or data.get("target_locale") or "ko_kr",
            model=config_data.get("model") or data.get("model") or "openai/gpt-5.6-luna",
            temperature=config_data.get("temperature", 0.3),
            batch_size=config_data.get("batch_size", 10),
            max_concurrent=config_data.get("max_concurrent", 15),
            max_refine=config_data.get("max_refine", 2),
            reasoning_effort=config_data.get("reasoning_effort"),
            use_tm=config_data.get("use_tm", True),
            use_vanilla_glossary=config_data.get("use_vanilla_glossary", True),
            extract_glossary=config_data.get("extract_glossary", False),
            glossary_max_terms=config_data.get("glossary_max_terms"),
            include_categories=config_data.get("include_categories"),
        )

        entries = [
            EntryResult(
                key=e["key"],
                file=e["file"],
                source_text=e.get("source_text", ""),
                translated_text=e.get("translated_text"),
                status=EntryStatus(e.get("status", "passed")),
                errors=e.get("errors", []),
            )
            for e in data.get("entries", [])
        ]

        stats_dict = data.get("stats") or {}
        stats = PipelineStats(**stats_dict)

        pipeline_result = PipelineResult(
            config=config,
            entries=entries,
            stats=stats,
        )

        created_at = datetime.now(UTC)
        if data.get("created_at"):
            try:
                created_at = datetime.fromisoformat(data["created_at"])
            except ValueError:
                pass

        status_str = str(data.get("status", JobStatus.DONE.value))
        try:
            job_status = JobStatus(status_str)
        except ValueError as exc:
            raise ValueError(f"unknown session status: {status_str!r}") from exc
        if job_status not in _TERMINAL_STATUSES:
            raise ValueError(f"session status {status_str!r} is not finished")

        record = JobRecord(
            id=session_id,
            type=JobType.TRANSLATE,
            params={
                "modpack_path": str(config.modpack_path),
                "modpack_name": data.get("modpack_name") or config.modpack_path.name or "Modpack",
                "source_locale": config.source_locale,
                "target_locale": config.target_locale,
                "model": config.model,
                "identity": data.get("identity"),
                "scan_result": data.get("scan_result"),
            },
            status=job_status,
            created_at=created_at,
            result=pipeline_result,
            done_payload=data.get("done_payload"),
            finished=True,
        )
        return record

    def list_sessions(self) -> list[dict[str, Any]]:
        """List metadata for all persisted sessions."""
        sessions = []
        seen_ids = set()

        for file in self.sessions_dir.glob("*.moru"):
            data = _read_json(file)
            if isinstance(data, dict) and "id" in data:
                seen_ids.add(data["id"])
                sessions.append(self.summarize_session(data))

        for file in self.sessions_dir.glob("*.json"):
            data = _read_json(file)
            if isinstance(data, dict) and "id" in data and data["id"] not in seen_ids:
                seen_ids.add(data["id"])
                sessions.append(self.summarize_session(data))

        sessions.sort(key=lambda s: s.get("created_at") or "", reverse=True)
        return sessions

    @staticmethod
    def summarize_session(data: dict[str, Any]) -> dict[str, Any]:
        stats = data.get("stats") or {}
        entries = data.get("entries") or []
        done_entries = sum(1 for e in entries if e.get("status") in ("passed", "warning", "modified", "tm_hit"))
        done_payload = data.get("done_payload") if isinstance(data.get("done_payload"), dict) else {}
        return {
            "id": data.get("id"),
            "modpack_name": data.get("modpack_name") or data.get("modpack_path") or "Modpack",
            "modpack_path": data.get("modpack_path", ""),
            "source_locale": data.get("source_locale", "en_us"),
            "target_locale": data.get("target_locale", "ko_kr"),
            "model": data.get("model", ""),
            "status": data.get("status", "done"),
            "created_at": data.get("created_at"),
            "finished_at": data.get("finished_at"),
            "total_entries": len(entries),
            "done_entries": done_entries,
            "stats": stats,
            "export_zip_path": done_payload.get("zip_path"),
            "export_overrides_zip_path": done_payload.get("overrides_zip_path"),
        }

    def delete_session(self, session_id: str) -> bool:
        path = self._find_session_file(session_id)
        if path is not None and path.is_file():
            path.unlink()
            return True
        return False

    def export_session_file(self, session_id: str, output_path: Path) -> Path:
        """Export session file to external path."""
        path = self._find_session_file(session_id)
        if path is None or not path.is_file():
            raise FileNotFoundError(f"Session {session_id} not found")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, output_path)
        logger.info("Exported session %s to %s", session_id, output_path)
        return output_path

    def import_session_file(self, input_path: Path) -> JobRecord:
        """Import external .moru session file and store locally."""
        if not input_path.is_file():
            raise FileNotFoundError(f"File not found: {input_path}")
        data = _read_json(input_path)
        if not isinstance(data, dict) or "entries" not in data:
            raise ValueError("Invalid session file format")

        record = self.deserialize_job_session(data)
        self.save_job_session(record)
        return record
