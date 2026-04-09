# WhatsApp Service Deployment Script
# Deploys Node.js app as a Windows Service using NSSM
param(
    [string]$Environment = "Production",
    [string]$PublishRoot = ""
)

# Dynamic path calculation
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$workRoot = Split-Path -Parent $projectRoot
$publishBase = Join-Path $workRoot "Publish"

# Use default publish root if not specified
if ([string]::IsNullOrEmpty($PublishRoot)) {
    $PublishRoot = Join-Path $publishBase "Najah.ERP.Whatsapp"
}

# Configuration
$projectName = "Najah.ERP.Whatsapp"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$version = "$(Get-Date -Format "yyyy.MM.dd").$($timestamp.Substring(9,6))"
$serviceName = "NajahERP-WhatsApp"
$servicePort = 8090

# Source directory (this project)
$sourceDir = $projectRoot

# Deployment paths
$targetDir = Join-Path $PublishRoot "versions\$timestamp"
$currentLink = Join-Path $PublishRoot "current"
$publishLogsDir = Join-Path $PublishRoot "deployment-logs"

# NSSM path
$nssmPath = "C:\Tools\nssm.exe"

# Display header
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "           WHATSAPP SERVICE DEPLOYMENT SCRIPT" -ForegroundColor Cyan
Write-Host "                  Version: $version" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Deployment Configuration:" -ForegroundColor Yellow
Write-Host "  Project: $projectName"
Write-Host "  Environment: $Environment"
Write-Host "  Service: $serviceName"
Write-Host "  Port: $servicePort"
Write-Host "  Timestamp: $timestamp"
Write-Host "  Source: $sourceDir"
Write-Host "  Target: $targetDir"
Write-Host ""

# Check NSSM
if (-not (Test-Path $nssmPath)) {
    Write-Host "NSSM not found at $nssmPath" -ForegroundColor Red
    Write-Host "Please run install-nssm.ps1 first" -ForegroundColor Yellow
    exit 1
}

# Stop existing service
Write-Host "Stopping existing service..." -ForegroundColor Yellow

# Check if service exists using Get-Service (more reliable than nssm status)
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

if ($existingService) {
    # Service exists, try to stop it
    try {
        & $nssmPath stop $serviceName 2>&1 | Out-Null
        Start-Sleep -Seconds 2
        Write-Host "  Service stopped" -ForegroundColor Green
    } catch {
        Write-Host "  Could not stop service (may already be stopped)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  Service does not exist (will be created)" -ForegroundColor Gray
}

# Create directories
Write-Host ""
Write-Host "Creating publish directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
New-Item -ItemType Directory -Path $publishLogsDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $targetDir "sessions") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $targetDir "logs") -Force | Out-Null

# Copy application files
Write-Host ""
Write-Host "Publishing application files..." -ForegroundColor Yellow

# Define files and folders to copy
$includeItems = @(
    "app.js",
    "startApp.js",
    "routes.js",
    "response.js",
    "whatsapp.js",
    "logger.js",
    "dirname.js",
    ".env",
    "package.json",
    "package-lock.json",
    "controllers",
    "middlewares",
    "routes",
    "utils",
    "lib"
)

foreach ($item in $includeItems) {
    $sourcePath = Join-Path $sourceDir $item
    if (Test-Path $sourcePath) {
        $destPath = Join-Path $targetDir $item
        if ((Get-Item $sourcePath).PSIsContainer) {
            Copy-Item -Path $sourcePath -Destination $destPath -Recurse -Force
        } else {
            Copy-Item -Path $sourcePath -Destination $destPath -Force
        }
    }
}

Write-Host "  Application files copied" -ForegroundColor Green

# Install production dependencies
Write-Host ""
Write-Host "Installing production dependencies..." -ForegroundColor Yellow
Push-Location $targetDir
try {
    & npm ci --omit=dev 2>&1 | Out-Null
    Write-Host "  Dependencies installed" -ForegroundColor Green
} finally {
    Pop-Location
}

# Create deployment manifest
Write-Host ""
Write-Host "Creating deployment manifest..." -ForegroundColor Yellow
$manifest = @{
    Version = $version
    Timestamp = $timestamp
    Environment = $Environment
    DeployedBy = $env:USERNAME
    DeployedFrom = $env:COMPUTERNAME
    DeployedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    SourcePath = $sourceDir
    TargetPath = $targetDir
    ServiceName = $serviceName
    Port = $servicePort
}

$manifest | ConvertTo-Json | Out-File -FilePath (Join-Path $targetDir "deployment-manifest.json") -Encoding UTF8
Write-Host "  Deployment manifest created" -ForegroundColor Green

# Update current symlink
Write-Host ""
Write-Host "Updating current deployment link..." -ForegroundColor Yellow
if (Test-Path $currentLink) {
    # Remove existing link
    if ((Get-Item $currentLink).LinkType -eq "SymbolicLink") {
        (Get-Item $currentLink).Delete()
    } else {
        Remove-Item $currentLink -Recurse -Force
    }
}

# Create new symbolic link
New-Item -ItemType SymbolicLink -Path $currentLink -Target $targetDir | Out-Null
Write-Host "  Symlink created" -ForegroundColor Green

# Configure Windows Service using NSSM
Write-Host ""
Write-Host "Configuring Windows Service..." -ForegroundColor Yellow

# Get Node.js path
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    $nodePath = "C:\Program Files\nodejs\node.exe"
}

# Check if service exists
$serviceExists = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

if ($serviceExists) {
    Write-Host "  Updating existing service..." -ForegroundColor Gray
    & $nssmPath set $serviceName Application "$nodePath"
    & $nssmPath set $serviceName AppParameters "app.js"
    & $nssmPath set $serviceName AppDirectory "$currentLink"
} else {
    Write-Host "  Creating new service..." -ForegroundColor Gray
    & $nssmPath install $serviceName "$nodePath" "app.js"
    & $nssmPath set $serviceName AppDirectory "$currentLink"
}

# Configure service settings
& $nssmPath set $serviceName DisplayName "Najah ERP WhatsApp Service"
& $nssmPath set $serviceName Description "WhatsApp messaging service for Najah ERP"
& $nssmPath set $serviceName Start SERVICE_AUTO_START
& $nssmPath set $serviceName AppStdout (Join-Path $currentLink "logs\service-stdout.log")
& $nssmPath set $serviceName AppStderr (Join-Path $currentLink "logs\service-stderr.log")
& $nssmPath set $serviceName AppStdoutCreationDisposition 4
& $nssmPath set $serviceName AppStderrCreationDisposition 4
& $nssmPath set $serviceName AppRotateFiles 1
& $nssmPath set $serviceName AppRotateOnline 1
& $nssmPath set $serviceName AppRotateBytes 10485760

# Set environment variables
& $nssmPath set $serviceName AppEnvironmentExtra "PORT=$servicePort" "NODE_ENV=production"

Write-Host "  Windows Service configured" -ForegroundColor Green

# Set directory permissions
Write-Host ""
Write-Host "Setting permissions..." -ForegroundColor Yellow
$acl = Get-Acl $targetDir
$permission = "NETWORK SERVICE", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"
$accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule $permission
$acl.SetAccessRule($accessRule)
Set-Acl $targetDir $acl
Write-Host "  Permissions configured" -ForegroundColor Green

# Start service
Write-Host ""
Write-Host "Starting service..." -ForegroundColor Yellow
& $nssmPath start $serviceName
Start-Sleep -Seconds 3

# Check service status
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -eq "Running") {
    Write-Host "  Service started successfully" -ForegroundColor Green
} else {
    Write-Host "  Service may not have started correctly" -ForegroundColor Yellow
    Write-Host "  Check logs at: $currentLink\logs\" -ForegroundColor Yellow
}

# Log deployment
$logEntry = @{
    Version = $version
    Timestamp = $timestamp
    Environment = $Environment
    Status = "Success"
    DeployedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    User = $env:USERNAME
    Machine = $env:COMPUTERNAME
}

$logFile = Join-Path $publishLogsDir "deployments.json"
if (Test-Path $logFile) {
    $logs = @(Get-Content $logFile | ConvertFrom-Json)
} else {
    $logs = @()
}
$logs = $logs + @($logEntry)
$logs | ConvertTo-Json | Out-File $logFile -Encoding UTF8

# Test deployment
Write-Host ""
Write-Host "Testing deployment..." -ForegroundColor Cyan
Start-Sleep -Seconds 2

try {
    $response = Invoke-WebRequest -Uri "http://localhost:$servicePort" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    Write-Host "  Service is responding on port $servicePort" -ForegroundColor Green
} catch {
    $errorMsg = $_.Exception.Message
    if ($errorMsg -like "*404*" -or $errorMsg -like "*cannot be found*") {
        Write-Host "  Service is responding (404 on root is expected)" -ForegroundColor Green
    } else {
        Write-Host "  Service test returned: $errorMsg" -ForegroundColor Yellow
    }
}

# Clean up old versions (keep last 5)
Write-Host ""
Write-Host "Cleaning old versions..." -ForegroundColor Yellow
$versionsDir = Join-Path $PublishRoot "versions"
if (Test-Path $versionsDir) {
    $oldVersions = Get-ChildItem -Path $versionsDir -Directory |
                   Sort-Object Name -Descending |
                   Select-Object -Skip 5

    foreach ($oldVersion in $oldVersions) {
        Remove-Item -Path $oldVersion.FullName -Recurse -Force
        Write-Host "  Removed old version: $($oldVersion.Name)" -ForegroundColor Gray
    }
}

# Display summary
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "                    DEPLOYMENT SUCCESSFUL!" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Version:    $version" -ForegroundColor Cyan
Write-Host "Timestamp:  $timestamp" -ForegroundColor Cyan
Write-Host "Path:       $targetDir" -ForegroundColor Cyan
Write-Host "Current:    $currentLink" -ForegroundColor Cyan
Write-Host ""
Write-Host "Service:" -ForegroundColor Yellow
Write-Host "  Name: $serviceName" -ForegroundColor Cyan
Write-Host "  URL:  http://localhost:$servicePort" -ForegroundColor Cyan
Write-Host "  Logs: $currentLink\logs\" -ForegroundColor Cyan
Write-Host ""
Write-Host "Management Commands:" -ForegroundColor Yellow
Write-Host "  Start:   nssm start $serviceName" -ForegroundColor Gray
Write-Host "  Stop:    nssm stop $serviceName" -ForegroundColor Gray
Write-Host "  Restart: nssm restart $serviceName" -ForegroundColor Gray
Write-Host "  Status:  sc query $serviceName" -ForegroundColor Gray
Write-Host ""

# Show recent versions
$recentVersions = Get-ChildItem -Path $versionsDir -Directory |
                  Sort-Object Name -Descending |
                  Select-Object -First 3
Write-Host "Recent versions:" -ForegroundColor Yellow
foreach ($v in $recentVersions) {
    Write-Host "  - $($v.Name)" -ForegroundColor Gray
}
Write-Host ""
