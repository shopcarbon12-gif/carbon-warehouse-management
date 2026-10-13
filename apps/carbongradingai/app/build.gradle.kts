import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

/** Dotted-only version (X.Y.Z). versionCode is derived — same scheme as the other Carbon apps. */
val appVersionName = "1.0.1"

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
    namespace = "com.shopcarbon.gradingai"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.shopcarbon.gradingai"
        // Galaxy Note10+ / Note10+ 5G end at Android 12 (API 31); S20+ / S20 Ultra at Android 13.
        minSdk = 31
        targetSdk = 35
        versionCode = computeVersionCode(appVersionName)
        versionName = appVersionName
        buildConfigField("String", "WMS_ORIGIN", "\"https://wms.shopcarbon.com\"")
    }

    buildFeatures {
        buildConfig = true
        compose = true
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
            // R8 drops the unused Compose icon set and library code: ~45 MB → a size the phone downloads quickly.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keyPropsFile.exists()) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
        // OutlineTest's picture folder: ./gradlew testDebugUnitTest -PgradingTestDir=/path
        unitTests.all { it.environment("GRADING_TEST_DIR", (project.findProperty("gradingTestDir") as String?) ?: "") }
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
    val composeBom = platform("androidx.compose:compose-bom:2025.01.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Depth: ARCore's raw depth uses the rear time-of-flight sensor on the supported Samsungs.
    implementation("com.google.ar:core:1.46.0")
    // Hang-tag barcode: Play services scanner (no camera permission or preview of our own).
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // Garment cut-out on the phone, and the care-label check.
    implementation("com.google.android.gms:play-services-mlkit-subject-segmentation:16.0.0-beta1")
    implementation("com.google.android.gms:play-services-mlkit-text-recognition:19.0.1")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in local unit tests; the real one parses the WMS config there.
    testImplementation("org.json:json:20240303")
}
