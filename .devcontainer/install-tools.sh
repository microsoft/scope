#!/usr/bin/env bash
set -euo pipefail

architecture="${1:?architecture required}"
case "$architecture" in
  amd64) triple=x86_64-unknown-linux-gnu; powershell_arch=x64 ;;
  arm64) triple=aarch64-unknown-linux-gnu; powershell_arch=arm64 ;;
  *) echo "Unsupported architecture: $architecture" >&2; exit 1 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
cd "$temporary"

curl -fsSLo rustup-init "https://static.rust-lang.org/rustup/archive/1.28.2/${triple}/rustup-init"
curl -fsSLo rustup-init.sha256 "https://static.rust-lang.org/rustup/archive/1.28.2/${triple}/rustup-init.sha256"
sha256sum -c rustup-init.sha256
chmod +x rustup-init
export CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup
./rustup-init -y --no-modify-path --default-toolchain 1.88.0 --profile minimal --component rustfmt,clippy
export PATH="/opt/cargo/bin:$PATH"
cargo install cargo-watch --locked --version 8.5.3

curl -fsSLO "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-${powershell_arch/x64/x64}.tar.xz"
curl -fsSLO https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
grep "node-v24.21.0-linux-${powershell_arch}.tar.xz$" SHASUMS256.txt | sha256sum -c -
mkdir -p /opt/node24
tar -xJf "node-v24.21.0-linux-${powershell_arch}.tar.xz" -C /opt/node24 --strip-components=1
ln -s /usr/local/bin/node /usr/local/bin/node22
ln -s /opt/node24/bin/node /usr/local/bin/node24

curl -fsSLO "https://github.com/astral-sh/uv/releases/download/0.10.0/uv-${triple}.tar.gz"
curl -fsSLO "https://github.com/astral-sh/uv/releases/download/0.10.0/uv-${triple}.tar.gz.sha256"
sha256sum -c "uv-${triple}.tar.gz.sha256"
tar -xzf "uv-${triple}.tar.gz"
install -m 0755 "uv-${triple}/uv" "uv-${triple}/uvx" /usr/local/bin/

curl -fsSLO "https://get.helm.sh/helm-v3.17.2-linux-${architecture}.tar.gz"
curl -fsSLO "https://get.helm.sh/helm-v3.17.2-linux-${architecture}.tar.gz.sha256sum"
sha256sum -c "helm-v3.17.2-linux-${architecture}.tar.gz.sha256sum"
tar -xzf "helm-v3.17.2-linux-${architecture}.tar.gz"
install -m 0755 "linux-${architecture}/helm" /usr/local/bin/helm

curl -fsSLo skaffold "https://storage.googleapis.com/skaffold/releases/v2.15.0/skaffold-linux-${architecture}"
curl -fsSLo skaffold.sha256 "https://storage.googleapis.com/skaffold/releases/v2.15.0/skaffold-linux-${architecture}.sha256"
printf '%s  skaffold\n' "$(awk '{print $1}' skaffold.sha256)" | sha256sum -c -
install -m 0755 skaffold /usr/local/bin/skaffold

curl -fsSLO "https://github.com/cli/cli/releases/download/v2.67.0/gh_2.67.0_linux_${architecture}.tar.gz"
curl -fsSLO https://github.com/cli/cli/releases/download/v2.67.0/gh_2.67.0_checksums.txt
grep "gh_2.67.0_linux_${architecture}.tar.gz$" gh_2.67.0_checksums.txt | sha256sum -c -
tar -xzf "gh_2.67.0_linux_${architecture}.tar.gz"
install -m 0755 "gh_2.67.0_linux_${architecture}/bin/gh" /usr/local/bin/gh

curl -fsSLo powershell.tar.gz "https://github.com/PowerShell/PowerShell/releases/download/v7.4.14/powershell-7.4.14-linux-${powershell_arch}.tar.gz"
curl -fsSLo powershell-hashes.txt https://github.com/PowerShell/PowerShell/releases/download/v7.4.14/hashes.sha256
expected=$(iconv -f UTF-16 -t UTF-8 powershell-hashes.txt | tr -d '\r' | grep -i "powershell-7.4.14-linux-${powershell_arch}.tar.gz$" | awk '{print tolower($1)}')
printf '%s  powershell.tar.gz\n' "$expected" | sha256sum -c -
mkdir -p /opt/powershell
tar -xzf powershell.tar.gz -C /opt/powershell
chmod +x /opt/powershell/pwsh
ln -s /opt/powershell/pwsh /usr/local/bin/pwsh

uv venv /opt/azure-cli
uv pip install --python /opt/azure-cli/bin/python --prerelease=allow azure-cli==2.68.0
ln -s /opt/azure-cli/bin/az /usr/local/bin/az