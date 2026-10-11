# Tip #3: Set up Scope on Windows with WSL

Scope's development scripts need Bash, Linux tools and Docker, so on Windows you
develop inside [WSL 2](https://learn.microsoft.com/windows/wsl/about) with
Docker Desktop. This guide assumes **Ubuntu 22.04 or 24.04 LTS** in WSL, and the
Portal opened in a Windows browser.

Run commands in the Ubuntu (WSL) terminal unless a step says
**Windows PowerShell**.

## Before you start

- Windows 11 23H2 (build 22631) or later, or Windows 10 22H2 (build 19045): the
  minimum for
  [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/).
  Run `winver` to check.
- Hardware virtualization turned on in the UEFI/BIOS: Task Manager >
  **Performance** > **CPU** shows **Virtualization: Enabled**.
- Administrator rights, to install WSL and Docker Desktop.
- For the Copilot worker, a GitHub account with an active GitHub Copilot
  entitlement.

Check that the
[Docker Desktop license terms](https://docs.docker.com/subscription-billing/desktop-license/)
cover your use: larger companies need a paid subscription.

## Quick setup with the scripts

Two scripts automate most of the steps below:

| Script | Run it in | What it does |
|--------|-----------|--------------|
| [`scripts/setup-windows-wsl.ps1`](../../scripts/setup-windows-wsl.ps1) | Windows PowerShell, as Administrator | Updates WSL and makes WSL 2 the default, installs the Ubuntu distribution and makes it the default WSL distribution, then offers to install Docker Desktop (WSL 2 backend) with WinGet. |
| [`scripts/setup-linux-prereqs.sh`](../../scripts/setup-linux-prereqs.sh) | Ubuntu (WSL) or native Linux | Checks the prerequisites and installs the missing ones: base tools, Node.js 22, Corepack and pnpm, mkcert, GitHub CLI, and Docker Engine unless you pass `--skip-docker`. |

1. Open **Windows PowerShell as Administrator**, then download the Windows
   script and review it:

   ```powershell
   $script = Join-Path $env:TEMP 'setup-windows-wsl.ps1'
   Invoke-WebRequest -UseBasicParsing -OutFile $script -Uri 'https://raw.githubusercontent.com/microsoft/scope/main/scripts/setup-windows-wsl.ps1'
   notepad $script
   ```

   Run it in the same window:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Distribution Ubuntu-24.04
   ```

   `-ExecutionPolicy Bypass` applies to that process only: the default
   [execution policy](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies)
   of Windows clients blocks scripts. Use `-Distribution Ubuntu-22.04` for
   22.04. Without `-Distribution`, the script installs `Ubuntu`, which follows
   the newest LTS release. If WSL asks for a restart, restart Windows and run
   the script again.
2. Create your Linux user ([step 1](#1-install-wsl-2-and-ubuntu)) and configure
   Docker Desktop
   ([step 2](#2-install-docker-desktop-and-enable-wsl-integration)).
3. In Ubuntu, [clone the repository](#3-clone-the-repository-inside-wsl), then
   run the Linux script from the checkout:

   ```bash
   bash scripts/setup-linux-prereqs.sh --skip-docker
   ```

   `--skip-docker` keeps Docker Desktop as the only Docker engine. The script
   asks for your `sudo` password and confirms some installs: `--yes` answers
   for you, `--check` only reports what is missing (and exits non-zero if
   anything is), and `--skip-gh` skips GitHub CLI.
4. Continue with [step 5](#5-authenticate-github-cli).

The sections below explain each step and give the manual commands for Ubuntu
22.04 and 24.04.

## 1. Install WSL 2 and Ubuntu

*`setup-windows-wsl.ps1` does this step, except creating your Linux user.*

In **Windows PowerShell as Administrator**:

```powershell
wsl --install --distribution Ubuntu-24.04   # or Ubuntu-22.04
```

Restart Windows if asked. Then open the distribution from the Start menu
(**Ubuntu 24.04 LTS**) and create your Linux user name and password when
prompted. `sudo` asks for that password.

If WSL was already installed, update it, and check that the distribution runs
on WSL 2 and is the default (marked with `*`):

```powershell
wsl --update
wsl --list --verbose
wsl --set-version Ubuntu-24.04 2   # only if VERSION shows 1
wsl --set-default Ubuntu-24.04
```

Docker Desktop's WSL integration is on for the default distribution, and `wsl`
opens it. More: [Install WSL](https://learn.microsoft.com/windows/wsl/install),
[Set up a WSL development environment](https://learn.microsoft.com/windows/wsl/setup/environment)
and [Troubleshooting WSL](https://learn.microsoft.com/windows/wsl/troubleshooting).

## 2. Install Docker Desktop and enable WSL integration

*`setup-windows-wsl.ps1` installs Docker Desktop; configure it as below.*

Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
and keep **Use WSL 2 instead of Hyper-V** selected on the installer's
configuration page. Or, with WinGet:

```powershell
winget install --exact --id Docker.DockerDesktop
```

Do not also install Docker Engine in Ubuntu: Docker Desktop provides `docker`
and `docker compose` to the distribution, and Docker asks you to uninstall any
Docker Engine or CLI installed there first.

Then:

1. Start Docker Desktop from the Start menu and wait until the engine is
   running.
2. In **Settings** > **General**, check that **Use WSL 2 based engine** is
   selected. On systems that support WSL 2 it is on by default and may be
   hidden.
3. In **Settings** > **Resources** > **WSL Integration**, turn on integration
   for your Ubuntu distribution, then select **Apply & restart**.

Open a new Ubuntu terminal and check that the client and the engine respond:

```bash
docker version             # shows both Client and Server
docker compose version
docker run --rm hello-world
```

Leave `DOCKER_GID` unset with Docker Desktop. Inside containers, its Docker
socket belongs to group 0, which `docker-compose.yml` uses by default;
`DOCKER_GID` is for Docker Engine on Linux.

More: [Docker Desktop WSL 2 backend](https://docs.docker.com/desktop/features/wsl/)
and [WSL 2 best practices](https://docs.docker.com/desktop/features/wsl/best-practices/).

## 3. Clone the repository inside WSL

Keep the checkout in the Linux file system (under `~`), not under `/mnt/c`:
bind mounts and `pnpm install` are much faster there, and containers only
receive file change events for files stored in the Linux file system
([WSL file systems](https://learn.microsoft.com/windows/wsl/filesystems)).
Clone with the Git in Ubuntu, from your fork if you plan to contribute:

```bash
sudo apt-get update && sudo apt-get install -y git
mkdir -p ~/src && cd ~/src
git clone https://github.com/<your-github-user>/scope.git
cd scope
git remote add upstream https://github.com/microsoft/scope.git
```

To edit the code, run `code .` in the checkout to open VS Code with its
[WSL extension](https://code.visualstudio.com/docs/remote/wsl). Windows apps can
also reach the checkout at `\\wsl.localhost\Ubuntu-24.04\home\<user>\src\scope`.
For Git credentials, see [step 5](#5-authenticate-github-cli) or
[Git in WSL](https://learn.microsoft.com/windows/wsl/tutorials/wsl-git).

## 4. Install the Linux prerequisites

From the checkout, the Linux script does this whole step:

```bash
bash scripts/setup-linux-prereqs.sh --check --skip-docker   # report only, changes nothing
bash scripts/setup-linux-prereqs.sh --skip-docker           # install what is missing
```

To install them manually on Ubuntu 22.04 or 24.04:

**Base tools.** `libnss3-tools` lets mkcert update Linux trust stores, and
`libdigest-sha-perl` provides the `shasum` used by `scripts/worktree-env.sh`:

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates openssl tar unzip libnss3-tools libdigest-sha-perl
```

**Node.js 22.** Ubuntu's own `nodejs` package is too old (12 on 22.04, 18 on
24.04), so install Node.js 22 from
[NodeSource](https://github.com/nodesource/distributions):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node --version             # v22.x
```

A version manager such as nvm works too; see
[Download Node.js](https://nodejs.org/en/download).

**pnpm 10.29.1, through Corepack.** [Corepack](https://github.com/nodejs/corepack)
ships with Node.js 22 and runs the pnpm version pinned in the `packageManager`
field of `package.json`. With the NodeSource package, enabling it needs `sudo`
because Corepack puts its shims next to the `corepack` binary, in `/usr/bin`:

```bash
sudo corepack enable       # no sudo if Node.js comes from nvm
cd ~/src/scope
pnpm --version             # 10.29.1; accept if Corepack asks to download pnpm
```

**mkcert.** Ubuntu packages it:

```bash
sudo apt-get install -y mkcert
```

**GitHub CLI.** Ubuntu's `gh` package is old (2.4.0 on 22.04), so install it
from GitHub's apt repository, as in the
[official instructions](https://github.com/cli/cli/blob/trunk/docs/install_linux.md):

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && sudo mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y
```

**Rust/Cargo** is only needed to build or test the AI gateway (`apps/gateway/`)
outside Docker. Install it with [rustup](https://rustup.rs/) if you need it.

## 5. Authenticate GitHub CLI

```bash
gh auth login
export GITHUB_TOKEN="$(gh auth token)"
```

Choose **GitHub.com** and **HTTPS**, and let `gh` authenticate Git so you can
push to your fork. If no browser opens from WSL, open the URL that `gh` prints
in a Windows browser and enter the one-time code.

The Copilot worker needs a token from an account with an active GitHub Copilot
entitlement: `gh auth login` alone does not grant Copilot access. Export
`GITHUB_TOKEN` again in each new terminal before you start the Copilot stack.

## 6. Install dependencies and start Scope

```bash
cd ~/src/scope
pnpm install --frozen-lockfile
pnpm docker:dev:copilot    # full stack with the Copilot worker + Portal (hot reload)
```

Other stacks:

```bash
pnpm docker:up:infra       # backing services only, to run services natively
pnpm docker:dev:portal     # Portal + API (hot reload)
pnpm docker:dev:all        # all workers + Portal + report generator (hot reload)
```

The first build downloads several images and takes a while. The first stack
that starts the Portal also creates the local HTTPS certificate with mkcert, and
asks for your `sudo` password once to trust its CA in Ubuntu.

In a second Ubuntu terminal, print the Portal's address (`http://localhost:5100`
by default; worktrees get their own port) and open it in a Windows browser:

```bash
pnpm portal:url
```

## 7. Trust the local HTTPS certificate in Windows

Sign-in uses a local Entra emulator over HTTPS, with a certificate from a
development CA that mkcert creates. `mkcert -install` ran in Ubuntu, so a
Windows browser does not trust that CA yet, and sign-in fails with
`ERR_CERT_AUTHORITY_INVALID` until it does.

Once `.certs/rootCA.pem` exists (the first stack with the Portal creates it),
print its Windows path from the checkout:

```bash
wslpath -w "$PWD/.certs/rootCA.pem"
```

Then, in an interactive **Windows PowerShell** session (no administrator rights
needed), import that public certificate for your Windows user:

```powershell
Import-Certificate -FilePath "<Windows path printed by wslpath>" -CertStoreLocation Cert:\CurrentUser\Root
```

Approve the Windows security warning, then reload the Portal. Restart the
browser if it still uses the previous result.

> Do not disable TLS verification. Import only `.certs/rootCA.pem`; never import
> `rootCA-key.pem` or any other private key.

This trusts every certificate the development CA signs, for your Windows user
only. See the local authentication section of
[`ENV_VARIABLES.md`](../../ENV_VARIABLES.md#local-dev-setup-entra-local) for
details, including what to do after rotating the CA.

## 8. Check your setup

Sign in to the Portal with a seeded user such as `alice@entralocal.dev`, then
run the checks you will run before a pull request:

```bash
pnpm lint
pnpm test
```

The contribution workflow, test commands and coding conventions are in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md), and the
[local development guide](https://microsoft.github.io/scope/getting-started/local-development/)
walks through a first evaluation.

## Troubleshooting

- **`wsl --install` fails or mentions virtualization:** turn on virtualization
  in the UEFI/BIOS, then see
  [Troubleshooting WSL](https://learn.microsoft.com/windows/wsl/troubleshooting).
- **`docker` is not found or cannot connect in Ubuntu:** check that Docker
  Desktop is running and that WSL Integration is on for this distribution, then
  open a new terminal. If it still fails, run `wsl --shutdown` in Windows
  PowerShell and restart Docker Desktop.
- **The ACP workers cannot use the Docker socket:** if you exported
  `DOCKER_GID`, unset it; with Docker Desktop the default is correct.
- **Builds are killed or Windows runs out of memory:** the WSL 2 VM, which also
  runs Docker Desktop's containers, gets 50% of Windows memory by default.
  Change `memory` in `%UserProfile%\.wslconfig` and run `wsl --shutdown`; see
  [WSL configuration](https://learn.microsoft.com/windows/wsl/wsl-config).
- **Everything is slow:** move the checkout from `/mnt/c/...` to the Linux file
  system, for example `~/src/scope`.
- **The browser rejects the `localhost` certificate:** repeat
  [step 7](#7-trust-the-local-https-certificate-in-windows) and restart the
  browser. Do not bypass TLS checks.
- **Copilot authentication fails:** run `gh auth status`, confirm the account
  has a Copilot entitlement, and export `GITHUB_TOKEN` again in the current
  terminal.
