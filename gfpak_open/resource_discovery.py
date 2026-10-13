"""Identify hashed companions through reference chains and content evidence."""
from collections import deque
from pathlib import Path
import struct
from .core import GFPakError
from .pokemon_assets import pokemon_id
from .converter import REFERENCE_RE, safe_path, fnv1a64, ConversionError

DESCRIPTORS = {'.trmdl', '.gfbmdl', '.trmsh', '.trmtr', '.trmmt', '.trskl',
               '.tranm', '.gfbanm', '.tracn', '.tracp', '.tracr', '.tracs'}
MAX_DESCRIPTOR = 16 * 1024 * 1024


def _native_model_type(data):
    """Identify actual Trinity/GFBMDL FlatBuffers structures, not hash guesses.

    This check is intentionally stricter than a valid FlatBuffers vtable:
    GFBMDL needs a mesh with vertex attributes, geometry bytes and polygons;
    TRMDL needs an actual .trmsh reference. A standalone model does not need
    the Trinity three-file hash family to be recognized.
    """
    if len(data) < 32:
        return None

    def u16(at):
        if at < 0 or at + 2 > len(data):
            raise ValueError("outside data")
        return struct.unpack_from("<H", data, at)[0]

    def u32(at):
        if at < 0 or at + 4 > len(data):
            raise ValueError("outside data")
        return struct.unpack_from("<I", data, at)[0]

    def i32(at):
        if at < 0 or at + 4 > len(data):
            raise ValueError("outside data")
        return struct.unpack_from("<i", data, at)[0]

    def table(at):
        if at < 4 or at + 4 > len(data):
            raise ValueError("invalid table")
        vt = at - i32(at)
        if vt < 4 or vt >= at:
            raise ValueError("invalid vtable")
        length, obj = u16(vt), u16(vt + 2)
        if (length < 4 or length > 1024 or length & 1 or obj < 4 or
                obj > 65535 or vt + length > len(data) or at + obj > len(data)):
            raise ValueError("invalid table bounds")
        return at, vt, length, obj

    def field(tab, slot):
        at, vt, length, obj = tab
        index = 4 + slot * 2
        offset = u16(vt + index) if index < length else 0
        if offset and not 4 <= offset < obj:
            raise ValueError("invalid field")
        return at + offset if offset else None

    def ptr(at):
        if at is None:
            raise ValueError("missing pointer")
        result = at + u32(at)
        if result <= at or result + 4 > len(data):
            raise ValueError("invalid pointer")
        return result

    def entries(tab, slot, limit):
        at = field(tab, slot)
        if at is None:
            return []
        vec = ptr(at)
        count = u32(vec)
        if not 0 < count <= limit or vec + 4 + count * 4 > len(data):
            raise ValueError("invalid vector")
        return [table(ptr(vec + 4 + index * 4)) for index in range(count)]

    def string(tab, slot):
        at = field(tab, slot)
        if at is None:
            return ""
        start = ptr(at)
        length = u32(start)
        if not 0 < length <= 512 or start + 4 + length >= len(data):
            raise ValueError("invalid string")
        value = data[start + 4:start + 4 + length]
        decoded = value.decode("utf-8")
        if not decoded.isprintable() or data[start + 4 + length] != 0:
            raise ValueError("invalid string")
        return decoded

    try:
        root = table(u32(0))
        # Trinity models contain a list of independently named .trmsh files
        # in root slot 1. Do not require their hashes to share a basename.
        try:
            models = entries(root, 1, 512)
            refs = [string(entry, 0).lower() for entry in models]
            if refs and all(ref.endswith(".trmsh") for ref in refs):
                return ".trmdl"
        except (ValueError, struct.error, UnicodeError):
            pass

        # Sword/Shield and Let's Go store actual vertex geometry in GFBMDL.
        # Root slot 8 references mesh tables, each of which contains polygon,
        # vertex declaration and vertex byte vectors (slots 0, 1, 2).
        meshes = entries(root, 8, 10000)
        mesh = meshes[0]
        attributes = entries(mesh, 1, 64)
        if not attributes:
            return None
        polygons = entries(mesh, 0, 4096)
        if not polygons:
            return None
        geom_at = field(mesh, 2)
        geom = ptr(geom_at)
        nbytes = u32(geom)
        if not 12 <= nbytes <= 450 * 1024 * 1024:
            return None
        # Large model resources may be examined through only a prefix.
        # Requiring an attribute table and polygon prevents data-only guesses.
        if not any(field(attr, 0) is not None and
                   field(attr, 1) is not None and field(attr, 2) is not None
                   for attr in attributes):
            return None
        return ".gfbmdl"
    except (ValueError, struct.error, UnicodeError):
        return None


def content_extension(data):
    """Signatures identify formats, never an original filename or species."""
    for magic, extension in ((b'BNTX', '.bntx'), (b'DDS ', '.dds'),
                             (b'\x89PNG\r\n\x1a\n', '.png')):
        if data.startswith(magic):
            return extension
    model_extension = _native_model_type(data)
    if model_extension:
        return model_extension
    # Native animation FlatBuffers have no magic. Require playback info,
    # bounded bone vectors, valid strings and supported channel union tables.
    def read(fmt, at):
        return struct.unpack_from(fmt, data, at)[0]
    def table(at):
        if at < 4 or at + 4 > len(data):
            raise ValueError('table')
        vt = at - read('<i', at)
        if vt < 0 or vt + 4 > len(data):
            raise ValueError('vtable')
        size, obj = read('<H', vt), read('<H', vt + 2)
        if size < 4 or size % 2 or vt + size > len(data) or obj < 4 or at + obj > len(data):
            raise ValueError('bounds')
        return at, vt, size, obj
    def field(t, slot):
        at, vt, size, obj = t
        entry = 4 + slot * 2
        offset = read('<H', vt + entry) if entry < size else 0
        if offset and not 4 <= offset < obj:
            raise ValueError('field')
        return at + offset if offset else None
    def target(at):
        if at is None:
            raise ValueError('missing pointer')
        result = at + read('<I', at)
        if result <= at or result + 4 > len(data):
            raise ValueError('pointer')
        return result
    try:
        root = table(read('<I', 0))
        info = table(target(field(root, 0)))
        fa, ra = field(info, 1), field(info, 2)
        frames, rate = read('<I', fa) if fa else 0, read('<I', ra) if ra else 30
        if not 0 < frames <= 120000 or not 0 < rate <= 1000:
            return None
        skeletal = table(target(field(root, 1)))
        vector = target(field(skeletal, 0))
        count = read('<I', vector)
        if not 0 < count <= 4096 or vector + 4 + count * 4 > len(data):
            return None
        for i in range(count):
            track = table(target(vector + 4 + i * 4))
            name = target(field(track, 0))
            length = read('<I', name)
            if not 0 < length <= 256 or name + 4 + length >= len(data):
                return None
            text = data[name + 4:name + 4 + length].decode('utf-8')
            if not text.isprintable() or data[name + 4 + length] != 0:
                return None
            channels = 0
            for slot in (1, 3, 5):
                ka = field(track, slot)
                kind = data[ka] if ka else 0
                if kind:
                    if not 1 <= kind <= 4:
                        return None
                    channel = table(target(field(track, slot + 1)))
                    values_at = field(channel, 0 if kind <= 2 else 1)
                    if values_at is None:
                        return None
                    stride = 6 if slot == 3 else 12
                    if kind == 1:
                        if values_at + stride > len(data):
                            return None
                    else:
                        values = target(values_at)
                        points = read('<I', values)
                        if not 0 < points <= 240000 or values + 4 + points * stride > len(data):
                            return None
                        if kind >= 3:
                            keys = target(field(channel, 0))
                            if read('<I', keys) != points or keys + 4 + points * (2 if kind == 3 else 1) > len(data):
                                return None
                    channels += 1
            if not channels:
                return None
        return '.tranm'
    except (ValueError, struct.error, IndexError, UnicodeError):
        return None


def discover_resource_names(archive, initial):
    """Follow descriptors and inspect every unknown member, one at a time.

    Large resources get a prefix read; unreadable resources remain unknown.
    """
    names = dict(initial)
    families = {pokemon_id(name) for name in names.values()
                if Path(name).suffix.lower() in {".trmdl", ".gfbmdl"}} - {""}
    family = next(iter(families)) + "_" if len(families) == 1 else ""
    if not family:
        # The RomFS archive basename provides a display label, not proof
        # of a resource type. Type still comes from decoded model structure.
        origin = pokemon_id(getattr(getattr(archive, "source", None), "stem", ""))
        if origin:
            family = origin + "_"
    hashes = {}
    for resource in archive.resources:
        for value in (resource.path_hash, resource.file_hash):
            if value:
                hashes.setdefault(value, {})[resource.index] = resource
    queue = deque(r.index for r in archive.resources if r.index in names and
                  Path(names[r.index]).suffix.lower() in DESCRIPTORS)
    visited = set()
    def inspect(index):
        if index in visited:
            return
        visited.add(index)
        resource = archive.resources[index]
        try:
            if resource.size <= MAX_DESCRIPTOR:
                data = archive.read_resource(resource)
            else:
                data, decoded = archive.peek_resource(resource, 4096)
                if not decoded:
                    return
        except (GFPakError, OSError, ImportError, ValueError):
            return
        extension = content_extension(data)
        if index not in names and extension:
            names[index] = f'{family}resource_{index:04d}{extension}'
        for match in set(REFERENCE_RE.findall(data)):
            try:
                original = safe_path(match.decode('ascii')).as_posix()
            except (UnicodeError, ConversionError, ValueError):
                continue
            found = {}
            # Game Freak also uses a nonstandard FNV offset basis. A format
            # label alone is insufficient: exact descriptor names must match
            # the archive hashes before replacing discovery aliases.
            for spelling in (original, original.rsplit('/', 1)[-1]):
                for seed in (0xCBF29CE484222325, 0xCBF29CE484222645):
                    found.update(hashes.get(fnv1a64(spelling, seed), {}))
            if len(found) == 1:
                resolved = next(iter(found))
                names[resolved] = original
                if Path(original).suffix.lower() in DESCRIPTORS:
                    queue.append(resolved)
    while queue:
        inspect(queue.popleft())
    for resource in archive.resources:
        if resource.index not in names:
            inspect(resource.index)
        while queue:
            inspect(queue.popleft())
    return names
