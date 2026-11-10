# Khata — Android Trusted Web Activity (TWA) Release & Packaging Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Package Application ID:** `in.algions.khata`  
**Application Name:** Khata  
**Target Platform:** Android (Trusted Web Activity via `androidbrowserhelper:2.5.0` & AndroidX Browser `1.8.0`)  
**Production URL:** `https://erp.algions.in`  
**Gradle Wrapper:** 8.11.1 | **JDK:** 17 | **Compile SDK:** 35 | **Min SDK:** 23

---

## 1. Remote-Website TWA Architecture

The Android application uses Google's Trusted Web Activity (TWA) architecture. 

Rather than bundling static web assets inside the APK (which would require generating and distributing a new APK every time the frontend is updated), the Android application points directly to the live remote website:
`https://erp.algions.in`.

### Key Benefits:
1. **Immediate Frontend Updates:** Any frontend change deployed to `https://erp.algions.in` is immediately reflected in the installed Android application on refresh or reopen via the Network-First Service Worker (`sw.js`). No new APK rebuild is required.
2. **Single Shopkeeper Experience:** Both the browser website and the installed Android app communicate with the same backend API (`https://erp-api.algions.in`) and the same Neon PostgreSQL database.
3. **Full Screen Chrome-Free Experience:** When Digital Asset Links verification succeeds, the browser URL address bar is hidden completely, presenting an app experience indistinguishable from a native application.
4. **Lightweight APK:** Zero bundled HTML/JS assets inside the binary.

### When is an APK Rebuild Required?
- **NOT Required for:** Any UI styling changes, new web features, form validations, API integration updates, or bug fixes.
- **REQUIRED Only for:** Changing the Android package name (`in.algions.khata`), replacing launcher icons inside `res/mipmap-*`, modifying AndroidManifest permissions, or updating target SDK versions.

---

## 2. Digital Asset Links (`.well-known/assetlinks.json`) & Application-Side Metadata

### 2.1 Website-Side Asset Links
Android verifies ownership of the remote website by fetching:
`https://erp.algions.in/.well-known/assetlinks.json`

The file is hosted from `frontend/public/.well-known/assetlinks.json` and served with `Content-Type: application/json`.

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

### 2.2 Application-Side Asset Statements
In `android-twa/app/src/main/res/values/strings.xml`:
```xml
<string name="asset_statements" translatable="false">
    [{\\\"relation\\\": [\\\"delegate_permission/common.handle_all_urls\\\"], \\\"target\\\": {\\\"namespace\\\": \\\"web\\\", \\\"site\\\": \\\"https://erp.algions.in\\\"}}]
</string>
```
And inside `<application>` in `android-twa/app/src/main/AndroidManifest.xml`:
```xml
<meta-data
    android:name="asset_statements"
    android:resource="@string/asset_statements" />
```

### 2.3 Validating Asset Links Configuration
Run the repository validation script:
```bash
node frontend/scripts/validate-assetlinks.js
```

---

## 3. Certificate Types & Release Signing

Android requires all applications to be digitally signed with a certificate before installation. It is critical to distinguish the different certificate types:

| Certificate Type | Purpose | SHA-256 Fingerprint Location |
|---|---|---|
| **Development / Debug Certificate** | Local testing on developer devices via `assembleDebug`. Standard debug key in `~/.android/debug.keystore`. | Fingerprint `D0:83:6B:...` currently registered for local validation. |
| **Existing Original Release Key** | Used if Khata was previously distributed directly (e.g. via direct APK download). Must be retained for in-place updates. | Extracted using `keytool -list -v -keystore release-keystore.jks`. |
| **Google Play App Signing Key** | Google's certificate if distributed via the Play Store with Play App Signing. Google replaces your upload key with this key for users. | Extracted from Google Play Console -> App Signing -> App signing key certificate. |
| **Play Upload Key** | The key used only to upload AABs/APKs to the Google Play Console if Play App Signing is enabled. | Extracted from your local upload keystore. |

> [!CRITICAL]
> In-place update compatibility requires:
> 1. Exact package ID match: `in.algions.khata`.
> 2. Strictly monotonically higher `versionCode`.
> 3. Signature match with the certificate currently installed on the user device.
> Never generate a new key if you intend to update an existing in-place installation!

---

## 4. Fail-Closed Release Signing Configuration

Release builds in Khata **fail closed**. If a release APK or AAB is requested (`assembleRelease` or `bundleRelease`) without valid signing credentials, Gradle immediately aborts with a security error instead of producing an unsigned artifact.

### Configuring Credentials:
Create `android-twa/signing.properties` (strictly ignored by Git):
```properties
RELEASE_STORE_FILE=release-keystore.jks
RELEASE_STORE_PASSWORD=YourKeystorePassword
RELEASE_KEY_ALIAS=khata-release-key
RELEASE_KEY_PASSWORD=YourKeyPassword
```
Or set environment variables in your secure release CI/CD environment:
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

# Build signed release APK (requires signing credentials):
./gradlew assembleRelease
```

- Debug APK: `android-twa/app/build/outputs/apk/debug/app-debug.apk`
- Release APK: `android-twa/app/build/outputs/apk/release/app-release.apk`

---

## 6. Testing TWA & Verification Procedure

1. **Install Debug APK on Test Device:**
   ```bash
   adb install -r android-twa/app/build/outputs/apk/debug/app-debug.apk
   ```
2. **Open Khata:** Launch the app from the Android home screen.
3. **Verify Full-Screen TWA:** The app opens `https://erp.algions.in` with full-screen experience and NO visible browser URL bar (confirming Digital Asset Links auto-verification).
4. **Test Live Website Updates:**
   - Deploy a frontend styling or feature update to Vercel.
   - Reopen or refresh Khata on the Android device.
   - Confirm that the updated UI appears immediately without rebuilding or reinstalling the APK!
