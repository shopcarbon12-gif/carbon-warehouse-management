import com.android.build.gradle.LibraryExtension
import org.gradle.api.JavaVersion

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// install_plugin 2.1.0: no namespace, compileSdk 28 + Java 8 vs app Kotlin 17 — patch in-tree only.
subprojects {
    afterEvaluate {
        if (project.name != "install_plugin") return@afterEvaluate
        extensions.findByType(LibraryExtension::class.java)?.apply {
            if (namespace == null || namespace!!.isEmpty()) {
                namespace = "com.example.installplugin"
            }
            compileSdk = 35
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_17
                targetCompatibility = JavaVersion.VERSION_17
            }
        }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
