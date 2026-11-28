"""Run after `flutter create`: release signing, desugaring (flutter_local_notifications) and SDK levels.

Signing uses the keystore from the ANDROID_KEYSTORE_B64 / ANDROID_KEYSTORE_PASSWORD secrets when present
(stable key: drivers can install updates over the old app); otherwise the build is a test build signed
with the debug key.
"""
import os, re, sys, pathlib

g = pathlib.Path("android/app/build.gradle.kts")
s = g.read_text()

if "isCoreLibraryDesugaringEnabled" not in s:
    s = re.sub(r"compileOptions\s*\{", "compileOptions {\n        isCoreLibraryDesugaringEnabled = true", s, count=1)
if "desugar_jdk_libs" not in s:
    s += '\ndependencies {\n    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")\n}\n'
s = re.sub(r"minSdk\s*=\s*[^\n]+", "minSdk = 24", s, count=1)
s = re.sub(r"compileSdk\s*=\s*[^\n]+", "compileSdk = 37", s, count=1)
s = re.sub(r"targetSdk\s*=\s*[^\n]+", "targetSdk = 36", s, count=1)

if os.environ.get("ANDROID_KEYSTORE_B64"):
    signing = '''
    signingConfigs {
        create("release") {
            storeFile = file("upload.jks")
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias = "soytutaxi"
            keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
        }
    }
'''
    s = re.sub(r"(android\s*\{)", r"\1" + signing, s, count=1)
    s = s.replace('signingConfig = signingConfigs.getByName("debug")', 'signingConfig = signingConfigs.getByName("release")')
    print("signing: release keystore")
else:
    print("signing: debug key (test build)")

g.write_text(s)
print(s[:2000] if "--show" in sys.argv else "patched build.gradle.kts")
