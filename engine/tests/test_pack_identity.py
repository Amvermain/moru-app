"""Tests for launcher-metadata pack identity detection.

Covers every detection source in scanner.pack_identity against tmp_path
fixture layouts, plus the plumbing: identity on the scan payload and
curseforge_id on the upload payload. No network, no LLM.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from moru_engine.pipeline import PipelineConfig, PipelineResult, PipelineStats
from moru_engine.scanner import ScanResult
from moru_engine.scanner.pack_identity import PackIdentity, detect_pack_identity
from moru_engine.server.jobs import (
    EnrichedScanResult,
    JobManager,
    JobParamsError,
    JobRecord,
    JobStatus,
    JobType,
    scan_result_payload,
)


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


# -- CurseForge app instance ---------------------------------------------------


def test_curseforge_launcher_instance(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "minecraftinstance.json",
        {
            "name": "All the Mods 10",
            "gameVersion": "1.21.1",
            "baseModLoader": {
                "name": "neoforge-21.1.77",
                "minecraftVersion": "1.21.1",
            },
            "installedModpack": {
                "addonID": 925200,
                "installedFile": {
                    "id": 5820002,
                    "projectId": 925200,
                    "displayName": "ATM10-2.32",
                    "fileNameOnDisk": "ATM10-2.32.zip",
                },
            },
        },
    )
    assert detect_pack_identity(tmp_path) == PackIdentity(
        name="All the Mods 10",
        version="2.32",
        mc_version="1.21.1",
        loader="neoforge",
        curseforge_project_id=925200,
        curseforge_file_id=5820002,
        source="curseforge_instance",
        confident=True,
    )


def test_curseforge_instance_version_falls_back_to_filename(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "minecraftinstance.json",
        {
            "name": "Some Pack",
            "installedModpack": {
                "installedFile": {
                    "projectId": 111,
                    "fileNameOnDisk": "SomePack-1.0.zip",
                },
            },
        },
    )
    identity = detect_pack_identity(tmp_path)
    assert identity.version == "1.0"
    assert identity.curseforge_project_id == 111
    assert identity.curseforge_file_id is None


def test_version_strips_redundant_pack_name_prefix(tmp_path: Path) -> None:
    """CF display names repeat the whole pack name; only the tail survives."""
    _write_json(
        tmp_path / "minecraftinstance.json",
        {
            "name": "Boosted FPS Fabric",
            "installedModpack": {
                "installedFile": {
                    "displayName": "Boosted FPS Fabric-26.2-1.7.4",
                },
            },
        },
    )
    assert detect_pack_identity(tmp_path).version == "26.2-1.7.4"


def test_version_drops_leading_v_marker(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "minecraftinstance.json",
        {
            "name": "Some Pack",
            "installedModpack": {
                "installedFile": {"displayName": "Some Pack v1.7.4"},
            },
        },
    )
    assert detect_pack_identity(tmp_path).version == "1.7.4"


def test_version_without_numeric_tail_kept_verbatim(tmp_path: Path) -> None:
    """No digit-leading token -> pass through, minus the archive suffix."""
    _write_json(
        tmp_path / "minecraftinstance.json",
        {
            "name": "Some Pack",
            "installedModpack": {
                "installedFile": {"displayName": "indev-beta.zip"},
            },
        },
    )
    assert detect_pack_identity(tmp_path).version == "indev-beta"


def test_curseforge_instance_found_one_level_up_from_game_dir(
    tmp_path: Path,
) -> None:
    game_dir = tmp_path / ".minecraft"
    game_dir.mkdir()
    _write_json(
        tmp_path / "minecraftinstance.json",
        {"name": "Up One Level", "gameVersion": "1.20.1"},
    )
    identity = detect_pack_identity(game_dir)
    assert identity.source == "curseforge_instance"
    assert identity.name == "Up One Level"
    assert identity.mc_version == "1.20.1"


# -- CurseForge export manifest --------------------------------------------------


def test_curseforge_export_manifest(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "manifest.json",
        {
            "manifestType": "minecraftModpack",
            "name": "Craft to Exile 2",
            "version": "0.5.3",
            "minecraft": {
                "version": "1.20.1",
                "modLoaders": [{"id": "forge-47.3.0", "primary": True}],
            },
        },
    )
    identity = detect_pack_identity(tmp_path)
    assert identity.source == "curseforge_manifest"
    assert identity.confident is True
    assert identity.name == "Craft to Exile 2"
    assert identity.version == "0.5.3"
    assert identity.mc_version == "1.20.1"
    assert identity.loader == "forge"
    assert identity.curseforge_project_id is None


def test_manifest_found_one_level_down_in_game_dir(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "minecraft" / "manifest.json",
        {"manifestType": "minecraftModpack", "name": "Nested Pack"},
    )
    identity = detect_pack_identity(tmp_path)
    assert identity.source == "curseforge_manifest"
    assert identity.name == "Nested Pack"


def test_non_modpack_manifest_is_ignored(tmp_path: Path) -> None:
    pack = tmp_path / "not-a-pack"
    pack.mkdir()
    _write_json(pack / "manifest.json", {"manifestType": "other", "name": "x"})
    identity = detect_pack_identity(pack)
    assert identity.source == "folder"
    assert identity.name == "not-a-pack"


# -- Modrinth pack index ---------------------------------------------------------


def test_modrinth_pack_index(tmp_path: Path) -> None:
    _write_json(
        tmp_path / "modrinth.index.json",
        {
            "name": "Fabulously Optimized",
            "versionId": "5.11.2",
            "dependencies": {"minecraft": "1.21.1", "fabric-loader": "0.16.5"},
        },
    )
    identity = detect_pack_identity(tmp_path)
    assert identity.source == "modrinth_pack"
    assert identity.confident is True
    assert identity.name == "Fabulously Optimized"
    assert identity.version == "5.11.2"
    assert identity.modrinth_version_id == "5.11.2"
    assert identity.mc_version == "1.21.1"
    assert identity.loader == "fabric"
    assert identity.modrinth_project_id is None


# -- Prism / MultiMC -------------------------------------------------------------

_PRISM_FLAME_CFG = """\
[General]
ConfigVersion=1.2
InstanceType=OneSix
ManagedPack=true
ManagedPackID=925200
ManagedPackName=All the Mods 10
ManagedPackType=flame
ManagedPackVersionID=5820002
ManagedPackVersionName=2.32
name=All the Mods 10
"""


def test_prism_flame_managed_instance(tmp_path: Path) -> None:
    inst = tmp_path / "All the Mods 10"
    game_dir = inst / ".minecraft"
    game_dir.mkdir(parents=True)
    (inst / "instance.cfg").write_text(_PRISM_FLAME_CFG, encoding="utf-8")
    _write_json(
        inst / "mmc-pack.json",
        {
            "formatVersion": 1,
            "components": [
                {"uid": "net.minecraft", "version": "1.21.1"},
                {"uid": "net.neoforged", "version": "21.1.77"},
            ],
        },
    )
    # Detection pointed at the game dir, the folder users actually pick.
    assert detect_pack_identity(game_dir) == PackIdentity(
        name="All the Mods 10",
        version="2.32",
        mc_version="1.21.1",
        loader="neoforge",
        curseforge_project_id=925200,
        curseforge_file_id=5820002,
        source="prism_managed",
        confident=True,
    )


def test_prism_modrinth_managed_instance(tmp_path: Path) -> None:
    inst = tmp_path / "fo"
    inst.mkdir()
    (inst / "instance.cfg").write_text(
        "[General]\n"
        "name=Fabulously Optimized\n"
        "ManagedPack=true\n"
        "ManagedPackType=modrinth\n"
        "ManagedPackID=1KVo5zza\n"
        "ManagedPackVersionID=abcDEF12\n"
        "ManagedPackVersionName=5.11.2\n",
        encoding="utf-8",
    )
    identity = detect_pack_identity(inst)
    assert identity.source == "prism_managed"
    assert identity.modrinth_project_id == "1KVo5zza"
    assert identity.modrinth_version_id == "abcDEF12"
    assert identity.version == "5.11.2"
    assert identity.curseforge_project_id is None


def test_prism_flame_non_numeric_ids_guarded(tmp_path: Path) -> None:
    inst = tmp_path / "weird"
    inst.mkdir()
    (inst / "instance.cfg").write_text(
        "ManagedPack=true\n"
        "ManagedPackType=flame\n"
        "ManagedPackID=not-a-number\n"
        "ManagedPackVersionID=also-not\n"
        "name=Weird Pack\n",
        encoding="utf-8",
    )
    identity = detect_pack_identity(inst)
    assert identity.source == "prism_managed"
    assert identity.curseforge_project_id is None
    assert identity.curseforge_file_id is None
    assert identity.name == "Weird Pack"


def test_prism_unmanaged_instance(tmp_path: Path) -> None:
    inst = tmp_path / "my-pack"
    game_dir = inst / "minecraft"
    game_dir.mkdir(parents=True)
    # Header-less MultiMC-style cfg exercises the raw key=value parser.
    (inst / "instance.cfg").write_text(
        "InstanceType=OneSix\nname=My Custom Pack\n", encoding="utf-8"
    )
    _write_json(
        inst / "mmc-pack.json",
        {
            "components": [
                {"uid": "net.minecraft", "version": "1.20.1"},
                {"uid": "net.fabricmc.fabric-loader", "version": "0.16.5"},
            ],
        },
    )
    identity = detect_pack_identity(game_dir)
    assert identity.source == "prism_instance"
    assert identity.confident is True
    assert identity.name == "My Custom Pack"
    assert identity.mc_version == "1.20.1"
    assert identity.loader == "fabric"
    assert identity.curseforge_project_id is None


# -- fallback + tolerance --------------------------------------------------------


def test_bare_folder_fallback(tmp_path: Path) -> None:
    pack = tmp_path / "Some Random Pack"
    pack.mkdir()
    assert detect_pack_identity(pack) == PackIdentity(
        name="Some Random Pack", source="folder", confident=False
    )


def test_game_dir_fallback_names_parent(tmp_path: Path) -> None:
    game_dir = tmp_path / "Vanilla Plus" / ".minecraft"
    game_dir.mkdir(parents=True)
    identity = detect_pack_identity(game_dir)
    assert identity.source == "folder"
    assert identity.name == "Vanilla Plus"


def test_corrupt_metadata_falls_through_to_folder(tmp_path: Path) -> None:
    pack = tmp_path / "broken"
    pack.mkdir()
    (pack / "minecraftinstance.json").write_text("{not json", encoding="utf-8")
    (pack / "manifest.json").write_text("[1, 2", encoding="utf-8")
    (pack / "modrinth.index.json").write_bytes(b"\xff\xfe\x00garbage")
    identity = detect_pack_identity(pack)
    assert identity.source == "folder"
    assert identity.confident is False
    assert identity.name == "broken"


# -- scan payload plumbing -------------------------------------------------------


def test_scan_result_payload_carries_identity(tmp_path: Path) -> None:
    enriched = EnrichedScanResult(
        scan=ScanResult(modpack_path=tmp_path),
        identity=PackIdentity(name="ATM 10", source="folder", confident=False),
    )
    payload = scan_result_payload(enriched)
    # Full wire shape of the contract identity object.
    assert payload["identity"] == {
        "name": "ATM 10",
        "version": None,
        "mc_version": None,
        "loader": None,
        "curseforge_project_id": None,
        "curseforge_file_id": None,
        "modrinth_project_id": None,
        "modrinth_version_id": None,
        "source": "folder",
        "confident": False,
    }


# -- upload payload plumbing -----------------------------------------------------

#: _pack_payload slots argument: {kind: slot} for every uploaded archive.
_SLOT = {
    "resource_pack": {
        "kind": "resource_pack",
        "url": "https://r2.test/put",
        "object_key": "packs/x.zip",
    }
}


def _translate_record(tmp_path: Path) -> JobRecord:
    """Completed translate JobRecord built by hand (no LLM run)."""
    output_dir = tmp_path / "out"
    lang_file = output_dir / "assets" / "somemod" / "lang" / "ko_kr.json"
    lang_file.parent.mkdir(parents=True)
    lang_file.write_text('{"key.hello": "안녕"}', encoding="utf-8")
    result = PipelineResult(
        config=PipelineConfig(
            modpack_path=tmp_path / "modpack",
            output_dir=output_dir,
            source_locale="en_us",
            target_locale="ko_kr",
            model="openai/gpt-4o-mini",
        ),
        output_files=[lang_file],
        stats=PipelineStats(
            total_entries=10, translated_entries=8, failed_entries=1
        ),
    )
    result.stats.finalize()
    return JobRecord(
        id=f"translate-{uuid.uuid4()}",
        type=JobType.TRANSLATE,
        params={},
        status=JobStatus.DONE,
        result=result,
        finished=True,
    )


def _upload_record(source: JobRecord, **extra: object) -> JobRecord:
    params: dict[str, object] = {
        "translate_job_id": source.id,
        "modpack_name": "ATM 10",
        **extra,
    }
    return JobRecord(id="upload-1", type=JobType.UPLOAD, params=params)


def test_pack_payload_includes_curseforge_id(tmp_path: Path) -> None:
    source = _translate_record(tmp_path)
    record = _upload_record(source, curseforge_id=925200)
    payload = JobManager._pack_payload(record, source, _SLOT)
    assert payload["curseforge_id"] == 925200


def test_pack_payload_omits_curseforge_id_when_absent(tmp_path: Path) -> None:
    source = _translate_record(tmp_path)
    payload = JobManager._pack_payload(_upload_record(source), source, _SLOT)
    assert "curseforge_id" not in payload


def test_upload_rejects_invalid_curseforge_id() -> None:
    manager = JobManager()
    for bad in (0, -3, "925200", True, 1.5):
        with pytest.raises(JobParamsError, match="curseforge_id"):
            manager.create_job(
                "upload", {"modpack_name": "X", "curseforge_id": bad}
            )
