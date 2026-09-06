#!/usr/bin/env python3
"""Build the self-contained bridge zipapp without embedding tests or build files."""

from __future__ import annotations

import argparse
import os
import stat
import tempfile
import zipfile
from pathlib import Path


def bundle_sources(source: Path) -> list[tuple[str, Path]]:
    package = source / "remodr_bridge"
    entry = source / "archive_main.py"
    if package.is_symlink() or not package.is_dir():
        raise ValueError(f"Missing or unsafe bridge package: {package}")
    for required in (entry, package / "__init__.py", package / "__main__.py"):
        if not required.is_file() or required.is_symlink():
            raise ValueError(f"Missing or unsafe bridge source: {required}")
    files = [("__main__.py", entry)]
    for path in sorted(package.rglob("*")):
        relative = path.relative_to(source)
        if (
            any(part.startswith(".") or part in ("tests", "__pycache__") for part in relative.parts)
            or path.name.startswith("test_")
            or path.name.endswith("_test.py")
        ):
            continue
        if path.is_symlink():
            raise ValueError(f"Unsafe bridge module: {path}")
        if not path.is_file() or path.suffix != ".py":
            continue
        if package.resolve() not in path.resolve().parents:
            raise ValueError(f"Unsafe bridge module: {path}")
        files.append((relative.as_posix(), path))
    return sorted(files)


def build_bundle(output: Path, source: Path | None = None) -> Path:
    source = source or Path(__file__).resolve().parent
    files = bundle_sources(source)
    output = output.absolute()
    if output.is_symlink():
        raise ValueError(f"Refusing a symlink bundle destination: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent,
    )
    temporary = Path(temporary_name)
    os.close(descriptor)
    try:
        # Stored entries need no remote zlib and have compressor-independent hashes.
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, path in files:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.compress_type = zipfile.ZIP_STORED
                archive.writestr(info, path.read_bytes())
        # Stable bytes and timestamps avoid needless content-addressed redeploys.
        if not output.is_file() or output.read_bytes() != temporary.read_bytes():
            temporary.replace(output)
        return output
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="Destination .pyz file")
    arguments = parser.parse_args()
    print(build_bundle(arguments.output))


if __name__ == "__main__":
    main()
