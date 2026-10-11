import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Secret Google Calendar iCal address: lives only in the ignored local.properties.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val icalUrl: String = localProps.getProperty("ICAL_URL", "").trim()
val photoAssetsDir = layout.buildDirectory.dir("generated/photo-assets")

android {
    namespace = "com.pearboard.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pearboard.tv"
        minSdk = 25 // Fire OS 6
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        val escaped = icalUrl.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "ICAL_URL", "\"$escaped\"")
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(photoAssetsDir)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// Optional clock background: android-board/photo.jpg → assets/web/photo.jpg.
val copyPhoto by tasks.registering(Sync::class) {
    from(rootProject.file("photo.jpg"))
    into(photoAssetsDir.map { it.dir("web") })
}
tasks.named("preBuild") { dependsOn(copyPhoto) }

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
