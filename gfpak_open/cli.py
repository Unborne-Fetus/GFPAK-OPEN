"""Archive diagnostics and 3D model conversion CLI."""
import argparse
import json
import sys
from pathlib import Path

from .converter import ConversionError, ConversionOptions, convert_model
from .core import GFPak, GFPakError


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="gfpak-open", description="Convert Pokémon TRMDL models or inspect GFLXPACK archives")
    parser.add_argument("archive", nargs="?", help="Path to .gfpak file or decoded TRMDL directory")
    parser.add_argument("--convert-glb", metavar="MODEL.GLB", help="Convert model into real GLB using Blender")
    parser.add_argument("--blender", metavar="EXE", help="Blender executable path")
    parser.add_argument("--addon", metavar="FOLDER", help="Pokémon Switch Blender importer folder")
    parser.add_argument("--hashes", metavar="FILE", help="GFPAK filename dictionary, gfpak.txt or JSON")
    parser.add_argument("--model", metavar="NAME", help="Which TRMDL model to convert")
    parser.add_argument("--textures", metavar="FOLDER", help="Optional decoded PNG textures")
    parser.add_argument("--animations", action="store_true", help="Import available compatible animations")
    parser.add_argument("--keep-extracted", metavar="FOLDER", help="Keep decoded source files for inspection")
    parser.add_argument("--list", action="store_true", help="List archive entries")
    parser.add_argument("--report", metavar="JSON", help="Save JSON archive metadata")
    parser.add_argument("--extract", metavar="FOLDER", help="Extract resources with hashed names")
    parser.add_argument("--packed", action="store_true", help="Save compressed blocks without decoding")
    parser.add_argument("--oodle", metavar="DLL", help="Locally supplied compatible Oodle DLL")
    args = parser.parse_args(argv)
    if not args.archive:
        parser.print_help()
        return 0
    try:
        if args.convert_glb:
            if not args.blender or not args.addon:
                raise ConversionError("--convert-glb requires --blender and --addon")
            output = convert_model(ConversionOptions(
                source=Path(args.archive), output=Path(args.convert_glb),
                blender=Path(args.blender), addon=Path(args.addon),
                dictionary=Path(args.hashes) if args.hashes else None,
                oodle=Path(args.oodle) if args.oodle else None,
                texture_folder=Path(args.textures) if args.textures else None,
                preferred_model=args.model, animations=args.animations,
                keep_extracted=Path(args.keep_extracted) if args.keep_extracted else None,
            ), progress=print)
            print("Converted to", output)
            return 0
        archive = GFPak(args.archive)
        print(json.dumps(archive.summary(), indent=2))
        if args.list:
            for r in archive.resources:
                print(f"{r.index:04d} c={r.compression} {r.packed_size:>8} -> {r.size:>8} {r.folder_name}/{r.filename}")
        if args.report:
            archive.save_report(args.report)
            print("Saved report:", args.report)
        if args.extract:
            extracted = archive.extract(args.extract, oodle_dll=args.oodle, packed=args.packed)
            print(f"Extracted {len(extracted)} entries to {args.extract}")
        return 0
    except (GFPakError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
