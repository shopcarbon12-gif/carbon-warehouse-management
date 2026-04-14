import java.util.Properties

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
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
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
    // Optional: drop Chainway DeviceAPI JAR/AAR here; reflection bridge loads at runtime.
    implementation(fileTree(mapOf("dir" to "libs", "include" to listOf("*.jar"))))
}
