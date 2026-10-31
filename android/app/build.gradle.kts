import javax.inject.Inject

plugins {
    id("com.android.application")
}

android {
    namespace = "com.pocketdeck.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.pocketdeck.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 2026102500
        versionName = "1.0.0"
    }

    // Release signing key comes from environment variables (GitHub secrets in CI); never stored in the repo.
    val keystorePath = System.getenv("PD_KEYSTORE")
    val hasReleaseKey = !keystorePath.isNullOrBlank() && file(keystorePath).exists()
    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = System.getenv("PD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("PD_KEY_ALIAS")
                keyPassword = System.getenv("PD_KEY_PASSWORD")
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without the release key (e.g. local builds) fall back to the debug key so the APK still installs.
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// Bundle the shared companion web UI (../../companion) into the app as assets/www.
abstract class CopyCompanion : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val source: DirectoryProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(source)
            into(output.dir("www"))
        }
    }
}

val copyCompanion = tasks.register<CopyCompanion>("copyCompanion") {
    source.set(rootProject.layout.projectDirectory.dir("../companion"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyCompanion, CopyCompanion::output)
    }
}
