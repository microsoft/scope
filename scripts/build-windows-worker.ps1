# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $root 'apps/workers/coder-acp-copilot-windows'
$versions = Get-Content (Join-Path $root 'apps/workers/coder-acp-copilot/versions.env')
$version = @($versions | Where-Object { $_ -match '^COPILOT_CLI_VERSION=' })
if ($version.Count -ne 1) { throw 'Expected one pinned COPILOT_CLI_VERSION' }
$version = $version[0].Split('=', 2)[1].Trim()
if ($version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { throw 'Invalid COPILOT_CLI_VERSION' }

function Invoke-Docker {
    param([string[]] $Arguments)
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "docker $($Arguments[0]) failed with exit code $LASTEXITCODE" }
}

$os = Invoke-Docker @('info', '--format', '{{.OSType}}')
if ($os -ne 'windows') { throw 'This build requires a Windows Docker engine (Windows Server 2022).' }

Invoke-Docker @('build', '--isolation=process', '-f', "$worker/Dockerfile.base", '-t', 'scope-windows-base:ci', $root)
Invoke-Docker @('build', '--isolation=process', '-f', "$worker/Dockerfile.deps", '--build-arg', 'BASE_IMAGE=scope-windows-base:ci', '--build-arg', "COPILOT_CLI_VERSION=$version", '-t', 'scope-windows-deps:ci', $root)
Invoke-Docker @('build', '--isolation=process', '-f', "$worker/Dockerfile.windows", '--build-arg', 'DEPS_IMAGE=scope-windows-deps:ci', '--build-arg', "COPILOT_CLI_VERSION=$version", '-t', 'scope-copilot-windows:ci', $root)
Invoke-Docker @('run', '--rm', '--isolation=process', '--entrypoint', 'node', 'scope-copilot-windows:ci', '-e', "require('node:fs').accessSync('dist/index.js'); console.log(process.version)")
