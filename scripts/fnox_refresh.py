"""Materialize the ignored local env file from a fnox profile.

Refresh lane contract (see docs/environment.md):
- export the selected fnox profile as JSON to a private staging file outside the loader's input
- validate the resolved key names against the profile's declared secrets, without printing values
- encode values semantically for dotenv and verify the merged file through Node's util.parseEnv
- merge into the target dotenv file inside a marker-managed block, preserving unmanaged entries
- atomically replace the target (mode 0600) only on success; any failure leaves the prior
  file untouched

Never prints secret values. Exit nonzero on any failure.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

BLOCK_BEGIN = "# >>> fnox managed (profile: {profile}) — do not edit between these markers"
BLOCK_END = "# <<< fnox managed"
BLOCK_BEGIN_PREFIX = "# >>> fnox managed"

IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# Characters that survive unquoted dotenv parsing unchanged: no whitespace at the
# edges, no comment introducer, no newline, and no leading quote (which would
# reparse as a quoted string).
QUOTE_CHARS = "'`\""

VERIFY_SNIPPET = (
    "import {readFileSync} from 'node:fs';"
    "import {parseEnv} from 'node:util';"
    "const {text,expected}=JSON.parse(readFileSync(0,'utf8'));"
    "const actual=parseEnv(text);"
    "process.exitCode=Object.entries(expected).every(([k,v])=>actual[k]===v)?0:1;"
)


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
    if any(not IDENTIFIER_RE.fullmatch(name) for name in names):
        fail("invalid secret name in profile metadata")
    return names


def export_profile(profile: str, staging: Path, cwd: Path) -> dict[str, str]:
    """Export resolved secrets as JSON. The env/dotenv fnox format rewrites literal
    backslashes and quote characters under Node, so it is never parsed line by line."""
    result = run_fnox(
        ["-P", profile, "--no-defaults", "--no-daemon", "export", "-f", "json", "-o", str(staging)],
        cwd,
    )
    if result.returncode != 0 or not staging.exists():
        fail("fnox export failed — check authentication and profile selection")
    try:
        payload = json.loads(staging.read_text())
    except ValueError:
        fail("unexpected fnox export shape")
    secrets = payload.get("secrets") if isinstance(payload, dict) else None
    if not isinstance(secrets, dict) or not secrets:
        fail("unexpected fnox export shape")
    entries: dict[str, str] = {}
    if any(not IDENTIFIER_RE.fullmatch(str(key)) for key in secrets):
        fail("invalid secret name in export")
    for key, value in secrets.items():
        if not isinstance(value, str):
            fail(f"non-string secret value type for: {key}")
        entries[str(key)] = value
    return entries


def encode_dotenv_value(value: str) -> str:
    """Encode one semantic value so Node util.parseEnv returns it byte-for-byte.
    Never transforms literal backslashes; fails closed when unrepresentable."""
    if "\x00" in value or "\r" in value:
        fail("secret value contains NUL or CR and cannot be represented in dotenv")
    if (
        value == value.strip()
        and "\n" not in value
        and "#" not in value
        and (not value or value[0] not in QUOTE_CHARS)
    ):
        return value
    for delimiter in QUOTE_CHARS:
        if delimiter in value:
            continue
        if delimiter == '"' and "\\" in value:
            # Double quotes reinterpret backslash escapes; never risk mutation.
            continue
        return f"{delimiter}{value}{delimiter}"
    fail("secret value is not representable in dotenv without mutation")
    raise AssertionError("unreachable")


def encode_block(profile: str, entries: dict[str, str]) -> list[str]:
    lines = [BLOCK_BEGIN.format(profile=profile)]
    for key in sorted(entries):
        lines.append(f"{key}={encode_dotenv_value(entries[key])}")
    lines.append(BLOCK_END)
    for line in lines[1:-1]:
        for embedded in line.split("\n"):
            if embedded == BLOCK_END or embedded.startswith(BLOCK_BEGIN_PREFIX):
                fail("secret value embeds a managed-block marker line")
    return lines


def merge_block(existing: str, profile: str, entries: dict[str, str]) -> str:
    """Splice the managed block into existing content, preserving every unmanaged
    byte (CRLF, blank lines, unicode separators) outside the markers. Legacy
    placeholder lines before the block are kept: the later managed block wins in
    parseEnv, and a conflicting duplicate after the block fails verification."""
    begin = BLOCK_BEGIN.format(profile=profile)
    rows = existing.split("\n")
    begins = [
        index
        for index, line in enumerate(rows)
        if line.removesuffix("\r").startswith(BLOCK_BEGIN_PREFIX)
    ]
    ends = [index for index, line in enumerate(rows) if line.removesuffix("\r") == BLOCK_END]
    if len(begins) != len(ends) or len(begins) > 1:
        fail("target file has broken or duplicate managed-block markers; edit it manually")
    block = "\n".join(encode_block(profile, entries))
    if not begins:
        separator = "" if not existing or existing.endswith("\n") else "\n"
        return existing + separator + block + "\n"
    start, end = begins[0], ends[0]
    if end < start or rows[start].removesuffix("\r") != begin:
        fail("target file has broken or duplicate managed-block markers; edit it manually")
    rows[start : end + 1] = [block]
    return "\n".join(rows)


def verify_merged(merged: str, entries: dict[str, str]) -> None:
    """Semantic equality of managed keys in the full merged output, checked with
    Node util.parseEnv before the target is replaced. Values never appear in
    argv, output, or errors."""
    payload = json.dumps({"text": merged, "expected": entries}).encode()
    result = subprocess.run(
        ["node", "--input-type=module", "-e", VERIFY_SNIPPET],
        input=payload,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail("merged env file does not round-trip through Node util.parseEnv")


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
        staging = Path(tmp) / "export.json"
        entries = export_profile(args.profile, staging, args.repo_root)

    missing = expected - set(entries)
    if missing:
        fail(f"profile resolution incomplete; missing: {', '.join(sorted(missing))}")
    unexpected = set(entries) - expected
    if unexpected:
        fail(f"profile resolution returned unexpected keys: {', '.join(sorted(unexpected))}")
    empty = sorted(key for key, value in entries.items() if not value)
    if empty:
        fail(f"resolved values empty for: {', '.join(empty)}")

    if args.profile == "local":
        if entries.get("OCCAVOY_RUNTIME_MODE", "local") != "local":
            fail("OCCAVOY_RUNTIME_MODE must resolve to the local mode for the local profile")
        token = entries.get("OCCAVOY_RUNTIME_DEMO_TOKEN")
        if token is not None and len(token) < 32:
            fail("OCCAVOY_RUNTIME_DEMO_TOKEN must be at least 32 characters")

    existing = ""
    if target.exists():
        with target.open("r", encoding="utf-8", newline="") as handle:
            existing = handle.read()
    merged = merge_block(existing, args.profile, entries)
    verify_merged(merged, entries)

    fd, tmpname = tempfile.mkstemp(dir=target.parent, prefix=".env.refresh.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
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
