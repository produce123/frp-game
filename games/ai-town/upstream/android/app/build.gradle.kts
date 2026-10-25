import java.util.Properties

plugins {
    id("com.android.application")
}

// 签名信息放在被忽略的 keystore.properties；没有时用调试签名（只能自己装）。
val signing = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.aitown.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.aitown.app"
        minSdk = 26
        targetSdk = 35
        versionCode = (project.findProperty("townVersionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("townVersionName") as String?) ?: "0.1.0"
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    signingConfigs {
        if (signing.containsKey("storeFile")) {
            create("release") {
                storeFile = rootProject.file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    // 两个 Rust 程序以 lib*.so 的名字放进 jniLibs，安装时解压到 nativeLibraryDir 才能执行。
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
