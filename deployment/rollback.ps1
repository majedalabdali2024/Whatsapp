# WhatsApp Service Rollback Script
# Uses NSSM Windows Service for service management
param(
    [string]$PublishRoot = "G:\Publish\Najah.ERP.Whatsapp",
    [string]$ToVersion = "",
    [switch]$ListVersions
)

$serviceName = "NajahERP-WhatsApp"
$nssmPath = "C:\Tools\nssm.exe"
$versionsPath = Join-Path $PublishRoot "versions"
$currentLink = Join-Path $PublishRoot "current"

# Get available versions
$versions = Get-ChildItem -Path $versionsPath -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending

if ($ListVersions) {
    Write-Host "Available Versions:" -ForegroundColor Cyan
    foreach ($version in $versions) {
        Write-Host "  - $($version.Name)" -ForegroundColor White
    }
    exit 0
}

if ($versions.Count -eq 0) {
    Write-Host "No versions available for rollback" -ForegroundColor Red
    exit 1
}

# If no specific version requested, show interactive menu
if ([string]::IsNullOrEmpty($ToVersion)) {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "           WHATSAPP SERVICE ROLLBACK" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""

    # Get current version
    $currentVersion = ""
    if (Test-Path $currentLink) {
        $currentTarget = (Get-Item $currentLink).Target
        if ($currentTarget) {
            $currentVersion = Split-Path -Leaf $currentTarget
        }
    }

    Write-Host "Current Version: $currentVersion" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Available Versions:" -ForegroundColor Cyan

    $versionList = @()
    $index = 1
    foreach ($version in $versions) {
        $versionName = $version.Name
        $manifestPath = Join-Path $version.FullName "deployment-manifest.json"
        $deployInfo = ""

        if (Test-Path $manifestPath) {
            $manifest = Get-Content $manifestPath | ConvertFrom-Json
            $deployInfo = " (Deployed: $($manifest.DeployedAt) by $($manifest.DeployedBy))"
        }

        $isCurrent = $versionName -eq $currentVersion
        if ($isCurrent) {
            Write-Host "  [$index] $versionName $deployInfo [CURRENT]" -ForegroundColor Green
        } else {
            Write-Host "  [$index] $versionName $deployInfo" -ForegroundColor White
        }

        $versionList += $version
        $index++
    }

    Write-Host ""
    Write-Host "Enter version number (1-$($versionList.Count)) or Q to quit: " -NoNewline -ForegroundColor Yellow
    $selection = Read-Host

    if ($selection -eq 'Q' -or $selection -eq 'q') {
        Write-Host "Rollback cancelled" -ForegroundColor Yellow
        exit 0
    }

    try {
        $selectedIndex = [int]$selection - 1
        if ($selectedIndex -lt 0 -or $selectedIndex -ge $versionList.Count) {
            Write-Host "Invalid selection" -ForegroundColor Red
            exit 1
        }

        $selectedVersion = $versionList[$selectedIndex]
        $ToVersion = $selectedVersion.Name
    } catch {
        Write-Host "Invalid selection" -ForegroundColor Red
        exit 1
    }
}

# Perform rollback
$targetPath = Join-Path $versionsPath $ToVersion

if (!(Test-Path $targetPath)) {
    Write-Host "Version $ToVersion not found" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Rolling back to version: $ToVersion" -ForegroundColor Yellow

# Stop Windows Service
Write-Host "Stopping service..." -ForegroundColor Yellow
if (Test-Path $nssmPath) {
    & $nssmPath stop $serviceName 2>&1 | Out-Null
} else {
    Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# Update symbolic link
Write-Host "Updating deployment link..." -ForegroundColor Yellow
if (Test-Path $currentLink) {
    if ((Get-Item $currentLink).LinkType -eq "SymbolicLink") {
        (Get-Item $currentLink).Delete()
    } else {
        Remove-Item $currentLink -Recurse -Force
    }
}

New-Item -ItemType SymbolicLink -Path $currentLink -Target $targetPath | Out-Null

# Start Windows Service
Write-Host "Starting service..." -ForegroundColor Yellow
if (Test-Path $nssmPath) {
    & $nssmPath start $serviceName 2>&1 | Out-Null
} else {
    Start-Service -Name $serviceName -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

# Check service status
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -eq "Running") {
    Write-Host "  Service restarted successfully" -ForegroundColor Green
} else {
    Write-Host "  Warning: Service may not have started correctly" -ForegroundColor Yellow
}

# Log rollback
$logsDir = Join-Path $PublishRoot "deployment-logs"
$logFile = Join-Path $logsDir "rollbacks.json"

if (!(Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

$rollbackEntry = @{
    RolledBackTo = $ToVersion
    RolledBackAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    User = $env:USERNAME
    Machine = $env:COMPUTERNAME
}

if (Test-Path $logFile) {
    $logs = @(Get-Content $logFile | ConvertFrom-Json)
} else {
    $logs = @()
}

$logs = $logs + @($rollbackEntry)
$logs | ConvertTo-Json | Out-File $logFile -Encoding UTF8

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "                    ROLLBACK SUCCESSFUL!" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Rolled back to version: $ToVersion" -ForegroundColor Cyan
Write-Host "Service URL: http://localhost:8090" -ForegroundColor Cyan
Write-Host ""
