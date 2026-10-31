# Android Release Keystore Generation Guide

This guide provides the official, cross-platform instructions for generating the permanent Android release signing key for `in.algions.khata`.

> [!IMPORTANT]
> The generated keystore is permanent. Once an application is published to devices or the Google Play Store signed with this key, all future updates MUST be signed with this exact key. Back up the keystore and passwords securely. Keystore files (`*.jks`, `*.keystore`) and `signing.properties` are strictly excluded in `.gitignore` and must never be committed.

---

## 1. Cross-Platform Generation via `keytool`

Run the following command from your terminal (Linux, macOS, or Windows Git Bash / PowerShell):

```bash
keytool -genkeypair -v \
  -keystore frontend/android/release-keystore.jks \
  -alias khata-release-key \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -dname "CN=Khata Owner, OU=Khata App, O=Algions Technologies, L=Delhi, ST=Delhi, C=IN"
```

You will be prompted to enter and confirm a secure password for the keystore and the key.

---

## 2. Configure Gradle Release Signing

Create `frontend/android/signing.properties` (gitignored):

```properties
RELEASE_STORE_FILE=../release-keystore.jks
RELEASE_STORE_PASSWORD=your_secure_keystore_password
RELEASE_KEY_ALIAS=khata-release-key
RELEASE_KEY_PASSWORD=your_secure_key_password
```

Or pass via environment variables in your CI/CD runner:
- `RELEASE_STORE_FILE`
- `RELEASE_STORE_PASSWORD`
- `RELEASE_KEY_ALIAS`
- `RELEASE_KEY_PASSWORD`

---

## 3. Build & Verify Release APK

```bash
# On Linux / macOS:
cd frontend/android
./gradlew assembleRelease

# On Windows:
cd frontend/android
.\gradlew.bat assembleRelease
```

### Signature Verification:
Verify the cryptographic signature using Android SDK `apksigner`:

```bash
apksigner verify --verbose --print-certs app/build/outputs/apk/release/app-release.apk
```
Confirm the SHA-256 fingerprint matches your generated release key.
