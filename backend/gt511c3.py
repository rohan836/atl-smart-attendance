"""
GT-511C3 real driver — UART packet protocol + sim fallback.
Implements only what project needs: Open, Close, EnrollStart/1/2/3, IsPressFinger, Capture, Identify, DeleteID, GetEnrollCount.
Falls back to sim if UART unavailable or sensor disconnect (so UI still testable without hardware).
No timers — caller blocks until sensor responds or timeout.
"""
import time
import struct
import random

try:
    import serial
    HAS_SERIAL = True
except ImportError:
    HAS_SERIAL = False

# Packet constants (from GT-511C3 datasheet + verified libs)
START_CODE = 0x55AA  # actually 0x55 0xAA
DEVICE_ID = 0x0001

# Commands (low byte first as per packet)
CMD_OPEN             = 0x01
CMD_CLOSE            = 0x02
CMD_USB_INTERNAL     = 0x03
CMD_CMOS_LED         = 0x12
CMD_GET_ENROLL_COUNT = 0x20
CMD_ENROLL_START     = 0x22
CMD_ENROLL_1         = 0x23
CMD_ENROLL_2         = 0x24
CMD_ENROLL_3         = 0x25
CMD_IS_PRESS_FINGER  = 0x26
CMD_DELETE_ID        = 0x40
CMD_DELETE_ALL       = 0x41
CMD_VERIFY           = 0x50
CMD_IDENTIFY         = 0x51
CMD_CAPTURE_FINGER   = 0x60

# Responses
ACK_OK  = 0x30
NACK    = 0x31

# Official ADH-Tech / SparkFun GT-511C3 datasheet error codes
NACK_CODES = {
    0x1001: "TIMEOUT",
    0x1002: "INVALID_BAUDRATE",
    0x1003: "INVALID_POS",
    0x1004: "IS_NOT_USED",
    0x1005: "IS_ALREADY_USED",
    0x1006: "COMM_ERR",
    0x1007: "VERIFY_FAILED",
    0x1008: "IDENTIFY_FAILED",
    0x1009: "DB_IS_FULL",
    0x100A: "DB_IS_EMPTY",
    0x100B: "TURN_ERR",
    0x100C: "BAD_FINGER",
    0x100D: "ENROLL_FAILED",
    0x100E: "IS_NOT_SUPPORTED",
    0x100F: "DEV_ERR",
    0x1010: "CAPTURE_CANCELED",
    0x1011: "INVALID_PARAM",
    0x1012: "FINGER_IS_NOT_PRESSED",
}

def _checksum(buf):
    # Sum of bytes 0..9 (start codes + DeviceID + Parameter + Command), as used by working GT-511C3 hosts
    return sum(buf[:10]) & 0xFFFF

def _build_packet(cmd, param=0):
    # 12-byte packet: [0]=0x55, [1]=0xAA, [2-3]=DeviceID LE, [4-7]=Param LE, [8-9]=Cmd LE, [10-11]=Checksum LE
    pkt = bytearray(12)
    pkt[0] = 0x55
    pkt[1] = 0xAA
    struct.pack_into('<H', pkt, 2, DEVICE_ID)
    struct.pack_into('<I', pkt, 4, param & 0xFFFFFFFF)
    struct.pack_into('<H', pkt, 8, cmd & 0xFFFF)
    chk = _checksum(pkt)
    struct.pack_into('<H', pkt, 10, chk)
    return bytes(pkt)

def _parse_response(buf):
    if len(buf) < 12:
        return None, "SHORT"
    if buf[0] != 0x55 or buf[1] != 0xAA:
        return None, "BAD_HEADER"
    dev = struct.unpack_from('<H', buf, 2)[0]
    param = struct.unpack_from('<I', buf, 4)[0]
    resp = struct.unpack_from('<H', buf, 8)[0]
    chk = struct.unpack_from('<H', buf, 10)[0]
    calc = sum(buf[:10]) & 0xFFFF
    if chk != calc:
        return None, "BAD_CHECKSUM"
    return {"device": dev, "param": param, "resp": resp}, None

class GT511C3:
    def __init__(self, uart="/dev/serial0", baud=9600, sim=None):
        # sim=None → auto-detect: try UART, fallback to sim if fail
        self.uart = uart
        self.baud = baud
        self.ser = None
        self.sim = False
        self.last_error = None
        self.keep_led_on = False  # when True, operations leave the CMOS LED on (always-on mode)
        if sim is True:
            self.sim = True
        elif sim is False:
            # force hardware — fail hard if no serial
            if not HAS_SERIAL:
                raise RuntimeError("pyserial not installed")
            self._open_uart()
        else: # auto
            if not HAS_SERIAL:
                self.sim = True
            else:
                try:
                    self._open_uart()
                    ok,_ = self.initialize()
                    if not ok:
                        self.sim = True
                        if self.ser:
                            try: self.ser.close()
                            except: pass
                            self.ser = None
                except Exception as e:
                    self.last_error = str(e)
                    self.sim = True
                    if self.ser:
                        try: self.ser.close()
                        except: pass
                        self.ser = None

    def _open_uart(self):
        self.ser = serial.Serial(self.uart, self.baud, timeout=0.2)
        time.sleep(0.3)

    def initialize(self):
        """Datasheet Open: param 0 = no extra info. Close first if the device is in DEV_ERR."""
        if self.sim:
            return True, "SIM"
        ok, msg = self._cmd(CMD_OPEN, 0, timeout=0.5)
        if not ok:
            self._cmd(CMD_CLOSE, 0, timeout=0.3)
            time.sleep(0.05)
            ok, msg = self._cmd(CMD_OPEN, 0, timeout=0.5)
        return ok, msg

    def _read_packet(self, timeout):
        """Read one 12-byte response, synced to 0x55 0xAA (SparkFun GetResponse)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            b = self.ser.read(1)
            if not b:
                continue
            if b[0] != 0x55:
                continue
            rest = bytearray(b)
            while len(rest) < 2 and time.time() < deadline:
                c = self.ser.read(1)
                if c:
                    rest.extend(c)
            if len(rest) < 2 or rest[1] != 0xAA:
                continue
            while len(rest) < 12 and time.time() < deadline:
                c = self.ser.read(12 - len(rest))
                if c:
                    rest.extend(c)
            if len(rest) == 12:
                return bytes(rest)
        return None

    def _drain(self, seconds=0.06):
        if not self.ser:
            return
        t0 = time.time()
        while time.time() - t0 < seconds:
            n = getattr(self.ser, "in_waiting", 0) or 0
            if n:
                self.ser.read(n)
            else:
                time.sleep(0.005)

    def _cmd(self, cmd, param=0, timeout=2.0):
        if self.sim or not self.ser or not self.ser.is_open:
            return False, "SIM"
        try:
            # Drop leftover ACK bytes (Capture/Enroll ACK param=0 looks like “finger pressed”).
            self._drain(0.05)
            pkt = _build_packet(cmd, param)
            self.ser.write(pkt)
            self.ser.flush()
            buf = self._read_packet(timeout)
            if not buf:
                return False, "TIMEOUT"
            parsed, err = _parse_response(buf)
            if err:
                return False, err
            if parsed["resp"] == ACK_OK:
                # Open(param!=0) is followed by a 30-byte extra-info data packet (0x5A 0xA5 ...)
                if cmd == CMD_OPEN and param:
                    extra = bytearray()
                    t2 = time.time()
                    while len(extra) < 30 and (time.time() - t2) < 1.0:
                        chunk = self.ser.read(30 - len(extra))
                        if chunk:
                            extra.extend(chunk)
                        else:
                            time.sleep(0.02)
                return True, parsed["param"]
            else:
                code = parsed["param"] & 0xFFFF
                msg = NACK_CODES.get(code, f"NACK 0x{code:04X}")
                return False, msg
        except Exception as e:
            self.last_error = str(e)
            return False, f"UART_ERR {e}"

    def is_ready(self):
        if self.sim:
            return True
        ok, _ = self._cmd(CMD_CMOS_LED, 1, timeout=0.5)  # LED on as ping
        if ok:
            self.set_led(self.keep_led_on)
            return True
        try:
            if self.ser: self.ser.close()
            self._open_uart()
            ok,_ = self.initialize()
            if not ok:
                return False
            ok,_ = self._cmd(CMD_CMOS_LED, 1, timeout=0.5)
            if ok:
                self.set_led(self.keep_led_on)
            return ok
        except:
            return False

    def set_led(self, on):
        """CMOS LED control. Returns True on sensor ACK."""
        if self.sim:
            return True
        ok, _ = self._cmd(CMD_CMOS_LED, 1 if on else 0, timeout=0.5)
        return ok

    def is_press_finger(self, timeout=0.2):
        """Datasheet + live sensor: ACK param 0 = pressed; ACK param 0x1012 = not pressed.
        Returns True / False / None (comms error). LED must already be on."""
        if self.sim:
            return True
        ok, param = self._cmd(CMD_IS_PRESS_FINGER, 0, timeout=timeout)
        if not ok:
            # NACK 0x1012 is valid "not pressed", not a comms error
            if "FINGER_IS_NOT_PRESSED" in str(param) or "0x1012" in str(param):
                return False
            return None
        return int(param) == 0

    def wait_finger(self, timeout=25.0, expect_press=True, stable=3, on_wait=None):
        """Wait until IsPressFinger reports the same state `stable` times in a row.
        on_wait(remain_sec, finger, expect_press) is the live backend wait — not a UI timer."""
        deadline = time.time() + timeout
        if self.sim:
            if on_wait:
                on_wait(int(timeout), False, expect_press, deadline)
            time.sleep(0.4)
            if on_wait:
                on_wait(0, True if expect_press else False, expect_press, deadline)
            return True
        streak = 0
        while time.time() < deadline:
            remain = max(0, int(deadline - time.time()))
            # cap is_press_finger timeout to remaining wait time, max 0.2s - respects requested timeout
            if time.time() >= deadline:
                return False
            cmd_timeout = min(0.2, max(0.05, deadline - time.time()))
            st = self.is_press_finger(timeout=cmd_timeout)
            if on_wait:
                on_wait(remain, st, expect_press, deadline)
            if st is None:
                streak = 0
                # check deadline before next sensor command
                if time.time() >= deadline:
                    return False
                time.sleep(0.02)
                continue
            if st == expect_press:
                streak += 1
                if streak >= stable:
                    return True
            else:
                streak = 0
            if time.time() >= deadline:
                return False
            time.sleep(0.02)

    def capture(self, best_image=False):
        if self.sim:
            time.sleep(0.3)
            return True, "OK"
        # CaptureFinger: 0 = fast, nonzero = best (use best for enroll)
        ok, msg = self._cmd(CMD_CAPTURE_FINGER, 1 if best_image else 0, timeout=8.0)
        if not ok and "FINGER_IS_NOT_PRESSED" in str(msg):
            return False, "NO_FINGER"
        return ok, msg

    def enroll_start(self, finger_id):
        if self.sim:
            time.sleep(0.2)
            if random.random() < 0.05:
                return False, "ENROLL_FAIL"
            return True, "OK"
        # Validate position
        if not (0 <= finger_id <= 199):
            return False, "INVALID_POS"
        ok, msg = self._cmd(CMD_ENROLL_START, finger_id, timeout=2.0)
        return ok, msg

    def enroll_n(self, n, log=None):
        # Official datasheet 6.3: wait press → CaptureFinger → EnrollN → wait until finger is taken off.
        cmd = {1: CMD_ENROLL_1, 2: CMD_ENROLL_2, 3: CMD_ENROLL_3}.get(n)
        if not cmd:
            return False, "INVALID_N"
        def emit(d):
            if log:
                log(d)
        title_place = "Place your finger" if n == 1 else "Place the same finger"
        WAIT_PRESS, WAIT_REMOVE = 40, 30
        def on_press(remain, finger, expect, deadline):
            emit({
                "mode": "enroll", "step": n, "steps_total": 3,
                "state": "hold" if finger else "place",
                "title": "Hold your finger" if finger else title_place,
                "detail": "Sensor light is on. Keep still." if finger else "Sensor light is on. Put your finger on the glass.",
                "timeout_sec": WAIT_PRESS, "deadline": deadline, "remain_sec": remain, "finger": finger,
            })
        emit({
            "mode": "enroll", "step": n, "steps_total": 3, "state": "place",
            "title": title_place,
            "detail": "Sensor light is on. Put your finger on the glass.",
            "timeout_sec": WAIT_PRESS, "deadline": time.time() + WAIT_PRESS, "finger": False,
        })
        if self.sim:
            time.sleep(0.5)
            return True, "OK"
        if not self.wait_finger(timeout=WAIT_PRESS, expect_press=True, stable=3, on_wait=on_press):
            return False, "TIMEOUT_WAIT_FINGER"
        emit({
            "mode": "enroll", "step": n, "steps_total": 3, "state": "capturing",
            "title": "Hold your finger",
            "detail": "Capturing — keep still.",
            "timeout_sec": 0, "deadline": 0, "finger": True,
        })
        ok, msg = False, "NO_CAPTURE"
        for _ in range(8):
            ok, msg = self.capture(best_image=True)
            if ok:
                break
            time.sleep(0.25)
        if not ok:
            return False, f"CAPTURE_FAIL {msg}"
        ok, msg = self._cmd(cmd, 0, timeout=8.0)
        if not ok:
            return False, msg
        time.sleep(0.15)
        self._drain(0.12)
        def on_lift(remain, finger, expect, deadline):
            emit({
                "mode": "enroll", "step": n, "steps_total": 3, "state": "remove",
                "title": "Remove your finger",
                "detail": "Lift your finger completely off the glass.",
                "timeout_sec": WAIT_REMOVE, "deadline": deadline, "remain_sec": remain, "finger": finger,
            })
        emit({
            "mode": "enroll", "step": n, "steps_total": 3, "state": "remove",
            "title": "Remove your finger",
            "detail": "Lift your finger completely off the glass.",
            "timeout_sec": WAIT_REMOVE, "deadline": time.time() + WAIT_REMOVE, "finger": True,
        })
        if not self.wait_finger(timeout=WAIT_REMOVE, expect_press=False, stable=2, on_wait=on_lift):
            return False, "TIMEOUT_WAIT_REMOVED"
        time.sleep(0.35)
        return True, "OK"

    def enroll(self, finger_id, log=None):
        """Full 3-capture enrollment. LED on; EnrollStart; Enroll1/2/3. Finger must lift between captures."""
        def emit(d):
            if log:
                log(d)
        if not (0 <= finger_id <= 199):
            return False, "INVALID_POS"
        if not self.sim:
            ok, msg = self.initialize()
            if not ok:
                return False, f"UART_INIT_FAIL {msg}"
            self._cmd(CMD_CMOS_LED, 1, timeout=1.0)
        ok, msg = self.enroll_start(finger_id)
        if not ok:
            if not self.sim:
                self.set_led(self.keep_led_on)
            return False, f"START_FAIL {msg}"
        for n in (1, 2, 3):
            ok, msg = self.enroll_n(n, log=log)
            if not ok:
                self.delete_id(finger_id)
                if not self.sim:
                    self.set_led(self.keep_led_on)
                emit({"mode": "enroll", "step": n, "steps_total": 3, "state": "fail", "title": "Try again", "detail": msg, "timeout_sec": 0, "deadline": 0, "raw": msg})
                return False, f"ENROLL_{n}_FAIL {msg}"
        if not self.sim:
            self.set_led(self.keep_led_on)
        emit({
            "mode": "enroll", "step": 3, "steps_total": 3, "state": "success",
            "title": "Fingerprint enrolled",
            "detail": "Saved on the sensor.",
            "timeout_sec": 0, "deadline": 0, "finger": False,
        })
        return True, "OK"

    def identify(self, log=None, timeout=30):
        """Wait for finger, CaptureFinger (fast), Identify. Returns (finger_id, msg)."""
        def emit(d):
            if log:
                log(d)
        try:
            WAIT = max(1, min(30, int(timeout)))
        except (TypeError, ValueError):
            WAIT = 30
        if self.sim:
            time.sleep(0.3)
            return None, "SIM"
        # For wait_finger, don't re-initialize before waiting - LED is already on via keep_led_on
        # This makes wait_finger(timeout=2) actually respect 2s instead of 2s+initialize(1.5s)
        try:
            def on_press(remain, finger, expect, deadline):
                emit({
                    "mode": "scan", "step": 0, "steps_total": 0,
                    "state": "hold" if finger else "place",
                    "title": "Hold your finger" if finger else "Place your finger",
                    "detail": "Sensor light is on. Keep still." if finger else "Sensor light is on. Put your finger on the glass.",
                    "timeout_sec": WAIT, "deadline": deadline, "remain_sec": remain, "finger": finger,
                })
            emit({
                "mode": "scan", "state": "place", "title": "Place your finger",
                "detail": "Sensor light is on. Put your finger on the glass.",
                "timeout_sec": WAIT, "deadline": time.time() + WAIT, "finger": False,
            })
            if not self.wait_finger(timeout=WAIT, expect_press=True, on_wait=on_press):
                return None, "NO_FINGER"
            # Finger pressed - now ensure sensor is ready for capture
            ok, msg = self.initialize()
            if not ok:
                return None, f"UART_INIT_FAIL {msg}"
            self._cmd(CMD_CMOS_LED, 1, timeout=0.3)
            emit({"mode": "scan", "state": "capturing", "title": "Scanning", "detail": "Keep still.", "timeout_sec": 0, "deadline": 0, "finger": True})
            ok, msg = False, "NO_CAPTURE"
            for _ in range(8):
                ok, msg = self.capture(best_image=True)
                if ok:
                    break
                time.sleep(0.2)
            if not ok:
                return None, f"CAPTURE_FAIL {msg}"
            emit({"mode": "scan", "state": "identifying", "title": "Identifying", "detail": "Matching your fingerprint.", "timeout_sec": 0, "deadline": 0, "finger": True})
            ok, param = self._cmd(CMD_IDENTIFY, 0, timeout=5.0)
            if ok:
                fid = int(param) & 0xFFFF
                return fid, "OK"
            if "IDENTIFY_FAILED" in str(param) or "0x1008" in str(param):
                return None, "UNKNOWN"
            return None, f"IDENTIFY_FAIL {param}"
        finally:
            self.set_led(self.keep_led_on)

    def delete_id(self, finger_id):
        if self.sim:
            time.sleep(0.1)
            return True, "OK"
        if not (0 <= finger_id <= 199):
            return False, "INVALID_POS"
        ok, msg = self._cmd(CMD_DELETE_ID, finger_id, timeout=2.0)
        # If already not used, treat as success (idempotent)
        if not ok and "IS_NOT_USED" in str(msg):
            return True, "ALREADY_EMPTY"
        return ok, msg

    def delete_all(self):
        if self.sim:
            return True, "OK"
        self.initialize()
        ok, msg = self._cmd(CMD_DELETE_ALL, 0, timeout=5.0)
        if not ok and "DB_IS_EMPTY" in str(msg):
            return True, "ALREADY_EMPTY"
        return ok, msg

    def close(self):
        if self.ser and self.ser.is_open:
            try:
                self._cmd(CMD_CLOSE, 0, timeout=1.0)
                self.ser.close()
            except:
                pass

if __name__ == "__main__":
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument("--uart", default="/dev/serial0")
    p.add_argument("--baud", type=int, default=9600)
    p.add_argument("--sim", action="store_true")
    p.add_argument("--test-enroll", type=int)
    p.add_argument("--test-identify", action="store_true")
    p.add_argument("--delete", type=int)
    args=p.parse_args()
    sensor=GT511C3(uart=args.uart, baud=args.baud, sim=args.sim if args.sim else None)
    print("sim:", sensor.sim, "ready:", sensor.is_ready(), "uart:", args.uart)
    if args.test_enroll is not None:
        print("enroll", args.test_enroll, sensor.enroll(args.test_enroll))
    if args.test_identify:
        print("identify", sensor.identify())
    if args.delete is not None:
        print("delete", args.delete, sensor.delete_id(args.delete))
