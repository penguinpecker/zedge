#!/usr/bin/env python3
"""Install checksum-pinned evaluation build tools into an explicit task directory.

No global package installation or unverified downloaded executable is used.
"""
import hashlib
import pathlib
import platform
import sys
import tarfile
import urllib.request

ASSETS = {
    ("Linux", "x86_64"): [
        ("https://github.com/tinygo-org/tinygo/releases/download/v0.39.0/tinygo0.39.0.linux-amd64.tar.gz", "a119801579ef0a7a4f3ee285f0caf55241eaa9e115154c2028b696770b47a846"),
        ("https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz", "2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489"),
    ],
    ("Darwin", "arm64"): [
        ("https://github.com/tinygo-org/tinygo/releases/download/v0.39.0/tinygo0.39.0.darwin-arm64.tar.gz", "a5827b8d4a8920682bf350053d7cf86a09be2951b010e99aa6a47d22ef0f5630"),
        ("https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-arm64-macos.tar.gz", "ad66da82ac13f163e424b1643f16c6dfcccc98b5966296b43e52d3cab04f84a8"),
    ],
}

def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: install-wasm-tools.py /absolute/task/tools-directory")
    root = pathlib.Path(sys.argv[1])
    if not root.is_absolute():
        raise SystemExit("An absolute task-specific tools directory is required.")
    assets = ASSETS.get((platform.system(), platform.machine()))
    if not assets:
        raise SystemExit("This platform needs a reviewed asset checksum before installation.")
    root.mkdir(parents=True, exist_ok=True)
    for url, expected in assets:
        archive = root / url.rsplit("/", 1)[1]
        if not archive.exists():
            with urllib.request.urlopen(url, timeout=60) as response:
                archive.write_bytes(response.read())
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise SystemExit(f"Checksum mismatch: {archive.name}")
        with tarfile.open(archive) as bundle:
            bundle.extractall(root, filter="data")
    print("Verified TinyGo 0.39.0 and Binaryen 133 in", root)

if __name__ == "__main__":
    main()
