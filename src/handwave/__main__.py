import argparse
import sys

from ._assets import cache_dir, download_assets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="handwave")
    sub = parser.add_subparsers(dest="command", required=True)

    dl = sub.add_parser(
        "download",
        help="Download the MediaPipe files handwave needs, so it works offline.",
    )
    dl.add_argument(
        "--force", action="store_true", help="Re-download files already cached."
    )
    sub.add_parser("cache-dir", help="Print where downloaded files are kept.")

    args = parser.parse_args(argv)
    if args.command == "download":
        print(f"Caching MediaPipe files in {cache_dir()}")
        try:
            download_assets(force=args.force)
        except Exception as e:
            print(f"Download failed: {e}", file=sys.stderr)
            return 1
        print("Done. handwave will now work offline.")
    elif args.command == "cache-dir":
        print(cache_dir())
    return 0


if __name__ == "__main__":
    sys.exit(main())
