# Windows entry point: .\scripts\remi.ps1 up   (same commands and options as scripts/remi, e.g. join <url>/<db> <code>)
# Installs WSL2 + Ubuntu if missing (asks for admin), then runs scripts/remi inside WSL, which installs the rest.
param([string]$Command = "up", [Parameter(ValueFromRemainingArguments)][string[]]$Rest = @())
$ErrorActionPreference = "Stop"

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Host "remi: no NVIDIA driver. Install it from https://www.nvidia.com/drivers, then run this again." -ForegroundColor Red
    exit 1
}

wsl.exe -e true 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "remi: installing WSL2 + Ubuntu (Windows asks for admin). Reboot when it finishes, open Ubuntu once to create your user, then run this again."
    Start-Process wsl.exe -ArgumentList "--install", "-d", "Ubuntu-24.04" -Verb RunAs -Wait
    exit 0
}

$repo = (wsl.exe wslpath -a ((Resolve-Path "$PSScriptRoot\..").Path -replace '\\', '/')).Trim()
$extra = ($Rest | ForEach-Object { "'$_'" }) -join ' '  # join codes and URLs contain no quotes
wsl.exe -e bash -lc "cd '$repo' && scripts/remi $Command $extra"
exit $LASTEXITCODE
