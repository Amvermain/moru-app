"""Translation pipeline orchestrator.

scan -> glossary/TM lookup -> [TM hit: reuse] -> protect -> DSPy translate
-> restore -> validate -> [fail: refined inside module / surfaced] -> write
translated files.

Placeholder protect/restore lives HERE (outside the LLM).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

import dspy
from pydantic import BaseModel, ConfigDict, Field

from .. import batching
from ..community import (
    default_glossary_store_dir,
    load_user_glossary_terms,
    merge_extracted_terms,
)
from ..dspy_modules import GlossaryExtractor, build_lm, load_translator
from ..dspy_modules.lm import token_usage
from ..glossary.pair_harvester import (
    TranslatedTerm,
    build_term_rules,
    collect_translated_terms,
    is_untranslated_copy,
)
from ..glossary.term_miner import TermCandidate, mine_candidates
from ..handlers.base import create_default_registry
from ..models import Glossary, TermRule, ValidationSeverity
from ..models.glossary_filter import GlossaryFilter
from ..output import (
    DEFAULT_PACK_FORMAT,
    FileOutput,
    GenerationResult,
    OutputConfig,
    OutputGenerator,
    pack_format_for_minecraft_version,
)
from ..placeholder import PlaceholderError, PlaceholderProtector, ProtectedText
from ..scanner import ModpackScanner, ScanResult
from ..scanner.pack_identity import detect_pack_identity
from ..tm import LocalTM
from ..validator import TranslationValidator

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from ..models import LanguageFilePair

logger = logging.getLogger(__name__)

#: Every Nth freshly translated entry becomes an entry_done ticker frame.
ENTRY_TICKER_INTERVAL = 5
#: Ticker frames truncate source/translated text to this many characters.
TICKER_TEXT_LIMIT = 120

_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9_./:-]+")
_DOTTED_VERSION_RE = re.compile(r"\d+(?:\.\d+)+")
_CATEGORY_BUCKET_BY_FILE_TYPE = {
    "ftbquests": "quests",
    "the_vault_quest": "quests",
    "patchouli": "guidebook",
    "kubejs": "scripts",
    "mod": "lang",
    "resources": "lang",
    "resourcepacks": "lang",
    "datapacks": "lang",
    "config": "json",
}


def looks_like_identifier(text: str) -> bool:
    """Detect Patchouli/lang-key references that should not reach the LLM.

    Patchouli page text can itself be another language key. Translating that
    reference invents prose instead of preserving the lookup; dotted numeric
    versions have the same untranslatable shape and are intentionally included.
    """
    value = text.strip()
    if not value or _IDENTIFIER_RE.fullmatch(value) is None:
        return False
    if "." not in value and ":" not in value:
        return False
    has_letter = any(
        "A" <= character <= "Z" or "a" <= character <= "z"
        for character in value
    )
    if not has_letter and _DOTTED_VERSION_RE.fullmatch(value) is None:
        return False
    segments = re.split(r"[./:]+", value)
    return len(segments) >= 2 and all(segments)


class RetranslateError(Exception):
    """Single-entry retranslation produced no acceptable output."""


class EntryStatus(str, Enum):
    PASSED = "passed"
    WARNING = "warning"
    FAILED = "failed"
    TM_HIT = "tm_hit"
    SKIPPED = "skipped"
    MODIFIED = "modified"


class EntryResult(BaseModel):
    """Per-entry outcome, the unit surfaced to the review screen."""

    key: str
    file: str
    source_text: str
    translated_text: str | None = None
    status: EntryStatus = EntryStatus.FAILED
    errors: list[str] = Field(default_factory=list)


class PipelineStats(BaseModel):
    total_files: int = 0
    total_entries: int = 0
    translated_entries: int = 0
    failed_entries: int = 0
    tm_hits: int = 0
    skipped_entries: int = 0
    categories: dict[str, int] = Field(default_factory=dict)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    duration_seconds: float = 0.0
    coverage_percent: float = 0.0
    quality_score: float = 0.0

    def finalize(self) -> None:
        done = self.translated_entries + self.tm_hits
        translatable = max(self.total_entries - self.skipped_entries, 1)
        self.coverage_percent = round(100.0 * done / translatable, 2)
        checked = done + self.failed_entries
        self.quality_score = round(done / checked, 4) if checked else 0.0


class PipelineConfig(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    modpack_path: Path
    output_dir: Path | None = None
    source_locale: str = "en_us"
    target_locale: str = "ko_kr"
    #: pack.mcmeta pack_format for the generated resource pack.
    pack_format: int = DEFAULT_PACK_FORMAT

    model: str = "openai/gpt-5.6-luna"
    api_key: str | None = None
    api_base: str | None = None
    temperature: float = 0.3
    #: LiteLLM reasoning_effort passthrough for reasoning-capable providers;
    #: an explicit value overrides build_lm's Ollama auto-disable.
    reasoning_effort: str | None = None

    batch_size: int = batching.DEFAULT_BATCH_SIZE
    max_batch_chars: int = batching.DEFAULT_MAX_BATCH_CHARS
    max_concurrent: int = Field(default=15, ge=1)
    #: Files prepared concurrently. None derives max_concurrent so enough
    #: batches exist to fill every LLM slot; a small fixed value starves
    #: the request semaphore when the pack has many small files.
    file_workers: int | None = Field(default=None, ge=1)
    max_refine: int = 2

    use_tm: bool = True
    tm_db_path: Path | None = None
    #: Include origin="vanilla" rows synced from the server into the user
    #: glossary store (the web-published vanilla bundle). No local vanilla
    #: glossary is bundled anymore; disabling this only drops those rows.
    use_vanilla_glossary: bool = True
    #: Merge the engine's user glossary store (hub manual terms + synced
    #: vanilla/community terms) into every run. Store dir defaults to the
    #: shared platformdirs location used by the sidecar server.
    use_user_glossary: bool = True
    glossary_store_dir: Path | None = None
    #: Harvest terminology from lang files the pack's mods already ship in
    #: the configured target locale alongside the source locale (e.g.
    #: en_us + ko_kr side by side). Deterministic and LLM-free; only
    #: unanimous source→target pairs become rules, and the user glossary
    #: store always wins on overlap.
    use_mod_translations: bool = True
    extract_glossary: bool = False
    #: Cap on mined term candidates sent to the curation LLM. Candidates
    #: come from a deterministic whole-corpus scan (term_miner), not from
    #: sampling, so coverage does not depend on file order.
    glossary_max_terms: int | None = Field(default=3000, ge=1)
    #: Candidates per curation LLM call. Small chunks bound the blast
    #: radius of one malformed response and make progress observable.
    glossary_chunk_size: int = 50
    #: Extra attempts per chunk after a schema-invalid LLM response; the
    #: validation error is fed back verbatim so the model can fix it.
    glossary_max_retries: int = 2
    artifacts_dir: Path | None = None

    #: Scan categories to translate (None = all). Names follow the scan
    #: payload convention: TranslationFile.category or file_type fallback.
    include_categories: list[str] | None = None


class PipelineResult(BaseModel):
    """Mutable across stages: retry mutates in place."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    config: PipelineConfig
    scan_result: ScanResult | None = None
    entries: list[EntryResult] = Field(default_factory=list)
    output_files: list[Path] = Field(default_factory=list)
    stats: PipelineStats = Field(default_factory=PipelineStats)
    artifact_id: str | None = None
    #: Effective glossary of the full run. retry_failed/retranslate_entry
    #: reuse it so post-run fixes see the exact same rules - harvested mod
    #: terms and LLM-curated terms are run-scoped and would be lost by a
    #: bare rebuild.
    glossary: Glossary | None = None

    @property
    def failed(self) -> list[EntryResult]:
        return [e for e in self.entries if e.status == EntryStatus.FAILED]


def category_stats(result: PipelineResult) -> dict[str, int]:
    """Count non-failed entries by their web-facing file-type bucket."""
    if result.scan_result is None:
        return {}

    modpack_path = result.config.modpack_path.resolve()
    file_type_by_path: dict[str, str] = {}
    for translation_file in result.scan_result.translation_files:
        input_path = Path(translation_file.input_path)
        try:
            relative = input_path.resolve().relative_to(modpack_path).as_posix()
        except ValueError:
            relative = input_path.as_posix()
        file_type_by_path[relative] = translation_file.file_type

    categories: dict[str, int] = {}
    for entry in result.entries:
        if entry.status is EntryStatus.FAILED:
            continue
        file_type = file_type_by_path.get(entry.file)
        if file_type is None:
            continue
        category = _CATEGORY_BUCKET_BY_FILE_TYPE.get(file_type, file_type)
        categories[category] = categories.get(category, 0) + 1
    return categories


class TranslationPipeline:
    """Orchestrates one translation session over a scanned modpack."""

    def __init__(
        self,
        config: PipelineConfig,
        *,
        on_event: Callable[[str, dict[str, object]], None] | None = None,
        cancel_check: Callable[[], bool] | None = None,
        lm: object | None = None,
    ) -> None:
        self.config = config
        self.on_event = on_event
        self.cancel_check = cancel_check
        self.registry = create_default_registry()
        # `lm` injection is a test/embedding seam; production builds from config.
        lm_extra: dict[str, object] = {}
        if config.reasoning_effort is not None:
            lm_extra["reasoning_effort"] = config.reasoning_effort
        self.lm = lm if lm is not None else build_lm(
            config.model,
            api_key=config.api_key,
            api_base=config.api_base,
            temperature=config.temperature,
            **lm_extra,
        )
        self.translator, self.artifact_id = load_translator(
            config.model,
            config.source_locale,
            config.target_locale,
            max_refine=config.max_refine,
            base_dir=config.artifacts_dir,
        )
        self.tm = LocalTM(config.tm_db_path) if config.use_tm else None
        self._llm_semaphore = asyncio.Semaphore(config.max_concurrent)
        self._file_semaphore = asyncio.Semaphore(
            config.file_workers
            if config.file_workers is not None
            else config.max_concurrent
        )
        #: Monotonic count of freshly translated entries, drives the sampled
        #: entry_done ticker frames (every ENTRY_TICKER_INTERVAL-th entry).
        self._entry_counter = 0
        #: Monotonic provider-request id for live concurrent-work events.
        self._request_counter = 0

    # -- events ------------------------------------------------------------

    def _emit(self, event: str, payload: dict[str, object]) -> None:
        if self.on_event is not None:
            try:
                self.on_event(event, payload)
            except Exception:  # noqa: BLE001 — listener bugs must not kill jobs
                logger.exception("Event listener failed for %s", event)

    def _check_cancelled(self) -> None:
        if self.cancel_check is not None and self.cancel_check():
            raise asyncio.CancelledError("pipeline cancelled")

    # -- glossary ----------------------------------------------------------

    async def _build_glossary(
        self,
        pairs: list[LanguageFilePair],
        *,
        harvest_pairs: list[LanguageFilePair] | None = None,
    ) -> tuple[Glossary, str]:
        glossary = Glossary(
            locale_source=self.config.source_locale,
            locale_target=self.config.target_locale,
        )

        user_rules = self._load_user_glossary()
        if user_rules:
            glossary = glossary.merge_with(
                Glossary(
                    locale_source=self.config.source_locale,
                    locale_target=self.config.target_locale,
                    term_rules=user_rules,
                )
            )

        if self.config.use_mod_translations and harvest_pairs:
            harvested = await self._harvest_mod_terms(harvest_pairs, glossary)
            if harvested:
                glossary = glossary.merge_with(
                    Glossary(
                        locale_source=self.config.source_locale,
                        locale_target=self.config.target_locale,
                        term_rules=harvested,
                    )
                )

        if self.config.extract_glossary and pairs:
            corpus: dict[str, str] = {}
            for pair in pairs:
                handler = self.registry.get_handler(pair.source_path)
                if handler is None:
                    continue
                data = await handler.extract(pair.source_path)
                if pair.target_path is not None and pair.target_path.exists():
                    existing = await handler.extract(pair.target_path)
                    data = {
                        key: value
                        for key, value in data.items()
                        if is_untranslated_copy(value, existing.get(key, ""))
                    }
                for key, value in data.items():
                    corpus[f"{pair.source_path}:{key}"] = value
            candidates = mine_candidates(
                corpus,
                {
                    alias
                    for rule in glossary.term_rules
                    for alias in rule.aliases
                },
                max_terms=self.config.glossary_max_terms,
            )
            logger.info(
                "Glossary mining: %d candidates from %d entries",
                len(candidates),
                len(corpus),
            )
            if candidates:
                extractor = GlossaryExtractor()
                size = max(1, self.config.glossary_chunk_size)
                chunks = [
                    candidates[i : i + size]
                    for i in range(0, len(candidates), size)
                ]
                total = len(chunks)
                progress = {"done": 0, "new_terms": 0}
                chunk_rules: list[list[TermRule] | None] = [None] * total
                self._emit(
                    "glossary_progress",
                    {"done": 0, "total": total, "new_terms": 0},
                )
                work = iter(enumerate(chunks))

                async def curate_worker() -> None:
                    for index, chunk in work:
                        rules = await self._curate_glossary_chunk(
                            extractor,
                            glossary,
                            chunk,
                            index,
                            total,
                            progress,
                        )
                        chunk_rules[index] = rules
                        progress["done"] += 1
                        progress["new_terms"] += len(rules)
                        self._emit(
                            "glossary_progress",
                            {
                                "done": progress["done"],
                                "total": total,
                                "new_terms": progress["new_terms"],
                            },
                        )

                workers = [
                    asyncio.create_task(
                        curate_worker(), name=f"moru-glossary-{worker_index}"
                    )
                    for worker_index in range(
                        min(self.config.max_concurrent, total)
                    )
                ]
                try:
                    await asyncio.gather(*workers)
                except BaseException:
                    for worker in workers:
                        worker.cancel()
                    await asyncio.gather(*workers, return_exceptions=True)
                    raise

                extracted_rules = [
                    rule
                    for rules in chunk_rules
                    if rules is not None
                    for rule in rules
                ]
                new_terms = len(extracted_rules)
                if extracted_rules:
                    glossary = glossary.merge_with(
                        Glossary(
                            locale_source=self.config.source_locale,
                            locale_target=self.config.target_locale,
                            term_rules=extracted_rules,
                        )
                    )
                    self._persist_extracted_terms(extracted_rules)
                self._emit("glossary_extracted", {"new_terms": new_terms})

        fingerprint = hashlib.sha256(
            "\x1e".join(
                sorted(
                    f"{'|'.join(t.aliases)}={t.term_ko}" for t in glossary.term_rules
                )
            ).encode("utf-8")
        ).hexdigest()[:12]
        return glossary, fingerprint

    async def _harvest_mod_terms(
        self, pairs: list[LanguageFilePair], glossary: Glossary
    ) -> list[TermRule]:
        """Deterministic terms from lang files mods ship in the target
        locale (see pair_harvester). Harvest scope is every paired file in
        the scan - independent of the translate scope, since evidence from
        an excluded category is still evidence. Best-effort: one broken
        file skips that file only."""

        async def harvest_one(pair: LanguageFilePair) -> list[TranslatedTerm]:
            handler = self.registry.get_handler(pair.source_path)
            if handler is None or pair.target_path is None:
                return []
            try:
                # File-semaphore bound: a large pack can pair hundreds of
                # lang files, and an unbounded gather would exhaust fds.
                async with self._file_semaphore:
                    source_data = await handler.extract(pair.source_path)
                    target_data = await handler.extract(pair.target_path)
            except Exception:  # noqa: BLE001 — enhancement path, never fatal
                logger.warning(
                    "Mod translation harvest failed for %s",
                    pair.source_path,
                    exc_info=True,
                )
                return []
            return collect_translated_terms(source_data, target_data)

        candidates = [p for p in pairs if p.has_existing_translation]
        if not candidates:
            return []
        per_file = await asyncio.gather(*(harvest_one(p) for p in candidates))
        rules = build_term_rules(
            (term for terms in per_file for term in terms),
            {alias for rule in glossary.term_rules for alias in rule.aliases},
        )
        if rules:
            logger.info(
                "Mod translation harvest: %d terms from %d translated lang files",
                len(rules),
                len(candidates),
            )
        return rules

    def _persist_extracted_terms(self, rules: list[TermRule]) -> None:
        """Extracted terms land in the user glossary store so the hub's
        glossary screen (and future runs' TM/glossary merge) can see them.
        Store I/O failure only logs - it never kills a run."""
        store_dir = self.config.glossary_store_dir or default_glossary_store_dir()
        try:
            added = merge_extracted_terms(
                store_dir,
                self.config.source_locale,
                self.config.target_locale,
                [(alias, rule.term_ko) for rule in rules for alias in rule.aliases],
            )
        except OSError:
            logger.exception("Failed to persist extracted glossary terms")
            return
        if added:
            logger.info("User glossary store: %d extracted terms added", added)

    def _load_user_glossary(self) -> list[TermRule]:
        """Store terms (manual/extracted + synced vanilla/community) as rules."""
        if not self.config.use_user_glossary:
            return []
        store_dir = self.config.glossary_store_dir or default_glossary_store_dir()
        rules: list[TermRule] = []
        for term in load_user_glossary_terms(
            store_dir, self.config.source_locale, self.config.target_locale
        ):
            source = str(term.get("source") or "").strip()
            target = str(term.get("target") or "").strip()
            if not source or not target:
                continue
            origin = str(term.get("origin") or "manual")
            # Vanilla rows are server-synced; the config toggle opts out of
            # them without touching the rest of the store.
            if origin == "vanilla" and not self.config.use_vanilla_glossary:
                continue
            rules.append(
                TermRule(
                    term_ko=target,
                    preferred_style="용어 고정",
                    aliases=[source],
                    notes=f"user glossary ({origin})",
                )
            )
        if rules:
            logger.info("User glossary store: %d terms merged", len(rules))
        return rules

    async def _curate_glossary_chunk(
        self,
        extractor: GlossaryExtractor,
        glossary: Glossary,
        chunk: list[TermCandidate],
        index: int,
        total: int,
        progress: dict[str, int],
    ) -> list[TermRule]:
        """One curation LLM call with schema-error feedback retries.

        A schema-invalid response (wrong category literal, missing field -
        pydantic rejects it inside the DSPy adapter) is retried up to
        glossary_max_retries times with the error text fed back as the
        `feedback` input. Glossary curation is an enhancement: a chunk
        that still fails is skipped with a warning, never fatal.
        """
        feedback = ""
        for attempt in range(1, self.config.glossary_max_retries + 2):
            self._check_cancelled()
            try:
                async with self._llm_semaphore:
                    self._check_cancelled()
                    with dspy.context(lm=self.lm, adapter=dspy.JSONAdapter()):
                        pred = await extractor.acall(
                            candidates="\n".join(c.as_line() for c in chunk),
                            existing_glossary=GlossaryFilter.filter_for_texts(
                                glossary,
                                {str(i): c.term for i, c in enumerate(chunk)},
                            ).to_context_string(),
                            target_lang=self.config.target_locale,
                            feedback=feedback,
                        )
                return list(pred.term_rules or [])
            except Exception as exc:  # noqa: BLE001 — LLM output is untrusted
                error = str(exc)
                skipped = attempt > self.config.glossary_max_retries
                logger.warning(
                    "Glossary chunk %d/%d attempt %d failed%s: %s",
                    index + 1,
                    total,
                    attempt,
                    " (skipping chunk)" if skipped else " (retrying)",
                    error[:500],
                )
                self._emit(
                    "glossary_progress",
                    {
                        "done": progress["done"],
                        "total": total,
                        "new_terms": progress["new_terms"],
                        "chunk": index + 1,
                        "attempt": attempt,
                        "error": error[:300],
                        "skipped": skipped,
                    },
                )
                if skipped:
                    return []
                # Full error text goes back to the model; pydantic messages
                # name the offending index/field, which is exactly the fix
                # instruction the retry needs.
                feedback = error[:2000]
            finally:
                # Glossary curation uses the same LM as translation. Publish
                # cumulative usage after every attempt so token/cost cards do
                # not sit at zero until the first translation batch.
                self._emit("tokens", token_usage(self.lm))
        return []

    # -- batching ----------------------------------------------------------

    def _make_batches(self, entries: Mapping[str, str]) -> list[dict[str, str]]:
        return batching.pack_batches(
            entries,
            batch_size=self.config.batch_size,
            max_batch_chars=self.config.max_batch_chars,
        )

    async def _translate_batch(
        self,
        batch: dict[str, str],
        glossary_text: str,
        context: str,
        *,
        file: str | None = None,
    ) -> tuple[dict[str, str], dict[str, list[str]]]:
        """One guarded module call; on adapter/parse failure split and retry."""
        async with self._llm_semaphore:
            self._check_cancelled()
            self._request_counter += 1
            request_id = self._request_counter
            self._emit(
                "batch_started",
                {
                    "request_id": request_id,
                    "file": file or context,
                    "key": next(iter(batch)),
                    "entries": len(batch),
                },
            )
            try:
                # Task-local LM binding: dspy.configure() is single-task only,
                # and server jobs run in separate asyncio tasks.
                with dspy.context(lm=self.lm, adapter=dspy.JSONAdapter()):
                    pred = await self.translator.acall(
                        source_lang=self.config.source_locale,
                        target_lang=self.config.target_locale,
                        context=context,
                        glossary=glossary_text,
                        entries=batch,
                    )
                return dict(pred.translations), dict(pred.failed)
            except Exception as exc:  # noqa: BLE001 — LLM/adapter errors
                if len(batch) == 1:
                    key = next(iter(batch))
                    logger.error("Translation failed for %s: %s", key, exc)
                    return {}, {key: [f"llm call failed: {exc}"]}
            finally:
                self._emit("batch_finished", {"request_id": request_id})
        # Split outside the semaphore to avoid deadlock.
        items = list(batch.items())
        mid = len(items) // 2
        left, right = dict(items[:mid]), dict(items[mid:])
        logger.warning(
            "Batch of %d failed; splitting into %d + %d",
            len(batch),
            len(left),
            len(right),
        )
        l_res, r_res = await asyncio.gather(
            self._translate_batch(left, glossary_text, context, file=file),
            self._translate_batch(right, glossary_text, context, file=file),
        )
        return {**l_res[0], **r_res[0]}, {**l_res[1], **r_res[1]}

    # -- per-file processing -------------------------------------------------

    async def _process_pair(
        self,
        pair: LanguageFilePair,
        glossary: Glossary,
        glossary_version: str,
        validator: TranslationValidator,
        result: PipelineResult,
    ) -> None:
        async with self._file_semaphore:
            self._check_cancelled()
            handler = self.registry.get_handler(pair.source_path)
            if handler is None:
                logger.warning("No handler for %s", pair.source_path)
                return
            rel = self._relative(pair.source_path)
            source_data = dict(await handler.extract(pair.source_path))
            if not source_data:
                return

            existing: dict[str, str] = {}
            if pair.target_path is not None and pair.target_path.exists():
                existing = dict(await handler.extract(pair.target_path))
            # Reuse only REAL existing translations. Mods routinely copy the
            # source-locale file into other locales (wholly or partially);
            # identical values are untranslated filler that must reach the
            # LLM.
            existing_keys = {
                key
                for key, text in source_data.items()
                if not is_untranslated_copy(text, existing.get(key, ""))
            }
            work_total = len(source_data) - len(existing_keys)

            final: dict[str, str] = {}
            file_entries: list[EntryResult] = []
            protector = PlaceholderProtector()
            protected_map: dict[str, ProtectedText] = {}
            to_translate: dict[str, str] = {}

            for key, text in source_data.items():
                if key in existing_keys:
                    final[key] = existing[key]
                    file_entries.append(
                        EntryResult(
                            key=key,
                            file=rel,
                            source_text=text,
                            translated_text=existing[key],
                            status=EntryStatus.SKIPPED,
                        )
                    )
                    continue
                protected = protector.protect(text)
                if (
                    protector.is_only_placeholders(protected)
                    or not text.strip()
                    or looks_like_identifier(text)
                ):
                    final[key] = text
                    file_entries.append(
                        EntryResult(
                            key=key,
                            file=rel,
                            source_text=text,
                            translated_text=text,
                            status=EntryStatus.SKIPPED,
                        )
                    )
                    continue
                protected_map[key] = protected
                to_translate[key] = protected.protected

            # TM lookup on raw source text
            tm_hits: dict[str, str] = {}
            if self.tm is not None and to_translate:
                raw = {k: source_data[k] for k in to_translate}
                tm_hits = await asyncio.to_thread(
                    self.tm.lookup_many,
                    raw,
                    self.config.target_locale,
                    glossary_version,
                )
                for key, translated in tm_hits.items():
                    final[key] = translated
                    to_translate.pop(key, None)
                    file_entries.append(
                        EntryResult(
                            key=key,
                            file=rel,
                            source_text=source_data[key],
                            translated_text=translated,
                            status=EntryStatus.TM_HIT,
                        )
                    )

            if work_total > 0:
                self._emit(
                    "progress",
                    {
                        "stage": "translate",
                        "file": rel,
                        "done": len(final) - len(existing_keys),
                        "total": work_total,
                    },
                )
            context = f"file: {rel}; handler: {handler.name}"
            translated_raw: dict[str, str] = {}

            async def translate_one(
                batch: dict[str, str],
            ) -> tuple[
                dict[str, str],
                dict[str, str],
                dict[str, list[str]],
            ]:
                self._check_cancelled()
                # Prompt only the glossary rules relevant to THIS batch —
                # rendering the whole store (a synced vanilla set alone is
                # thousands of rules) blows up the prompt and derails small
                # models.
                batch_glossary = GlossaryFilter.filter_for_texts(
                    glossary, {k: source_data[k] for k in batch}
                ).to_context_string()
                translations, failed = await self._translate_batch(
                    batch, batch_glossary, context, file=rel
                )
                return batch, translations, failed

            batch_tasks = [
                asyncio.create_task(translate_one(batch))
                for batch in self._make_batches(to_translate)
            ]
            was_cancelled = False
            try:
                for completed in asyncio.as_completed(batch_tasks):
                    batch, translations, failed = await completed
                    for key in batch:
                        protected = protected_map[key]
                        out = translations.get(key)
                        errors = list(failed.get(key, []))
                        if out is None:
                            file_entries.append(
                                EntryResult(
                                    key=key,
                                    file=rel,
                                    source_text=source_data[key],
                                    status=EntryStatus.FAILED,
                                    errors=errors or ["no translation returned"],
                                )
                            )
                            continue
                        try:
                            restored = protected.restore(out)
                        except PlaceholderError as exc:
                            file_entries.append(
                                EntryResult(
                                    key=key,
                                    file=rel,
                                    source_text=source_data[key],
                                    translated_text=out,
                                    status=EntryStatus.FAILED,
                                    errors=[*errors, str(exc)],
                                )
                            )
                            continue
                        translated_raw[key] = restored
                        self._entry_counter += 1
                        if self._entry_counter % ENTRY_TICKER_INTERVAL == 1:
                            # Sampled live preview pair for the GUI ticker.
                            self._emit(
                                "entry_done",
                                {
                                    "key": key,
                                    "source": source_data[key][:TICKER_TEXT_LIMIT],
                                    "translated": restored[:TICKER_TEXT_LIMIT],
                                },
                            )
                    self._emit(
                        "progress",
                        {
                            "stage": "translate",
                            "file": rel,
                            # Existing target-locale keys are excluded from the
                            # scan totals and therefore from live progress.
                            "done": len(final)
                            - len(existing_keys)
                            + len(translated_raw),
                            "total": work_total,
                        },
                    )
                    # lm.history aggregation is O(calls); once per completed
                    # batch keeps live token/cost counters current.
                    self._emit("tokens", token_usage(self.lm))
            except asyncio.CancelledError:
                was_cancelled = True
            finally:
                for task in batch_tasks:
                    if not task.done():
                        task.cancel()
                if batch_tasks:
                    await asyncio.gather(*batch_tasks, return_exceptions=True)

            # Post-restore validation with the full validator
            if translated_raw:
                report = validator.validate(
                    {k: source_data[k] for k in translated_raw}, translated_raw
                )
                issues_by_key: dict[str, list[str]] = {}
                error_keys: set[str] = set()
                for issue in report.issues:
                    issues_by_key.setdefault(issue.key, []).append(issue.message)
                    if issue.severity == ValidationSeverity.ERROR:
                        error_keys.add(issue.key)
                for key, translated in translated_raw.items():
                    issues = issues_by_key.get(key, [])
                    if key in error_keys:
                        file_entries.append(
                            EntryResult(
                                key=key,
                                file=rel,
                                source_text=source_data[key],
                                translated_text=translated,
                                status=EntryStatus.FAILED,
                                errors=issues,
                            )
                        )
                        self._emit(
                            "entry_failed", {"key": key, "errors": issues}
                        )
                        continue
                    final[key] = translated
                    file_entries.append(
                        EntryResult(
                            key=key,
                            file=rel,
                            source_text=source_data[key],
                            translated_text=translated,
                            status=(
                                EntryStatus.WARNING if issues else EntryStatus.PASSED
                            ),
                            errors=issues,
                        )
                    )

            # Concurrent batches finish out of order; restore source order for
            # review rows and generated language files. Extend before the
            # optional TM write so cancellation still preserves these entries.
            key_order = {key: index for index, key in enumerate(source_data)}
            file_entries.sort(key=lambda entry: key_order[entry.key])
            result.entries.extend(file_entries)

            # Persist fresh translations into TM only on the normal path.
            if self.tm is not None and not was_cancelled:
                stored = [
                    (source_data[k], v)
                    for k, v in translated_raw.items()
                    if k in final
                ]
                if stored:
                    await asyncio.to_thread(
                        self.tm.store_many,
                        stored,
                        self.config.target_locale,
                        glossary_version,
                    )

            if was_cancelled:
                raise asyncio.CancelledError("file translation cancelled")

    def _relative(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(
                self.config.modpack_path.resolve()
            ).as_posix()
        except ValueError:
            return path.as_posix()

    @staticmethod
    def _stage_frame(done: int) -> dict[str, object]:
        return {"stage": "write", "done": done, "total": 1}

    # -- entry point ---------------------------------------------------------

    async def run(self, scan_result: ScanResult | None = None) -> PipelineResult:
        started = time.monotonic()
        result = PipelineResult(config=self.config)
        cancelled = False

        try:
            self._emit("progress", {"stage": "scan", "done": 0, "total": 1})
            if scan_result is None:
                scanner = ModpackScanner(
                    source_locale=self.config.source_locale,
                    target_locale=self.config.target_locale,
                )
                scan_result = await scanner.scan(self.config.modpack_path)
            result.scan_result = scan_result
            result.artifact_id = self.artifact_id

            pairs = scan_result.all_translation_pairs
            if self.config.include_categories is not None:
                allowed = set(self.config.include_categories)
                category_by_path = {
                    str(Path(tf.input_path)): tf.category or tf.file_type
                    for tf in scan_result.translation_files
                }
                pairs = [
                    p
                    for p in pairs
                    if category_by_path.get(str(p.source_path)) in allowed
                ]
            result.stats.total_files = len(pairs)

            self._emit("progress", {"stage": "glossary", "done": 0, "total": 1})
            # Harvest scope = every paired file in the scan, regardless of
            # the include_categories translate scope: existing translations
            # in an excluded category are still terminology evidence.
            glossary, glossary_version = await self._build_glossary(
                pairs, harvest_pairs=scan_result.paired_files
            )
            result.glossary = glossary
            validator = TranslationValidator(
                glossary if glossary.has_rules else None
            )

            pair_tasks = [
                asyncio.create_task(
                    self._process_pair(
                        pair, glossary, glossary_version, validator, result
                    )
                )
                for pair in pairs
            ]
            try:
                await asyncio.gather(*pair_tasks)
            except asyncio.CancelledError:
                # gather propagates cancellation before child cleanup is
                # necessarily visible. Wait for every file task to flush its
                # completed batches into the shared partial result.
                if pair_tasks:
                    await asyncio.gather(*pair_tasks, return_exceptions=True)
                raise
            self._check_cancelled()
        except asyncio.CancelledError:
            # Cancellation is a successful partial-result boundary, not a
            # failed pipeline. Completed batches/files remain in `result`.
            cancelled = True
            logger.info(
                "Pipeline cancellation captured with %d partial entries",
                len(result.entries),
            )

        # Generate installable trees from every preserved partial entry. A
        # cancellation arriving during the write is consumed once and retried.
        if result.entries:
            self._emit("progress", self._stage_frame(0))
            try:
                await write_outputs(result)
            except asyncio.CancelledError:
                cancelled = True
                await write_outputs(result)
            self._emit("progress", self._stage_frame(1))

        usage = token_usage(self.lm)
        stats = result.stats
        stats.total_entries = len(result.entries)
        stats.tm_hits = sum(
            1 for e in result.entries if e.status == EntryStatus.TM_HIT
        )
        stats.skipped_entries = sum(
            1 for e in result.entries if e.status == EntryStatus.SKIPPED
        )
        stats.failed_entries = sum(
            1 for e in result.entries if e.status == EntryStatus.FAILED
        )
        stats.translated_entries = sum(
            1
            for e in result.entries
            if e.status in (EntryStatus.PASSED, EntryStatus.WARNING)
        )
        stats.categories = category_stats(result)
        stats.prompt_tokens = usage["prompt_tokens"]
        stats.completion_tokens = usage["completion_tokens"]
        stats.cached_tokens = usage["cached_tokens"]
        stats.duration_seconds = round(time.monotonic() - started, 2)
        stats.finalize()

        if not cancelled:
            self._emit("done", {"stats": stats.model_dump()})
            logger.info(
                "Pipeline done: %d translated, %d TM hits, %d failed, "
                "%d skipped (%.1fs)",
                stats.translated_entries,
                stats.tm_hits,
                stats.failed_entries,
                stats.skipped_entries,
                stats.duration_seconds,
            )
        return result

    async def retry_failed(self, result: PipelineResult) -> PipelineResult:
        """Re-translate failed entries, mutating the same PipelineResult."""
        failed = result.failed
        if not failed:
            return result
        glossary = result.glossary
        if glossary is None:  # result predates run-scoped glossary storage
            glossary, _ = await self._build_glossary([])
        validator = TranslationValidator(glossary if glossary.has_rules else None)

        by_file: dict[str, list[EntryResult]] = {}
        for entry in failed:
            by_file.setdefault(entry.file, []).append(entry)

        for rel, entries in by_file.items():
            protector = PlaceholderProtector()
            protected = {e.key: protector.protect(e.source_text) for e in entries}
            batch = {e.key: protected[e.key].protected for e in entries}
            batch_glossary = GlossaryFilter.filter_for_texts(
                glossary, {e.key: e.source_text for e in entries}
            ).to_context_string()
            translations, failures = await self._translate_batch(
                batch, batch_glossary, f"retry; file: {rel}"
            )
            for entry in entries:
                out = translations.get(entry.key)
                if out is None:
                    entry.errors = failures.get(entry.key, entry.errors)
                    continue
                try:
                    restored = protected[entry.key].restore(out)
                except PlaceholderError as exc:
                    entry.errors = [str(exc)]
                    continue
                report = validator.validate(
                    {entry.key: entry.source_text}, {entry.key: restored}
                )
                if report.get_errors():
                    entry.errors = [i.message for i in report.get_errors()]
                    continue
                entry.translated_text = restored
                entry.status = EntryStatus.MODIFIED
                entry.errors = []
        self._refresh_stats(result)
        return result

    async def retranslate_entry(
        self, result: PipelineResult, key: str, file: str | None = None
    ) -> EntryResult:
        """Re-translate ONE entry in place (review screen "AI retranslate").

        Works on entries in any status. Success marks the entry MODIFIED
        with cleared errors. Failure of a FAILED entry refreshes its error
        list; failure of a previously passing entry leaves it untouched and
        raises RetranslateError so the caller can surface the reason.
        """
        entry = next(
            (
                e
                for e in result.entries
                if e.key == key and (file is None or e.file == file)
            ),
            None,
        )
        if entry is None:
            raise KeyError(key)
        glossary = result.glossary
        if glossary is None:  # result predates run-scoped glossary storage
            glossary, _ = await self._build_glossary([])
        validator = TranslationValidator(glossary if glossary.has_rules else None)

        protector = PlaceholderProtector()
        protected = protector.protect(entry.source_text)
        batch_glossary = GlossaryFilter.filter_for_texts(
            glossary, {entry.key: entry.source_text}
        ).to_context_string()
        translations, failures = await self._translate_batch(
            {entry.key: protected.protected},
            batch_glossary,
            f"retranslate; file: {entry.file}",
        )

        errors: list[str]
        restored: str | None = None
        out = translations.get(entry.key)
        if out is None:
            errors = failures.get(entry.key, ["model returned no translation"])
        else:
            try:
                restored = protected.restore(out)
                report = validator.validate(
                    {entry.key: entry.source_text}, {entry.key: restored}
                )
                errors = [i.message for i in report.get_errors()]
            except PlaceholderError as exc:
                errors = [str(exc)]

        if errors:
            if entry.status is EntryStatus.FAILED:
                entry.errors = errors
                return entry
            raise RetranslateError("; ".join(errors))

        assert restored is not None  # errors == [] implies successful restore
        entry.translated_text = restored
        entry.status = EntryStatus.MODIFIED
        entry.errors = []
        self._refresh_stats(result)
        return entry

    @staticmethod
    def _refresh_stats(result: PipelineResult) -> None:
        """Recompute the counters a post-run mutation can change."""
        stats = result.stats
        stats.failed_entries = len(result.failed)
        stats.translated_entries = sum(
            1
            for e in result.entries
            if e.status
            in (EntryStatus.PASSED, EntryStatus.WARNING, EntryStatus.MODIFIED)
        )
        stats.categories = category_stats(result)
        stats.finalize()

    def close(self) -> None:
        if self.tm is not None:
            self.tm.close()


async def run_pipeline(
    config: PipelineConfig,
    *,
    on_event: Callable[[str, dict[str, object]], None] | None = None,
    cancel_check: Callable[[], bool] | None = None,
) -> PipelineResult:
    """Convenience wrapper: build, run, close."""
    pipeline = TranslationPipeline(
        config, on_event=on_event, cancel_check=cancel_check
    )
    try:
        return await pipeline.run()
    finally:
        pipeline.close()


def output_root(config: PipelineConfig) -> Path:
    """Root directory holding the generated output trees."""
    return config.output_dir or (config.modpack_path / "moru_output")


#: Statuses whose translation was produced by THIS run (vs. pre-existing).
_FRESH_STATUSES = (
    EntryStatus.PASSED,
    EntryStatus.WARNING,
    EntryStatus.MODIFIED,
    EntryStatus.TM_HIT,
)


async def write_outputs(result: PipelineResult) -> GenerationResult:
    """(Re)generate the installable outputs from ``result.entries``.

    Entries are the single source of truth: fresh statuses feed the
    resource pack (already-translated pairs are omitted), while override
    files additionally carry pre-existing SKIPPED translations because
    they replace whole files. Idempotent — wipes and rewrites the trees.
    """
    config = result.config
    namespaces: dict[str, str] = {}
    if result.scan_result is not None:
        for pair in result.scan_result.all_translation_pairs:
            namespaces[pair.source_path.resolve().as_posix()] = pair.namespace

    outputs: dict[str, FileOutput] = {}
    for entry in result.entries:
        if entry.status is EntryStatus.FAILED or not entry.translated_text:
            continue
        file_output = outputs.get(entry.file)
        if file_output is None:
            source_path = config.modpack_path / entry.file
            file_output = FileOutput(
                source_path=source_path,
                fresh={},
                full={},
                namespace=namespaces.get(source_path.resolve().as_posix(), ""),
            )
            outputs[entry.file] = file_output
        file_output.full[entry.key] = entry.translated_text
        if entry.status in _FRESH_STATUSES:
            file_output.fresh[entry.key] = entry.translated_text

    # The description shows under the moru icon in the resource-pack UI.
    # The pack list already displays the pack's name, so the description
    # carries only the translated version + attribution, e.g.
    # "v6.5.4hotfix / §a모루§7로 한국어로 번역됨 — §amoru.gg".
    # (identity versions are pre-stripped of any leading "v" marker.)
    identity = detect_pack_identity(config.modpack_path)
    version_prefix = f"v{identity.version} / " if identity.version else ""
    pack_format = pack_format_for_minecraft_version(
        identity.mc_version,
        config.pack_format,
    )
    generator = OutputGenerator(
        OutputConfig(
            modpack_root=config.modpack_path,
            output_dir=output_root(config),
            source_locale=config.source_locale,
            target_locale=config.target_locale,
            pack_format=pack_format,
            description=f"{version_prefix}§a모루§7로 한국어로 번역됨 — §amoru.gg",
        )
    )
    generation = await generator.generate(list(outputs.values()))
    result.output_files = generation.all_files
    return generation


async def apply_entry_edits(result: PipelineResult) -> int:
    """Regenerate outputs when entries were edited after the run.

    Review-screen mutations (manual PATCH, AI retranslate) change
    ``result.entries`` in memory but not the files the pipeline already
    wrote. Called before export/upload so the zips carry the reviewed
    state. Returns the number of files written (0 when nothing changed).
    """
    if not any(e.status is EntryStatus.MODIFIED for e in result.entries):
        return 0
    generation = await write_outputs(result)
    return len(generation.all_files)
