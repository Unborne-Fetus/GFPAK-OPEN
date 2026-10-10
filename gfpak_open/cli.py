"""Command-line interface for GFPAK Open."""
import argparse
import json
import sys

from .core import GFPak, GFPakError


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="gfpak-open", description="Inspect and extract GFLXPACK archives")
    parser.add_argument("archive", nargs="?", help="Path to an extracted .gfpak file")
    parser.add_argument("--list", action="store_true", help="List the internal resources")
    parser.add_argument("--report", metavar="JSON", help="Save metadata to JSON")
    parser.add_argument("--extract", metavar="FOLDER", help="Extract all resources")
    parser.add_argument("--packed", action="store_true", help="Extract raw compressed blocks without decoding")
    parser.add_argument("--oodle", metavar="DLL", help="Path to a legitimately obtained oo2core_*.dll")
    args = parser.parse_args(argv)
    if not args.archive:
        parser.print_help()
        return 0
    try:
        archive = GFPak(args.archive)
        print(json.dumps(archive.summary(), indent=2))
        if args.list:
            for r in archive.resources:
                print(f"{r.index:04d}  c={r.compression}  {r.packed_size:>8} -> {r.size:>8}  {r.folder_name}/{r.filename}")
        if args.report:
            archive.save_report(args.report)
            print(f"Saved report: {args.report}")
        if args.extract:
            extracted = archive.extract(args.extract, oodle_dll=args.oodle, packed=args.packed)
            print(f"Extracted {len(extracted)} resources to {args.extract}")
        return 0
    except (GFPakError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
