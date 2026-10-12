"""Evidence-based model/texture/animation matching for discovered game assets.

This deliberately avoids guessing a Pokémon from its numerical archive ID.
Matches are linked only by verified filename stems, Pokémon-family tokens, or
an unambiguous nearby model inside the same source container. Hashed assets
without resolved names remain unknown.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import PurePosixPath

from .pokemon_assets import pokemon_id

MODEL_KINDS = frozenset(("model",))
COMPANION_KINDS = frozenset(("mesh", "skeleton", "material", "texture", "animation"))


def _path(row):
    path = str(row.get("relative") or row.get("name") or "").replace("\\", "/")
    filename = path.rsplit("/", 1)[-1]
    if " · " in filename:
        filename = filename.split(" · ", 1)[-1]
    return (path.rsplit("/", 1)[0].casefold() if "/" in path else "",
            filename.casefold())


def _stem(filename):
    return filename.rsplit(".", 1)[0] if "." in filename else filename


def _score(model, part, unique_dir_models):
    mdir, mfile = _path(model)
    pdir, pfile = _path(part)
    ms, ps = _stem(mfile), _stem(pfile)
    mt, pt = pokemon_id(model.get("relative") or mfile), pokemon_id(part.get("relative") or pfile)
    # A fully identified Pokémon file for another Pokémon must never attach.
    if mt and pt and mt != pt:
        return 0, ""
    model_scope, part_scope = model.get("scope", ""), part.get("scope", "")
    if model_scope != part_scope:
        return 0, ""
    same_dir = mdir == pdir
    if ms == ps and ms:
        return 100, "identical filename stem"
    if mt and pt and mt == pt:
        return (90 if same_dir else 78), "matching Pokémon asset-family ID"
    if same_dir and (ps.startswith(ms + "_") or ms.startswith(ps + "_")):
        return 85, "matching model filename prefix"
    # Generic body/idle files are often shared in a packed folder. Never
    # attach them if multiple distinct models occupy that directory.
    if same_dir and unique_dir_models.get((model_scope, mdir), 0) == 1:
        return 65, "only model in the same source directory"
    return 0, ""


def match_model_assets(rows):
    """Return model node ID -> verified companions with evidence.

    Indexes by source scope and Pokémon token for efficient large scans.
    Tied generic matches are omitted, not silently attached to one Pokémon.
    """
    models = [r for r in rows if r.get("category") in MODEL_KINDS and r.get("id")]
    parts = [r for r in rows if r.get("category") in COMPANION_KINDS and r.get("id")]
    by_scope = defaultdict(list)
    by_species = defaultdict(list)
    by_dir = defaultdict(list)
    unique_dir_models = Counter()
    for model in models:
        directory, name = _path(model)
        scope = model.get("scope", "")
        unique_dir_models[(scope, directory)] += 1
        by_scope[scope].append(model)
        by_dir[(scope, directory)].append(model)
        token = pokemon_id(model.get("relative") or name)
        if token:
            by_species[(scope, token)].append(model)
    output = defaultdict(list)
    for part in parts:
        scope = part.get("scope", "")
        directory, filename = _path(part)
        token = pokemon_id(part.get("relative") or filename)
        # Candidates by exact directory + species first; unlike a quadratic
        # all-model scan this remains affordable for full game archives.
        possible = {m["id"]: m for m in by_dir.get((scope, directory), [])}
        if token:
            possible.update({m["id"]: m for m in by_species.get((scope, token), [])})
        scored = []
        for model in possible.values():
            value, reason = _score(model, part, unique_dir_models)
            if value:
                scored.append((value, model, reason))
        if not scored:
            continue
        best = max(value for value, _, _ in scored)
        winners = [(model, reason) for value, model, reason in scored if value == best]
        # More than one possible recipient is fine ONLY with a matching
        # explicit species token. Otherwise the companion remains ambiguous.
        explicit = bool(token) and all(
            pokemon_id(m.get("relative") or m.get("name", "")) == token
            for m, _ in winners)
        if len(winners) > 1 and not explicit:
            continue
        for model, reason in winners:
            output[model["id"]].append({
                "id": part["id"],
                "name": filename,
                "path": part.get("relative") or part.get("name"),
                "kind": part["category"],
                "confidence": "verified" if best >= 85 else "probable",
                "reason": reason
            })
    return {
        model["id"]: sorted(output.get(model["id"], []),
                            key=lambda x: ({"mesh":0, "skeleton":1, "material":2,
                                            "texture":3, "animation":4}.get(x["kind"], 9),
                                           x["path"].casefold()))
        for model in models
    }
