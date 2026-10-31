# ==============================================================================
# Khata Android Release Keystore Generator (PowerShell)
# ==============================================================================

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Khata Android Release Keystore Generator               " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "This script generates the dedicated release signing keystore."
Write-Host "NOTE: Keep this keystore secure! Future app updates require this same key."
Write-Host ""

$keystorePath = Join-Path $PSScriptRoot "..\android\release-keystore.jks"
if (Test-Path $keystorePath) {
    Write-Host "[WARNING] Keystore already exists at $keystorePath" -ForegroundColor Yellow
    exit 0
}

Write-Host "Generating release keystore at: $keystorePath"
keytool -genkeypair -v `
    -keystore $keystorePath `
    -alias "khata-release-key" `
    -keyalg RSA `
    -keysize 2048 `
    -validity 10000 `
    -dname "CN=Khata Owner, OU=Khata App, O=Algions Technologies, L=Delhi, ST=Delhi, C=IN"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "[SUCCESS] Keystore created successfully!" -ForegroundColor Green
    Write-Host "File: $keystorePath"
    Write-Host ""
    Write-Host "To configure Gradle release signing, create 'frontend/android/signing.properties':"
    Write-Host "RELEASE_STORE_FILE=../release-keystore.jks"
    Write-Host "RELEASE_STORE_PASSWORD=<your-keystore-password>"
    Write-Host "RELEASE_KEY_ALIAS=khata-release-key"
    Write-Host "RELEASE_KEY_PASSWORD=<your-key-password>"
    Write-Host "(signing.properties is already in .gitignore and will never be committed)"
} else {
    Write-Host "[ERROR] Failed to generate keystore." -ForegroundColor Red
}
