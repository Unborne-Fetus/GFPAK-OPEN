"""Locate the real model-bearing GFPAK for a selected Pokémon/form.

Never treat a filename alone as proof that a package contains geometry. Archive
membership is accepted only if the existing decoder identified a .trmdl or
.gfbmdl, or the completed game inventory identified a model member.
"""
from __future__ import annotations

import re
from pathlib import Path

MODEL_SUFFIXES = frozenset((".trmdl", ".gfbmdl"))
FORM_RE = re.compile(r"(?i)(?<![a-z0-9])pm\d{4}_\d{2}_\d{2}(?!\d)")
MAX_SIBLING_PAGES = 64


def form_key(value: str) -> str:
    """Require a precise internal species AND form token, not just pm####."""
    match = FORM_RE.search(str(value).replace("\\", "/"))
    return match.group().casefold() if match else ""


def selected_form(browser, node: dict | None) -> str:
    if node is None:
        return ""
    for value in (node.get("name", ""), node.get("inner", "")):
        key = form_key(value)
        if key:
            return key
    if node["kind"] == "gfpak_resource":
        return form_key(Path(node["path"]).name)
    if node["kind"] == "nca_gfpak_resource":
        parent = browser._virtual_gfpak_nodes.get(node["id"])
        if parent:
            return form_key(browser.node(parent[0])["name"])
    return ""


def archive_node_for_model(browser, model: dict):
    """Resolve a scanned, verified model member to its containing archive."""
    if model["kind"] == "gfpak_resource":
        return browser._fs_node(Path(model["path"]))
    if model["kind"] == "nca_gfpak_resource":
        member = browser._virtual_gfpak_nodes.get(model["id"])
        if member:
            return browser.node(member[0])
    return None


def archive_has_model(browser, archive: dict) -> bool:
    """Consult the existing native decoder/filename matcher for real members."""
    if archive["kind"] == "gfpak":
        names = browser._known_names(Path(archive["path"]))
    elif archive["kind"] == "nca_file" and archive["name"].lower().endswith(".gfpak"):
        _, names = browser._mounted_gfpak(archive["id"])
    else:
        return False
    return any(Path(name).suffix.lower() in MODEL_SUFFIXES for name in names.values())


def _neighboring_archives(browser, source: dict, key: str):
    """Probe ONLY same-form sibling packages; never bulk extract the whole ROM."""
    results = []
    if not key:
        return results
    if source["kind"] in {"gfpak", "gfpak_resource", "file"}:
        current = Path(source["path"])
        parent = current.parent
        if not parent.is_dir():
            return results
        # Directly opened GFPAKs still support a one-click sibling lookup.
        for path in parent.iterdir():
            if (path.is_symlink() or not path.is_file() or
                    path.suffix.lower() != ".gfpak" or
                    form_key(path.name) != key):
                continue
            try:
                candidate = browser._fs_node(path)
                if archive_has_model(browser, candidate):
                    results.append(candidate)
            except (OSError, ValueError, RuntimeError):
                continue
    elif source["kind"] in {"nca_file", "nca_gfpak_resource"}:
        parent_id = source["id"]
        if source["kind"] == "nca_gfpak_resource":
            binding = browser._virtual_gfpak_nodes.get(source["id"])
            if not binding:
                return results
            parent_id = binding[0]
        current = browser.node(parent_id)
        if current["kind"] != "nca_file":
            return results
        reader, index, section, full = browser._nca_virtual_file(current)
        directory = full.rpartition("/")[0]
        fs = browser._nca_sections.filesystem(reader, index, section)
        cursor = None
        for _ in range(MAX_SIBLING_PAGES):
            page = fs.children_page(directory, cursor=cursor, limit=250)
            for row in page["entries"]:
                if (row["type"] != "file" or row["size"] > 2 * 1024 * 1024 * 1024
                        or not row["name"].lower().endswith(".gfpak") or
                        form_key(row["name"]) != key):
                    continue
                candidate = browser._node(
                    "nca_file", reader.path,
                    inner=f"model-finder:{index}:{section}:{row['path']}",
                    name=row["name"], size=row["size"])
                candidate["expandable"] = True
                browser._nca_virtual_nodes[candidate["id"]] = (
                    index, section, row["path"])
                browser._nca_sources[candidate["id"]] = reader
                try:
                    if archive_has_model(browser, candidate):
                        results.append(candidate)
                except (OSError, ValueError, RuntimeError):
                    continue
            cursor = page.get("next_cursor")
            if not cursor:
                break
    return results


def _same_section_or_folder(browser, selected: dict, candidate: dict) -> int:
    """Prefer a nearby model, but never select between equal-scored duplicates."""
    if selected["kind"] == "nca_gfpak_resource":
        relation = browser._virtual_gfpak_nodes.get(selected["id"])
        selected = browser.node(relation[0]) if relation else selected
    if selected["kind"] == "nca_file" and candidate["kind"] == "nca_file":
        a = browser._nca_virtual_nodes.get(selected["id"])
        b = browser._nca_virtual_nodes.get(candidate["id"])
        if not a or not b:
            return 0
        if (a[:2] != b[:2] or
                browser._nca_sources.get(selected["id"]) is not
                browser._nca_sources.get(candidate["id"])):
            return 0
        return (3 if a[2].rpartition("/")[0] == b[2].rpartition("/")[0] else 2)
    if selected["kind"] in {"file", "gfpak", "gfpak_resource"} and candidate["kind"] == "gfpak":
        return 3 if Path(selected["path"]).parent == Path(candidate["path"]).parent else 0
    return 0


def find_pokemon_model_archive(browser, catalogs: dict, node_id: str | None) -> dict:
    """Find a verified archive inside the *already opened* game/source.

    The desktop bridge calls this under its lock. Catalogs are cached metadata
    from a completed scan; no untrusted client path or Pokemon name is used to
    choose a file or leave the open source.
    """
    selected = browser.node(node_id) if node_id else None
    key = selected_form(browser, selected)
    root_id = browser.root_id
    root = browser.node(root_id) if root_id else None
    available = root_id in catalogs
    if selected and not key:
        return {"status": "needs_selection",
                "message": "Select a Pokémon archive or asset whose filename includes "
                           "an exact pm####_##_## form ID. No form can be safely guessed."}

    candidates: dict[str, dict] = {}

    def add(node: dict, evidence: str, matched_form: str):
        if key and matched_form != key:
            return
        if node["id"] not in candidates:
            candidates[node["id"]] = {"node": node, "evidence": evidence}

    # The current archive may itself contain a real model.
    if selected and selected["kind"] in {"gfpak", "gfpak_resource",
                                         "nca_file", "nca_gfpak_resource"}:
        archive = selected
        if selected["kind"] == "gfpak_resource":
            archive = browser._fs_node(Path(selected["path"]))
        elif selected["kind"] == "nca_gfpak_resource":
            binding = browser._virtual_gfpak_nodes.get(selected["id"])
            archive = browser.node(binding[0]) if binding else selected
        if archive["kind"] == "gfpak" or (
                archive["kind"] == "nca_file" and archive["name"].lower().endswith(".gfpak")):
            try:
                if archive_has_model(browser, archive):
                    add(archive, "decoded model in selected GFPAK", key)
            except (OSError, ValueError, RuntimeError):
                pass

    # Search completed scan results (including separate NCA sections/folders).
    for catalog in catalogs.values():
        for row in catalog.get("assets", ()):
            if row.get("category") != "model":
                continue
            try:
                model = browser.node(row["id"])
                model_name = row.get("relative") or model["name"]
                if Path(model_name).suffix.lower() not in MODEL_SUFFIXES:
                    continue
                archive = archive_node_for_model(browser, model)
                if archive is None:
                    continue
                candidate_key = form_key(archive["name"]) or form_key(model_name)
                if not key and not candidate_key:
                    continue
                # This row was labeled model by GFPAK resource discovery;
                # the parent alone is not sufficient evidence.
                add(archive, "verified model resource: " + Path(model_name).name, candidate_key)
            except (KeyError, OSError, ValueError):
                continue

    # A sibling probe works even when the opened source is just one GFPAK,
    # or before the slower full-game asset scan has finished.
    if selected and key:
        for archive in _neighboring_archives(browser, selected, key):
            add(archive, "verified neighboring GFPAK", form_key(archive["name"]))

    ordered = list(candidates.values())
    if selected and ordered:
        ranking = [(_same_section_or_folder(browser, selected, candidate["node"]), candidate)
                   for candidate in ordered]
        best_score = max(score for score, _ in ranking)
        ordered = [candidate for score, candidate in ranking if score == best_score]
    if len(ordered) == 1:
        winner = ordered[0]
        return {"status": "found", "archive": browser._public(winner["node"]),
                "form": key or form_key(winner["node"]["name"]),
                "evidence": winner["evidence"]}
    if len(ordered) > 1:
        # Never silently choose among different model-containing versions.
        if not selected:
            return {"status": "browse", "count": len(ordered),
                    "message": "Multiple Pokémon model archives found. "
                               "Choose a Pokémon or browse the model catalog."}
        return {"status": "ambiguous", "form": key,
                "archives": [browser._public(candidate["node"]) for candidate in ordered[:30]],
                "count": len(ordered),
                "message": "Several model archives match this exact form. "
                           "Choose the intended game version or archive."}
    if root and root["kind"] in {"directory", "nsp", "xci"} and not available:
        return {"status": "scan_required", "message":
                "A complete model inventory is needed to locate this archive "
                "outside the current folder."}
    return {"status": "not_found",
            "message": (f"No verified model-bearing GFPAK for {key} was found in "
                        "the readable opened source. Encrypted or unresolved "
                        "files cannot be treated as confirmed models."
                        if key else
                        "No verified Pokémon model archives were found. "
                        "Open an extracted game folder or readable game package.")}
