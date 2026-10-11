"""Identify Pokémon Trinity resources from related FNV-1a-64 suffix hashes.

Identifies a resource's likely file type without pretending to know its original
filename. A matched .trmdl/.trmsh/.trmbf family is much stronger evidence than
a single hash match. The aliases generated here are not official filenames.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

MASK = (1 << 64) - 1
INV_PRIME = pow(0x100000001B3, -1, 1 << 64)
MODEL_EXTENSIONS = (".trmdl", ".trmsh", ".trmbf", ".trmtr", ".trskl", ".trmmt")
PAIR_EXTENSIONS = (".trmsh", ".trmbf")


def unwind_suffix(value: str, suffix: str) -> int:
    """Recover the FNV-1a hash state immediately before a known file extension."""
    state = int(value, 16)
    for byte in reversed(suffix.encode("ascii")):
        state = ((state * INV_PRIME) & MASK) ^ byte
    return state


def _groups(resources, attribute: str):
    groups = defaultdict(dict)
    for resource in resources:
        value = getattr(resource, attribute, None)
        if not value:
            continue
        for suffix in MODEL_EXTENSIONS:
            key = unwind_suffix(value, suffix)
            if suffix in groups[key]:
                groups[key][suffix] = None
            else:
                groups[key][suffix] = resource
    return [
        {suffix: item for suffix, item in variants.items() if item is not None}
        for variants in groups.values()
    ]


def infer_model_resources(resources, archive_stem: str) -> dict[int, str]:
    """Identify model families and closely related mesh buffers, using safe aliases.

    Each family must contain a .trmdl, .trmsh and .trmbf sharing a proven
    prefix-hash. The original basename is unknown until asset data is decoded.
    """
    candidates = []
    for field in ("path_hash", "file_hash"):
        for group in _groups(resources, field):
            if {".trmdl", ".trmsh", ".trmbf"}.issubset(group):
                candidates.append(group)
        if candidates:
            break
    if not candidates:
        return {}
    candidates.sort(key=lambda group: (-len(group), group[".trmdl"].index))
    clean = re.sub(r"[^a-zA-Z0-9_-]", "_", Path(archive_stem).stem) or "model"
    result = {}
    for n, group in enumerate(candidates):
        stem = clean if n == 0 else f"{clean}_model{n+1}"
        for suffix, resource in group.items():
            result.setdefault(resource.index, f"{stem}{suffix}")
    paired = []
    for group in _groups(resources, "path_hash"):
        if all(ext in group for ext in PAIR_EXTENSIONS) and not any(
            item.index in result for item in group.values()
        ):
            paired.append(group)
    paired.sort(key=lambda group: group[".trmsh"].index)
    for n, group in enumerate(paired, 1):
        for suffix in PAIR_EXTENSIONS:
            result[group[suffix].index] = f"{clean}_mesh{n}{suffix}"
    return result
