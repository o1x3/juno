#!/bin/sh
set -e

# Installs the latest released `juno` binary into /usr/local/bin.
#
# Usage:
#   curl -sSfL https://raw.githubusercontent.com/o1x3/juno/main/scripts/install.sh | sh

REPO="o1x3/juno"
INSTALL_DIR="/usr/local/bin"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
    linux|darwin) ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

fetch() {
    url="$1"; out="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -sSfL "$url" -o "$out"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$url" -O "$out"
    else
        echo "curl or wget required" >&2
        exit 1
    fi
}

fetch_stdout() {
    url="$1"
    if command -v curl >/dev/null 2>&1; then
        curl -sSfL "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$url"
    else
        echo "curl or wget required" >&2
        exit 1
    fi
}

VERSION=$(fetch_stdout "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -n1 | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
    echo "Failed to determine latest version of ${REPO}" >&2
    exit 1
fi

PLAIN_VERSION="${VERSION#v}"
FILENAME="juno-${PLAIN_VERSION}-${OS}-${ARCH}.tar.gz"
TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILENAME}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/checksums.txt"

echo "Downloading juno ${VERSION} for ${OS}/${ARCH}..."

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

fetch "$TARBALL_URL" "$TMPDIR/$FILENAME"

if fetch "$CHECKSUMS_URL" "$TMPDIR/checksums.txt" 2>/dev/null; then
    EXPECTED=$(grep -F "$FILENAME" "$TMPDIR/checksums.txt" | awk '{print $1}' | head -n1)
    if [ -z "$EXPECTED" ]; then
        echo "Warning: checksum entry for $FILENAME not found; skipping verification" >&2
    else
        if command -v sha256sum >/dev/null 2>&1; then
            ACTUAL=$(sha256sum "$TMPDIR/$FILENAME" | awk '{print $1}')
        elif command -v shasum >/dev/null 2>&1; then
            ACTUAL=$(shasum -a 256 "$TMPDIR/$FILENAME" | awk '{print $1}')
        else
            echo "Warning: no sha256sum or shasum available; skipping verification" >&2
            ACTUAL="$EXPECTED"
        fi
        if [ "$EXPECTED" != "$ACTUAL" ]; then
            echo "Checksum verification failed for $FILENAME" >&2
            echo "  expected: $EXPECTED" >&2
            echo "  actual:   $ACTUAL" >&2
            exit 1
        fi
        echo "Checksum verified."
    fi
else
    echo "Warning: could not fetch checksums.txt; skipping verification" >&2
fi

tar -xzf "$TMPDIR/$FILENAME" -C "$TMPDIR"

if [ ! -f "$TMPDIR/juno" ]; then
    echo "Archive did not contain a 'juno' binary" >&2
    exit 1
fi

if [ -w "$INSTALL_DIR" ]; then
    mv "$TMPDIR/juno" "$INSTALL_DIR/juno"
    chmod +x "$INSTALL_DIR/juno"
else
    echo "Installing to ${INSTALL_DIR} (requires sudo)..."
    sudo mv "$TMPDIR/juno" "$INSTALL_DIR/juno"
    sudo chmod +x "$INSTALL_DIR/juno"
fi

if [ "$OS" = "darwin" ]; then
    if [ -w "$INSTALL_DIR" ]; then
        xattr -dr com.apple.quarantine "$INSTALL_DIR/juno" 2>/dev/null || true
    else
        sudo xattr -dr com.apple.quarantine "$INSTALL_DIR/juno" 2>/dev/null || true
    fi
fi

echo "juno ${VERSION} installed to ${INSTALL_DIR}/juno"
