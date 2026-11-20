"""Download-and-cache for the MediaPipe files the widget needs.

handwave doesn't redistribute MediaPipe. Instead, the first time each file is
needed it's downloaded from the jsDelivr CDN into a local cache directory, and
from then on it's served to the browser from that cache, so the widget keeps
working without a network connection. Run ``python -m handwave download``
ahead of time to fetch everything up front.
"""

from __future__ import annotations

import os
import pathlib
import sys
import tempfile
import urllib.request

CDN = "https://cdn.jsdelivr.net/npm"

# Exact versions, so the cache never mixes files from different releases.
PACKAGES = {
    "hands": "0.4.1675469240",
    "camera_utils": "0.3.1675466862",
    "drawing_utils": "0.3.1675466124",
}

# File name (as requested by the browser) -> npm package it comes from.
ASSETS = {
    "camera_utils.js": "camera_utils",
    "drawing_utils.js": "drawing_utils",
    "hands.js": "hands",
    "hands.binarypb": "hands",
    "hands_solution_packed_assets_loader.js": "hands",
    "hands_solution_packed_assets.data": "hands",
    "hands_solution_simd_wasm_bin.js": "hands",
    "hands_solution_simd_wasm_bin.wasm": "hands",
    "hands_solution_wasm_bin.js": "hands",
    "hands_solution_wasm_bin.wasm": "hands",
    "hand_landmark_full.tflite": "hands",
    "hand_landmark_lite.tflite": "hands",
}


class AssetUnavailableError(Exception):
    pass


def cache_dir() -> pathlib.Path:
    """Where downloaded MediaPipe files are kept.

    Override with the ``HANDWAVE_CACHE_DIR`` environment variable.
    """
    override = os.environ.get("HANDWAVE_CACHE_DIR")
    if override:
        return pathlib.Path(override).expanduser()
    if sys.platform == "darwin":
        base = pathlib.Path.home() / "Library" / "Caches"
    elif sys.platform == "win32":
        base = pathlib.Path(
            os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local")
        )
    else:
        base = pathlib.Path(
            os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache")
        )
    return base / "handwave"


def _asset_path(name: str) -> pathlib.Path:
    package = ASSETS[name]
    return cache_dir() / f"{package}-{PACKAGES[package]}" / name


def _asset_url(name: str) -> str:
    package = ASSETS[name]
    return f"{CDN}/@mediapipe/{package}@{PACKAGES[package]}/{name}"


def _download(name: str, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write to a temp file and rename, so an interrupted download never
    # leaves a truncated file in the cache.
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{name}.")
    try:
        with os.fdopen(fd, "wb") as f, urllib.request.urlopen(
            _asset_url(name), timeout=60
        ) as resp:
            while chunk := resp.read(1 << 16):
                f.write(chunk)
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def get_asset(name: str) -> bytes:
    """Return the contents of a MediaPipe file, downloading it if needed."""
    if name not in ASSETS:
        raise AssetUnavailableError(f"Unknown asset: {name!r}")
    path = _asset_path(name)
    if not path.exists():
        try:
            _download(name, path)
        except Exception as e:
            raise AssetUnavailableError(
                f"{name} isn't cached and couldn't be downloaded ({e}). "
                "Connect to the internet and run `python -m handwave download`."
            ) from e
    return path.read_bytes()


def download_assets(*, force: bool = False, quiet: bool = False) -> pathlib.Path:
    """Download every MediaPipe file handwave can use, for offline use.

    Returns the cache directory.
    """
    for name in ASSETS:
        path = _asset_path(name)
        if path.exists() and not force:
            if not quiet:
                print(f"  cached      {name}")
            continue
        if not quiet:
            print(f"  downloading {name}", flush=True)
        _download(name, path)
    return cache_dir()
