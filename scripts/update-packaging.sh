#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION=""
CHECKSUMS_INPUT=""
OUT_DIR="${REPO_ROOT}/build"
NO_DOWNLOAD=0

KNOWN_TARGETS=(
    "linux-x64"
    "linux-arm64"
    "linux-x64-musl"
    "linux-arm64-musl"
    "darwin-x64"
    "darwin-arm64"
)

usage() {
    cat <<EOF
Usage: $(basename "$0") [options]

Generates packaging artifacts (Homebrew formula, Arch PKGBUILD, .SRCINFO)
for system-packaged channels with deterministic checksum substitution.

Options:
  --version <v>        Release version (e.g. 0.1.6). Defaults to package.json version.
  --checksums <path>   Path to SHA256SUMS file or directory containing release assets.
  --out <dir>          Output directory (default: build/)
  --no-download        Do not download SHA256SUMS from GitHub; require --checksums.
  -h, --help           Show this help message.
EOF
}

# Parse command line flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            [[ $# -ge 2 ]] || { echo "Error: --version requires an argument" >&2; exit 1; }
            VERSION="$2"
            shift 2
            ;;
        --checksums)
            [[ $# -ge 2 ]] || { echo "Error: --checksums requires an argument" >&2; exit 1; }
            CHECKSUMS_INPUT="$2"
            shift 2
            ;;
        --out)
            [[ $# -ge 2 ]] || { echo "Error: --out requires an argument" >&2; exit 1; }
            OUT_DIR="$2"
            shift 2
            ;;
        --no-download)
            NO_DOWNLOAD=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# Derive version if not provided
if [[ -z "${VERSION}" ]]; then
    if [[ -f "${REPO_ROOT}/package.json" ]]; then
        VERSION=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"${REPO_ROOT}"'/package.json")).version)' 2>/dev/null || grep -m1 '"version":' "${REPO_ROOT}/package.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')
    fi
fi

if [[ -z "${VERSION}" ]]; then
    echo "Error: Release version not specified and could not be determined from package.json" >&2
    exit 1
fi

# Normalize version (Arch PKGBUILD forbids leading 'v')
VERSION="${VERSION#v}"

is_known_target() {
    local t="$1"
    for k in "${KNOWN_TARGETS[@]}"; do
        if [[ "$k" == "$t" ]]; then
            return 0
        fi
    done
    return 1
}

extract_target() {
    local fname="$1"
    local base
    base=$(basename "$fname")
    local target=""

    if [[ "$base" == pi2d-"${VERSION}"-*.tar.gz ]]; then
        target="${base#pi2d-"${VERSION}"-}"
        target="${target%.tar.gz}"
    elif [[ "$base" =~ ^pi2d-([0-9][^-]*)-(.*)\.tar\.gz$ ]]; then
        local other_ver="${BASH_REMATCH[1]}"
        echo "Error: Version mismatch in checksums filename '${base}': expected '${VERSION}', got '${other_ver}'" >&2
        exit 1
    elif [[ "$base" == pi2d-*.tar.gz ]]; then
        target="${base#pi2d-}"
        target="${target%.tar.gz}"
    elif [[ "$base" == *.tar.gz ]]; then
        target="${base%.tar.gz}"
    else
        target="$base"
    fi

    if ! is_known_target "$target"; then
        echo "Error: Unknown target in checksums: '${target}' (from filename: '${fname}')" >&2
        exit 1
    fi

    echo "$target"
}

declare -A CHECKSUMS

process_checksum_line() {
    local line="$1"
    # Skip empty lines or comments
    [[ -z "${line// }" ]] && return 0
    [[ "${line}" =~ ^[[:space:]]*# ]] && return 0

    local hash=""
    local filename=""
    read -r hash filename <<< "${line}"

    # Strip any leading * from binary mode sha256sum
    filename="${filename#\*}"
    # Clean whitespace and carriage returns
    hash="${hash//[[:space:]]/}"
    filename="${filename//$'\r'/}"
    filename="${filename#"${filename%%[![:space:]]*}"}"
    filename="${filename%"${filename##*[![:space:]]}"}"

    if ! [[ "${hash}" =~ ^[0-9a-fA-F]{64}$ ]]; then
        echo "Error: Invalid sha256 checksum format: '${hash}' for file '${filename}'" >&2
        exit 1
    fi

    local target
    target="$(extract_target "${filename}")"
    CHECKSUMS["${target}"]="${hash}"
}

# Collect checksums
if [[ -n "${CHECKSUMS_INPUT}" ]]; then
    if [[ -f "${CHECKSUMS_INPUT}" ]]; then
        while IFS= read -r line || [[ -n "$line" ]]; do
            process_checksum_line "$line"
        done < "${CHECKSUMS_INPUT}"
    elif [[ -d "${CHECKSUMS_INPUT}" ]]; then
        if [[ -f "${CHECKSUMS_INPUT}/SHA256SUMS" ]]; then
            while IFS= read -r line || [[ -n "$line" ]]; do
                process_checksum_line "$line"
            done < "${CHECKSUMS_INPUT}/SHA256SUMS"
        else
            local_found=0
            for f in "${CHECKSUMS_INPUT}"/*.tar.gz; do
                [[ -f "$f" ]] || continue
                local_found=1
                hash=$(sha256sum "$f" | awk '{print $1}')
                target=$(extract_target "$f")
                CHECKSUMS["${target}"]="${hash}"
            done
            if [[ $local_found -eq 0 ]]; then
                echo "Error: Directory '${CHECKSUMS_INPUT}' contains neither SHA256SUMS nor .tar.gz assets" >&2
                exit 1
            fi
        fi
    else
        echo "Error: Checksums path does not exist: ${CHECKSUMS_INPUT}" >&2
        exit 1
    fi
else
    if [[ $NO_DOWNLOAD -eq 1 ]]; then
        echo "Error: --no-download specified but --checksums was not provided." >&2
        exit 1
    fi

    SUMS_URL="https://github.com/zgs225/pi2d/releases/download/v${VERSION}/SHA256SUMS"
    echo "Downloading checksums from ${SUMS_URL}..."
    TMP_SUMS=$(mktemp)
    trap 'rm -f "${TMP_SUMS}"' EXIT
    if ! curl -fsSL "${SUMS_URL}" -o "${TMP_SUMS}"; then
        echo "Error: Failed to download SHA256SUMS from ${SUMS_URL}" >&2
        exit 1
    fi
    while IFS= read -r line || [[ -n "$line" ]]; do
        process_checksum_line "$line"
    done < "${TMP_SUMS}"
    rm -f "${TMP_SUMS}"
    trap - EXIT
fi

# Ensure all 6 required targets have checksums
for target in "${KNOWN_TARGETS[@]}"; do
    if [[ -z "${CHECKSUMS[${target}]:-}" ]]; then
        echo "Error: Missing checksum for required target: ${target}" >&2
        exit 1
    fi
done

SHA256_LINUX_X64="${CHECKSUMS[linux-x64]}"
SHA256_LINUX_ARM64="${CHECKSUMS[linux-arm64]}"
SHA256_LINUX_X64_MUSL="${CHECKSUMS[linux-x64-musl]}"
SHA256_LINUX_ARM64_MUSL="${CHECKSUMS[linux-arm64-musl]}"
SHA256_DARWIN_X64="${CHECKSUMS[darwin-x64]}"
SHA256_DARWIN_ARM64="${CHECKSUMS[darwin-arm64]}"

BREW_TEMPLATE="${REPO_ROOT}/packaging/homebrew/pi2d.rb.in"
AUR_TEMPLATE="${REPO_ROOT}/packaging/aur/PKGBUILD.in"

if [[ ! -f "${BREW_TEMPLATE}" ]]; then
    echo "Error: Homebrew template not found at ${BREW_TEMPLATE}" >&2
    exit 1
fi

if [[ ! -f "${AUR_TEMPLATE}" ]]; then
    echo "Error: AUR template not found at ${AUR_TEMPLATE}" >&2
    exit 1
fi

mkdir -p "${OUT_DIR}"

render_template() {
    local src="$1"
    local dst="$2"
    sed \
        -e "s|@@VERSION@@|${VERSION}|g" \
        -e "s|@@SHA256_LINUX_X64@@|${SHA256_LINUX_X64}|g" \
        -e "s|@@SHA256_LINUX_ARM64@@|${SHA256_LINUX_ARM64}|g" \
        -e "s|@@SHA256_LINUX_X64_MUSL@@|${SHA256_LINUX_X64_MUSL}|g" \
        -e "s|@@SHA256_LINUX_ARM64_MUSL@@|${SHA256_LINUX_ARM64_MUSL}|g" \
        -e "s|@@SHA256_DARWIN_X64@@|${SHA256_DARWIN_X64}|g" \
        -e "s|@@SHA256_DARWIN_ARM64@@|${SHA256_DARWIN_ARM64}|g" \
        "${src}" > "${dst}"
}

render_template "${BREW_TEMPLATE}" "${OUT_DIR}/pi2d.rb"
render_template "${AUR_TEMPLATE}" "${OUT_DIR}/PKGBUILD"

TAB=$'\t'
if command -v makepkg >/dev/null 2>&1; then
    ( cd "${OUT_DIR}" && makepkg --printsrcinfo ) > "${OUT_DIR}/SRCINFO"
else
    cat <<EOF > "${OUT_DIR}/SRCINFO"
pkgbase = pi2d-bin
${TAB}pkgdesc = Web console daemon for pi2.nvim
${TAB}pkgver = ${VERSION}
${TAB}pkgrel = 1
${TAB}url = https://github.com/zgs225/pi2d
${TAB}arch = x86_64
${TAB}arch = aarch64
${TAB}license = MIT
${TAB}provides = pi2d
${TAB}conflicts = pi2d
${TAB}options = !strip
${TAB}source_x86_64 = https://github.com/zgs225/pi2d/releases/download/v${VERSION}/pi2d-${VERSION}-linux-x64.tar.gz
${TAB}sha256sums_x86_64 = ${SHA256_LINUX_X64}
${TAB}source_aarch64 = https://github.com/zgs225/pi2d/releases/download/v${VERSION}/pi2d-${VERSION}-linux-arm64.tar.gz
${TAB}sha256sums_aarch64 = ${SHA256_LINUX_ARM64}

pkgname = pi2d-bin
EOF
fi
cp "${OUT_DIR}/SRCINFO" "${OUT_DIR}/.SRCINFO"

# Verify no placeholders survived
for file in "${OUT_DIR}/pi2d.rb" "${OUT_DIR}/PKGBUILD" "${OUT_DIR}/SRCINFO" "${OUT_DIR}/.SRCINFO"; do
    if grep -q "@@" "${file}"; then
        echo "Error: Unsubstituted placeholder found in ${file}:" >&2
        grep -n "@@" "${file}" >&2
        exit 1
    fi
done

echo "Packaging update completed successfully for pi2d v${VERSION}."
echo ""
echo "Target SHA256 checksums used:"
echo "  darwin-arm64:     ${SHA256_DARWIN_ARM64}"
echo "  darwin-x64:       ${SHA256_DARWIN_X64}"
echo "  linux-arm64:      ${SHA256_LINUX_ARM64}"
echo "  linux-arm64-musl: ${SHA256_LINUX_ARM64_MUSL}"
echo "  linux-x64:        ${SHA256_LINUX_X64}"
echo "  linux-x64-musl:   ${SHA256_LINUX_X64_MUSL}"
echo ""
echo "Rendered files:"
echo "  ${OUT_DIR}/pi2d.rb"
echo "  ${OUT_DIR}/PKGBUILD"
echo "  ${OUT_DIR}/SRCINFO"
echo "  ${OUT_DIR}/.SRCINFO"
