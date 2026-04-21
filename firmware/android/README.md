# IoT Android SMS Bridge

Native sideload test app for using an Android phone as an MQTT SMS device.

First-version scope:

- subscribe to `device/{deviceId}/command/#` and `device/{deviceId}/cmd/#`
- send SMS for `send-sms` / `send_sms`
- receive inbound SMS through `SMS_RECEIVED`
- publish `device/{deviceId}/sms/incoming`
- publish firmware-compatible `device/{deviceId}/action/result`
- avoid `READ_SMS` and default-SMS role

Build:

The Android app reads MQTT defaults from `../../dashboard/.env` at build time and bakes them into the APK as the initial broker settings.

```powershell
$env:JAVA_HOME="D:\Dev\Java\jdk-21.0.10+7"
$env:ANDROID_HOME="D:\Dev\Android\Sdk"
$env:ANDROID_SDK_ROOT="D:\Dev\Android\Sdk"
$env:Path="D:\Dev\Java\jdk-21.0.10+7\bin;D:\Dev\Gradle\gradle-9.4.1\bin;D:\Dev\Android\Sdk\cmdline-tools\latest\bin;D:\Dev\Android\Sdk\platform-tools;$env:Path"
gradle :app:assembleDebug
```

Install to a real phone:

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

Run those commands from `firmware/android`. Then open the app, verify the env-backed MQTT settings, request SMS permissions, and start the bridge.
