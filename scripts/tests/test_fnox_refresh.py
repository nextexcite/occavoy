"""Regression tests for scripts/fnox_refresh.py and scripts/load-local-env.mjs.

All secrets are synthetic; a stubbed `fnox` binary hermetic to the test temp dir
stands in for the real profile. Assertions about secret values happen inside the
verifying child process or in local memory — never in process output.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import time
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
REFRESH = REPO_ROOT / "scripts" / "fnox_refresh.py"
PRELOAD = REPO_ROOT / "scripts" / "load-local-env.mjs"
LOCAL_EXEC = REPO_ROOT / "scripts" / "local-exec.mjs"
PROTOCOL = REPO_ROOT / "apps" / "runtime" / "src" / "protocol.ts"

# The pinned toolchain PATH of the test workspace; child processes receive only
# this plus explicit synthetic fixture variables, never the ambient environment.
BASE_PATH = os.environ.get("PATH", "")


def base_env(tmp_path: Path, extra: dict | None = None) -> dict:
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    tmp = tmp_path / "tmp"
    tmp.mkdir(exist_ok=True)
    env = {"PATH": BASE_PATH, "HOME": str(home), "TMPDIR": str(tmp)}
    if extra:
        env.update(extra)
    return env


FNOX_STUB = """#!/usr/bin/env python3
import json
import os
import sys

data = json.loads(open(os.environ["FNOX_STUB_DATA"]).read())
args = sys.argv[1:]
if "env" in args:
    print(json.dumps({"keys": [{"key": key} for key in data["declared"]]}))
    sys.exit(0)
if "export" in args:
    if data.get("export_mode") == "fail":
        sys.exit(1)
    out = args[args.index("-o") + 1]
    fmt = args[args.index("-f") + 1]
    if fmt != "json":
        sys.exit(3)
    with open(out, "w") as handle:
        json.dump({"secrets": data.get("secrets", {})}, handle)
    sys.exit(0)
sys.exit(2)
"""

TRICKY = {
    "KEY_SIMPLE": "simple-word",
    "KEY_HASH": "abc#def",
    "KEY_SPACES": "with interior spaces",
    "KEY_EDGE_SPACE": " trailing",
    "KEY_LITERAL_BACKSLASH": "C:\\path\\nis-not-a-newline",
    "KEY_MULTILINE": "line1\nline2",
    "KEY_MIXED_QUOTES": 'it\'s a "test"',
    "KEY_BACKTICK": "has`tick",
    "KEY_LEADING_QUOTE": "'leading",
    "KEY_EQUALS": "a=b=c",
}


def write_stub(tmp_path: Path, declared: list[str], secrets: dict, export_mode: str = "ok"):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "fnox"
    stub.write_text(FNOX_STUB)
    stub.chmod(0o755)
    data = tmp_path / "stub-data.json"
    payload = {"declared": declared, "secrets": secrets, "export_mode": export_mode}
    data.write_text(json.dumps(payload))
    env = base_env(tmp_path)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["FNOX_STUB_DATA"] = str(data)
    return env


def run_refresh(env: dict, tmp_path: Path, target: Path) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [
            sys.executable,
            str(REFRESH),
            "--profile",
            "local",
            "--output",
            str(target),
            "--repo-root",
            str(tmp_path),
        ],
        env=env,
        capture_output=True,
        check=False,
    )


def parse_with_node(text: str, tmp_path: Path) -> dict[str, str]:
    snippet = (
        "import {readFileSync} from 'node:fs';"
        "import {parseEnv} from 'node:util';"
        "process.stdout.write(JSON.stringify(parseEnv(readFileSync(0,'utf8'))));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", snippet],
        input=text.encode(),
        env=base_env(tmp_path),
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, "node parseEnv failed"
    return json.loads(result.stdout)


@pytest.fixture
def lane(tmp_path: Path):
    target = tmp_path / ".env.local"
    env = write_stub(tmp_path, sorted(TRICKY), dict(TRICKY))
    return {"env": env, "tmp_path": tmp_path, "target": target}


def test_roundtrip_preserves_semantic_values(lane):
    result = run_refresh(lane["env"], lane["tmp_path"], lane["target"])
    assert result.returncode == 0, result.stderr.decode()
    assert stat.S_IMODE(lane["target"].stat().st_mode) == 0o600
    parsed = parse_with_node(lane["target"].read_text(), tmp_path=lane["tmp_path"])
    for key, value in TRICKY.items():
        assert parsed[key] == value, f"semantic mismatch for {key}"


def test_refresh_is_idempotent(lane):
    assert run_refresh(lane["env"], lane["tmp_path"], lane["target"]).returncode == 0
    first = lane["target"].read_bytes()
    assert run_refresh(lane["env"], lane["tmp_path"], lane["target"]).returncode == 0
    assert lane["target"].read_bytes() == first


def test_unmanaged_entries_and_comments_preserved(lane):
    lane["target"].write_text(
        "# hand-written comment\n"
        "RIVET_TOKEN=manual-unmanaged\n"
        "RIVET_ENDPOINT=https://example.invalid\n"
    )
    result = run_refresh(lane["env"], lane["tmp_path"], lane["target"])
    assert result.returncode == 0, result.stderr.decode()
    text = lane["target"].read_text()
    assert "RIVET_TOKEN=manual-unmanaged" in text
    assert "# hand-written comment" in text
    parsed = parse_with_node(text, tmp_path=lane["tmp_path"])
    assert parsed["RIVET_TOKEN"] == "manual-unmanaged"


def failing_lane(tmp_path: Path, secrets: dict, declared: list[str] | None = None):
    env = write_stub(tmp_path, declared or sorted(secrets), secrets)
    target = tmp_path / ".env.local"
    target.write_text("# previous good content\n")
    os.chmod(target, 0o600)
    before = target.read_bytes()
    result = run_refresh(env, tmp_path, target)
    assert result.returncode != 0, "expected refresh failure"
    assert target.read_bytes() == before, "failed refresh must preserve the previous file"
    assert stat.S_IMODE(target.stat().st_mode) == 0o600, "failed refresh must preserve the mode"
    return result


def test_missing_declared_key_fails(tmp_path):
    secrets = dict(TRICKY)
    declared = sorted({*secrets, "KEY_NEVER_EXPORTED"})
    failing_lane(tmp_path, secrets, declared)


def test_empty_value_fails(tmp_path):
    secrets = {**TRICKY, "KEY_SIMPLE": ""}
    failing_lane(tmp_path, secrets)


def test_unexpected_key_fails(tmp_path):
    secrets = {**TRICKY, "KEY_BONUS": "unexpected"}
    declared = sorted(TRICKY)
    failing_lane(tmp_path, secrets, declared)


def test_non_string_value_fails(tmp_path):
    secrets = {**TRICKY, "KEY_SIMPLE": 42}
    failing_lane(tmp_path, secrets)


def test_fnox_export_failure_fails(tmp_path):
    env = write_stub(tmp_path, sorted(TRICKY), dict(TRICKY), export_mode="fail")
    target = tmp_path / ".env.local"
    result = run_refresh(env, tmp_path, target)
    assert result.returncode != 0
    assert not target.exists()


def test_cr_value_fails(tmp_path):
    secrets = {**TRICKY, "KEY_SIMPLE": "carriage\rreturn"}
    failing_lane(tmp_path, secrets)


def test_unrepresentable_value_fails(tmp_path):
    # Newline forces quoting; every quote char is present and a backslash blocks
    # double quotes, so no delimiter can represent the value without mutation.
    secrets = {**TRICKY, "KEY_SIMPLE": "x'y`z\"w\\v\nline2"}
    failing_lane(tmp_path, secrets)


def test_embedded_marker_in_multiline_fails(tmp_path):
    secrets = {**TRICKY, "KEY_SIMPLE": "line1\n# <<< fnox managed\nline3"}
    failing_lane(tmp_path, secrets)


def test_broken_marker_pair_fails(tmp_path):
    env = write_stub(tmp_path, sorted(TRICKY), dict(TRICKY))
    target = tmp_path / ".env.local"
    target.write_text("# >>> fnox managed (profile: local) — do not edit between these markers\n")
    before = target.read_bytes()
    result = run_refresh(env, tmp_path, target)
    assert result.returncode != 0
    assert target.read_bytes() == before


def test_duplicate_marker_pairs_fail(tmp_path):
    env = write_stub(tmp_path, sorted(TRICKY), dict(TRICKY))
    target = tmp_path / ".env.local"
    begin = "# >>> fnox managed (profile: local) — do not edit between these markers"
    end = "# <<< fnox managed"
    target.write_text(f"{begin}\n{end}\n{begin}\n{end}\n")
    before = target.read_bytes()
    result = run_refresh(env, tmp_path, target)
    assert result.returncode != 0
    assert target.read_bytes() == before


def test_legacy_placeholder_before_block_accepted_unchanged(tmp_path):
    # Legacy .env.local files may start with managed-name placeholders copied
    # from .env.example; the appended managed block overrides them in parseEnv.
    env = write_stub(tmp_path, sorted(TRICKY), dict(TRICKY))
    target = tmp_path / ".env.local"
    target.write_text("KEY_SIMPLE=placeholder\nKEY_HASH=\n")
    result = run_refresh(env, tmp_path, target)
    assert result.returncode == 0, result.stderr.decode()
    text = target.read_text()
    assert text.startswith("KEY_SIMPLE=placeholder\nKEY_HASH=\n")
    parsed = parse_with_node(text, tmp_path=tmp_path)
    for key, value in TRICKY.items():
        assert parsed[key] == value, f"managed block must override placeholder for {key}"


def test_conflicting_duplicate_after_block_fails_with_old_bytes(tmp_path):
    env = write_stub(tmp_path, sorted(TRICKY), dict(TRICKY))
    target = tmp_path / ".env.local"
    assert run_refresh(env, tmp_path, target).returncode == 0
    with target.open("a") as handle:
        handle.write("KEY_SIMPLE=conflicting-shadow\n")
    before = target.read_bytes()
    result = run_refresh(env, tmp_path, target)
    assert result.returncode != 0, "conflicting duplicate after the block must fail"
    assert target.read_bytes() == before


def test_crlf_unmanaged_affixes_preserved_byte_identical(tmp_path):
    env = write_stub(tmp_path, sorted(TRICKY), dict(TRICKY))
    target = tmp_path / ".env.local"
    prefix = b"# crlf comment\r\n\r\nRIVET_TOKEN=manual\r\n"
    target.write_bytes(prefix)
    assert run_refresh(env, tmp_path, target).returncode == 0
    first = target.read_bytes()
    assert first.startswith(prefix), "CRLF prefix must survive byte-identical"
    suffix = b"\r\n# trailing note\r\n\r\n"
    with target.open("ab") as handle:
        handle.write(suffix)
    seeded = target.read_bytes()
    assert run_refresh(env, tmp_path, target).returncode == 0
    after = target.read_bytes()
    assert after.startswith(prefix), "CRLF prefix byte-identical after re-refresh"
    assert after.endswith(suffix), "CRLF suffix incl blank lines byte-identical"
    assert len(after) == len(seeded), "same entries must re-encode to identical bytes"


def node_with_preload(repo: Path, script: str, cwd: Path, env_extra: dict | None = None):
    env = base_env(cwd)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [
            "node",
            "--import",
            str(repo / "scripts" / "load-local-env.mjs"),
            "--input-type=module",
            "-e",
            script,
        ],
        cwd=cwd,
        env=env,
        capture_output=True,
        check=False,
    )


def synthetic_repo(tmp_path: Path, dotenv: str | None) -> Path:
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / "scripts" / "load-local-env.mjs").write_bytes(PRELOAD.read_bytes())
    if dotenv is not None:
        (repo / ".env.local").write_text(dotenv)
    return repo


CHECKER = (
    "process.exitCode=(process.env.DATABASE_URL==='synthetic-url'"
    "&&process.env.OCCAVOY_RUNTIME_MODE==='local'"
    "&&process.env.OCCAVOY_RUNTIME_DEMO_TOKEN==='synthetic-token'"
    "&&process.env.RIVET_TOKEN===undefined"
    "&&process.env.NODE_OPTIONS===undefined)?0:1;"
)


def test_preload_populates_only_local_names_from_any_cwd(tmp_path):
    repo = synthetic_repo(
        tmp_path,
        "DATABASE_URL=synthetic-url\nOCCAVOY_RUNTIME_MODE=local\n"
        "OCCAVOY_RUNTIME_DEMO_TOKEN=synthetic-token\nRIVET_TOKEN=unmanaged\nNODE_OPTIONS=unmanaged\n",
    )
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    result = node_with_preload(repo, CHECKER, elsewhere)
    assert result.returncode == 0, result.stderr.decode()


def test_inherited_environment_wins(tmp_path):
    synthetic_repo(
        tmp_path,
        "DATABASE_URL=file-value\nOCCAVOY_RUNTIME_MODE=local\nOCCAVOY_RUNTIME_DEMO_TOKEN=x\n",
    )
    script = "process.exitCode=process.env.DATABASE_URL==='inherited-value'?0:1;"
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    result = node_with_preload(
        tmp_path / "repo", script, elsewhere, {"DATABASE_URL": "inherited-value"}
    )
    assert result.returncode == 0, result.stderr.decode()


def test_non_local_mode_rejected(tmp_path):
    synthetic_repo(tmp_path, "OCCAVOY_RUNTIME_MODE=cloud\n")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    result = node_with_preload(tmp_path / "repo", "process.exitCode=0", elsewhere)
    assert result.returncode != 0


def test_missing_file_is_not_an_error(tmp_path):
    synthetic_repo(tmp_path, None)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    result = node_with_preload(tmp_path / "repo", "process.exitCode=0", elsewhere)
    assert result.returncode == 0


LOCAL_SECRETS = {
    "DATABASE_URL": "postgresql://127.0.0.1:54329/occavoy",
    "OCCAVOY_RUNTIME_MODE": "local",
    "OCCAVOY_RUNTIME_DEMO_TOKEN": "synthetic-token-value-of-32-plus!",
}


def test_valid_local_profile_values_succeed(tmp_path):
    env = write_stub(tmp_path, sorted(LOCAL_SECRETS), dict(LOCAL_SECRETS))
    target = tmp_path / ".env.local"
    result = run_refresh(env, tmp_path, target)
    assert result.returncode == 0, result.stderr.decode()
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_non_local_mode_value_fails(tmp_path):
    secrets = {**LOCAL_SECRETS, "OCCAVOY_RUNTIME_MODE": "cloud"}
    result = failing_lane(tmp_path, secrets)
    assert "OCCAVOY_RUNTIME_MODE" in result.stderr.decode()


def test_short_demo_token_fails(tmp_path):
    secrets = {**LOCAL_SECRETS, "OCCAVOY_RUNTIME_DEMO_TOKEN": "too-short"}
    result = failing_lane(tmp_path, secrets)
    assert "OCCAVOY_RUNTIME_DEMO_TOKEN" in result.stderr.decode()


def test_fnox_toml_local_profile_matches_loader_keys(tmp_path):
    declared = set(
        tomllib.loads((REPO_ROOT / "fnox.toml").read_text())["profiles"]["local"]["secrets"]
    )
    fixture_scripts = tmp_path / "fixture" / "scripts"
    fixture_scripts.mkdir(parents=True)
    shutil.copy(PRELOAD, fixture_scripts / "load-local-env.mjs")
    loader = (fixture_scripts / "load-local-env.mjs").as_posix()
    snippet = (
        f"import {{localKeys}} from 'file://{loader}';"
        "process.stdout.write(JSON.stringify(localKeys));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", snippet],
        env=base_env(tmp_path),
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
    keys = set(json.loads(result.stdout))
    assert keys == declared, (
        f"loader localKeys {sorted(keys)} must exactly match fnox local profile {sorted(declared)}"
    )


def test_non_enoent_preload_failure_fails(tmp_path):
    repo = synthetic_repo(tmp_path, None)
    (repo / ".env.local").mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    result = node_with_preload(repo, "process.exitCode=0", elsewhere)
    assert result.returncode != 0


def exec_fixture(tmp_path: Path, dotenv: str | None = None) -> Path:
    repo = tmp_path / "execrepo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy(PRELOAD, repo / "scripts" / "load-local-env.mjs")
    shutil.copy(LOCAL_EXEC, repo / "scripts" / "local-exec.mjs")
    (repo / "dumpargv.mjs").write_text(
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
    )
    if dotenv is not None:
        (repo / ".env.local").write_text(dotenv)
    return repo


EXEC_DOTENV = (
    "DATABASE_URL=postgresql://127.0.0.1:54329/occavoy\n"
    "OCCAVOY_RUNTIME_MODE=local\n"
    "OCCAVOY_RUNTIME_DEMO_TOKEN=synthetic-token-value-of-32-plus!\n"
    "RIVET_TOKEN=unmanaged-external\n"
)


def run_local_exec(repo: Path, tmp_path: Path, args: list[str], extra: dict | None = None):
    return subprocess.run(
        ["node", str(repo / "scripts" / "local-exec.mjs"), *args],
        cwd=repo,
        env=base_env(tmp_path, extra),
        capture_output=True,
        check=False,
    )


def test_exec_path_lookup_and_snapshot_overlay(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    script = (
        "process.exitCode=(process.env.DATABASE_URL==='postgresql://127.0.0.1:54329/occavoy'"
        "&&process.env.OCCAVOY_RUNTIME_MODE==='local')?0:1;"
    )
    result = run_local_exec(repo, tmp_path, ["node", "--input-type=module", "-e", script])
    assert result.returncode == 0, result.stderr.decode()


def test_exec_tricky_argv_passed_verbatim(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    tricky = ["", "with space", "quote'\"", "$HOME", "semi;colon", "a=b=c"]
    result = run_local_exec(repo, tmp_path, ["node", "dumpargv.mjs", *tricky])
    assert result.returncode == 0, result.stderr.decode()
    assert json.loads(result.stdout) == tricky


def test_exec_inherited_override_wins(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    script = "process.exitCode=process.env.DATABASE_URL==='inherited-override'?0:1;"
    result = run_local_exec(
        repo,
        tmp_path,
        ["node", "--input-type=module", "-e", script],
        {"DATABASE_URL": "inherited-override"},
    )
    assert result.returncode == 0, result.stderr.decode()


def test_exec_unknown_names_not_imported(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    script = "process.exitCode=process.env.RIVET_TOKEN===undefined?0:1;"
    result = run_local_exec(repo, tmp_path, ["node", "--input-type=module", "-e", script])
    assert result.returncode == 0, result.stderr.decode()


def test_exec_exit_code_propagates(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    result = run_local_exec(repo, tmp_path, ["node", "-e", "process.exit(37)"])
    assert result.returncode == 37


def test_exec_sigterm_replaces_process_image(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    ready = tmp_path / "ready"
    script = (
        "import('node:fs').then(({writeFileSync})=>{"
        f"writeFileSync({json.dumps(str(ready))},'ready');"
        "setInterval(()=>{},1000);});"
    )
    proc = subprocess.Popen(
        [
            "node",
            str(repo / "scripts" / "local-exec.mjs"),
            "node",
            "--input-type=module",
            "-e",
            script,
        ],
        cwd=repo,
        env=base_env(tmp_path),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            if ready.exists():
                break
            if proc.poll() is not None:
                break
            time.sleep(0.05)
        assert ready.exists(), "exec child never became ready"
        proc.send_signal(signal.SIGTERM)
        returncode = proc.wait(timeout=10)
        assert returncode == -signal.SIGTERM, (
            f"expected termination by SIGTERM after exec, got {returncode}"
        )
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)


@pytest.mark.parametrize(
    "argv",
    [
        [],
        [""],
        ["NAME=value"],
        ["-"],
    ],
)
def test_exec_guard_refuses_env_syntax(tmp_path, argv):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    result = run_local_exec(repo, tmp_path, argv, {"SYNTHETIC_MARKER": "marker-never-printed"})
    assert result.returncode == 2
    combined = result.stdout + result.stderr
    assert b"Usage:" in combined
    assert b"marker-never-printed" not in combined


def test_exec_equals_sign_allowed_in_non_command_args(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    result = run_local_exec(repo, tmp_path, ["node", "-e", "const x=1;process.exitCode=x-1;"])
    assert result.returncode == 0, result.stderr.decode()


def test_read_runtime_config_consumes_snapshot(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    shutil.copy(PROTOCOL, repo / "protocol.ts")
    script = (
        "const m=await import('./protocol.ts');"
        "const c=m.readRuntimeConfig(process.env);"
        "process.exitCode=(c.mode==='local'"
        "&&c.databaseUrl==='postgresql://127.0.0.1:54329/occavoy'"
        "&&typeof c.demoToken==='string'&&c.demoToken.length>=32)?0:1;"
    )
    result = subprocess.run(
        [
            "node",
            "--import",
            str(repo / "scripts" / "load-local-env.mjs"),
            "--input-type=module",
            "-e",
            script,
        ],
        cwd=repo,
        env=base_env(tmp_path),
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()


def test_pnpm_public_entrypoint(tmp_path):
    repo = exec_fixture(tmp_path, EXEC_DOTENV)
    shutil.copy(REPO_ROOT / "package.json", repo / "package.json")
    tricky = ["", "with space", "a=b=c", "semi;colon", "$HOME", "quote'\""]
    check = repo / "check.py"
    check.write_text(
        "import os, sys\n"
        f"assert sys.argv[1:] == {tricky!r}\n"
        "assert os.environ['DATABASE_URL'] == 'explicit-override'\n"
        "assert os.environ['OCCAVOY_RUNTIME_MODE'] == 'local'\n"
        "assert 'RIVET_TOKEN' not in os.environ\n"
        "sys.exit(37)\n"
    )
    result = subprocess.run(
        ["pnpm", "local:exec", "python3", "check.py", *tricky],
        cwd=repo,
        env=base_env(tmp_path, {"DATABASE_URL": "explicit-override", "npm_config_offline": "true"}),
        capture_output=True,
        check=False,
    )
    assert result.returncode == 37, result.stderr.decode()
