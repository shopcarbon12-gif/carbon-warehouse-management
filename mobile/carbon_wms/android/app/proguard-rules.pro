# Zebra RFID API3 (fat AAR) — optional transitive references not shipped in the app.
-dontwarn org.apache.**
-dontwarn org.slf4j.**
-dontwarn org.bouncycastle.**
-dontwarn org.ietf.jgss.**
-dontwarn com.zebra.scannercontrol.**
-dontwarn org.llrp.**
-keep class com.zebra.rfid.api3.** { *; }
