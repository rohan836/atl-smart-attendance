import sys
sys.path.insert(0, '/opt/atl-attendance/backend')
from gt511c3 import GT511C3

s = GT511C3(uart='/dev/serial0', baud=9600, sim=False)
print('hw_ok:', not s.sim, '| last_error:', s.last_error)
print('LED_ON_ACK:', s.set_led(True))
s.keep_led_on = True
s.close()
print('LED left ON (always-on mode)')
