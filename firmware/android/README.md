# IoT Android SMS Bridge

Native sideload test app for using an Android phone as an MQTT SMS device.

First-version scope:

- subscribe to `device/{deviceId}/command/#` and `device/{deviceId}/cmd/#`
- send SMS for `send-sms` / `send_sms`
- receive inbound SMS through `SMS_RECEIVED`
- publish `device/{deviceId}/sms/incoming`
- publish firmware-compatible `device/{deviceId}/action/result`
- keep `READ_SMS` scoped to the in-app threaded SMS view and avoid default-SMS role

Build:

The Android app reads MQTT defaults from `../../dashboard/.env` at build time and bakes them into the APK as the initial broker settings.

```powershell
$env:JAVA_HOME="D:\Dev\Java\jdk-21.0.10+7"
$env:ANDROID_HOME="D:\Dev\Android\Sdk"
$env:ANDROID_SDK_ROOT="D:\Dev\Android\Sdk"
$env:Path="D:\Dev\Java\jdk-21.0.10+7\bin;D:\Dev\Gradle\gradle-9.4.1\bin;D:\Dev\Android\Sdk\cmdline-tools\latest\bin;D:\Dev\Android\Sdk\platform-tools;$env:Path"
.\gradlew.bat :app:assembleRelease
```

Install to a real phone:

```powershell
.\install-apk.ps1
```

Run those commands from `firmware/android`. The default installer builds the signed release APK, chooses the APK matching the connected phone CPU ABI, and prints a clear diagnostic if `adb` sees no device, an `offline` device, or an `unauthorized` device.

Useful install options:

```powershell
.\install-apk.ps1 -Serial <adb-serial>
.\install-apk.ps1 -Clean
```

Use `-Clean` only when Android reports a signature mismatch from a previously installed APK; it uninstalls `com.devicebridge.android` before reinstalling. Then open the app, verify the env-backed MQTT settings, request SMS permissions, and start the bridge.

Related docs:

- [Android Device Bridge contract](/d:/Projects/IoT/firmware/android/docs/ANDROID_SMS_BRIDGE.md)
