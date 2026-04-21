#include <Wire.h>

#define MAX17048_I2C_ADDRESS 0x36

void setup() {
  Wire.begin(3, 2);
  Serial.begin(9600);
}

void loop() {
  Wire.beginTransmission(MAX17048_I2C_ADDRESS);
  Wire.write(0x02);
  Wire.endTransmission();

  Wire.requestFrom(MAX17048_I2C_ADDRESS, 2);
  uint16_t soc = (Wire.read() << 8) | Wire.read();

  if (soc > 65535) {
    soc = 65535;
  }

  float batteryLevel = (float)soc / 65535.0 * 5;

  Serial.print("Battery Level: ");
  Serial.print(batteryLevel);
  Serial.println("%");

  delay(1000);
}
