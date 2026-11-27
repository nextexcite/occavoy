"""Materialize the ignored local env file from a fnox profile.

Refresh lane contract (see docs/environment.md):
- export the selected fnox profile to a private staging file outside the loader's input
- validate the resolved key names against the profile's declared secrets, without printing values
- merge into the target dotenv file inside a marker-managed block, preserving unmanaged entries
- atomically replace the target (mode 0600) only on success; any failure leaves the prior
  file untouched

Never prints secret values. Exit nonzero on any failure.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

BLOCK_BEGIN = "# >>> fnox managed (profile: {profile}) — do not edit between these markers"
BLOCK_END = "# <<< fnox managed"

KEY_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def fail(message: str) -> None:
    print(f"secrets refresh failed: {message}", file=sys.stderr)
    sys.exit(1)


def run_fnox(args: list[str], cwd: Path) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["fnox", *args],
        cwd=cwd,
        capture_output=True,
        check=False,
    )


def declared_keys(profile: str, cwd: Path) -> set[str]:
    """Value-free list of secret names the profile declares."""
    result = run_fnox(
        ["-P", profile, "--no-defaults", "--no-daemon", "env", "--json", "--describe"],
        cwd,
    )
    if result.returncode != 0:
        fail("could not enumerate profile secrets (check fnox version and profile name)")
    import json

    try:
        payload = json.loads(result.stdout.decode())
    except ValueError:
        fail("unexpected fnox metadata shape")
    keys = payload.get("keys") if isinstance(payload, dict) else None
    if not isinstance(keys, list):
        fail("unexpected fnox metadata shape")
    names = {str(entry["key"]) for entry in keys if isinstance(entry, dict) and "key" in entry}
    if not names:
        fail("profile declares no secrets")
    return names


def parse_env_file(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line in path.read_text().splitlines():
        match = KEY_RE.match(line.strip())
        if match:
            value = match.group(2)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            entries[match.group(1)] = value
    return entries


def export_profile(profile: str, staging: Path, cwd: Path) -> dict[str, str]:
    result = run_fnox(
        ["-P", profile, "--no-defaults", "--no-daemon", "export", "-f", "env", "-o", str(staging)],
        cwd,
    )
    if result.returncode != 0 or not staging.exists():
        fail("fnox export failed — check Doppler authentication and profile selection")
    return parse_env_file(staging)


def merge_block(existing: str, profile: str, entries: dict[str, str]) -> str:
    begin = BLOCK_BEGIN.format(profile=profile)
    block_lines = [begin] + [f"{key}={entries[key]}" for key in sorted(entries)] + [BLOCK_END]
    lines = existing.splitlines()
    try:
        start = lines.index(begin)
        end = lines.index(BLOCK_END, start)
    except ValueError:
        merged = lines[:]
        if merged and merged[-1].strip():
            merged.append("")
        merged.extend(block_lines)
    else:
        merged = lines[:start] + block_lines + lines[end + 1 :]
    text = "\n".join(merged).rstrip("\n") + "\n"
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()

    os.umask(0o077)
    target: Path = args.output
    if not target.is_absolute():
        target = args.repo_root / target

    expected = declared_keys(args.profile, args.repo_root)
    with tempfile.TemporaryDirectory() as tmp:
        staging = Path(tmp) / "export.env"
        entries = export_profile(args.profile, staging, args.repo_root)

    missing = expected - set(entries)
    if missing:
        fail(f"profile resolution incomplete; missing: {', '.join(sorted(missing))}")
    empty = sorted(key for key, value in entries.items() if not value)
    if empty:
        fail(f"resolved values empty for: {', '.join(empty)}")

    existing = target.read_text() if target.exists() else ""
    merged = merge_block(existing, args.profile, entries)

    fd, tmpname = tempfile.mkstemp(dir=target.parent, prefix=".env.refresh.")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(merged)
        os.chmod(tmpname, 0o600)
        os.replace(tmpname, target)
    except BaseException:
        if os.path.exists(tmpname):
            os.unlink(tmpname)
        raise

    print(f"refreshed {target.name} from profile '{args.profile}': {', '.join(sorted(entries))}")


if __name__ == "__main__":
    main()
