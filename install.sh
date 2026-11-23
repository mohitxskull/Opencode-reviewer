#!/bin/sh
set -eu

REPO="mohitxskull/Opencode-reviewer"
INSTALL_DIR="${PEER_INSTALL_DIR:-${HOME}/.local/bin}"
VERSION="${PEER_VERSION:-latest}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${OS}" in
  linux) OS_SLUG="linux" ;;
  darwin) OS_SLUG="darwin" ;;
  *)
    echo "Unsupported OS: ${OS}. Download manually from https://github.com/${REPO}/releases" >&2
    exit 1
    ;;
esac

case "${ARCH}" in
  x86_64|amd64) ARCH_SLUG="x64" ;;
  arm64|aarch64) ARCH_SLUG="arm64" ;;
  *)
    echo "Unsupported architecture: ${ARCH}." >&2
    exit 1
    ;;
esac

ARCHIVE="peer-${OS_SLUG}-${ARCH_SLUG}.tar.gz"
if [ "${VERSION}" = "latest" ]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Downloading ${ARCHIVE} (${VERSION})..."
curl -fsSL "${BASE_URL}/${ARCHIVE}" -o "${TMP_DIR}/${ARCHIVE}"
curl -fsSL "${BASE_URL}/SHA256SUMS.txt" -o "${TMP_DIR}/SHA256SUMS.txt"

EXPECTED_SHA="$(grep " ${ARCHIVE}\$" "${TMP_DIR}/SHA256SUMS.txt" | awk '{print $1}')"
if [ -z "${EXPECTED_SHA}" ]; then
  echo "Failed to find checksum for ${ARCHIVE} in SHA256SUMS.txt" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "${TMP_DIR}/${ARCHIVE}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA="$(shasum -a 256 "${TMP_DIR}/${ARCHIVE}" | awk '{print $1}')"
else
  echo "Error: neither sha256sum nor shasum found to verify download." >&2
  exit 1
fi

if [ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]; then
  echo "Checksum mismatch for ${ARCHIVE}! Expected ${EXPECTED_SHA}, got ${ACTUAL_SHA}" >&2
  exit 1
fi

tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
mkdir -p "${INSTALL_DIR}"
install -m 755 "${TMP_DIR}/peer" "${INSTALL_DIR}/peer"
ln -sf "${INSTALL_DIR}/peer" "${INSTALL_DIR}/cargo-peer"

echo "Installed peer (+ cargo-peer alias) to ${INSTALL_DIR}/peer"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to your PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
