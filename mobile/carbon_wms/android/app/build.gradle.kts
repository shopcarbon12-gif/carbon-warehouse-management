import java.util.Properties

/**
 * Derive Android `versionCode` (monotonic integer Android compares for
 * upgrades) from the dotted Flutter `versionName` ("X.Y.Z" or "X.Y").
 *
 *   code = MAJOR * 1_000_000 + MINOR * 1_000 + PATCH
 *
 * Examples:
 *   "1.1.15" -> 1_001_015
 *   "1.1.16" -> 1_001_016
 *   "1.2.0"  -> 1_002_000
 *   "2.0.0"  -> 2_000_000
 *
 * Bumping any component (and never decreasing the others) keeps the code
 * strictly increasing. MINOR and PATCH each have room up to 999.
 *
 * Falls back to 1 if the version name doesn't parse as numeric — emits a
 * warning so a malformed pubspec is loud, not silent.
 */
fun computeVersionCode(versionName: String?): Int {
    val name = versionName?.trim().orEmpty()
    if (name.isEmpty()) {
        logger.warn("computeVersionCode: empty versionName, defaulting to 1")
        return 1
    }
    val parts = name.split('.')
    val major = parts.getOrNull(0)?.toIntOrNull()
    val minor = parts.getOrNull(1)?.toIntOrNull() ?: 0
    val patch = parts.getOrNull(2)?.toIntOrNull() ?: 0
    if (major == null) {
        logger.warn("computeVersionCode: cannot parse '$name' as X.Y.Z, defaulting to 1")
        return 1
    }
    if (minor < 0 || minor > 999 || patch < 0 || patch > 999) {
        logger.warn("computeVersionCode: minor/patch out of [0,999] in '$name', clamping")
    }
    val m = minor.coerceIn(0, 999)
    val p = patch.coerceIn(0, 999)
    val code = major * 1_000_000 + m * 1_000 + p
    logger.lifecycle("computeVersionCode: '$name' -> $code")
    return code
}

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val keyPropsFile = rootProject.file("key.properties")
val keyProps = Properties()
if (keyPropsFile.exists()) keyProps.load(keyPropsFile.inputStream())

android {
    namespace = "com.shopcarbon.wms"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.shopcarbon.wms"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // c72e (Chainway) ships API 27; Zebra API3 AAR minSdk is 24.
        minSdk = maxOf(flutter.minSdkVersion, 27)
        // Pinned to 31 (not flutter.targetSdkVersion which is 36) because the
        // bundled Zebra Scanner Control SDK (com.zebra.scannercontrol.SDKHandler)
        // calls Settings.Secure.getString("bluetooth_address") at init.
        // Android 12+ blocks that read for apps with targetSdk >= 32, throwing
        // SecurityException → barcode SDK setContext fails → RFD8500 imager
        // decodes never reach the app. Pinning to 31 keeps the legacy permission
        // path open. Cosmetic Android 13+ niceties (themed adaptive icon,
        // predictive back animation) are lost on the S25; functional behaviour
        // — including the Bin Assign barcode flow — works.
        targetSdk = 31
        // versionCode is derived from the dotted versionName (X.Y.Z) using
        //   code = X * 1_000_000 + Y * 1_000 + Z
        // so pubspec.yaml only needs `version: X.Y.Z` (no `+N` build counter).
        // Patch bumps push code up by 1, minor bumps cross a 1_000 boundary,
        // major bumps cross a 1_000_000 boundary — Android's monotonic-increase
        // requirement is satisfied as long as you only ever bump components,
        // never decrease them. Caps: minor < 1000, patch < 1000 (room to spare).
        versionCode = computeVersionCode(flutter.versionName)
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            storeFile = file(keyProps["storeFile"] as? String ?: "")
            storePassword = keyProps["storePassword"] as? String ?: ""
            keyAlias = keyProps["keyAlias"] as? String ?: ""
            keyPassword = keyProps["keyPassword"] as? String ?: ""
        }
    }

    // We sideload Carbon WMS to rugged handhelds (C72E + S25 + RFD8500); we
    // don't ship through Google Play, so the Play Store target-API policy
    // (ExpiredTargetSdkVersion ≥ 33) doesn't apply. We deliberately pin
    // targetSdk to 31 above so the bundled Zebra Scanner Control SDK can read
    // Settings.Secure.bluetooth_address — without that read, RFD8500 imager
    // decodes never reach the app on Android 12+. Suppress the lint here so
    // lintVitalRelease stops aborting the build over a non-applicable rule.
    lint {
        disable += "ExpiredTargetSdkVersion"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            // Zebra API3 AAR references optional Apache/SLF4J/BouncyCastle stacks; R8 fails if minify strips them.
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (keyPropsFile.exists()) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    // Zebra RFID API3 — AAR from ZebraDevs/RFID-Android-Inventory-Sample (see app/libs/THIRD_PARTY.txt).
    implementation(files("libs/API3_LIB-release-2.0.2.82.aar"))
    // Zebra API3 transitive dependency used at runtime by some builds.
    implementation("androidx.localbroadcastmanager:localbroadcastmanager:1.1.0")
    // Chainway DeviceAPI v20251103 — contains ScannerUtility for cooperative UHF eviction.
    implementation(files("libs/DeviceAPI_ver20251103_release.aar"))
    // Optional: drop additional Chainway JARs here.
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.jar"))))
}
