#!/usr/bin/env bash
#
# Build a standalone binary distribution of pi2d.
#
# Produces:
#   <output-dir>/bin/pi2
#   <output-dir>/share/pi2d/web/dist/...
#   <output-dir>/LICENSE
#   <output-dir>/pi2d-<version>-<os>-<arch>.tar.gz
#
# Usage:
#   bash scripts/build-binary.sh [flags]
#
# Flags:
#   --target <bun-target>   Cross-compile target (e.g. bun-linux-x64, bun-darwin-arm64)
#   --version <v>           Release version (default: version from package.json)
#   --output-dir <dir>      Output directory (default: dist-bin)
#   --skip-build            Reuse existing dist/ and web/dist/
#   --no-archive            Do not produce the .tar.gz archive
set -euo pipefail

ORIG_CWD="$(pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET=""
VERSION=""
OUTPUT_DIR=""
SKIP_BUILD=0
NO_ARCHIVE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)
            TARGET="$2"
            shift 2
            ;;
        --target=*)
            TARGET="${1#*=}"
            shift
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --version=*)
            VERSION="${1#*=}"
            shift
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --output-dir=*)
            OUTPUT_DIR="${1#*=}"
            shift
            ;;
        --skip-build)
            SKIP_BUILD=1
            shift
            ;;
        --no-archive)
            NO_ARCHIVE=1
            shift
            ;;
        -h|--help)
            cat <<EOF
Usage: $0 [options]

Options:
  --target <target>     Bun compilation target (default: host target)
                        Supported: linux-x64, linux-arm64, linux-x64-musl,
                                   linux-arm64-musl, darwin-x64, darwin-arm64
  --version <version>   Version string (default: package.json version)
  --output-dir <dir>    Output directory (default: dist-bin)
  --skip-build          Skip tsc and web build if dist/ and web/dist/ exist
  --no-archive          Skip packaging the .tar.gz archive
  -h, --help            Show this help message
EOF
            exit 0
            ;;
        *)
            printf 'Error: unknown option: %s\n' "$1" >&2
            exit 1
            ;;
    esac
done

cd "$ROOT"

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="$ROOT/dist-bin"
elif [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$ORIG_CWD/$OUTPUT_DIR"
fi

if [[ -z "$VERSION" ]]; then
    VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version)")"
fi

detect_host_target() {
    local os arch
    case "$(uname -s)" in
        Linux) os="linux" ;;
        Darwin) os="darwin" ;;
        *) os="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) arch="$(uname -m)" ;;
    esac

    if [[ "$os" == "linux" ]]; then
        if ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
            arch="${arch}-musl"
        fi
    fi

    printf '%s-%s\n' "$os" "$arch"
}

if [[ -n "$TARGET" ]]; then
    TARGET_NAME="${TARGET#bun-}"
    case "$TARGET_NAME" in
        linux-x64|linux-arm64|linux-x64-musl|linux-arm64-musl|darwin-x64|darwin-arm64)
            OS_ARCH="$TARGET_NAME"
            BUN_TARGET="bun-$TARGET_NAME"
            ;;
        *)
            printf 'Error: unsupported target "%s". Supported: linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl, darwin-x64, darwin-arm64\n' "$TARGET" >&2
            exit 1
            ;;
    esac
else
    BUN_TARGET=""
    OS_ARCH="$(detect_host_target)"
fi

if [[ "$SKIP_BUILD" -eq 1 && -f "dist/cli/pi2.js" && -d "web/dist" ]]; then
    printf '==> reusing existing dist/ and web/dist/\n'
else
    printf '==> building TypeScript and web UI\n'
    pnpm build
    pnpm build:web
fi

[[ -f "dist/cli/pi2.js" ]] || { printf 'Error: dist/cli/pi2.js not found\n' >&2; exit 1; }
[[ -d "web/dist" ]] || { printf 'Error: web/dist directory not found\n' >&2; exit 1; }
[[ -f "LICENSE" ]] || { printf 'Error: LICENSE file not found\n' >&2; exit 1; }

ARCHIVE_NAME="pi2d-${VERSION}-${OS_ARCH}.tar.gz"
ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"

# Clean stale outputs for idempotency
rm -rf "${OUTPUT_DIR:?}/bin" "${OUTPUT_DIR:?}/share" "${OUTPUT_DIR:?}/LICENSE"
rm -f "$ARCHIVE_PATH"

mkdir -p "$OUTPUT_DIR/bin"
mkdir -p "$OUTPUT_DIR/share/pi2d/web"

printf '==> compiling binary with bun\n'
BUN_CMD=(
    bun build
    dist/cli/pi2.js
    --compile
    --outfile "$OUTPUT_DIR/bin/pi2"
    --define "PI2_BUILD_VERSION=\"$VERSION\""
    # `pi2 update` picks the release asset named after what this binary was
    # built for, instead of re-probing libc at runtime.
    --define "PI2_BUILD_TARGET=\"$OS_ARCH\""
)
if [[ -n "$BUN_TARGET" ]]; then
    BUN_CMD+=("--target=$BUN_TARGET")
fi

"${BUN_CMD[@]}"
chmod +x "$OUTPUT_DIR/bin/pi2"

printf '==> copying assets\n'
cp -R web/dist "$OUTPUT_DIR/share/pi2d/web/dist"
cp LICENSE "$OUTPUT_DIR/LICENSE"

if [[ "$NO_ARCHIVE" -eq 0 ]]; then
    printf '==> packaging tarball\n'
    tar -czf "$ARCHIVE_PATH" -C "$OUTPUT_DIR" bin share LICENSE
fi

BIN_PATH="$OUTPUT_DIR/bin/pi2"
BIN_SIZE="$(du -h "$BIN_PATH" | cut -f1)"

if [[ "$NO_ARCHIVE" -eq 1 ]]; then
    printf 'Artifact: %s (%s)\n' "$BIN_PATH" "$BIN_SIZE"
else
    ARCHIVE_SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
    printf 'Binary:   %s (%s)\n' "$BIN_PATH" "$BIN_SIZE"
    printf 'Artifact: %s (%s)\n' "$ARCHIVE_PATH" "$ARCHIVE_SIZE"
fi
