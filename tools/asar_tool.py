"""Extract the JSON header of an Electron asar archive and optionally dump files.

Usage:
    python asar_tool.py list  <archive> [substring]
    python asar_tool.py cat   <archive> <inner/path>
    python asar_tool.py dump  <archive> <inner/prefix> <outdir>
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

HEADER_SIZE = 16  # 4 x uint32: pickle size, header size, header+string size, json size


def read_header(archive: Path) -> tuple[dict, int]:
    with archive.open("rb") as fh:
        raw = fh.read(HEADER_SIZE)
        if len(raw) != HEADER_SIZE:
            raise SystemExit("archive too small")
        _pickle, _hdr, _hdrstr, json_size = struct.unpack("<4I", raw)
        if json_size <= 0 or json_size > 64 * 1024 * 1024:
            raise SystemExit(f"implausible json header size: {json_size}")
        payload = fh.read(json_size)
        if len(payload) != json_size:
            raise SystemExit("truncated header")
    # Header JSON is padded to an 8-byte boundary relative to the 16-byte prefix.
    text = payload.decode("utf-8", errors="replace").rstrip("\x00").strip()
    return json.loads(text), 8 + json_size  # data starts at 8 + json_size


def walk(node: dict, prefix: str = ""):
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}/{name}" if prefix else name
        if "files" in entry:
            yield from walk(entry, path)
        else:
            yield path, entry


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, archive = sys.argv[1], Path(sys.argv[2])
    header, base = read_header(archive)

    if cmd == "list":
        needle = sys.argv[3] if len(sys.argv) > 3 else ""
        count = 0
        for path, entry in walk(header):
            if needle and needle not in path:
                continue
            print(f"{entry.get('size', 0):>10}  {path}")
            count += 1
        print(f"--- {count} entries ---", file=sys.stderr)
        return 0

    if cmd == "cat":
        target = sys.argv[3].strip("/")
        for path, entry in walk(header):
            if path == target:
                with archive.open("rb") as fh:
                    fh.seek(base + int(entry["offset"]))
                    data = fh.read(int(entry["size"]))
                sys.stdout.write(data.decode("utf-8", errors="replace"))
                return 0
        print(f"not found: {target}", file=sys.stderr)
        return 1

    if cmd == "dump":
        want = sys.argv[3].strip("/")
        outdir = Path(sys.argv[4])
        n = 0
        for path, entry in walk(header):
            if not path.startswith(want):
                continue
            if int(entry.get("size", 0)) > 8 * 1024 * 1024:
                continue
            dest = outdir / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open("rb") as fh:
                fh.seek(base + int(entry["offset"]))
                dest.write_bytes(fh.read(int(entry["size"])))
            n += 1
        print(f"dumped {n} files to {outdir}")
        return 0

    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
