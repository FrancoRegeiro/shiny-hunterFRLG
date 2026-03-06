/**
 * ESP32-S3 Switch Pro Controller Emulator
 *
 * Emulates a Pokken Tournament DX Pro Pad via USB HID.
 * Overrides weak TinyUSB callbacks to exactly match real controller descriptors.
 *
 * Hardware setup (ESP32-S3-DevKitC-1):
 *   - "USB" port (native, GPIO 19/20) → Switch dock (HID gamepad)
 *   - "COM" port (UART bridge)        → Mac (serial commands)
 */

#include "USB.h"
#include "USBHID.h"
#include "class/hid/hid_device.h"

// ── Override weak TinyUSB descriptor callbacks ────────────────────────
// The Arduino ESP32 HAL always adds BOS (WebUSB + MS OS 2.0) descriptors
// and always sets iSerialNumber=3 with the chip MAC. Real Pokken controllers
// don't have these, and the Switch may reject devices with unexpected descriptors.

// Device descriptor — override to set iSerialNumber=0 (no serial, like real controller)
static const tusb_desc_device_t custom_device_descriptor = {
  .bLength            = sizeof(tusb_desc_device_t),
  .bDescriptorType    = TUSB_DESC_DEVICE,
  .bcdUSB             = 0x0200,       // USB 2.0 (no BOS needed)
  .bDeviceClass       = 0x00,
  .bDeviceSubClass    = 0x00,
  .bDeviceProtocol    = 0x00,
  .bMaxPacketSize0    = 64,
  .idVendor           = 0x0F0D,       // Hori
  .idProduct          = 0x0092,       // Pokken Tournament DX Pro Pad
  .bcdDevice          = 0x0100,
  .iManufacturer      = 0x01,
  .iProduct           = 0x02,
  .iSerialNumber      = 0x00,         // No serial number (like real controller)
  .bNumConfigurations = 0x01
};

extern "C" const uint8_t* tud_descriptor_device_cb(void) {
  return (const uint8_t*)&custom_device_descriptor;
}

// Note: BOS descriptor cannot be overridden due to linker constraints.
// The Arduino HAL always includes WebUSB/MSOS2 in BOS, but since bcdUSB=0x0200,
// the Switch host should not request BOS descriptors.

// ── HID Report Descriptor (exact Pokken Tournament DX Pro Pad) ────────
// Must match exactly — Switch has a hardcoded driver for this VID/PID
static const uint8_t switchReportDescriptor[] = {
  0x05, 0x01,        // Usage Page (Generic Desktop)
  0x09, 0x05,        // Usage (Game Pad)
  0xA1, 0x01,        // Collection (Application)
  0x15, 0x00,        //   Logical Minimum (0)
  0x25, 0x01,        //   Logical Maximum (1)
  0x35, 0x00,        //   Physical Minimum (0)
  0x45, 0x01,        //   Physical Maximum (1)
  0x75, 0x01,        //   Report Size (1)
  0x95, 0x10,        //   Report Count (16)
  0x05, 0x09,        //   Usage Page (Button)
  0x19, 0x01,        //   Usage Minimum (1)
  0x29, 0x10,        //   Usage Maximum (16)
  0x81, 0x02,        //   Input (Data, Var, Abs)
  0x05, 0x01,        //   Usage Page (Generic Desktop)
  0x25, 0x07,        //   Logical Maximum (7)
  0x46, 0x3B, 0x01,  //   Physical Maximum (315)
  0x75, 0x04,        //   Report Size (4)
  0x95, 0x01,        //   Report Count (1)
  0x65, 0x14,        //   Unit (Eng Rot: Degree)
  0x09, 0x39,        //   Usage (Hat Switch)
  0x81, 0x42,        //   Input (Data, Var, Abs, Null)
  0x65, 0x00,        //   Unit (None)
  0x95, 0x01,        //   Report Count (1)
  0x81, 0x01,        //   Input (Const) — 4-bit padding
  0x26, 0xFF, 0x00,  //   Logical Maximum (255)
  0x46, 0xFF, 0x00,  //   Physical Maximum (255)
  0x09, 0x30,        //   Usage (X)
  0x09, 0x31,        //   Usage (Y)
  0x09, 0x32,        //   Usage (Z)
  0x09, 0x35,        //   Usage (Rz)
  0x75, 0x08,        //   Report Size (8)
  0x95, 0x04,        //   Report Count (4)
  0x81, 0x02,        //   Input (Data, Var, Abs)
  // Vendor-specific byte (required by real Pokken pad — makes input 8 bytes)
  0x06, 0x00, 0xFF,  //   Usage Page (Vendor Defined 0xFF00)
  0x09, 0x20,        //   Usage (0x20)
  0x95, 0x01,        //   Report Count (1)
  0x81, 0x02,        //   Input (Data, Var, Abs)
  // Output report (8 bytes, for rumble/LEDs)
  0x0A, 0x21, 0x26,  //   Usage (0x2621)
  0x95, 0x08,        //   Report Count (8)
  0x91, 0x02,        //   Output (Data, Var, Abs)
  0xC0               // End Collection
};

// ── HID Report Structure ──────────────────────────────────────────────

typedef struct __attribute__((packed)) {
  uint16_t buttons;
  uint8_t hat;
  uint8_t lx;
  uint8_t ly;
  uint8_t rx;
  uint8_t ry;
  uint8_t vendor;  // Vendor-specific byte (always 0)
} SwitchReport;

#define BTN_Y       0x0001
#define BTN_B       0x0002
#define BTN_A       0x0004
#define BTN_X       0x0008
#define BTN_L       0x0010
#define BTN_R       0x0020
#define BTN_ZL      0x0040
#define BTN_ZR      0x0080
#define BTN_MINUS   0x0100
#define BTN_PLUS    0x0200
#define BTN_LSTICK  0x0400
#define BTN_RSTICK  0x0800
#define BTN_HOME    0x1000
#define BTN_CAPTURE 0x2000

#define HAT_UP        0x00
#define HAT_UPRIGHT   0x01
#define HAT_RIGHT     0x02
#define HAT_DOWNRIGHT 0x03
#define HAT_DOWN      0x04
#define HAT_DOWNLEFT  0x05
#define HAT_LEFT      0x06
#define HAT_UPLEFT    0x07
#define HAT_CENTER    0x08

// ── Controller class ──────────────────────────────────────────────────

class SwitchController : public USBHIDDevice {
public:
  SwitchController() {
    static bool initialized = false;
    if (!initialized) {
      initialized = true;
      memset(&report, 0, sizeof(report));
      report.hat = HAT_CENTER;
      report.lx = 128;
      report.ly = 128;
      report.rx = 128;
      report.ry = 128;
    }
  }

  void begin() {
    hid.addDevice(this, sizeof(switchReportDescriptor));
    hid.begin();
    // VID/PID set via custom_device_descriptor override above
    USB.productName("POKKEN CONTROLLER");
    USB.manufacturerName("HORI CO.,LTD.");
    USB.usbClass(0);
    USB.usbSubClass(0);
    USB.usbProtocol(0);
    USB.webUSB(false);
    USB.begin();
  }

  uint16_t _onGetDescriptor(uint8_t* buffer) {
    memcpy(buffer, switchReportDescriptor, sizeof(switchReportDescriptor));
    return sizeof(switchReportDescriptor);
  }

  void sendReport() {
    hid.SendReport(0, (uint8_t*)&report, sizeof(report));
  }

  void pressButton(uint16_t btn) {
    report.buttons |= btn;
    sendReport();
  }

  void releaseButton(uint16_t btn) {
    report.buttons &= ~btn;
    sendReport();
  }

  void setHat(uint8_t hat) {
    report.hat = hat;
    sendReport();
  }

  void releaseAll() {
    report.buttons = 0;
    report.hat = HAT_CENTER;
    report.lx = 128;
    report.ly = 128;
    report.rx = 128;
    report.ry = 128;
    sendReport();
  }

  SwitchReport report;
  USBHID hid;
};

SwitchController controller;

// ── Button/Hat mapping ────────────────────────────────────────────────

uint16_t getButtonBit(const char* name) {
  if (strcmp(name, "A") == 0) return BTN_A;
  if (strcmp(name, "B") == 0) return BTN_B;
  if (strcmp(name, "X") == 0) return BTN_X;
  if (strcmp(name, "Y") == 0) return BTN_Y;
  if (strcmp(name, "L") == 0) return BTN_L;
  if (strcmp(name, "R") == 0) return BTN_R;
  if (strcmp(name, "ZL") == 0) return BTN_ZL;
  if (strcmp(name, "ZR") == 0) return BTN_ZR;
  if (strcmp(name, "PLUS") == 0) return BTN_PLUS;
  if (strcmp(name, "START") == 0) return BTN_PLUS;
  if (strcmp(name, "MINUS") == 0) return BTN_MINUS;
  if (strcmp(name, "SELECT") == 0) return BTN_MINUS;
  if (strcmp(name, "HOME") == 0) return BTN_HOME;
  if (strcmp(name, "CAPTURE") == 0) return BTN_CAPTURE;
  if (strcmp(name, "LSTICK") == 0) return BTN_LSTICK;
  if (strcmp(name, "RSTICK") == 0) return BTN_RSTICK;
  return 0;
}

int8_t getHatValue(const char* name) {
  if (strcmp(name, "UP") == 0) return HAT_UP;
  if (strcmp(name, "DOWN") == 0) return HAT_DOWN;
  if (strcmp(name, "LEFT") == 0) return HAT_LEFT;
  if (strcmp(name, "RIGHT") == 0) return HAT_RIGHT;
  return -1;
}

// ── Command processing ────────────────────────────────────────────────

String inputBuffer = "";

void processCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  int spaceIdx = cmd.indexOf(' ');
  String action = (spaceIdx > 0) ? cmd.substring(0, spaceIdx) : cmd;
  String args = (spaceIdx > 0) ? cmd.substring(spaceIdx + 1) : "";
  action.toUpperCase();
  args.trim();

  if (action == "PING") {
    Serial.println("PONG");
    return;
  }

  if (action == "STATUS") {
    Serial.print("HID_READY=");
    Serial.println(controller.hid.ready() ? "true" : "false");
    return;
  }

  if (action == "RELEASE_ALL") {
    controller.releaseAll();
    Serial.println("OK");
    return;
  }

  if (action == "PRESS") {
    int spaceIdx2 = args.indexOf(' ');
    String btnName = (spaceIdx2 > 0) ? args.substring(0, spaceIdx2) : args;
    int durationMs = (spaceIdx2 > 0) ? args.substring(spaceIdx2 + 1).toInt() : 100;
    btnName.toUpperCase();

    int8_t hat = getHatValue(btnName.c_str());
    if (hat >= 0) {
      controller.setHat(hat);
      delay(durationMs);
      controller.setHat(HAT_CENTER);
      Serial.println("OK");
      return;
    }

    uint16_t btn = getButtonBit(btnName.c_str());
    if (btn) {
      controller.pressButton(btn);
      delay(durationMs);
      controller.releaseButton(btn);
      Serial.println("OK");
      return;
    }

    Serial.println("ERR unknown button: " + btnName);
    return;
  }

  if (action == "HOLD") {
    String btnName = args;
    btnName.toUpperCase();

    int8_t hat = getHatValue(btnName.c_str());
    if (hat >= 0) {
      controller.setHat(hat);
      Serial.println("OK");
      return;
    }

    uint16_t btn = getButtonBit(btnName.c_str());
    if (btn) {
      controller.pressButton(btn);
      Serial.println("OK");
      return;
    }

    Serial.println("ERR unknown button: " + btnName);
    return;
  }

  if (action == "RELEASE") {
    String btnName = args;
    btnName.toUpperCase();

    int8_t hat = getHatValue(btnName.c_str());
    if (hat >= 0) {
      controller.setHat(HAT_CENTER);
      Serial.println("OK");
      return;
    }

    uint16_t btn = getButtonBit(btnName.c_str());
    if (btn) {
      controller.releaseButton(btn);
      Serial.println("OK");
      return;
    }

    Serial.println("ERR unknown button: " + btnName);
    return;
  }

  if (action == "RESET") {
    // NSO soft reset: hold A+B+X+Y simultaneously for 1 second
    controller.pressButton(BTN_A | BTN_B | BTN_X | BTN_Y);
    delay(1000);
    controller.releaseButton(BTN_A | BTN_B | BTN_X | BTN_Y);
    Serial.println("OK");
    return;
  }

  Serial.println("ERR unknown command: " + action);
}

// ── Main ──────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);
  controller.begin();
  delay(1000);
  controller.releaseAll();
  Serial.println("READY");
}

void loop() {
  // Report USB state via HID ready check
  static bool lastReady = false;
  bool ready = controller.hid.ready();
  if (ready != lastReady) {
    Serial.println(ready ? "STATE:HID_READY" : "STATE:HID_NOT_READY");
    lastReady = ready;
  }

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inputBuffer.length() > 0) {
        processCommand(inputBuffer);
        inputBuffer = "";
      }
    } else {
      inputBuffer += c;
    }
  }

  static unsigned long lastReport = 0;
  if (millis() - lastReport > 100) {
    controller.sendReport();
    lastReport = millis();
  }
}
