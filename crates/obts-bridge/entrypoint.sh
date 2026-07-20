#!/bin/sh
set -eu

runtime_root=/run/obts-bridge
api_source=${API_TOKEN_SOURCE_DIR:-/var/run/obts-bridge-api-source}
mcp_source=${MCP_TOKEN_SOURCE_DIR:-/var/run/obts-bridge-mcp-source}
api_runtime=${API_TOKEN_DIR:-$runtime_root/api}
mcp_runtime=${MCP_BEARER_TOKEN_DIR:-$runtime_root/mcp}

install -d -o obts-bridge -g obts-bridge -m 0700 "$runtime_root" "$api_runtime" "$mcp_runtime"

copy_tokens() {
  source_dir=$1
  target_dir=$2
  if [ ! -d "$source_dir" ]; then
    return
  fi
  find "$target_dir" -type f -name '*.token' -delete
  for source in "$source_dir"/*.token; do
    [ -f "$source" ] || continue
    target="$target_dir/$(basename "$source")"
    install -o obts-bridge -g obts-bridge -m 0400 "$source" "$target"
  done
}

copy_tokens "$api_source" "$api_runtime"
copy_tokens "$mcp_source" "$mcp_runtime"

exec gosu obts-bridge:obts-bridge "$@"
