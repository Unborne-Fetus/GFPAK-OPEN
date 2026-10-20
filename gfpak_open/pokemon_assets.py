"""Conservative Pokémon Switch asset classification and companion matching.

Model numbering in game archives is *not* assumed to equal National Pokédex
numbering. Unknown hashed entries are kept unknown rather than guessed.
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import PurePosixPath

POKEMON_ID = re.compile(r"(?<![a-z0-9])pm(\d{4})(?!\d)", re.IGNORECASE)
ASSET_EXTENSIONS = {
    ".gfpak": "model archive",
    ".gfbmdl": "model",
    ".trmdl": "model",
    ".trmsh": "mesh",
    ".trmbf": "mesh buffer",
    ".trmtr": "material",
    ".trmmt": "material",
    ".bnsh": "shader",
    ".sharc": "shader",
    ".trskl": "skeleton",
    ".bntx": "texture",
    ".trtex": "texture",
    ".dds": "texture",
    ".png": "texture",
    ".jpg": "texture",
    ".webp": "texture",
    ".tranm": "animation",
    ".gfbanm": "animation",
    ".tracn": "animation",
    ".tracp": "animation",
    ".tracr": "animation",
    ".tracs": "animation",
    ".tracm": "animation",
    ".traef": "animation",
    ".tracl": "animation",
    ".tralk": "animation",
    ".trslp": "animation",
    ".nusrcmdlb": "snap model",
    ".nutexb": "snap texture",
    ".assets": "unity data",
    ".unity3d": "unity data",
    ".bundle": "unity data",
    ".prefab": "unity data",
}


def pokemon_id(path: str) -> str:
    match = POKEMON_ID.search(str(path).replace("\\", "/"))
    return "pm" + match.group(1) if match else ""


def asset_kind(filename: str) -> str:
    return ASSET_EXTENSIONS.get(PurePosixPath(filename.replace("\\", "/")).suffix.lower(),
                                "unidentified")


def engine_family(file_paths: list[str]) -> str:
    endings = {PurePosixPath(p.replace("\\", "/")).suffix.lower() for p in file_paths}
    if endings & {".trmdl", ".trmsh", ".trmbf", ".tranm"}:
        return "Game Freak Trinity"
    if endings & {".gfbmdl", ".gfbanm"}:
        return "Game Freak GFBMDL"
    if endings & {".nusrcmdlb", ".nutexb"}:
        return "New Pokémon Snap asset formats"
    if endings & {".unity3d", ".assets", ".bundle"}:
        return "Unity (including BDSP)"
    return "Unidentified or mixed"


def group_related(selected: str, candidates: list[str], max_files: int = 80) -> dict:
    """Group already-discovered, name-verified assets by species-like ID."""
    token = pokemon_id(selected)
    if not token:
        return {"asset_id": "", "engine": "Undetermined", "files": [],
                "counts": {}, "note": "No pm#### asset ID detected in this filename."}
    matched = []
    for path in candidates:
        if pokemon_id(path) != token:
            continue
        kind = asset_kind(path)
        if kind == "unidentified":
            continue
        matched.append((path, kind))
    counts = dict(Counter(kind for _, kind in matched))
    priority = {"model archive": 0, "model": 1, "mesh": 2, "mesh buffer": 3,
                "material": 4, "texture": 5, "skeleton": 6, "animation": 7}
    matched.sort(key=lambda item: (priority.get(item[1], 20), item[0].lower()))
    return {
        "asset_id": token, "engine": engine_family([p for p, _ in matched]),
        "files": [{"path": path, "kind": kind} for path, kind in matched[:max_files]],
        "counts": counts, "truncated": len(matched) > max_files,
        "note": ("The pm#### token is an internal filename family, not a verified "
                 "National Pokédex ID. Only files discovered in this session "
                 "are listed; hashed or compressed contents may be missing.")
    }
