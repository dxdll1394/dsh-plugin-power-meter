/*
 * Minimal read-only AppleSMC client for the DSH power meter.
 *
 * Only two undocumented keys are read, both `flt ` typed and both in watts:
 *   PDTR — power drawn from the external supply (DC in)
 *   PSTR — total system load
 *
 * The key layout mirrors Apple's SMCKeyData; getting it wrong shifts every
 * field and makes the read return a bogus type, so the fields below are the
 * whole point of this file.
 *
 * Build: cc -O2 -o smc-read smc.c -framework IOKit
 */
#include <IOKit/IOKitLib.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define SMC_USER_CLIENT 2
#define SMC_CMD_READ_BYTES 5
#define SMC_CMD_READ_KEY_INFO 9

typedef struct { char major, minor, build, reserved[1]; uint16_t release; } SmcVersion;
typedef struct { uint16_t version, length; uint32_t cpuPLimit, gpuPLimit, memPLimit; } SmcPowerLimit;
typedef struct { uint32_t dataSize, dataType; char dataAttributes; } SmcKeyInfo;
typedef char SmcBytes[32];
typedef struct {
  uint32_t key;
  SmcVersion version;
  SmcPowerLimit powerLimitData;
  SmcKeyInfo keyInfo;
  char result, status, data8;
  uint32_t data32;
  SmcBytes bytes;
} SmcKeyData;

static io_connect_t connection = IO_OBJECT_NULL;

static uint32_t fourCC(const char *value) {
  return ((uint32_t)(uint8_t)value[0] << 24) | ((uint32_t)(uint8_t)value[1] << 16) |
         ((uint32_t)(uint8_t)value[2] << 8) | (uint32_t)(uint8_t)value[3];
}

static kern_return_t smcCall(SmcKeyData *input, SmcKeyData *output) {
  size_t size = sizeof(*output);
  kern_return_t result = IOConnectCallStructMethod(connection, SMC_USER_CLIENT,
                                                   input, sizeof(*input), output, &size);
  if (result != kIOReturnSuccess) return result;
  return output->result == 0 ? kIOReturnSuccess : kIOReturnError;
}

/** Read one float-typed key. @returns 1 on success. */
static int readFloat(const char key[4], double *value) {
  SmcKeyData in, out;
  memset(&in, 0, sizeof in);
  memset(&out, 0, sizeof out);
  in.key = fourCC(key);
  in.data8 = SMC_CMD_READ_KEY_INFO;
  if (smcCall(&in, &out) != kIOReturnSuccess) return 0;
  if (out.keyInfo.dataSize == 0 || out.keyInfo.dataSize > sizeof(((SmcKeyData *)0)->bytes)) return 0;
  SmcKeyInfo info = out.keyInfo;

  memset(&in, 0, sizeof in);
  memset(&out, 0, sizeof out);
  in.key = fourCC(key);
  in.keyInfo.dataSize = info.dataSize;
  in.data8 = SMC_CMD_READ_BYTES;
  if (smcCall(&in, &out) != kIOReturnSuccess) return 0;

  const uint32_t type = info.dataType;
  if (type != fourCC("flt ")) return 0;
  float parsed = 0;
  memcpy(&parsed, out.bytes, sizeof parsed);
  if (!isfinite(parsed) || parsed < 0) return 0;
  *value = (double)parsed;
  return 1;
}

int main(void) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault,
                                                     IOServiceMatching("AppleSMC"));
  if (service == IO_OBJECT_NULL) {
    printf("{\"ok\":false,\"reason\":\"no-smc\"}\n");
    return 0;
  }
  const kern_return_t opened = IOServiceOpen(service, mach_task_self(), 0, &connection);
  IOObjectRelease(service);
  if (opened != kIOReturnSuccess) {
    printf("{\"ok\":false,\"reason\":\"smc-open\"}\n");
    return 0;
  }

  double load = 0;
  double input = 0;
  const int hasLoad = readFloat("PSTR", &load);
  const int hasInput = readFloat("PDTR", &input);
  if (!hasInput) {
    printf("{\"ok\":false,\"reason\":\"no-pdtr\"}\n");
    IOServiceClose(connection);
    return 0;
  }
  printf("{\"ok\":true,\"pdtr\":%.4f,\"pstr\":%.4f}\n", input, hasLoad ? load : -1.0);
  IOServiceClose(connection);
  return 0;
}
