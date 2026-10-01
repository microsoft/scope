<#
.SYNOPSIS
    Installs and configures WSL2 with Ubuntu on Windows for Scope development.

.DESCRIPTION
    This script prepares a Windows machine to develop Scope inside WSL2:
      1. Enables the required Windows features (WSL, Virtual Machine Platform).
      2. Installs/updates the WSL2 kernel and the Ubuntu distribution.
      3. Verifies that virtualization (Hyper-V) is available.
      4. Prints next steps to run `scripts/setup-linux-prereqs.sh` inside Ubuntu.

    Run this script from an elevated (Administrator) PowerShell prompt on Windows.
    It is safe to re-run; steps that are already complete are skipped.

.PARAMETER SkipReboot
    Do not prompt to reboot even if a reboot is required. Useful for unattended /
    CI runs. The script will still report that a reboot is required.

.PARAMETER Distribution
    The WSL distribution to install. Defaults to "Ubuntu".

.EXAMPLE
    ./scripts/install-wsl-ubuntu.ps1

.EXAMPLE
    ./scripts/install-wsl-ubuntu.ps1 -SkipReboot
#>
[CmdletBinding()]
param(
    [switch]$SkipReboot,
    [string]$Distribution = "Ubuntu"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Message)
    Write-Host "    $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor Yellow
}

function Test-IsRunningOnCI {
    return [bool]($env:CI -or $env:TF_BUILD -or $env:GITHUB_ACTIONS)
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$script:RebootRequired = $false

function Enable-RequiredWindowsFeatures {
    Write-Step "Checking Windows features required for WSL2"

    $features = @(
        "Microsoft-Windows-Subsystem-Linux",
        "VirtualMachinePlatform"
    )

    foreach ($feature in $features) {
        $state = Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction SilentlyContinue
        if (-not $state) {
            Write-Warn "Could not query feature '$feature'. Skipping (it may not apply to this Windows edition)."
            continue
        }

        if ($state.State -eq "Enabled") {
            Write-Info "'$feature' is already enabled."
            continue
        }

        Write-Info "Enabling '$feature'..."
        $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
        if ($result.RestartNeeded) {
            $script:RebootRequired = $true
        }
    }
}

function Test-VirtualizationEnabled {
    Write-Step "Verifying hardware virtualization is available"

    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem
        if ($cs.HypervisorPresent) {
            Write-Info "Hypervisor is present and active."
            return $true
        }
    } catch {
        Write-Warn "Unable to query hypervisor state via CIM: $($_.Exception.Message)"
    }

    Write-Warn "Hardware virtualization does not appear to be active."
    Write-Warn "Enable virtualization (Intel VT-x / AMD-V) in your system BIOS/UEFI, then re-run this script."
    return $false
}

function Invoke-WslCommand {
    <#
        Runs `wsl.exe` with the given arguments, streams its output through
        Write-Info, and returns the process exit code. Returns $null (and logs
        a warning) if wsl.exe itself could not be invoked.
    #>
    param(
        [Parameter(Mandatory)][string]$Description,
        [Parameter(Mandatory)][string[]]$ArgumentList
    )

    try {
        $output = & wsl.exe @ArgumentList
        $exitCode = $LASTEXITCODE
        $output | ForEach-Object { Write-Info $_ }
        if ($exitCode -ne 0) {
            Write-Warn "'$Description' exited with code $exitCode."
        }
        return $exitCode
    } catch {
        Write-Warn "'$Description' failed: $($_.Exception.Message)"
        return $null
    }
}

function Install-WslAndDistribution {
    param([string]$DistroName)

    Write-Step "Installing/updating WSL2 and the $DistroName distribution"

    $wslCommand = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wslCommand) {
        Write-Warn "wsl.exe was not found on PATH. It should ship with Windows 10 2004+ / Windows 11."
        Write-Warn "Re-run this script after a reboot if this is the first time WSL features were enabled."
        return
    }

    Write-Info "Updating the WSL2 kernel (wsl --update)..."
    Invoke-WslCommand -Description "wsl --update" -ArgumentList @("--update") | Out-Null

    Write-Info "Setting WSL default version to 2 (wsl --set-default-version 2)..."
    Invoke-WslCommand -Description "wsl --set-default-version 2" -ArgumentList @("--set-default-version", "2") | Out-Null

    $installedDistros = @()
    try {
        $installedDistros = (wsl -l -q 2>$null) |
            ForEach-Object { ($_ -replace '[^\x20-\x7E]', '').Trim() } |
            Where-Object { $_ }
    } catch {
        $installedDistros = @()
    }

    if ($installedDistros -contains $DistroName) {
        Write-Info "'$DistroName' is already installed."
    } else {
        Write-Info "Installing '$DistroName' (wsl --install -d $DistroName)..."
        $installExitCode = Invoke-WslCommand -Description "wsl --install -d $DistroName" -ArgumentList @("--install", "-d", $DistroName)
        if ($null -eq $installExitCode -or $installExitCode -ne 0) {
            Write-Warn "You may need to reboot and re-run this script."
            $script:RebootRequired = $true
        }
    }
}

function Show-NextSteps {
    param([string]$DistroName)

    Write-Step "Next steps"
    Write-Info "1. Launch '$DistroName' from the Start menu (or run: wsl -d $DistroName)."
    Write-Info "   The first launch will ask you to create a UNIX username and password."
    Write-Info "2. Inside the $DistroName shell, clone (or open) the Scope repository."
    Write-Info "3. Run the Linux prerequisites script from within ${DistroName}:"
    Write-Info ""
    Write-Info "     bash scripts/setup-linux-prereqs.sh"
    Write-Info ""
    Write-Info "   This installs git, Node.js 22, pnpm, Docker Engine, mkcert, gh, and other"
    Write-Info "   tools needed to run 'pnpm docker:dev:copilot'."
    Write-Info "See CONTRIBUTING.md for the full local development walkthrough."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# $IsWindows only exists on PowerShell 6+ (Core); Windows PowerShell 5.1 always
# runs on Windows and does not define it, so guard the lookup under StrictMode.
$onWindowsCore = (Get-Variable -Name IsWindows -Scope Global -ErrorAction SilentlyContinue) -and $IsWindows
if ($env:OS -notlike "Windows*" -and -not $onWindowsCore) {
    Write-Error "install-wsl-ubuntu.ps1 must be run on Windows."
    exit 1
}

$isCI = Test-IsRunningOnCI

if (-not (Test-IsAdministrator)) {
    Write-Error "Please re-run this script from an elevated (Administrator) PowerShell prompt."
    exit 1
}

Enable-RequiredWindowsFeatures
$virtualizationOk = Test-VirtualizationEnabled
Install-WslAndDistribution -DistroName $Distribution

if ($script:RebootRequired) {
    Write-Step "A reboot is required to finish enabling WSL2"

    if ($SkipReboot -or $isCI) {
        Write-Warn "Skipping the reboot prompt (-SkipReboot or CI environment detected)."
        Write-Warn "Reboot the machine, then re-run this script to finish installing '$Distribution'."
    } else {
        $answer = Read-Host "Reboot now to finish WSL2 setup? [y/N]"
        if ($answer -match '^(y|yes)$') {
            Restart-Computer -Confirm:$false
            exit 0
        } else {
            Write-Warn "Remember to reboot before using WSL, then re-run this script if '$Distribution' isn't ready yet."
        }
    }
}

if (-not $virtualizationOk) {
    Write-Warn "WSL2 requires hardware virtualization. Enable it in BIOS/UEFI before continuing."
}

Show-NextSteps -DistroName $Distribution

Write-Host ""
Write-Host "Done." -ForegroundColor Green
