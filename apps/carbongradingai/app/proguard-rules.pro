# CarbonGradingAI release shrinking. ARCore and ML Kit ship their own consumer rules; these keeps are
# belt and braces, because neither can be exercised on the build host before a release.
-keep class com.google.ar.core.** { *; }
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_** { *; }
-dontwarn com.google.ar.core.**
-dontwarn com.google.mlkit.**
# WorkManager creates the upload worker by name.
-keep class com.shopcarbon.gradingai.sync.UploadWorker { <init>(...); }
# okhttp / okio optional platform classes
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
