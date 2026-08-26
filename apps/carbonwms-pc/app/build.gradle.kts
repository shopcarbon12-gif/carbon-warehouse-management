import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/** Dotted-only version (X.Y.Z). versionCode is derived — same scheme as the handheld app. */
val appVersionName = "1.0.0"

fun computeVersionCode(versionName: String): Int {
    val parts = versionName.trim().split('.')
    val major = parts.getOrNull(0)?.toIntOrNull() ?: return 1
    val minor = (parts.getOrNull(1)?.toIntOrNull() ?: 0).coerceIn(0, 999)
    val patch = (parts.getOrNull(2)?.toIntOrNull() ?: 0).coerceIn(0, 999)
    return major * 1_000_000 + minor * 1_000 + patch
}

val keyPropsFile = rootProject.file("key.properties")
val keyProps = Properties().apply { if (keyPropsFile.exists()) load(keyPropsFile.inputStream()) }

android {
    namespace = "com.shopcarbon.wmspc"
    compileSdk = 35

    defaultConfig {
        // Identity derived from wmspc.shopcarbon.com (owner decision D4). Different from the
        // handheld app (com.shopcarbon.wms) so both install side by side.
        applicationId = "com.shopcarbon.wmspc"
        // Latest-Android-only build (owner decision): Android 13+ — Photo Picker, predictive back,
        // themed icons and edge-to-edge are all first-class from here.
        minSdk = 33
        targetSdk = 35
        versionCode = computeVersionCode(appVersionName)
        versionName = appVersionName

        // The server this shell mirrors. Overridable at runtime from the Diagnostics screen (LAN dev box).
        buildConfigField("String", "WMS_ORIGIN", "\"https://wms.shopcarbon.com\"")
        // Minimum Chromium major the web app supports (Next.js 16 browserslist: chrome 111).
        buildConfigField("int", "MIN_WEBVIEW_MAJOR", "111")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        create("release") {
            storeFile = (keyProps["storeFile"] as? String)?.takeIf { it.isNotBlank() }?.let { file(it) }
            storePassword = keyProps["storePassword"] as? String ?: ""
            keyAlias = keyProps["keyAlias"] as? String ?: ""
            keyPassword = keyProps["keyPassword"] as? String ?: ""
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            // Tiny app; keep the build deterministic and the JavascriptInterface surface untouched.
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (keyPropsFile.exists()) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
}
