#!/usr/bin/env bash
set -euo pipefail

ARCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${STRUCTURIZR_IMAGE:-structurizr/structurizr}"
RICH_EXPORT_DIR="$ARCH_DIR/.structurizr-rich-export"

cleanup() {
  rm -rf "$RICH_EXPORT_DIR"
}
trap cleanup EXIT

cd "$ARCH_DIR"
mkdir -p export "$RICH_EXPORT_DIR"
rm -rf "$RICH_EXPORT_DIR"/*
rm -f DIAGRAMS.md export/*.mmd export/*.json export/*.svg

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to simplify Structurizr Mermaid exports for Markdown preview." >&2
  exit 127
fi

docker run --rm -u "$(id -u):$(id -g)" \
  -v "$ARCH_DIR:/usr/local/structurizr" \
  "$IMAGE" validate -workspace /usr/local/structurizr/workspace.dsl

docker run --rm -u "$(id -u):$(id -g)" \
  -v "$ARCH_DIR:/usr/local/structurizr" \
  "$IMAGE" export \
  -workspace /usr/local/structurizr/workspace.dsl \
  -format mermaid \
  -output /usr/local/structurizr/.structurizr-rich-export

python3 - "$RICH_EXPORT_DIR" "$ARCH_DIR/export" <<'PY'
from pathlib import Path
import html
import re
import sys

source_dir = Path(sys.argv[1])
target_dir = Path(sys.argv[2])

quoted_string = re.compile(r'"((?:[^"\\]|\\.)*)"')
div_content = re.compile(r"<div[^>]*>(.*?)</div>", re.IGNORECASE | re.DOTALL)
tag = re.compile(r"<[^>]+>")
line_break = re.compile(r"<br\s*/?>", re.IGNORECASE)


def strip_markup(fragment: str) -> str:
    fragment = line_break.sub(" ", fragment)
    fragment = tag.sub("", fragment)
    return " ".join(html.unescape(fragment).split())


def simplify_label(raw: str) -> str:
    parts = [strip_markup(part) for part in div_content.findall(raw)]
    parts = [part for part in parts if part]
    if not parts:
        parts = [strip_markup(raw)]

    # Structurizr node labels are title, type, description. Keep the preview
    # concise and leave full detail in workspace.dsl/workspace.json.
    if len(parts) >= 2 and parts[1].startswith("["):
        return f"{parts[0]} {parts[1]}"

    return " ".join(parts)


def escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def rewrite_line(line: str) -> str | None:
    stripped = line.lstrip()
    if stripped.startswith("linkStyle default") or stripped.startswith("style "):
        return None

    def replace_label(match: re.Match[str]) -> str:
        value = match.group(1)
        if "<div" not in value:
            return match.group(0)
        return f'"{escape_label(simplify_label(value))}"'

    return quoted_string.sub(replace_label, line)


for source in sorted(source_dir.glob("*.mmd")):
    output = []
    for line in source.read_text().splitlines():
        rewritten = rewrite_line(line)
        if rewritten is not None:
            output.append(rewritten)
    (target_dir / source.name).write_text("\n".join(output) + "\n")
PY

docker run --rm -u "$(id -u):$(id -g)" \
  -v "$ARCH_DIR:/usr/local/structurizr" \
  "$IMAGE" export \
  -workspace /usr/local/structurizr/workspace.dsl \
  -format json \
  -output /usr/local/structurizr/export

{
  printf '# Architecture Diagrams\n\n'
  printf '_Generated from `workspace.dsl`; do not edit by hand._\n\n'

  shopt -s nullglob
  diagrams=(export/*.mmd)

  if ((${#diagrams[@]} == 0)); then
    printf '_No Mermaid diagrams were exported._\n'
  else
    for diagram in "${diagrams[@]}"; do
      name="$(basename "$diagram" .mmd)"
      title="${name//-/ }"
      title="${title//_/ }"

      printf '## %s\n\n' "$title"
      printf '```mermaid\n'
      cat "$diagram"
      printf '\n```\n\n'
    done
  fi
} > DIAGRAMS.md
