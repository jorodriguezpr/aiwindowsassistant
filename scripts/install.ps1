<#
AiWindowsAssistant
Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
GitHub: https://github.com/jorodriguezpr/aiwindowsassistant

One-shot Windows bootstrap: installs Git and Node.js if missing (via winget),
clones (or updates) the repo, installs npm dependencies, installs the Claude
Code CLI, scaffolds .env from the template, and builds the project.

Usage — already have the repo cloned, run from anywhere inside it:
    .\scripts\install.ps1

Usage — fresh machine, nothing downloaded yet:
    irm https://raw.githubusercontent.com/jorodriguezpr/aiwindowsassistant/main/scripts/install.ps1 | iex

Parameters:
    -InstallPath   Where to clone/build (default: .\aiwindowsassistant under
                    the current directory, or the current directory itself if
                    already run from inside a clone of this repo).
    -RepoUrl       Repo to clone (default: this project's GitHub URL).
    -SkipClaudeCli Skip installing the Claude Code CLI globally.
#>

param(
    [string]$InstallPath = (Join-Path $PWD 'aiwindowsassistant'),
    [string]$RepoUrl = 'https://github.com/jorodriguezpr/aiwindowsassistant.git',
    [switch]$SkipClaudeCli
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Test-CommandExists([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
    # Installers register PATH at the Machine/User scope but don't touch this
    # already-running process — pull both back in so newly-installed tools
    # (git, node) are usable without restarting the shell.
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Install-WithWinget([string]$Id, [string]$FriendlyName) {
    if (-not (Test-CommandExists 'winget')) {
        throw "winget not found, so '$FriendlyName' can't be installed automatically. " +
              "Install it manually (https://aka.ms/winget for winget itself, or grab " +
              "'$FriendlyName' directly from its vendor site), then re-run this script."
    }
    Write-Host "Installing $FriendlyName via winget..."
    winget install --id $Id -e --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
}

# ---------- prerequisites ----------

Write-Step 'Checking prerequisites'

if (-not (Test-CommandExists 'git')) {
    Install-WithWinget -Id 'Git.Git' -FriendlyName 'Git'
}
if (-not (Test-CommandExists 'git')) {
    throw 'Git install did not take effect in this session — close this PowerShell window, open a new one, and re-run this script.'
}
Write-Host "Git:  $(git --version)"

if (-not (Test-CommandExists 'node')) {
    Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -FriendlyName 'Node.js LTS'
}
if (-not (Test-CommandExists 'node')) {
    throw 'Node.js install did not take effect in this session — close this PowerShell window, open a new one, and re-run this script.'
}
Write-Host "Node: $(node --version)"
Write-Host "npm:  $(npm --version)"

# ---------- get the source ----------

Write-Step 'Getting the source'

$hereIsTheRepo = $false
$pkgJsonPath = Join-Path $PWD 'package.json'
if (Test-Path $pkgJsonPath) {
    $pkgContent = Get-Content $pkgJsonPath -Raw
    if ($pkgContent -match '"name"\s*:\s*"aiwindowsassistant"') {
        $hereIsTheRepo = $true
    }
}

if ($hereIsTheRepo) {
    $InstallPath = (Get-Item $PWD).FullName
    Write-Host "Already inside the repo at $InstallPath — skipping clone."
} elseif (Test-Path $InstallPath) {
    Write-Host "$InstallPath already exists — pulling latest instead of cloning."
    Push-Location $InstallPath
    git pull
    Pop-Location
} else {
    Write-Host "Cloning into $InstallPath..."
    git clone $RepoUrl $InstallPath
}

Set-Location $InstallPath

# ---------- dependencies ----------

Write-Step 'Installing npm dependencies'
npm install

if (-not $SkipClaudeCli) {
    Write-Step 'Installing Claude Code CLI'
    if (Test-CommandExists 'claude') {
        Write-Host 'Claude Code CLI already installed.'
    } else {
        npm install -g @anthropic-ai/claude-code
    }
    Write-Host "Run 'claude login' once, interactively, before using the Claude Code engine." -ForegroundColor Yellow
}

# ---------- config scaffold ----------

Write-Step 'Setting up .env'
if (Test-Path '.env') {
    Write-Host '.env already exists — leaving it as-is.'
} else {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env from .env.example — edit it before starting the bot.' -ForegroundColor Yellow
}

# ---------- build ----------

Write-Step 'Building'
npm run build

Write-Step 'Done'
Write-Host "Project ready at: $InstallPath" -ForegroundColor Green
Write-Host @"

Next steps:
  1. Edit .env in $InstallPath — at minimum set TELEGRAM_BOT_TOKEN.
  2. Run: npm start
  3. Message your bot with /start to get your Telegram chat ID.
  4. Add that ID to TELEGRAM_ALLOWED_USERS in .env and restart — the bot
     will not respond to anything else until an allowed user is configured.
"@
