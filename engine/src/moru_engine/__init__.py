"""Moru translation engine.

DSPy-based Minecraft modpack translation engine. External consumers
(desktop app, CLI, tools) MUST import from this package root, not deep
paths.
"""

from __future__ import annotations

from .dspy_modules import BatchTranslator, build_lm, configure_engine, load_translator
from .handlers import ContentHandler, HandlerRegistry
from .handlers.base import create_default_registry
from .models import Glossary, TermRule
from .pipeline import (
    EntryResult,
    EntryStatus,
    PipelineConfig,
    PipelineResult,
    TranslationPipeline,
    run_pipeline,
)
from .placeholder import PlaceholderError, PlaceholderProtector
from .scanner import ModpackScanner, ScanResult, scan_modpack
from .validator import TranslationValidator

__version__ = "0.8.2"

__all__ = [
    "BatchTranslator",
    "ContentHandler",
    "EntryResult",
    "EntryStatus",
    "Glossary",
    "HandlerRegistry",
    "ModpackScanner",
    "PipelineConfig",
    "PipelineResult",
    "PlaceholderError",
    "PlaceholderProtector",
    "ScanResult",
    "TermRule",
    "TranslationPipeline",
    "TranslationValidator",
    "__version__",
    "build_lm",
    "configure_engine",
    "create_default_registry",
    "load_translator",
    "run_pipeline",
    "scan_modpack",
]
