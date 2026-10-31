# Khata - Capacitor Android Release & Packaging Guide

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Package Application ID:** `in.algions.khata`  
**Application Name:** Khata  
**Target Platform:** Android (Capacitor 6)  

---

## 1. Capacitor Architecture & Offline Asset Sync

Khata's Android shell embeds the production React application within an optimized Android Webview. Assets (including Montserrat fonts) are served locally from device storage for near-instant cold startup.

### Web Build & Capacitor Sync Workflow
Execute from the repository root:

```bash
# 1. Compile the production web bundle
npm run build --workspace=frontend

# 2. Synchronize bundled assets into the Android native project
cd frontend
npx cap sync android
```

The synchronization process copies `frontend/dist/` directly into `frontend/android/app/src/main/assets/public/`.

---

## 2. Release Keystore Generation

> [!IMPORTANT]
> The release signing key is permanent. Once an application is published or installed with this signature, all subsequent updates must use the exact same key. Back up the keystore and passwords securely. Keystore files (`*.jks`) and `signing.properties` are strictly excluded from version control via `.gitignore`.

### Generation Command via `keytool`
```bash
keytool -genkeypair -v \
  -keystore frontend/android/release-keystore.jks \
  -alias khata-release-key \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -dname "CN=Khata Owner, OU=Khata App, O=Algions Technologies, L=Delhi, ST=Delhi, C=IN"
```

---

## 3. Configuring Release Signing

Create `frontend/android/signing.properties` (ignored by git):

```properties
RELEASE_STORE_FILE=release-keystore.jks
RELEASE_STORE_PASSWORD=YourSecureKeystorePassword
RELEASE_KEY_ALIAS=khata-release-key
RELEASE_KEY_PASSWORD=YourSecureKeyPassword
```

Update `frontend/android/app/build.gradle` to load `signing.properties`:

```groovy
android {
    ...
    signingConfigs {
        release {
            if (project.hasProperty('RELEASE_STORE_FILE')) {
                storeFile file(RELEASE_STORE_FILE)
                storePassword RELEASE_STORE_PASSWORD
                keyAlias RELEASE_KEY_ALIAS
                keyPassword RELEASE_KEY_PASSWORD
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

---

## 4. Building Release APK & AAB

Ensure the Android SDK is installed and `ANDROID_HOME` is set:

```bash
cd frontend/android

# Build standalone signed APK (for direct sideloading or internal distribution)
./gradlew assembleRelease

# Or build Google Play App Bundle (AAB)
./gradlew bundleRelease
```

### Artifact Outputs
- Standalone APK: `frontend/android/app/build/outputs/apk/release/app-release.apk`
- Play Bundle: `frontend/android/app/build/outputs/bundle/release/app-release.aab`

---

## 5. Security & Manifest Configuration

Verified in `frontend/android/app/src/main/AndroidManifest.xml`:
- **Network Security:** `android:usesCleartextTraffic="false"` prohibits unencrypted HTTP traffic.
- **Hardware Acceleration:** `android:hardwareAccelerated="true"` ensures 60 FPS neumorphic CSS shadow rendering.
- **Orientation & Viewport:** Standard responsive layout adapts seamlessly to portrait and landscape modes without restricted user zoom.
