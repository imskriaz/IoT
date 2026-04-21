#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <SD_MMC.h>
#include <esp_http_server.h>
#include <esp_camera.h>
#include <img_converters.h>
#include "config.h"

void batterySetSuspended(bool suspended);

static httpd_handle_t _cameraHttpd = nullptr;
static bool _cameraReady = false;
static bool _cameraServerStarted = false;
static esp_err_t _cameraInitErr = ESP_FAIL;
static uint32_t _cameraCaptureOk = 0;
static uint32_t _cameraCaptureFail = 0;
static uint32_t _cameraJpegOk = 0;
static uint32_t _cameraJpegFail = 0;
static uint32_t _cameraBmpOk = 0;
static uint32_t _cameraBmpFail = 0;
static uint32_t _cameraStreamSessions = 0;
static uint32_t _cameraStreamFrames = 0;
static uint32_t _cameraStreamFail = 0;
static bool _cameraSaveToSd = true;
static char _cameraLastSavePath[96] = "";

static camera_config_t _cameraMakeConfig() {
    camera_config_t config = {};
    config.ledc_channel = LEDC_CHANNEL_0;
    config.ledc_timer = LEDC_TIMER_0;
    config.pin_d0 = CAMERA_Y2_PIN;
    config.pin_d1 = CAMERA_Y3_PIN;
    config.pin_d2 = CAMERA_Y4_PIN;
    config.pin_d3 = CAMERA_Y5_PIN;
    config.pin_d4 = CAMERA_Y6_PIN;
    config.pin_d5 = CAMERA_Y7_PIN;
    config.pin_d6 = CAMERA_Y8_PIN;
    config.pin_d7 = CAMERA_Y9_PIN;
    config.pin_xclk = CAMERA_XCLK_PIN;
    config.pin_pclk = CAMERA_PCLK_PIN;
    config.pin_vsync = CAMERA_VSYNC_PIN;
    config.pin_href = CAMERA_HREF_PIN;
    config.pin_sccb_sda = CAMERA_SIOD_PIN;
    config.pin_sccb_scl = CAMERA_SIOC_PIN;
    config.pin_pwdn = CAMERA_PWDN_PIN;
    config.pin_reset = CAMERA_RESET_PIN;
    config.xclk_freq_hz = 20000000;
    config.frame_size = FRAMESIZE_QQVGA;
    config.pixel_format = PIXFORMAT_RGB565;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.jpeg_quality = 12;
    config.fb_count = 1;
    return config;
}

static camera_fb_t* _cameraCaptureFrame() {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        ++_cameraCaptureFail;
        return nullptr;
    }
    ++_cameraCaptureOk;
    return fb;
}

static bool _cameraSaveBufferToSd(const char* ext, const uint8_t* data, size_t len) {
    if (!_cameraSaveToSd || !ext || !data || len == 0) return false;
    if (SD_MMC.cardType() == CARD_NONE) return false;

    if (!SD_MMC.exists("/camera")) {
        SD_MMC.mkdir("/camera");
    }

    char path[96];
    snprintf(path, sizeof(path), "/camera/cap-%010lu-%06lu.%s",
             (unsigned long)(millis() / 1000UL),
             (unsigned long)(_cameraCaptureOk + _cameraStreamFrames),
             ext);
    File file = SD_MMC.open(path, FILE_WRITE);
    if (!file) return false;
    size_t written = file.write(data, len);
    file.close();
    if (written != len) return false;

    strncpy(_cameraLastSavePath, path, sizeof(_cameraLastSavePath) - 1);
    _cameraLastSavePath[sizeof(_cameraLastSavePath) - 1] = '\0';
    return true;
}

static void _cameraBuildStatusJson(char* out, size_t outLen) {
    snprintf(out, outLen,
             "{"
               "\"ready\":%s,"
               "\"serverStarted\":%s,"
               "\"initError\":\"0x%08lx\","
               "\"port\":%d,"
               "\"pixelFormat\":\"RGB565\","
               "\"frameSize\":\"QQVGA\","
               "\"fbLocation\":\"%s\","
               "\"saveToSd\":%s,"
               "\"lastSavePath\":\"%s\","
               "\"captures\":%lu,"
               "\"captureFail\":%lu,"
               "\"jpegOk\":%lu,"
               "\"jpegFail\":%lu,"
               "\"bmpOk\":%lu,"
               "\"bmpFail\":%lu,"
               "\"streamSessions\":%lu,"
               "\"streamFrames\":%lu,"
               "\"streamFail\":%lu"
             "}",
             _cameraReady ? "true" : "false",
             _cameraServerStarted ? "true" : "false",
             (unsigned long)_cameraInitErr,
             CAMERA_HTTP_PORT,
             "dram",
             _cameraSaveToSd ? "true" : "false",
             _cameraLastSavePath,
             (unsigned long)_cameraCaptureOk,
             (unsigned long)_cameraCaptureFail,
             (unsigned long)_cameraJpegOk,
             (unsigned long)_cameraJpegFail,
             (unsigned long)_cameraBmpOk,
             (unsigned long)_cameraBmpFail,
             (unsigned long)_cameraStreamSessions,
             (unsigned long)_cameraStreamFrames,
             (unsigned long)_cameraStreamFail);
}

static esp_err_t _cameraIndexHandler(httpd_req_t* req) {
    const char* html =
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>ESP32 Camera</title>"
        "<style>"
        "body{font-family:system-ui;margin:24px;background:#101418;color:#eef3f7;}"
        "a{color:#7dd3fc} img{max-width:100%;border-radius:12px;background:#1a232c}"
        ".row{display:flex;gap:16px;flex-wrap:wrap}.card{background:#17212b;padding:16px;border-radius:14px;flex:1;min-width:280px}"
        "button{padding:10px 14px;border:none;border-radius:999px;background:#38bdf8;color:#04131c;font-weight:700;cursor:pointer}"
        "code{color:#93c5fd}"
        "</style></head><body>"
        "<h1>ESP32 Camera Service</h1>"
        "<p>Main-firmware path: <code>RGB565 / QQVGA / DRAM</code></p>"
        "<p>Saved snapshots go to <code>/camera</code> on the SD card when mounted.</p>"
        "<div class='row'>"
        "<div class='card'><h2>Status</h2><pre id='status'>loading...</pre><button onclick='loadStatus()'>Refresh</button></div>"
        "<div class='card'><h2>Snapshot</h2><p><a href='/capture.jpg' target='_blank'>JPEG</a> | <a href='/capture.bmp' target='_blank'>BMP</a></p><img id='shot' src='/capture.jpg' alt='snapshot'></div>"
        "<div class='card'><h2>Stream</h2><p><a href='/stream' target='_blank'>Open stream directly</a></p><img src='/stream' alt='stream'></div>"
        "</div>"
        "<script>async function loadStatus(){const r=await fetch('/status');document.getElementById('status').textContent=JSON.stringify(await r.json(),null,2);}loadStatus();</script>"
        "</body></html>";
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, html, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t _cameraStatusHandler(httpd_req_t* req) {
    char json[320];
    _cameraBuildStatusJson(json, sizeof(json));
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t _cameraJpegHandler(httpd_req_t* req) {
    camera_fb_t* fb = _cameraCaptureFrame();
    if (!fb) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "capture failed");
    }

    uint8_t* jpgBuf = nullptr;
    size_t jpgLen = 0;
    bool ok = frame2jpg(fb, 80, &jpgBuf, &jpgLen);
    esp_camera_fb_return(fb);

    if (!ok || !jpgBuf || !jpgLen) {
        ++_cameraJpegFail;
        if (jpgBuf) free(jpgBuf);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "jpeg conversion failed");
    }

    ++_cameraJpegOk;
    _cameraSaveBufferToSd("jpg", jpgBuf, jpgLen);
    httpd_resp_set_type(req, "image/jpeg");
    esp_err_t err = httpd_resp_send(req, (const char*)jpgBuf, jpgLen);
    free(jpgBuf);
    return err;
}

static esp_err_t _cameraBmpHandler(httpd_req_t* req) {
    camera_fb_t* fb = _cameraCaptureFrame();
    if (!fb) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "capture failed");
    }

    uint8_t* bmpBuf = nullptr;
    size_t bmpLen = 0;
    bool ok = frame2bmp(fb, &bmpBuf, &bmpLen);
    esp_camera_fb_return(fb);

    if (!ok || !bmpBuf || !bmpLen) {
        ++_cameraBmpFail;
        if (bmpBuf) free(bmpBuf);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "bmp conversion failed");
    }

    ++_cameraBmpOk;
    _cameraSaveBufferToSd("bmp", bmpBuf, bmpLen);
    httpd_resp_set_type(req, "image/bmp");
    esp_err_t err = httpd_resp_send(req, (const char*)bmpBuf, bmpLen);
    free(bmpBuf);
    return err;
}

static esp_err_t _cameraStreamHandler(httpd_req_t* req) {
    static const char* kBoundary = "frame";
    static const char* kContentType = "multipart/x-mixed-replace; boundary=frame";

    ++_cameraStreamSessions;
    httpd_resp_set_type(req, kContentType);
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    httpd_resp_set_hdr(req, "Pragma", "no-cache");

    const uint32_t started = millis();
    uint32_t sent = 0;
    while (millis() - started < 15000UL) {
        camera_fb_t* fb = _cameraCaptureFrame();
        if (!fb) {
            ++_cameraStreamFail;
            delay(60);
            continue;
        }

        uint8_t* jpgBuf = nullptr;
        size_t jpgLen = 0;
        bool ok = frame2jpg(fb, 70, &jpgBuf, &jpgLen);
        esp_camera_fb_return(fb);

        if (!ok || !jpgBuf || !jpgLen) {
            ++_cameraJpegFail;
            ++_cameraStreamFail;
            if (jpgBuf) free(jpgBuf);
            delay(60);
            continue;
        }

        ++_cameraJpegOk;
        ++_cameraStreamFrames;
        ++sent;

        char part[96];
        int partLen = snprintf(part, sizeof(part),
                               "--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
                               kBoundary, (unsigned int)jpgLen);
        if (httpd_resp_send_chunk(req, part, partLen) != ESP_OK ||
            httpd_resp_send_chunk(req, (const char*)jpgBuf, jpgLen) != ESP_OK ||
            httpd_resp_send_chunk(req, "\r\n", 2) != ESP_OK) {
            free(jpgBuf);
            break;
        }
        free(jpgBuf);
        delay(80);
    }

    httpd_resp_send_chunk(req, nullptr, 0);
    Serial.printf("[CAM] stream end frames=%u sessions=%u totalFrames=%u fail=%u\n",
                  (unsigned int)sent,
                  (unsigned int)_cameraStreamSessions,
                  (unsigned int)_cameraStreamFrames,
                  (unsigned int)_cameraStreamFail);
    return ESP_OK;
}

static bool cameraServiceInitHardware() {
    if (_cameraReady) return true;
    batterySetSuspended(true);
    camera_config_t config = _cameraMakeConfig();
    delay(1000);
    _cameraInitErr = esp_camera_init(&config);
    if (_cameraInitErr != ESP_OK) {
        delay(400);
        _cameraInitErr = esp_camera_init(&config);
    }
    if (_cameraInitErr != ESP_OK) {
        batterySetSuspended(false);
        Serial.printf("[CAM] init failed err=0x%08lx\n", (unsigned long)_cameraInitErr);
        return false;
    }

    sensor_t* sensor = esp_camera_sensor_get();
    if (sensor) {
        Serial.printf("[CAM] sensor pid=0x%02x\n", sensor->id.PID);
    }

    camera_fb_t* probe = esp_camera_fb_get();
    if (!probe) {
        _cameraInitErr = ESP_FAIL;
        batterySetSuspended(false);
        Serial.println("[CAM] probe capture failed");
        return false;
    }
    Serial.printf("[CAM] probe ok len=%u w=%u h=%u fmt=%d\n",
                  (unsigned int)probe->len,
                  (unsigned int)probe->width,
                  (unsigned int)probe->height,
                  (int)probe->format);
    esp_camera_fb_return(probe);

    _cameraReady = true;
    return true;
}

static bool cameraServiceStartServer() {
    if (!_cameraReady) return false;
    if (_cameraServerStarted && _cameraHttpd) return true;

    httpd_config_t httpConfig = HTTPD_DEFAULT_CONFIG();
    httpConfig.server_port = CAMERA_HTTP_PORT;
    httpConfig.ctrl_port = CAMERA_HTTP_PORT + 1;
    httpConfig.stack_size = 10240;
    httpConfig.max_uri_handlers = 8;

    if (httpd_start(&_cameraHttpd, &httpConfig) != ESP_OK) {
        batterySetSuspended(false);
        Serial.printf("[CAM] http server start failed on port %d\n", CAMERA_HTTP_PORT);
        _cameraHttpd = nullptr;
        return false;
    }

    httpd_uri_t indexUri = { .uri = "/", .method = HTTP_GET, .handler = _cameraIndexHandler, .user_ctx = nullptr };
    httpd_uri_t statusUri = { .uri = "/status", .method = HTTP_GET, .handler = _cameraStatusHandler, .user_ctx = nullptr };
    httpd_uri_t jpgUri = { .uri = "/capture.jpg", .method = HTTP_GET, .handler = _cameraJpegHandler, .user_ctx = nullptr };
    httpd_uri_t bmpUri = { .uri = "/capture.bmp", .method = HTTP_GET, .handler = _cameraBmpHandler, .user_ctx = nullptr };
    httpd_uri_t streamUri = { .uri = "/stream", .method = HTTP_GET, .handler = _cameraStreamHandler, .user_ctx = nullptr };

    httpd_register_uri_handler(_cameraHttpd, &indexUri);
    httpd_register_uri_handler(_cameraHttpd, &statusUri);
    httpd_register_uri_handler(_cameraHttpd, &jpgUri);
    httpd_register_uri_handler(_cameraHttpd, &bmpUri);
    httpd_register_uri_handler(_cameraHttpd, &streamUri);

    _cameraServerStarted = true;
    Serial.printf("[CAM] service ready on port %d\n", CAMERA_HTTP_PORT);
    return true;
}

static bool cameraServiceBegin() {
    if (!cameraServiceInitHardware()) return false;
    return cameraServiceStartServer();
}

static bool cameraServiceReady() {
    return _cameraReady;
}

static uint16_t cameraServicePort() {
    return CAMERA_HTTP_PORT;
}
