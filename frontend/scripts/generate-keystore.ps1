# ==============================================================================
# Khata Android TWA Release Keystore Utility (PowerShell)
# ==============================================================================
# Manages signing keystore and fingerprint verification for Android TWA (in.algions.khata)
#
# CRITICAL NOTICE ON UPGRADE COMPATIBILITY:
# If you are updating an existing installed application on devices or Google Play,
# you MUST use your existing original release keystore and alias. Generating a new
# key will cause Android to reject in-place updates ("signatures do not match").
# ==============================================================================

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Khata Android TWA Keystore & Fingerprint Utility       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Target Package: in.algions.khata"
Write-Host "Target Origin:  https://erp.algions.in"
Write-Host ""

$twaDir = Join-Path $PSScriptRoot "..\..\android-twa"
$keystorePath = Join-Path $twaDir "release-keystore.jks"

if (Test-Path $keystorePath) {
    Write-Host "[INFO] Existing keystore found at: $keystorePath" -ForegroundColor Green
    Write-Host "Extracting SHA-256 certificate fingerprint:" -ForegroundColor Cyan
    keytool -list -v -keystore $keystorePath -alias "khata-release-key"
    Write-Host ""
    Write-Host "To configure Android release signing in android-twa/signing.properties:"
    Write-Host "RELEASE_STORE_FILE=release-keystore.jks"
    Write-Host "RELEASE_STORE_PASSWORD=<your-keystore-password>"
    Write-Host "RELEASE_KEY_ALIAS=khata-release-key"
    Write-Host "RELEASE_KEY_PASSWORD=<your-key-password>"
    exit 0
}

Write-Host "[NOTICE] No keystore found at: $keystorePath" -ForegroundColor Yellow
Write-Host "Would you like to generate a NEW keystore for initial installation? (y/N): " -NoNewline
$response = Read-Host

if ($response -ne "y" -and $response -ne "Y") {
    Write-Host "Aborted. Please place your existing release keystore at $keystorePath" -ForegroundColor Yellow
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
    Write-Host "SHA-256 Fingerprint for Digital Asset Links (.well-known/assetlinks.json):" -ForegroundColor Cyan
    keytool -list -v -keystore $keystorePath -alias "khata-release-key"
    Write-Host ""
    Write-Host "To configure Gradle release signing, create 'android-twa/signing.properties':"
    Write-Host "RELEASE_STORE_FILE=release-keystore.jks"
    Write-Host "RELEASE_STORE_PASSWORD=<your-keystore-password>"
    Write-Host "RELEASE_KEY_ALIAS=khata-release-key"
    Write-Host "RELEASE_KEY_PASSWORD=<your-key-password>"
    Write-Host "(signing.properties is already in .gitignore and will never be committed)"
} else {
    Write-Host "[ERROR] Failed to generate keystore." -ForegroundColor Red
}
