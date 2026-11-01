# Khata — Android Trusted Web Activity (TWA) Release & Packaging Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Package Application ID:** `in.algions.khata`  
**Application Name:** Khata  
**Target Platform:** Android (Trusted Web Activity via `androidbrowserhelper:2.5.0` & AndroidX Browser `1.8.0`)  
**Production URL:** `https://khata.algions.in`  

---

## 1. Remote-Website TWA Architecture

The Android application uses Google's Trusted Web Activity (TWA) architecture. 

Rather than bundling static web assets inside the APK (which would require generating and distributing a new APK every time the frontend is updated), the Android application points directly to the live remote website:
`https://khata.algions.in`.

### Key Benefits:
1. **Immediate Frontend Updates:** Any frontend change deployed to `https://khata.algions.in` is immediately reflected in the installed Android application on refresh or reopen via the Network-First Service Worker (`sw.js`). No new APK rebuild is required.
2. **Single Shopkeeper Experience:** Both the browser website and the installed Android app communicate with the same backend API (`https://api-khata.algions.in`) and the same Neon PostgreSQL database.
3. **Full Screen Chrome-Free Experience:** When Digital Asset Links verification succeeds, the browser URL address bar is hidden completely, presenting an app experience indistinguishable from a native application.
4. **Lightweight APK:** Zero bundled HTML/JS assets inside the binary.

### When is an APK Rebuild Required?
- **NOT Required for:** Any UI styling changes, new web features, form validations, API integration updates, or bug fixes.
- **REQUIRED Only for:** Changing the Android package name (`in.algions.khata`), replacing launcher icons inside `res/mipmap-*`, modifying AndroidManifest permissions, or updating target SDK versions.

---

## 2. Digital Asset Links (`.well-known/assetlinks.json`)

Android verifies ownership of the remote website by fetching:
`https://khata.algions.in/.well-known/assetlinks.json`

The file is hosted from `frontend/public/.well-known/assetlinks.json` and served with `Content-Type: application/json`.

### Format:
```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "in.algions.khata",
      "sha256_cert_fingerprints": [
        "D0:83:6B:13:CF:E8:BA:ED:0A:50:04:AA:4D:82:60:2E:E2:52:5D:99:C5:E8:96:F6:E7:67:E1:B4:7D:2B:0D:81"
      ]
    }
  }
]
```

### Validating Asset Links Configuration:
Run the repository validation script:
```bash
node frontend/scripts/validate-assetlinks.js
```

---

## 3. Keystore Generation & Fingerprint Extraction

> [!IMPORTANT]
> The release signing key is permanent. Once an application is installed or published to Google Play, all future APK updates must use the exact same key. Keep your keystore safe. Keystores (`*.jks`) and `signing.properties` are strictly excluded from git.

### 3.1 Generating a New Release Keystore
```bash
keytool -genkeypair -v \
  -keystore android-twa/release-keystore.jks \
  -alias khata-release-key \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -dname "CN=Khata Owner, OU=Khata App, O=Algions Technologies, L=Delhi, ST=Delhi, C=IN"
```

### 3.2 Extracting the SHA-256 Fingerprint
To view the SHA-256 fingerprint from an existing keystore:
```bash
keytool -list -v -keystore android-twa/release-keystore.jks -alias khata-release-key
```

Look for the line:
`Certificate fingerprints: SHA256: XX:XX:XX:...`

Copy that fingerprint and add it to `frontend/public/.well-known/assetlinks.json`.

---

## 4. Configuring Release Signing

Create `android-twa/signing.properties` (ignored by git):

```properties
RELEASE_STORE_FILE=../release-keystore.jks
RELEASE_STORE_PASSWORD=YourKeystorePassword
RELEASE_KEY_ALIAS=khata-release-key
RELEASE_KEY_PASSWORD=YourKeyPassword
```

Alternatively, supply the signing credentials via environment variables during CI/CD:
- `RELEASE_STORE_FILE`
- `RELEASE_STORE_PASSWORD`
- `RELEASE_KEY_ALIAS`
- `RELEASE_KEY_PASSWORD`

---

## 5. Building the TWA APK

Navigate to `android-twa/`:

```bash
cd android-twa

# Build debug APK (for local testing via USB debugging):
./gradlew assembleDebug

# Build release APK (signed with your production key):
./gradlew assembleRelease
```

The resulting signed APK is generated at:
`android-twa/app/build/outputs/apk/release/app-release.apk`

---

## 6. Testing TWA & Verification Procedure

1. **Install APK on Test Device:**
   ```bash
   adb install -r android-twa/app/build/outputs/apk/debug/app-debug.apk
   ```
2. **Open Khata:** Launch the app from the home screen.
3. **Verify Full-Screen TWA:** The app opens `https://khata.algions.in` with full-screen experience and NO visible browser URL bar (confirming Digital Asset Links auto-verification).
4. **Test Live Website Updates:**
   - Deploy a test change to `frontend` on Vercel.
   - Reopen the app on the Android device.
   - Confirm that the updated UI appears without rebuilding or reinstalling the APK!
