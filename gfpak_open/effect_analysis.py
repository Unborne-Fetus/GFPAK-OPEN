"""Evidence-based visual-effect companion inventory for the desktop model studio.

This is a *discovery* layer, not a decoder for Nintendo's proprietary GPU shaders.
Only the filenames in a verified, selected preview/export manifest are inspected;
nothing is inferred from raw hashed filenames or attributed to another species.
"""
from __future__ import annotations

import re
from pathlib import PurePosixPath

from .pokemon_assets import pokemon_id

EFFECT_RULES = {
    "fire": re.compile(r"(?i)(?:^|[^a-z])(flame|firecore|firemask|fire|ember|burn)(?:[^a-z]|$)"),
    "smoke": re.compile(r"(?i)(?:^|[^a-z])(smoke|fog|mist|gas|vapor|vapour|steam)(?:[^a-z]|$)"),
    "electricity": re.compile(r"(?i)(?:^|[^a-z])(electric|spark|lightning|thunder)(?:[^a-z]|$)"),
    "energy": re.compile(r"(?i)(?:^|[^a-z])(aura|glow|energy|pulse|beam)(?:[^a-z]|$)"),
    "water": re.compile(r"(?i)(?:^|[^a-z])(bubble|splash|spray|waterfall)(?:[^a-z]|$)"),
    "ice": re.compile(r"(?i)(?:^|[^a-z])(frost|ice|snow|blizzard)(?:[^a-z]|$)"),
}
SHADERS = {".bnsh", ".sharc"}
ANIMATIONS = {".tranm", ".gfbanm", ".tracn", ".tracp", ".tracr",
              ".tracs", ".tracm", ".traef", ".tracl", ".tralk", ".trslp"}
TEXTURES = {".bntx", ".trtex", ".dds", ".png", ".tga", ".webp", ".jpg", ".jpeg"}
MATERIALS = {".trmtr", ".trmmt", ".mtl"}
MAX_SCAN = 4096
MAX_HINTS = 80


def analyze_effect_assets(selected: str, items: list[dict]) -> dict:
    """Return bounded, non-assertive diagnostics for verified companion paths.

    Paths alone cannot prove a fire/smoke shader is used by the selected model.
    A discovered track is not described as a playable clip until decoded.
    """
    token = pokemon_id(selected)
    counts = {"textures": 0, "animations": 0, "materials": 0, "shaders": 0}
    types: set[str] = set()
    hints = []
    seen = set()
    ignored_other_species = 0
    for item in items[:MAX_SCAN]:
        path = item.get("path", "")
        if not isinstance(path, str) or not path or len(path) > 512:
            continue
        path = path.replace("\\", "/")
        family = pokemon_id(path)
        if token and family and token != family:
            ignored_other_species += 1
            continue
        key = path.casefold()
        if key in seen:
            continue
        seen.add(key)
        name = PurePosixPath(path).name
        suffix = PurePosixPath(name).suffix.lower()
        if suffix in TEXTURES:
            kind = "texture"
            counts["textures"] += 1
        elif suffix in ANIMATIONS:
            kind = "animation"
            counts["animations"] += 1
        elif suffix in MATERIALS:
            kind = "material"
            counts["materials"] += 1
        elif suffix in SHADERS:
            kind = "shader"
            counts["shaders"] += 1
        else:
            continue
        # Only use the basename for visual-effect hints: directory names such as
        # "fire_region" must not cause unrelated assets to be classified as fire.
        matched = [effect for effect, pattern in EFFECT_RULES.items() if pattern.search(name)]
        if suffix == ".traef" and not matched:
            matched = ["unspecified"]
        if not matched:
            continue
        types.update(matched)
        if len(hints) < MAX_HINTS:
            hints.append({
                "path": path,
                "kind": kind,
                "effects": matched,
                "evidence": "filename-only",
                "linked": item.get("linkedKind") == kind,
            })
    return {
        "format": "gfpak-desktop-effects",
        "version": 1,
        "selectedModel": selected,
        "identifiedEffects": sorted(types),
        "companionCounts": counts,
        "hints": hints,
        "ignoredOtherSpecies": ignored_other_species,
        "truncated": len(items) > MAX_SCAN or len(hints) >= MAX_HINTS,
        "accuracy": "candidate-only",
        "note": (
            "Visual-effect names are hints, not decoded shader programs. "
            "Animation and material resources are preserved in exports even "
            "when native rendering is unsupported. Animated preview effects "
            "are optional approximations and are not original game shaders."
        ),
    }
