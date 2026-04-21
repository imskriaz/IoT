#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <SPI.h>

#define TFT_SCLK 39
#define TFT_MOSI 41
#define TFT_CS   45
#define TFT_DC   42
#define TFT_RST  1
#define TFT_BL   21  // 背光引脚

Adafruit_ST7789 tft = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_MOSI, TFT_SCLK, TFT_RST);

void setup(void) {
  Serial.begin(9600);
  tft.init(240, 280);  // 设置屏幕分辨率
  Serial.println(F("Initialized"));
  uint16_t time = millis();
  tft.fillScreen(ST77XX_BLACK);
  time = millis() - time;
  tftPrintTest();
}

void loop() {
  // 从高到低调整背光亮度
  for (int brightness = 100; brightness >= 0; brightness -= 5) {
    setBacklightBrightness(brightness);
    delay(50);  // 调整延迟时间以控制变化速度
  }

  // 从低到高调整背光亮度
  for (int brightness = 0; brightness <= 100; brightness += 5) {
    setBacklightBrightness(brightness);
    delay(50);  // 调整延迟时间以控制变化速度
  }
}

void setBacklightBrightness(int brightness) {
  // 将亮度值限制在0到100之间
  brightness = constrain(brightness, 0, 100);

  // 根据具体情况调整背光控制逻辑
  analogWrite(TFT_BL, brightness * 2.55);  // 映射到0-255的范围
}

void tftPrintTest() {
  tft.setTextWrap(false);
  tft.fillScreen(ST77XX_BLACK);
  
  // 设置文本起始位置
  tft.setCursor(0, 40);
  
  tft.setTextColor(ST77XX_RED);
  tft.setTextSize(1);
  tft.println("Hello World!");
  
  tft.setTextColor(ST77XX_YELLOW);
  tft.setTextSize(2);
  tft.println("Hello World!");
  
  tft.setTextColor(ST77XX_GREEN);
  tft.setTextSize(3);
  tft.println("Hello World!");
  
  tft.setTextColor(ST77XX_BLUE);
  tft.setTextSize(4);
  tft.print(1234.567);
}
