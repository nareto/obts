default:
    @just --list

arch port="" verbose="false":
    #!/usr/bin/env bash
    set -euo pipefail

    port_arg="{{port}}"
    verbose_arg="{{verbose}}"
    case "${port_arg}" in
      port=*|public_port=*)
        port_arg="${port_arg#*=}"
        ;;
      true|yes|on|verbose=true|false|no|off|verbose=false)
        verbose_arg="${port_arg}"
        port_arg=""
        ;;
    esac

    verbose=false
    case "${verbose_arg}" in
      true|1|yes|on|verbose=true)
        verbose=true
        ;;
      false|0|no|off|verbose=false)
        verbose=false
        ;;
      *)
        echo "Invalid verbose value: ${verbose_arg}. Use true or false." >&2
        exit 2
        ;;
    esac

    if [[ -n "${port_arg}" && ! "${port_arg}" =~ ^[0-9]+$ ]]; then
      echo "Invalid port value: ${port_arg}. Use an integer from 1 to 65535." >&2
      exit 2
    fi

    target_path="$(pwd)"
    arch_path="${target_path}/architecture"
    public_port="${port_arg:-${STRUCTURIZR_PORT:-8080}}"
    if [[ ! "${public_port}" =~ ^[0-9]+$ || "${public_port}" -lt 1 || "${public_port}" -gt 65535 ]]; then
      echo "Invalid public port value: ${public_port}. Use an integer from 1 to 65535." >&2
      exit 2
    fi
    local_port="${STRUCTURIZR_LOCAL_PORT:-$((public_port + 10000))}"
    if [[ ! "${local_port}" =~ ^[0-9]+$ || "${local_port}" -lt 1 || "${local_port}" -gt 65535 ]]; then
      echo "Invalid local port value: ${local_port}. Use an integer from 1 to 65535." >&2
      exit 2
    fi
    local_name="${STRUCTURIZR_LOCAL_NAME:-structurizr-local-obts}"
    proxy_name="${STRUCTURIZR_PROXY_NAME:-structurizr-proxy-obts}"
    proxy_conf="${TMPDIR:-/tmp}/${proxy_name}.conf"
    host_name="${STRUCTURIZR_HOST:-$(hostname -f 2>/dev/null || hostname)}"
    if [[ "${host_name}" != *.* && -n "${STRUCTURIZR_HOST_SUFFIX:-example.test}" ]]; then
      host_name="${host_name}.${STRUCTURIZR_HOST_SUFFIX:-example.test}"
    fi
    log_dir="${TMPDIR:-/tmp}/obts-structurizr"
    local_log="${log_dir}/${local_name}.log"
    proxy_log="${log_dir}/${proxy_name}.log"

    cleanup() {
      status=$?
      docker stop "${proxy_name}" "${local_name}" >/dev/null 2>&1 || true
      rm -f "${proxy_conf}"
      exit "${status}"
    }
    trap cleanup EXIT INT TERM

    run_container() {
      local log_file="$1"
      shift
      if [[ "${verbose}" == "true" ]]; then
        "$@"
      else
        "$@" >"${log_file}" 2>&1
      fi
    }

    mkdir -p "${log_dir}"
    : > "${local_log}"
    : > "${proxy_log}"

    docker stop "${proxy_name}" "${local_name}" >/dev/null 2>&1 || true

    cat > "${proxy_conf}" <<EOF
    server {
      listen ${public_port};

      location / {
        proxy_pass http://127.0.0.1:${local_port};
        proxy_set_header Host localhost;
        proxy_set_header Accept-Encoding "";
        proxy_redirect http://localhost/ \$scheme://\$http_host/;
        proxy_redirect http://localhost:8080/ \$scheme://\$http_host/;
        proxy_redirect http://127.0.0.1:${local_port}/ \$scheme://\$http_host/;

        sub_filter_types application/javascript text/css;
        sub_filter_once off;
        sub_filter 'http://localhost:80/api' '\$scheme://\$http_host/api';
        sub_filter 'http://localhost/api' '\$scheme://\$http_host/api';
        sub_filter 'http://localhost:8080/' '\$scheme://\$http_host/';
        sub_filter 'http://localhost/' '\$scheme://\$http_host/';
      }
    }
    EOF

    run_container "${local_log}" docker run --rm --name "${local_name}" \
      -p "127.0.0.1:${local_port}:8080" \
      -e STRUCTURIZR_EDITABLE=false \
      -e STRUCTURIZR_AUTOSAVEINTERVAL=0 \
      -e STRUCTURIZR_AUTOREFRESHINTERVAL=2000 \
      -v "${arch_path}:/usr/local/structurizr" \
      structurizr/structurizr local &

    ready=0
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:${local_port}/workspace/1" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done

    if [[ "${ready}" != "1" ]]; then
      echo "Structurizr Local did not become ready on 127.0.0.1:${local_port}" >&2
      if [[ "${verbose}" != "true" ]]; then
        echo "Structurizr Local log: ${local_log}" >&2
      fi
      exit 1
    fi

    viewer_url="http://${host_name}:${public_port}/workspace/1"
    echo
    echo "========================================"
    echo "Structurizr architecture viewer"
    echo "Accessible at: ${viewer_url}"
    echo "Stop: Ctrl-C"
    if [[ "${verbose}" == "true" ]]; then
      echo "Logs: streaming below"
    else
      echo "Logs: hidden; run 'just arch ${public_port} true' or 'just arch port=${public_port} verbose=true' to stream"
      echo "Log files:"
      echo "  ${local_log}"
      echo "  ${proxy_log}"
    fi
    echo "========================================"
    echo

    run_container "${proxy_log}" docker run --rm --name "${proxy_name}" \
      --network host \
      -v "${proxy_conf}:/etc/nginx/conf.d/default.conf:ro" \
      nginx:alpine
