"""Convert Pokémon Switch native TRMDL/GFBMDL resources into GLB using Blender.

Game assets, external Blender importers and proprietary decompressors are not bundled.
"""
from __future__ import annotations

import json
import re
import shutil
import struct
import subprocess
import tempfile
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable

from .core import GFPak, GFPakError, Resource, find_oodle_dll
from .model_discovery import infer_model_resources


class ConversionError(GFPakError):
    """Model conversion cannot complete accurately."""


HEX_HASH = re.compile(r"^(?:0x)?[0-9a-fA-F]{16}$")
MODEL_SUFFIXES = {".trmdl", ".gfbmdl"}


def fnv1a64(name: str) -> str:
    value = 0xCBF29CE484222325
    for c in name.encode("utf-8"):
        value = (value ^ c) * 0x100000001B3 & 0xFFFFFFFFFFFFFFFF
    return f"{value:016x}"


def safe_path(name: str) -> Path:
    if not name or "\x00" in name or "\\" in name or ":" in name:
        raise ConversionError(f"Unsafe resource path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in (".", "..", "") for part in name.split("/")):
        raise ConversionError(f"Unsafe resource path: {name!r}")
    return Path(*path.parts)


class HashDictionary:
    """Read gfpak.txt or JSON mapping known hash IDs to original filenames."""

    def __init__(self, file: str | Path | None = None):
        self.mapping: dict[str, str] = {}
        self.names: set[str] = set()
        if file is not None:
            self.load(file)

    def add(self, name: str) -> None:
        name = name.strip().replace("\\", "/")
        if not name or name.startswith("#"):
            return
        name = safe_path(name).as_posix()
        self.names.add(name)
        for item in {name, PurePosixPath(name).name, name.lower()}:
            self.mapping.setdefault(fnv1a64(item), name)

    def load(self, file: str | Path) -> None:
        file = Path(file)
        if not file.is_file():
            raise ConversionError(f"Filename dictionary not found: {file}")
        contents = file.read_text(encoding="utf-8-sig")
        if file.suffix.lower() == ".json":
            data = json.loads(contents)
            if not isinstance(data, dict):
                raise ConversionError("JSON dictionary must map hashes to paths")
            for key, name in data.items():
                if not isinstance(name, str):
                    raise ConversionError("Every hash mapping must point to a filename")
                safe = safe_path(name).as_posix()
                if not HEX_HASH.fullmatch(key):
                    raise ConversionError(f"Invalid 64-bit hash: {key}")
                self.mapping[key.removeprefix("0x").lower()] = safe
                self.add(safe)
            return
        current_folder = ""
        for line in contents.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("//"):
                continue
            if line.endswith("/"):
                current_folder = line
                continue
            name = line if "/" in line else current_folder + line
            self.add(name)

    def lookup(self, resource: Resource) -> str | None:
        for key in (resource.path_hash, resource.file_hash):
            result = self.mapping.get(key)
            if result:
                return result
        return None



def discover_dictionary(source: Path) -> Path | None:
    """Find an adjacent GFPAK hash dictionary without searching unrelated files."""
    roots = [source.parent, source.parent / "hashes", source.parent / "dictionaries"]
    names = [source.stem + ".json", source.stem + ".txt",
             "gfpak.txt", "gfpak.json", "hashes.txt", "hashes.json",
             "filenames.txt", "filenames.json"]
    for folder in roots:
        for name in names:
            candidate = folder / name
            if candidate.is_file():
                return candidate
    return None



# Community-contributed filename list for Pokémon Legends: Arceus (Terasol).
# No game files or proprietary decompression DLLs are downloaded.
PLA_HASHES_URL = (
    "https://gist.githubusercontent.com/Terasol/"
    "c12b518af355d443486c244a425b9541/raw/GFPAK.txt"
)

def community_dictionary(archive: GFPak, log: Callable[[str], None]) -> tuple[HashDictionary | None, dict[int, str]]:
    """Fetch a public candidate and accept it only when model hashes match."""
    cache = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".cache") / "GFPAK-OPEN" / "hashes"
    path = cache / "legends_arceus_gfpak.txt"
    if not path.is_file():
        try:
            request = urllib.request.Request(PLA_HASHES_URL, headers={"User-Agent": "GFPAK-OPEN"})
            with urllib.request.urlopen(request, timeout=12) as response:
                data = response.read(24 * 1024 * 1024 + 1)
            if len(data) > 24 * 1024 * 1024:
                raise ValueError("Community dictionary is too large")
            decoded = data.decode("utf-8-sig")
            if ".trmdl" not in decoded or len(decoded.splitlines()) < 100:
                raise ValueError("Community dictionary contains no usable model names")
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=cache,
                                             suffix=".txt", delete=False) as temp:
                temp.write(decoded)
                staged = Path(temp.name)
            staged.replace(path)
        except (OSError, UnicodeError, ValueError) as exc:
            log("Community hash lookup unavailable: " + str(exc))
            return None, {}
    try:
        mapping = HashDictionary(path)
        found = read_resource_names(archive, mapping)
    except (OSError, ValueError) as exc:
        log("Community dictionary could not be read: " + str(exc))
        return None, {}
    models = [name for name in found.values() if Path(name).suffix.lower() in MODEL_SUFFIXES]
    if not models:
        log("Community Legends: Arceus filename list did not match this archive's model hashes.")
        return None, {}
    log(f"Community filename list matched {len(found)} archive entries, including {len(models)} models.")
    return mapping, found


def read_resource_names(archive: GFPak, mapping: HashDictionary) -> dict[int, str]:
    names: dict[int, str] = {}
    used: set[str] = set()
    for r in archive.resources:
        name = mapping.lookup(r)
        if name:
            if name in used:
                raise ConversionError(f"Multiple resources resolved to {name}; fix the hash dictionary")
            used.add(name)
            names[r.index] = name
    return names


def unpack_named(archive: GFPak, destination: Path, names: dict[int, str],
                 *, oodle: str | Path | None = None,
                 progress: Callable[[str], None] | None = None) -> list[Path]:
    output = []
    destination = destination.resolve()
    for i, r in enumerate(archive.resources):
        name = names.get(r.index)
        if name is None:
            continue
        target = destination / safe_path(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = archive.read_resource(r, oodle_dll=oodle)
        target.write_bytes(data)
        output.append(target)
        if progress and (i % 20 == 0 or i == len(archive.resources) - 1):
            progress(f"Decoded {i+1}/{len(archive.resources)} resources")
    return output



# Filenames embedded in decoded FlatBuffers can restore the exact paths expected
# by the Blender importer, after suffix-hash inference identifies the first model.
# Do not treat random strings or unmatched hashes as verified resources.
REFERENCE_RE = re.compile(
    rb"[A-Za-z0-9_][A-Za-z0-9_./-]{2,190}"
    rb"\.(?:trmdl|trmsh|trmbf|trmtr|trskl|trmmt|tranm|gfbanm|bntx|png|dds|tga)",
    re.IGNORECASE,
)


def restore_referenced_paths(archive: GFPak, workspace: Path, names: dict[int, str],
                             *, oodle: str | Path | None = None,
                             progress: Callable[[str], None] | None = None) -> int:
    """Restore exact companion filenames only when their FNV hashes match.

    A TRMDL FlatBuffer refers to meshes/materials/skeletons by string, not by
    numeric resource ID. Our inferred filenames are aliases, so decode those
    references and write authenticated alias copies for Blender. No name is
    guessed from its file contents alone.
    """
    lookup: dict[str, list[Resource]] = {}
    for resource in archive.resources:
        for hash_value in (resource.path_hash, resource.file_hash):
            if hash_value:
                lookup.setdefault(hash_value, []).append(resource)
    queue = [workspace / safe_path(name) for name in names.values()
             if Path(name).suffix.lower() in {".trmdl", ".trmsh", ".trmtr", ".trskl"}]
    visited: set[Path] = set()
    created = 0
    while queue and len(visited) < 250:
        current = queue.pop(0)
        if current in visited or not current.is_file():
            continue
        visited.add(current)
        if current.stat().st_size > 12 * 1024 * 1024:
            continue
        content = current.read_bytes()
        for reference in set(REFERENCE_RE.findall(content)):
            try:
                decoded = reference.decode("ascii")
                path = safe_path(decoded)
            except (UnicodeError, ConversionError):
                continue
            full = path.as_posix()
            filename = path.name
            matches = lookup.get(fnv1a64(full), []) + lookup.get(fnv1a64(filename), [])
            # Deduplicate the same resource found through both hashes.
            unique = {entry.index: entry for entry in matches}
            if len(unique) != 1:
                continue
            resource = next(iter(unique.values()))
            target = workspace / path
            if target.is_file():
                continue
            # Reuse an existing inferred alias when available.
            alias = workspace / safe_path(names[resource.index]) if resource.index in names else None
            if alias is not None and alias.is_file():
                data = alias.read_bytes()
            else:
                data = archive.read_resource(resource, oodle_dll=oodle)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            created += 1
            if target.suffix.lower() in {".trmdl", ".trmsh", ".trmtr", ".trskl"}:
                queue.append(target)
    if created and progress:
        progress(f"Recovered {created} exact companion paths from verified FlatBuffer references.")
    return created


def find_models(root: Path) -> list[Path]:
    return sorted((p for p in root.rglob("*") if p.is_file()
                   and p.suffix.lower() in MODEL_SUFFIXES),
                  key=lambda p: (p.suffix.lower() != ".trmdl",
                                 "_lod" in p.stem.lower(), len(str(p)), str(p)))


def select_model(models: list[Path], preference: str | None,
                 archive_name: str | None = None) -> Path:
    if not models:
        raise ConversionError(
            "No .trmdl or .gfbmdl model file was identified. Provide a filename hash dictionary "
            "(--hashes) that resolves the model, mesh, material and skeleton resources."
        )
    if preference:
        matches = [p for p in models if p.stem.lower() == Path(preference).stem.lower()
                   or p.name.lower() == preference.lower()]
        if len(matches) != 1:
            raise ConversionError(f"Model {preference!r} not uniquely found. Choices: "
                                  + ", ".join(p.name for p in models[:15]))
        return matches[0]
    if archive_name:
        exact = [p for p in models if p.stem.lower() == Path(archive_name).stem.lower()]
        if len(exact) == 1:
            return exact[0]
    candidates = [p for p in models if "_lod" not in p.stem.lower()]
    return candidates[0] if candidates else models[0]


def validate_glb(file: Path) -> None:
    if not file.is_file():
        raise ConversionError("Blender did not produce the requested GLB file")
    with file.open("rb") as stream:
        head = stream.read(20)
        if len(head) < 20:
            raise ConversionError("Generated GLB is truncated")
        magic, version, length, chunk_length, chunk_type = struct.unpack("<4sIIII", head)
        if magic != b"glTF" or version != 2 or length != file.stat().st_size or chunk_type != 0x4E4F534A:
            raise ConversionError("Blender did not produce a valid glTF 2.0 GLB container")
        if chunk_length > 16 * 1024 * 1024 or chunk_length > length - 20:
            raise ConversionError("GLB JSON chunk has invalid size")
        try:
            document = json.loads(stream.read(chunk_length))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ConversionError("GLB scene metadata could not be read") from exc
    if not document.get("meshes"):
        raise ConversionError("GLB has no 3D meshes; conversion failed")
    if not any(mesh.get("primitives") for mesh in document["meshes"]):
        raise ConversionError("GLB meshes contain no primitives")


@dataclass
class ConversionOptions:
    source: Path
    output: Path
    blender: Path
    addon: Path
    dictionary: Path | None = None
    oodle: Path | None = None
    texture_folder: Path | None = None
    preferred_model: str | None = None
    animations: bool = False
    keep_extracted: Path | None = None


def convert_model(options: ConversionOptions,
                  progress: Callable[[str], None] | None = None) -> Path:
    """Convert native GFBMDL/TRMDL assets or a GFPAK to genuine 3D GLB."""
    def log(msg: str) -> None:
        if progress:
            progress(msg)

    src, blender, addon, output = (Path(options.source), Path(options.blender),
                                   Path(options.addon), Path(options.output))
    if not src.exists():
        raise ConversionError(f"Source not found: {src}")
    if not blender.is_file():
        raise ConversionError("Blender executable not found. Select blender.exe in Converter Settings.")
    if not addon.is_dir() or not (addon / "__init__.py").is_file():
        raise ConversionError("Choose the folder containing __init__.py from the Pokémon Switch Blender add-on.")
    if src.is_file() and src.suffix.lower() not in {".gfpak", ".trmdl", ".gfbmdl"}:
        raise ConversionError("Choose a .gfpak, .trmdl, .gfbmdl or folder of decoded model resources")
    if options.texture_folder and not Path(options.texture_folder).is_dir():
        raise ConversionError("Texture folder does not exist")
    if output.suffix.lower() != ".glb":
        raise ConversionError("Output file must end in .glb")
    if output.exists():
        raise ConversionError(f"Output already exists: {output}. Choose another name to prevent overwriting.")

    with tempfile.TemporaryDirectory(prefix="gfpak-converter-") as tmp:
        workspace = Path(tmp) / "resources"
        workspace.mkdir()
        if src.is_dir():
            log("Preparing decoded model folder…")
            shutil.copytree(src, workspace, dirs_exist_ok=True)
        elif src.suffix.lower() in MODEL_SUFFIXES:
            log("Collecting adjacent native model resources…")
            # A single .trmdl usually references sibling skeleton/mesh/material files.
            # Copy relevant siblings, without changing or deleting the originals.
            related = {".trmdl", ".gfbmdl", ".trmsh", ".trmbf", ".trskl",
                       ".trmtr", ".tranm", ".gfbanm", ".png", ".tga",
                       ".jpg", ".jpeg", ".dds", ".bntx", ".trmmt", ".trmms", ".trmmo"}
            for sibling in src.parent.iterdir():
                if sibling.is_file() and sibling.suffix.lower() in related:
                    shutil.copy2(sibling, workspace / sibling.name)
            if not (workspace / src.name).is_file():
                raise ConversionError("Failed to stage native model for conversion")
        else:
            archive = GFPak(src)
            detected_oodle = options.oodle or find_oodle_dll(src)
            if detected_oodle and not options.oodle:
                log("Found locally installed Oodle runtime: " + str(detected_oodle))
            dictionary = options.dictionary or discover_dictionary(src)
            if dictionary and not options.dictionary:
                log("Automatically found filename dictionary: " + str(dictionary))
            mapping = HashDictionary(dictionary)
            found = read_resource_names(archive, mapping)
            model_names = [name for name in found.values()
                           if Path(name).suffix.lower() in MODEL_SUFFIXES]
            if not model_names:
                # Trinity files frequently share the same FNV-1a hash prefix.
                # Undoing only their known extensions identifies model families
                # without guessing the original filenames or fetching a dictionary.
                inferred = infer_model_resources(archive.resources, src.stem)
                if inferred:
                    existing_names = set(found.values())
                    for index, name in inferred.items():
                        if index not in found and name not in existing_names:
                            found[index] = name
                            existing_names.add(name)
                    model_names = [name for name in found.values()
                                   if Path(name).suffix.lower() in MODEL_SUFFIXES]
                    group = sorted(
                        (index, name) for index, name in inferred.items()
                        if Path(name).suffix.lower() in MODEL_SUFFIXES
                    )
                    log(f"Identified {len(inferred)} Trinity resource types by matching "
                        "FNV-1a filename suffixes (original names remain unknown).")
                    for index, name in group[:12]:
                        log(f"  GFPAK resource {index}: {name}")
            if not model_names and not dictionary:
                _public_dictionary, auto_found = community_dictionary(archive, log)
                if auto_found:
                    found = auto_found
                    model_names = [name for name in found.values()
                                   if Path(name).suffix.lower() in MODEL_SUFFIXES]
                    dictionary = "community Legends: Arceus list"
            if not model_names:
                codecs = archive.summary()["compression_types"]
                raise ConversionError(
                    f"Opened {len(archive.resources)} GFPAK resources (compression {codecs}), "
                    "but no complete model family could be identified from its hashes. "
                    + ("No matching filename dictionary was found. "
                       if not dictionary else "The selected dictionary did not match the model hashes. ")
                    + "Select an appropriate gfpak.txt or JSON hash list under Advanced Settings."
                )
            if "3" in archive.summary()["compression_types"] and not detected_oodle:
                try:
                    import ooz  # noqa: F401 - optional open-source decoder
                except ImportError as exc:
                    raise ConversionError(
                        f"Identified {len(model_names)} model descriptor(s), but Oodle "
                        "decompression is unavailable. Install the optional open-source "
                        "decoder (pip install pyooz==0.0.8) or configure a compatible "
                        "oo2core_*.dll. Hash identification already succeeded."
                    ) from exc
            log(f"Identified {len(model_names)} model entry(s); decompressing {len(found)} known resources…")
            unpack_named(archive, workspace, found, oodle=detected_oodle, progress=log)
            restore_referenced_paths(archive, workspace, found, oodle=detected_oodle, progress=log)
        if options.texture_folder:
            source_textures = Path(options.texture_folder)
            for texture in source_textures.rglob("*"):
                if texture.is_file() and texture.suffix.lower() in {".png", ".dds", ".tga", ".jpg", ".jpeg"}:
                    relative = texture.relative_to(source_textures)
                    target = workspace / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(texture, target)
        models = find_models(workspace)
        model = select_model(models, options.preferred_model, src.stem)
        log(f"Importing {model.name} ({model.suffix.upper()}) into Blender…")
        output.parent.mkdir(parents=True, exist_ok=True)
        worker = Path(__file__).with_name("blender_worker.py")
        command = [str(blender), "--background", "--factory-startup", "--python", str(worker), "--",
                   "--model", str(model), "--output", str(output), "--addon", str(addon)]
        if options.animations:
            command += ["--animations"]
        try:
            result = subprocess.run(command, capture_output=True, text=True,
                                    errors="replace", timeout=900, check=False)
        except subprocess.TimeoutExpired as exc:
            raise ConversionError("Blender conversion exceeded 15 minutes") from exc
        except OSError as exc:
            raise ConversionError(f"Unable to launch Blender: {exc}") from exc
        if result.returncode:
            snippet = (result.stdout + "\n" + result.stderr)[-4000:]
            raise ConversionError(f"Blender model import/export failed (code {result.returncode}):\n{snippet}")
        validate_glb(output)
        if options.keep_extracted:
            destination = Path(options.keep_extracted)
            if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
                raise ConversionError("Extracted-resources destination must be an empty directory")
            shutil.copytree(workspace, destination, dirs_exist_ok=True)
        log(f"Exported {output.name} ({output.stat().st_size:,} bytes)")
        return output
