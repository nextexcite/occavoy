"""Create a small uv workspace member; usage: mise run experiment -- supplier-quotes."""

import argparse
import re
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", args.slug):
        parser.error("Use a lowercase kebab-case slug")
    root = Path(__file__).resolve().parents[1]
    directory = root / "experiments" / args.slug
    directory.mkdir(exist_ok=False)
    module = "occavoy_" + args.slug.replace("-", "_")
    package = directory / "src" / module
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(f'"""Occavoy {args.slug} experiment."""\n')
    (directory / "pyproject.toml").write_text(
        f'[project]\nname = "occavoy-{args.slug}"\nversion = "0.1.0"\n'
        'requires-python = ">=3.15,<3.16"\ndependencies = []\n\n'
        '[build-system]\nrequires = ["uv_build==0.13.10"]\nbuild-backend = "uv_build"\n'
    )
    (directory / "README.md").write_text(
        f"# {args.slug}\n\n## Question\n\nState one decision this experiment informs.\n\n"
        "## Procedure\n\nRecord inputs, versions, limits and reproduction commands.\n\n"
        "## Evidence\n\nRecord actual observations, including failures and cost.\n\n"
        "## Decision\n\nAdopt, revise, defer or stop; link the OCA issue.\n"
    )
    print(f"Created {directory.relative_to(root)}. Run uv sync --all-packages to update uv.lock.")


if __name__ == "__main__":
    main()
