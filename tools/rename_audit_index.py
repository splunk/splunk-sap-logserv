#!/usr/bin/env python3
"""
rename_audit_index.py — one-shot rename of the underscore-prefixed
audit-index name (`_ai_assistant_audit`) to its current
non-underscore form (`ai_assistant_audit`) across the v0.1.1 snapshot.

Reason: AppInspect (Splunkbase precert) forbids custom-app index names
that start with `_` because that prefix is reserved for Splunk's
internal indexes. The functional behavior is unchanged; only the index
name differs.

Already executed in v0.1.1 build 185 prep; preserved as a historical
artifact in case the rename needs to be re-applied to a fresh checkout.
Skips build outputs (node_modules, stage, dist, output, types) and
binary files.
"""

import os
import sys

# Use char-concat tricks so this script's own constants survive a
# self-rerun (otherwise the script's source itself would be replaced
# the first time it ran).
OLD = "_" + "ai_assistant_audit"
NEW = "ai_assistant_audit"

# Skip these directories anywhere in the path
SKIP_DIRS = {
    "node_modules",
    "stage",
    "dist",
    "output",
    "types",
    ".git",
    "release_binaries",
    "build",
    ".venv",
    "__pycache__",
}

# Only process these extensions
PROCESS_EXTS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".conf",
    ".md",
    ".html",
    ".py",
    ".txt",
    ".xml",
}


def should_skip_dir(path):
    parts = path.replace("\\", "/").split("/")
    return any(p in SKIP_DIRS for p in parts)


def process_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except (UnicodeDecodeError, OSError):
        return None

    if OLD not in content:
        return None

    count = content.count(OLD)
    new_content = content.replace(OLD, NEW)

    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(new_content)

    return count


def main():
    if len(sys.argv) < 2:
        print("Usage: rename_audit_index.py <root_dir>")
        sys.exit(1)

    root = sys.argv[1]
    if not os.path.isdir(root):
        print("Not a directory:", root)
        sys.exit(1)

    total_files = 0
    total_replacements = 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

        if should_skip_dir(dirpath):
            continue

        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in PROCESS_EXTS:
                continue

            full = os.path.join(dirpath, fname)
            count = process_file(full)
            if count:
                rel = os.path.relpath(full, root)
                print(f"  {count:3d}x  {rel}")
                total_files += 1
                total_replacements += count

    print()
    print(f"Modified {total_files} files; {total_replacements} total replacements")


if __name__ == "__main__":
    main()
