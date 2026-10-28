#!/bin/sh
#
# pi2 standalone installer
#
# Installs the precompiled pi2 binary and web console assets with no Node,
# no npm, and no root privileges required.
#
# Quick install:
#   curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh
#
# Uninstall:
#   curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh -s -- --uninstall
#
set -eu

# -----------------------------------------------------------------------------
# Configuration & Knobs
# -----------------------------------------------------------------------------

PI2_INSTALL_DIR="${PI2_INSTALL_DIR:-$HOME/.local/lib/pi2d}"
PI2_BIN_DIR="${PI2_BIN_DIR:-$HOME/.local/bin}"
PI2_SKIP_CHECKSUM="${PI2_SKIP_CHECKSUM:-0}"

# Strip trailing slashes for clean path manipulation
PI2_INSTALL_DIR="${PI2_INSTALL_DIR%/}"
PI2_BIN_DIR="${PI2_BIN_DIR%/}"

staging=""
tmp_dir=""

cleanup() {
    exit_code=$?
    trap - EXIT INT TERM
    if [ -n "$staging" ] && [ -d "$staging" ]; then
        rm -rf "$staging"
    fi
    if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
        rm -rf "$tmp_dir"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

show_help() {
    cat << 'EOF'
Usage: install.sh [OPTIONS]

Installs the compiled pi2 binary and web UI with no Node, no npm, and no root.

Options:
  --uninstall, -u     Uninstall pi2 and remove binary symlink
  --help, -h          Show this help message

Environment variables:
  PI2_VERSION         Version to install (default: latest release tag from GitHub)
  PI2_INSTALL_DIR     Installation directory (default: $HOME/.local/lib/pi2d)
  PI2_BIN_DIR         Directory for executable symlink (default: $HOME/.local/bin)
  PI2_BASE_URL        Base URL for release assets (default: GitHub releases URL)
  PI2_ARCHIVE         Path to a local tarball (skips network download)
  PI2_SKIP_CHECKSUM   Set to 1 to bypass SHA256 checksum verification
  PI2_CHECKSUM_FILE   Explicit path to SHA256SUMS file
EOF
}

print_supported_platforms() {
    printf 'Supported platforms:\n' >&2
    printf '  - linux-x64\n' >&2
    printf '  - linux-arm64\n' >&2
    printf '  - linux-x64-musl\n' >&2
    printf '  - linux-arm64-musl\n' >&2
    printf '  - darwin-x64\n' >&2
    printf '  - darwin-arm64\n' >&2
}

# -----------------------------------------------------------------------------
# Platform Detection
# -----------------------------------------------------------------------------

detect_platform() {
    raw_os="$(uname -s)"
    case "$raw_os" in
        Linux)  os="linux" ;;
        Darwin) os="darwin" ;;
        *)
            printf 'Error: Unsupported operating system: %s\n' "$raw_os" >&2
            print_supported_platforms
            exit 1
            ;;
    esac

    raw_arch="$(uname -m)"
    case "$raw_arch" in
        x86_64|amd64)   arch="x64" ;;
        aarch64|arm64)  arch="arm64" ;;
        *)
            printf 'Error: Unsupported architecture: %s\n' "$raw_arch" >&2
            print_supported_platforms
            exit 1
            ;;
    esac

    is_musl=0
    if [ "$os" = "linux" ]; then
        if [ -f /etc/alpine-release ]; then
            is_musl=1
        elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -i musl >/dev/null 2>&1; then
            is_musl=1
        elif ls /lib/ld-musl-*.so* >/dev/null 2>&1 || ls /usr/lib/ld-musl-*.so* >/dev/null 2>&1; then
            is_musl=1
        fi
    fi
}

# -----------------------------------------------------------------------------
# HTTP / Download Helpers
# -----------------------------------------------------------------------------

fetch_text() {
    url="$1"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -H "Accept: application/vnd.github+json" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- --header="Accept: application/vnd.github+json" "$url"
    else
        printf 'Error: Neither curl nor wget was found. Please install curl or wget.\n' >&2
        exit 1
    fi
}

download_file() {
    url="$1"
    dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$dest"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$dest" "$url"
    else
        printf 'Error: Neither curl nor wget was found. Please install curl or wget.\n' >&2
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# Checksum Verification
# -----------------------------------------------------------------------------

compute_sha256() {
    target_file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$target_file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$target_file" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$target_file" | awk '{print $NF}'
    else
        printf 'Error: Neither sha256sum, shasum, nor openssl is available.\n' >&2
        printf 'Install sha256sum/shasum or set PI2_SKIP_CHECKSUM=1 to bypass.\n' >&2
        exit 1
    fi
}

verify_checksum() {
    file_to_check="$1"
    checksum_file="$2"
    require_entry="${3:-1}"
    file_name="$(basename "$file_to_check")"

    expected="$(awk -v fname="$file_name" -v fpath="$file_to_check" '{
        if (NF == 1 && length($1) == 64) { print $1; exit }
        name = $2;
        sub(/^\*/, "", name);
        bname = name;
        sub(/.*\//, "", bname);
        if (name == fname || name == fpath || bname == fname) { print $1; exit }
    }' "$checksum_file")"

    if [ -z "$expected" ]; then
        if [ "$require_entry" -eq 1 ]; then
            printf 'Error: No SHA256 checksum entry found for %s in %s\n' "$file_name" "$checksum_file" >&2
            exit 1
        else
            printf 'info: no checksum entry for %s found in %s; skipping checksum verification\n' "$file_name" "$checksum_file"
            return 0
        fi
    fi

    actual="$(compute_sha256 "$file_to_check")"

    expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
    actual="$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')"

    if [ "$actual" != "$expected" ]; then
        printf 'Error: SHA256 checksum verification failed for %s\n' "$file_to_check" >&2
        printf '  Expected: %s\n' "$expected" >&2
        printf '  Actual:   %s\n' "$actual" >&2
        exit 1
    fi

    printf 'Checksum verified: %s\n' "$actual"
}

# -----------------------------------------------------------------------------
# Parse Arguments
# -----------------------------------------------------------------------------

uninstall_mode=0
for arg in "$@"; do
    case "$arg" in
        --uninstall|-u|uninstall)
            uninstall_mode=1
            ;;
        --help|-h|help)
            show_help
            exit 0
            ;;
        *)
            printf 'Error: Unknown argument: %s\n\n' "$arg" >&2
            show_help
            exit 1
            ;;
    esac
done

detect_platform

# -----------------------------------------------------------------------------
# Uninstall Mode
# -----------------------------------------------------------------------------

if [ "$uninstall_mode" -eq 1 ]; then
    printf 'Uninstalling pi2...\n'
    removed_any=0

    if [ -d "$PI2_INSTALL_DIR" ]; then
        rm -rf "$PI2_INSTALL_DIR"
        printf '  - Removed install directory: %s\n' "$PI2_INSTALL_DIR"
        removed_any=1
    fi

    if [ -e "$PI2_BIN_DIR/pi2" ] || [ -L "$PI2_BIN_DIR/pi2" ]; then
        rm -f "$PI2_BIN_DIR/pi2"
        printf '  - Removed binary symlink:    %s\n' "$PI2_BIN_DIR/pi2"
        removed_any=1
    fi

    if [ "$removed_any" -eq 0 ]; then
        printf 'No existing installation found at %s or %s/pi2.\n' "$PI2_INSTALL_DIR" "$PI2_BIN_DIR"
    else
        printf 'pi2 uninstalled successfully.\n'
    fi

    # Report untouched directories
    if [ -n "${PI2_DATA_DIR:-}" ]; then
        disp_data="$PI2_DATA_DIR"
    elif [ "$os" = "darwin" ]; then
        disp_data="$HOME/Library/Application Support/pi2"
    else
        disp_data="${XDG_DATA_HOME:-$HOME/.local/share}/pi2"
    fi

    if [ -n "${PI2_RUNTIME_DIR:-}" ]; then
        disp_runtime="$PI2_RUNTIME_DIR"
    elif [ "$os" = "darwin" ]; then
        disp_runtime="$HOME/Library/Caches/pi2/run"
    else
        uid="$(id -u 2>/dev/null || echo 0)"
        disp_runtime="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}/pi2-${uid}}/pi2"
    fi

    if [ -n "${PI2_STATE_DIR:-}" ]; then
        disp_state="$PI2_STATE_DIR"
    elif [ "$os" = "darwin" ]; then
        disp_state="$HOME/Library/Logs/pi2"
    else
        disp_state="${XDG_STATE_HOME:-$HOME/.local/state}/pi2"
    fi

    printf '\nThe following runtime, data, and state directories were left untouched:\n'
    printf '  - Runtime: %s\n' "$disp_runtime"
    printf '  - Data:    %s\n' "$disp_data"
    printf '  - State:   %s\n' "$disp_state"
    exit 0
fi

# -----------------------------------------------------------------------------
# Install Mode: Resolve Artifact
# -----------------------------------------------------------------------------

archive_path=""
target=""
version=""

if [ -n "${PI2_ARCHIVE:-}" ]; then
    # Offline install path
    if [ ! -f "$PI2_ARCHIVE" ]; then
        printf 'Error: Local archive not found: %s\n' "$PI2_ARCHIVE" >&2
        exit 1
    fi
    archive_path="$PI2_ARCHIVE"
    archive_name="$(basename "$archive_path")"

    if [ -n "${PI2_VERSION:-}" ]; then
        version="${PI2_VERSION#v}"
    else
        case "$archive_name" in
            pi2d-*-*)
                v="${archive_name#pi2d-}"
                version="${v%%-*}"
                ;;
            *)
                version="custom"
                ;;
        esac
    fi

    case "$archive_name" in
        pi2d-*-*.tar.gz)
            t="${archive_name#pi2d-}"
            t="${t#*-}"
            target="${t%.tar.gz}"
            ;;
        *)
            target="${os}-${arch}"
            ;;
    esac

    if [ "$PI2_SKIP_CHECKSUM" = "1" ]; then
        printf 'info: skipping checksum verification (PI2_SKIP_CHECKSUM=1)\n'
    else
        sums_file=""
        require_entry=1
        if [ -n "${PI2_CHECKSUM_FILE:-}" ] && [ -f "$PI2_CHECKSUM_FILE" ]; then
            sums_file="$PI2_CHECKSUM_FILE"
            require_entry=1
        elif [ -f "${archive_path}.sha256" ]; then
            sums_file="${archive_path}.sha256"
            require_entry=1
        elif [ -f "$(dirname "$archive_path")/SHA256SUMS" ]; then
            sums_file="$(dirname "$archive_path")/SHA256SUMS"
            require_entry=0
        fi

        if [ -n "$sums_file" ]; then
            verify_checksum "$archive_path" "$sums_file" "$require_entry"
        else
            printf 'info: no SHA256SUMS found next to archive; skipping checksum verification\n'
        fi
    fi
else
    # Online install path
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi2d-install.XXXXXX")"

    if [ -n "${PI2_VERSION:-}" ]; then
        version="${PI2_VERSION#v}"
    else
        printf 'Querying latest release from GitHub...\n'
        latest_api_url="https://api.github.com/repos/zgs225/pi2d/releases/latest"
        release_json=""
        if ! release_json="$(fetch_text "$latest_api_url" 2>/dev/null)"; then
            printf 'Error: Failed to fetch latest release from %s\n' "$latest_api_url" >&2
            printf 'The GitHub API may be unreachable or rate-limited.\n' >&2
            printf 'Specify a version explicitly: PI2_VERSION=<version> %s\n' "$0" >&2
            exit 1
        fi

        tag=""
        if command -v jq >/dev/null 2>&1; then
            tag="$(printf '%s' "$release_json" | jq -r .tag_name 2>/dev/null || true)"
        fi
        if [ -z "$tag" ] || [ "$tag" = "null" ]; then
            tag="$(printf '%s\n' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
        fi

        if [ -z "$tag" ] || [ "$tag" = "null" ]; then
            printf 'Error: Could not parse release tag from GitHub API response.\n' >&2
            printf 'Specify a version explicitly: PI2_VERSION=<version> %s\n' "$0" >&2
            exit 1
        fi
        version="${tag#v}"
    fi

    base_url="${PI2_BASE_URL:-https://github.com/zgs225/pi2d/releases/download/v${version}}"
    base_url="${base_url%/}"

    # Fetch SHA256SUMS if checksums are enabled
    sums_file=""
    if [ "$PI2_SKIP_CHECKSUM" != "1" ]; then
        sums_url="${base_url}/SHA256SUMS"
        sums_file="$tmp_dir/SHA256SUMS"
        printf 'Downloading SHA256SUMS from %s...\n' "$sums_url"
        if ! download_file "$sums_url" "$sums_file"; then
            printf 'Error: Failed to download SHA256SUMS from %s\n' "$sums_url" >&2
            printf 'To bypass checksum verification, set PI2_SKIP_CHECKSUM=1\n' >&2
            exit 1
        fi
    fi

    # Determine target architecture/libc
    if [ "$os" = "darwin" ]; then
        target="darwin-${arch}"
        archive_name="pi2d-${version}-${target}.tar.gz"
    elif [ "$os" = "linux" ]; then
        if [ "$is_musl" -eq 1 ]; then
            musl_target="linux-${arch}-musl"
            musl_archive="pi2d-${version}-${musl_target}.tar.gz"
            glibc_target="linux-${arch}"
            glibc_archive="pi2d-${version}-${glibc_target}.tar.gz"

            if [ -n "$sums_file" ] && [ -f "$sums_file" ]; then
                if grep -F "$musl_archive" "$sums_file" >/dev/null 2>&1; then
                    target="$musl_target"
                    archive_name="$musl_archive"
                elif grep -F "$glibc_archive" "$sums_file" >/dev/null 2>&1; then
                    printf 'info: musl asset not found in SHA256SUMS, falling back to glibc (%s)\n' "$glibc_target"
                    target="$glibc_target"
                    archive_name="$glibc_archive"
                else
                    printf 'Error: Neither %s nor %s found in release SHA256SUMS\n' "$musl_archive" "$glibc_archive" >&2
                    print_supported_platforms
                    exit 1
                fi
            else
                target="$musl_target"
                archive_name="$musl_archive"
            fi
        else
            target="linux-${arch}"
            archive_name="pi2d-${version}-${target}.tar.gz"
        fi
    fi

    archive_url="${base_url}/${archive_name}"
    archive_path="$tmp_dir/${archive_name}"
    printf 'Downloading %s...\n' "$archive_url"

    if ! download_file "$archive_url" "$archive_path"; then
        if [ "$os" = "linux" ] && [ "$target" = "linux-${arch}-musl" ]; then
            printf 'info: musl archive download failed, falling back to glibc asset\n'
            target="linux-${arch}"
            archive_name="pi2d-${version}-${target}.tar.gz"
            archive_url="${base_url}/${archive_name}"
            archive_path="$tmp_dir/${archive_name}"
            if ! download_file "$archive_url" "$archive_path"; then
                printf 'Error: Failed to download release archive %s from %s\n' "$archive_name" "$base_url" >&2
                print_supported_platforms
                exit 1
            fi
        else
            printf 'Error: Failed to download release archive %s from %s\n' "$archive_name" "$base_url" >&2
            print_supported_platforms
            exit 1
        fi
    fi

    if [ "$PI2_SKIP_CHECKSUM" = "1" ]; then
        printf 'info: skipping checksum verification (PI2_SKIP_CHECKSUM=1)\n'
    else
        verify_checksum "$archive_path" "$sums_file" 1
    fi
fi

# -----------------------------------------------------------------------------
# Unpack & Atomic Install
# -----------------------------------------------------------------------------

printf 'Installing pi2 to %s...\n' "$PI2_INSTALL_DIR"
mkdir -p "$PI2_INSTALL_DIR"
staging="$PI2_INSTALL_DIR/.staging.$$"
rm -rf "$staging"
mkdir -p "$staging"

if ! tar -xzf "$archive_path" -C "$staging"; then
    rm -rf "$staging"
    staging=""
    printf 'Error: Failed to extract archive %s\n' "$archive_path" >&2
    exit 1
fi

if [ ! -f "$staging/bin/pi2" ]; then
    rm -rf "$staging"
    staging=""
    printf 'Error: Archive does not contain bin/pi2\n' >&2
    exit 1
fi

chmod +x "$staging/bin/pi2"
if [ ! -x "$staging/bin/pi2" ]; then
    rm -rf "$staging"
    staging=""
    printf 'Error: %s/bin/pi2 is not executable\n' "$staging" >&2
    exit 1
fi

# Atomic swap: move existing directories aside before moving staged directories
rm -rf "$PI2_INSTALL_DIR/bin.old.$$" "$PI2_INSTALL_DIR/share.old.$$" "$PI2_INSTALL_DIR/LICENSE.old.$$"
[ -d "$PI2_INSTALL_DIR/bin" ] && mv "$PI2_INSTALL_DIR/bin" "$PI2_INSTALL_DIR/bin.old.$$"
[ -d "$PI2_INSTALL_DIR/share" ] && mv "$PI2_INSTALL_DIR/share" "$PI2_INSTALL_DIR/share.old.$$"
[ -f "$PI2_INSTALL_DIR/LICENSE" ] && mv "$PI2_INSTALL_DIR/LICENSE" "$PI2_INSTALL_DIR/LICENSE.old.$$"

mv "$staging/bin" "$PI2_INSTALL_DIR/bin"
if [ -d "$staging/share" ]; then
    mv "$staging/share" "$PI2_INSTALL_DIR/share"
fi
if [ -f "$staging/LICENSE" ]; then
    mv "$staging/LICENSE" "$PI2_INSTALL_DIR/LICENSE"
fi

rm -rf "$PI2_INSTALL_DIR/bin.old.$$" "$PI2_INSTALL_DIR/share.old.$$" "$PI2_INSTALL_DIR/LICENSE.old.$$" "$staging"
staging=""

# Symlink executable into PI2_BIN_DIR
mkdir -p "$PI2_BIN_DIR"
symlink="$PI2_BIN_DIR/pi2"
binary_target="$PI2_INSTALL_DIR/bin/pi2"

rm -f "$symlink"
ln -s "$binary_target" "$symlink"

# -----------------------------------------------------------------------------
# Final Output & Next Steps
# -----------------------------------------------------------------------------

printf '\npi2 %s (%s) installed successfully!\n\n' "$version" "$target"
printf 'Install location:\n'
printf '  - Directory:  %s\n' "$PI2_INSTALL_DIR"
printf '  - Executable: %s -> %s\n\n' "$symlink" "$binary_target"

printf 'Next steps:\n'
printf '  - Run in foreground:\n'
printf '      pi2 daemon\n'
printf '  - Run as background service (systemd user unit or macOS LaunchAgent):\n'
printf '      pi2 install-service --write\n'

in_path=0
case ":$PATH:" in
    *":$PI2_BIN_DIR:"*) in_path=1 ;;
esac

if [ "$in_path" -eq 0 ]; then
    printf '\nWarning: %s is not in your PATH.\n' "$PI2_BIN_DIR"
    printf 'To run pi2 directly, add it to your shell configuration (e.g. ~/.bashrc or ~/.zshrc):\n'
    printf "  export PATH=\"%s:\$PATH\"\n" "$PI2_BIN_DIR"
fi
