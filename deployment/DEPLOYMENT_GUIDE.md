# WhatsApp Service Deployment Guide

## Overview
This guide provides instructions for deploying, managing, and maintaining the Najah ERP WhatsApp Integration Service using NSSM (Non-Sucking Service Manager) as a Windows Service.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Deployment Commands](#deployment-commands)
- [Service Management](#service-management)
- [Monitoring & Logs](#monitoring--logs)
- [Rollback Procedures](#rollback-procedures)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)

## Prerequisites

### System Requirements
- Windows Server 2016 or higher
- Node.js 18.x or higher
- PowerShell 5.0 or higher
- Administrator privileges
- NSSM (installed automatically by deployment script)

### First-Time Setup
Run the NSSM installation script before first deployment:
```powershell
cd H:\Work\Najah.ERP.Whatsapp\deployment
.\install-nssm.ps1
```

## Quick Start

### 1. Deploy to Production
```powershell
cd H:\Work\Najah.ERP.Whatsapp\deployment
.\publish-whatsapp.ps1
```

### 2. Check Service Status
```powershell
sc query NajahERP-WhatsApp
```

### 3. Service URL
- **Production**: http://localhost:8090

## Deployment Commands

### Deploy to Production
```powershell
# From deployment directory
cd H:\Work\Najah.ERP.Whatsapp\deployment
.\publish-whatsapp.ps1

# Or with custom publish root
.\publish-whatsapp.ps1 -PublishRoot "D:\Custom\Path"
```

### Deployment Process
The deployment script performs the following steps:
1. Stops the existing Windows Service
2. Creates timestamped version folder
3. Copies application files
4. Installs production dependencies (`npm ci --omit=dev`)
5. Updates symbolic link to new version
6. Configures/updates Windows Service with NSSM
7. Sets proper permissions
8. Starts the service
9. Tests deployment
10. Cleans up old versions (keeps last 5)

## Service Management

### Using NSSM (Recommended)
```powershell
# Start service
C:\Tools\nssm.exe start NajahERP-WhatsApp

# Stop service
C:\Tools\nssm.exe stop NajahERP-WhatsApp

# Restart service
C:\Tools\nssm.exe restart NajahERP-WhatsApp

# Check status
C:\Tools\nssm.exe status NajahERP-WhatsApp

# Edit service configuration
C:\Tools\nssm.exe edit NajahERP-WhatsApp
```

### Using Windows SC Command
```powershell
# Check status
sc query NajahERP-WhatsApp

# Start service
sc start NajahERP-WhatsApp

# Stop service
sc stop NajahERP-WhatsApp
```

### Using PowerShell
```powershell
# Check status
Get-Service -Name NajahERP-WhatsApp

# Start service
Start-Service -Name NajahERP-WhatsApp

# Stop service
Stop-Service -Name NajahERP-WhatsApp

# Restart service
Restart-Service -Name NajahERP-WhatsApp
```

## Monitoring & Logs

### Log Locations
- **Service Stdout**: `G:\Publish\Najah.ERP.Whatsapp\current\logs\service-stdout.log`
- **Service Stderr**: `G:\Publish\Najah.ERP.Whatsapp\current\logs\service-stderr.log`
- **Deployment Logs**: `G:\Publish\Najah.ERP.Whatsapp\deployment-logs\`

### View Logs
```powershell
# View recent stdout logs
Get-Content "G:\Publish\Najah.ERP.Whatsapp\current\logs\service-stdout.log" -Tail 50

# View error logs
Get-Content "G:\Publish\Najah.ERP.Whatsapp\current\logs\service-stderr.log" -Tail 50

# Follow logs in real-time
Get-Content "G:\Publish\Najah.ERP.Whatsapp\current\logs\service-stdout.log" -Wait -Tail 20
```

### Test Endpoints
```powershell
# Test if service is responding
curl http://localhost:8090/

# Create a test session
curl -X POST http://localhost:8090/session/add -H "Content-Type: application/json" -d '{"id": "test", "isLegacy": false}'
```

## Rollback Procedures

### Interactive Rollback
```powershell
cd H:\Work\Najah.ERP.Whatsapp\deployment
.\rollback.ps1
```
This will:
1. Show all available versions
2. Display deployment timestamps and users
3. Allow selection of version to rollback to
4. Automatically restart the service

### List Available Versions
```powershell
.\rollback.ps1 -ListVersions
```

### Rollback to Specific Version
```powershell
.\rollback.ps1 -ToVersion "20251121_205825"
```

## Troubleshooting

### Common Issues and Solutions

#### 1. Service Not Starting
**Check service status:**
```powershell
sc query NajahERP-WhatsApp
```

**Check error logs:**
```powershell
Get-Content "G:\Publish\Najah.ERP.Whatsapp\current\logs\service-stderr.log" -Tail 100
```

**Common causes:**
- Missing .env file
- Port 8090 already in use
- Missing Node.js modules

**Solution:**
```powershell
# Check if port is in use
netstat -ano | findstr :8090

# Reinstall service
C:\Tools\nssm.exe remove NajahERP-WhatsApp confirm
cd H:\Work\Najah.ERP.Whatsapp\deployment
.\publish-whatsapp.ps1
```

#### 2. Port Already in Use
**Error**: "EADDRINUSE: address already in use :::8090"

**Solution:**
```powershell
# Find process using the port
netstat -ano | findstr :8090

# Kill the process (replace PID with actual process ID)
taskkill /PID <PID> /F

# Restart service
C:\Tools\nssm.exe restart NajahERP-WhatsApp
```

#### 3. WhatsApp Sessions Not Persisting
Sessions are stored in `G:\Publish\Najah.ERP.Whatsapp\current\sessions\`

**Check:**
- Directory permissions (NETWORK SERVICE needs Full Control)
- Sessions folder exists in the deployed version

**Solution:**
```powershell
# Check sessions directory
dir "G:\Publish\Najah.ERP.Whatsapp\current\sessions"

# Grant permissions
icacls "G:\Publish\Najah.ERP.Whatsapp\current\sessions" /grant "NETWORK SERVICE:(OI)(CI)F"
```

#### 4. Service Crashes Immediately
**Check NSSM error details:**
```powershell
C:\Tools\nssm.exe status NajahERP-WhatsApp
```

**Check Windows Event Viewer:**
- Open Event Viewer
- Navigate to Windows Logs > Application
- Filter by Source: "nssm"

## Architecture

### Directory Structure
```
G:\Publish\Najah.ERP.Whatsapp\
├── current\              # Symbolic link to active version
│   ├── app.js           # Main application entry
│   ├── startApp.js      # Server startup logic
│   ├── routes.js        # Route definitions
│   ├── controllers\     # Request handlers
│   ├── middlewares\     # Express middlewares
│   ├── lib\            # Core WhatsApp logic
│   ├── sessions\       # WhatsApp session data
│   └── logs\           # Service logs
├── versions\            # All deployed versions
│   ├── 20251121_205825\
│   ├── 20251121_204229\
│   └── ...
└── deployment-logs\     # Deployment history
    ├── deployments.json
    └── rollbacks.json
```

### Key Files
| File | Description |
|------|-------------|
| `app.js` | Express application setup and entry point |
| `startApp.js` | Server startup function |
| `routes.js` | API route definitions |
| `.env` | Environment configuration |

### Service Configuration
| Setting | Value |
|---------|-------|
| Service Name | NajahERP-WhatsApp |
| Display Name | Najah ERP WhatsApp Service |
| Port | 8090 |
| Start Type | Automatic |
| Log Rotation | 10MB per file |

## Maintenance

### Clean Old Versions Manually
```powershell
# Keep only last 3 versions
Get-ChildItem "G:\Publish\Najah.ERP.Whatsapp\versions" |
    Sort-Object Name -Descending |
    Select-Object -Skip 3 |
    Remove-Item -Recurse -Force
```

### Backup Current Deployment
```powershell
$currentPath = (Get-Item "G:\Publish\Najah.ERP.Whatsapp\current").Target
$backupPath = "D:\Backups\WhatsApp\backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
Copy-Item -Path $currentPath -Destination $backupPath -Recurse
```

### Uninstall Service
```powershell
C:\Tools\nssm.exe stop NajahERP-WhatsApp
C:\Tools\nssm.exe remove NajahERP-WhatsApp confirm
```

## Security Considerations

1. **Environment Variables**: Never commit `.env` file to version control
2. **Sessions Security**: WhatsApp session files contain sensitive authentication data
3. **API Access**: Implement proper authentication for production use
4. **File Permissions**: Ensure only NETWORK SERVICE and Administrators have access
5. **Port Security**: Use Windows Firewall to restrict access to port 8090

## Quick Reference

| Command | Description |
|---------|-------------|
| `.\publish-whatsapp.ps1` | Deploy to production |
| `.\rollback.ps1` | Interactive rollback |
| `nssm start NajahERP-WhatsApp` | Start service |
| `nssm stop NajahERP-WhatsApp` | Stop service |
| `nssm restart NajahERP-WhatsApp` | Restart service |
| `sc query NajahERP-WhatsApp` | Check service status |

---

*Last Updated: November 21, 2025*
