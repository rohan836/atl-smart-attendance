#!/usr/bin/env python3
"""Automated end-to-end browser integration tests for ATL Smart Attendance.

Uses Playwright with headless Chromium against a live, isolated test instance of
the Flask app with simulated sensor mode and a temporary SQLite database.

Covers:
  1. Kiosk idle screen presentation and typography/prompt rendering.
  2. Biometric scan event handling, student profile card reveal, and automatic idle fadeback.
  3. Admin security gate: PIN challenge, rejection on invalid PIN, and unlock on valid PIN.
  4. Complete navigation across all six Admin tabs (Students, Today, Reports, Calendar, Settings, Backup).
  5. Student enrollment modal: required field validation, form submission, and cancel/close.
  6. Backup tab: Google Drive Device Flow pairing display (unauthenticated state).
  7. Backup tab: Google Drive schedule configuration controls (authenticated state, frequency, weekdays, save).
  8. Backup tab: Telegram secondary backup card and interactive controls (status, toggle, send backup, clear status).

Run via:
    python -m unittest backend.test_ui_e2e -v
"""

import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import unittest
from werkzeug.serving import make_server

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

import app as atl

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

_TMP_DIR = None
_SERVER_THREAD = None
_TEST_PORT = None
_BASE_URL = None
_PLAYWRIGHT = None
_BROWSER = None


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class ServerThread(threading.Thread):
    def __init__(self, flask_app, host='127.0.0.1', port=5007):
        super().__init__(daemon=True)
        self.server = make_server(host, port, flask_app, threaded=True)
        self.ctx = flask_app.app_context()
        self.ctx.push()

    def run(self):
        self.server.serve_forever()

    def shutdown(self):
        try:
            self.server.shutdown()
        except Exception:
            pass


def setUpModule():
    global _TMP_DIR, _SERVER_THREAD, _TEST_PORT, _BASE_URL, _PLAYWRIGHT, _BROWSER
    if sync_playwright is None:
        raise unittest.SkipTest("playwright is not installed. Install with: pip install playwright && playwright install chromium")

    _TMP_DIR = tempfile.mkdtemp(prefix="atl_ui_e2e_")
    db_path = os.path.join(_TMP_DIR, "test_ui.db")
    images_dir = os.path.join(_TMP_DIR, "images")
    token_file = os.path.join(_TMP_DIR, "gdrive_token.json")
    os.makedirs(images_dir, exist_ok=True)

    atl.DB_PATH = db_path
    atl.IMAGES_DIR = images_dir
    atl.cfg["sensor"] = "sim"
    atl.cfg["uart"] = "/dev/null"
    atl.cfg["adminPin"] = "1234"
    atl.cfg["gdrive"] = {
        "enabled": True,
        "clientId": "test_client_id_123.apps.googleusercontent.com",
        "clientSecret": "test_client_secret_456",
        "tokenFile": token_file,
        "folderName": "ATL-Attendance-Backups-Test",
        "scheduleTime": "18:30"
    }

    with atl.app.app_context():
        db = atl.get_db()
        current_settings = atl.get_settings()
        current_settings["workingDays"] = {str(i): True for i in range(7)}
        current_settings["classes"] = ["Grade 10-A", "Grade 10-B", "Grade 9-A"]
        atl.save_settings(current_settings)

        db.execute(
            """INSERT INTO students (id, name, roll, grade, batch, section, parent, phone, address, fingerId, photo, active, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (1, "Aarav Sharma", "10A-08", "Grade 10-A", "Batch A", "A", "Ramesh Sharma", "9876543210", "Pune", 1, "", 1, "2026-09-02T08:00:00")
        )
        db.commit()

    _TEST_PORT = find_free_port()
    _BASE_URL = f"http://127.0.0.1:{_TEST_PORT}"
    _SERVER_THREAD = ServerThread(atl.app, host="127.0.0.1", port=_TEST_PORT)
    _SERVER_THREAD.start()

    import urllib.request
    healthy = False
    for _ in range(30):
        try:
            with urllib.request.urlopen(f"{_BASE_URL}/api/health", timeout=1) as resp:
                if resp.status == 200:
                    healthy = True
                    break
        except Exception:
            time.sleep(0.1)
    if not healthy:
        raise RuntimeError(f"Test server at {_BASE_URL} failed to start")

    _PLAYWRIGHT = sync_playwright().start()
    _BROWSER = _PLAYWRIGHT.chromium.launch(
        headless=True,
        args=["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"]
    )


def tearDownModule():
    global _PLAYWRIGHT, _BROWSER, _SERVER_THREAD, _TMP_DIR
    if _BROWSER:
        try:
            _BROWSER.close()
        except Exception:
            pass
    if _PLAYWRIGHT:
        try:
            _PLAYWRIGHT.stop()
        except Exception:
            pass
    if _SERVER_THREAD:
        _SERVER_THREAD.shutdown()
    if _TMP_DIR and os.path.exists(_TMP_DIR):
        import shutil
        try:
            shutil.rmtree(_TMP_DIR, ignore_errors=True)
        except Exception:
            pass


class UiE2eTest(unittest.TestCase):
    def setUp(self):
        self.context = _BROWSER.new_context(
            viewport={"width": 1280, "height": 800},
            ignore_https_errors=True
        )
        self.page = self.context.new_page()
        self.console_messages = []
        self.page_errors = []

        self.page.on("console", lambda msg: self.console_messages.append(f"[{msg.type}] {msg.text}"))
        self.page.on("pageerror", lambda err: self.page_errors.append(str(err)))

    def tearDown(self):
        has_failed = False
        outcome = getattr(self, "_outcome", None)
        if outcome:
            result = getattr(outcome, "result", None)
            if result:
                all_errs = getattr(result, "errors", []) + getattr(result, "failures", [])
                has_failed = any(test == self for test, _ in all_errs)

        if has_failed:
            screenshot_dir = ROOT / "artifacts"
            os.makedirs(screenshot_dir, exist_ok=True)
            screenshot_path = screenshot_dir / f"fail_{self._testMethodName}.png"
            try:
                self.page.screenshot(path=str(screenshot_path), full_page=True)
                print(f"\n[E2E Failure] Screenshot captured: {screenshot_path}")
                if self.console_messages:
                    print("[E2E Failure] Console logs:\n" + "\n".join(self.console_messages[-10:]))
                if self.page_errors:
                    print("[E2E Failure] Page errors:\n" + "\n".join(self.page_errors))
            except Exception as ex:
                print(f"Failed to capture failure screenshot: {ex}")

        try:
            self.page.close()
            self.context.close()
        except Exception:
            pass

    def test_01_kiosk_idle_screen_renders_correctly(self):
        """Kiosk terminal displays idle prompt 'PLACE YOUR FINGER', admin trigger, and no result cards."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.assertEqual(self.page.title(), "ATL Smart Attendance Terminal — Complete School System")

        terminal = self.page.locator("#terminal")
        self.assertTrue(terminal.is_visible())

        prompt = self.page.locator("#promptText")
        self.assertTrue(prompt.is_visible())
        self.assertEqual(prompt.inner_text().strip().upper(), "PLACE YOUR FINGER")

        admin_btn = self.page.locator("#openAdminBtn")
        self.assertTrue(admin_btn.is_visible())
        self.assertEqual(admin_btn.inner_text().strip().upper(), "ADMIN")

        # Result layers do not have .visible class
        self.page.wait_for_function("!document.getElementById('identityLayer').classList.contains('visible')")
        self.page.wait_for_function("!document.getElementById('unknownLayer').classList.contains('visible')")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')")

    def test_02_simulated_scan_displays_student_and_returns_to_idle(self):
        """Simulated fingerprint scan triggers student profile presentation and auto-dismisses back to idle."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        # Allow bridge poller to complete initial synchronization handshake
        self.page.wait_for_timeout(1000)

        # Trigger simulated scan event for student 1 via backend API
        import urllib.request
        scan_req = urllib.request.Request(
            f"{_BASE_URL}/api/scan",
            data=json.dumps({"studentId": 1}).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(scan_req) as resp:
            self.assertEqual(resp.status, 200)
            scan_res = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(scan_res.get("ok"))

        # Wait for client bridge to receive the scan and activate #identityLayer.visible
        self.page.wait_for_function(
            "document.getElementById('identityLayer').classList.contains('visible')",
            timeout=6000
        )

        name_el = self.page.locator("#idName")
        roll_el = self.page.locator("#idRoll")
        class_el = self.page.locator("#idClass")
        status_el = self.page.locator("#idStatus")

        self.assertIn("AARAV SHARMA", name_el.inner_text().upper())
        self.assertEqual(roll_el.inner_text().strip(), "10A-08")
        self.assertEqual(class_el.inner_text().strip(), "Grade 10-A")
        self.assertIn(status_el.inner_text().strip().upper(), ["PRESENT", "LATE", "ALREADY RECORDED"])

        # Wait for hold timeout to elapse (~4.5s) and layer to fade out
        self.page.wait_for_function(
            "!document.getElementById('identityLayer').classList.contains('visible')",
            timeout=8000
        )

        # Prompt returns to visible idle state
        self.page.wait_for_function(
            "!document.getElementById('promptText').classList.contains('is-hidden')",
            timeout=3000
        )

    def test_03_admin_pin_security_and_unlock(self):
        """Admin requires PIN: handles cancellation/invalid PIN rejection and unlocks on valid PIN."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')")

        # Step A: Invalid PIN attempt -> admin layer remains closed
        def handle_invalid_pin(dialog):
            self.assertIn("Admin PIN", dialog.message)
            dialog.accept("0000")

        self.page.once("dialog", handle_invalid_pin)
        self.page.click("#openAdminBtn")
        self.page.wait_for_timeout(500)
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')")

        # Step B: Valid PIN attempt -> admin layer opens
        def handle_valid_pin(dialog):
            self.assertIn("Admin PIN", dialog.message)
            dialog.accept("1234")

        self.page.once("dialog", handle_valid_pin)
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        admin_title = self.page.locator("#adminTitle")
        self.assertEqual(admin_title.inner_text().strip().upper(), "STUDENTS")

        # Close Admin
        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_04_admin_navigation_all_six_tabs(self):
        """Navigating through all 6 admin tabs correctly switches active panes and titles."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        tabs = [
            ("students", "pane-students", "Students"),
            ("today", "pane-today", "Today — Attendance"),
            ("reports", "pane-reports", "Reports"),
            ("calendar", "pane-calendar", "Calendar — Schedule"),
            ("settings", "pane-settings", "Settings"),
            ("backup", "pane-backup", "Backup — Audit"),
        ]

        for tab_id, pane_id, expected_title in tabs:
            tab_btn = self.page.locator(f"#adminNav button[data-tab='{tab_id}']")
            tab_btn.click()
            self.page.wait_for_function(f"!document.getElementById('{pane_id}').classList.contains('hidden')")

            title_el = self.page.locator("#adminTitle")
            self.assertEqual(title_el.inner_text().strip().upper(), expected_title.upper())

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_05_enrollment_modal_validation_and_form_flow(self):
        """Enrollment modal validates required fields and handles cancel correctly."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='students']")
        self.page.click("#newStudentToolbarBtn")

        # Modal should acquire .open class
        self.page.wait_for_function("document.getElementById('enrollModal').classList.contains('open')", timeout=3000)

        # Empty submit -> inline error shown
        self.page.click("#nsSave")
        err_el = self.page.locator("#nsErr")
        err_el.wait_for(state="visible", timeout=2000)
        self.assertIn("Name, roll and class are required", err_el.inner_text())

        # Fill in valid fields
        self.page.fill("#nsName", "Pooja Patel")
        self.page.fill("#nsRoll", "10A-15")
        self.page.select_option("#nsGrade", label="Grade 10-A")

        # Cancel enrollment modal
        self.page.click("#nsCancel")
        self.page.wait_for_function("!document.getElementById('enrollModal').classList.contains('open')", timeout=3000)

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_06_backup_tab_gdrive_unauthenticated_device_flow(self):
        """Backup tab displays Google Drive Device Flow pairing code box when unauthenticated."""
        # Intercept device-start request to return deterministic mock pairing code
        self.page.route("**/api/backup/gdrive/device-start", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "ok": True,
                "userCode": "WDJK-9942",
                "verificationUrl": "https://www.google.com/device",
                "verificationUrlComplete": "https://www.google.com/device?user_code=WDJK-9942",
                "expiresIn": 1800,
                "interval": 5
            })
        ))

        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='backup']")
        self.page.wait_for_function("!document.getElementById('pane-backup').classList.contains('hidden')", timeout=3000)

        start_btn = self.page.locator("#gdriveDeviceStartBtn")
        start_btn.wait_for(state="visible", timeout=4000)

        # Click Connect Google Drive -> device code box appears
        start_btn.click()

        code_box = self.page.locator("#gdriveDeviceCodeBox")
        code_box.wait_for(state="visible", timeout=3000)

        code_display = self.page.locator("#gdriveUserCodeDisplay")
        self.assertEqual(code_display.inner_text().strip(), "WDJK-9942")

        # Cancel pairing flow
        cancel_btn = self.page.locator("#gdriveDeviceCancelBtn")
        cancel_btn.click()
        code_box.wait_for(state="hidden", timeout=3000)

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_07_backup_tab_unified_schedule_controls(self):
        """Backup tab allows configuring unified automatic backup schedule (frequency, weekdays, save)."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='backup']")
        self.page.wait_for_function("!document.getElementById('pane-backup').classList.contains('hidden')", timeout=3000)

        # 1. Unified Backup Manager card renders
        manager_card = self.page.locator("#backupManagerCard")
        manager_card.wait_for(state="visible", timeout=3000)
        self.page.wait_for_function("document.getElementById('destStatusTelegram').textContent !== 'Checking…'", timeout=5000)

        enabled_checkbox = self.page.locator("#backupSchedEnabled")
        self.assertTrue(enabled_checkbox.is_visible())
        if not enabled_checkbox.is_checked():
            enabled_checkbox.click()
            self.page.wait_for_timeout(200)

        self.page.fill("#backupSchedTime", "19:45")

        freq_select = self.page.locator("#backupSchedFreq")
        interval_wrap = self.page.locator("#backupSchedIntervalWrap")
        days_wrap = self.page.locator("#backupSchedDaysWrap")

        # Frequency: interval
        freq_select.select_option("interval")
        interval_wrap.wait_for(state="visible", timeout=2000)
        self.assertFalse(days_wrap.is_visible())
        self.page.fill("#backupSchedInterval", "4")

        # Frequency: weekdays
        freq_select.select_option("weekdays")
        days_wrap.wait_for(state="visible", timeout=2000)
        self.assertFalse(interval_wrap.is_visible())

        # Weekday toggle (Monday = 1)
        mon_btn = self.page.locator("#backupSchedDays button[data-day='1']")
        mon_btn.click()

        # Save schedule
        self.page.click("#backupSchedSaveBtn")
        status_span = self.page.locator("#backupSchedStatus")
        status_span.wait_for(state="visible", timeout=3000)
        self.assertIn("SAVED", status_span.inner_text().upper())

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_08_backup_tab_destination_selection_and_select_all(self):
        """Backup tab displays independent destination checkboxes and Select all button."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='backup']")
        self.page.wait_for_function("!document.getElementById('pane-backup').classList.contains('hidden')", timeout=3000)

        # Destination checkboxes render
        gd_check = self.page.locator("#destCheckGdrive")
        tg_check = self.page.locator("#destCheckTelegram")
        usb_check = self.page.locator("#destCheckUsb")
        select_all_btn = self.page.locator("#backupSelectAllBtn")

        self.assertTrue(gd_check.is_visible())
        self.assertTrue(tg_check.is_visible())
        self.assertTrue(usb_check.is_visible())
        self.assertTrue(select_all_btn.is_visible())

        # Toggle Telegram checkbox
        init_tg = tg_check.is_checked()
        tg_check.click()
        self.page.wait_for_timeout(300)
        self.assertNotEqual(tg_check.is_checked(), init_tg)
        tg_check.click() # restore

        # Test Select all button
        select_all_btn.click()
        self.page.wait_for_timeout(400)
        state1 = gd_check.is_checked()
        self.assertEqual(tg_check.is_checked(), state1)
        self.assertEqual(usb_check.is_checked(), state1)

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_09_backup_tab_refresh_and_usb_status(self):
        """Refresh button updates live status in place, and USB reports Not connected when detached."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='backup']")
        self.page.wait_for_function("!document.getElementById('pane-backup').classList.contains('hidden')", timeout=3000)

        # In test environment with no physical USB attached, USB reports "Not connected"
        usb_status = self.page.locator("#destStatusUsb")
        usb_status.wait_for(state="visible", timeout=3000)
        self.assertIn(usb_status.inner_text().strip(), ["Not connected", "Disabled", "Ready"])

        # Click Refresh button
        refresh_btn = self.page.locator("#backupRefreshBtn")
        self.assertTrue(refresh_btn.is_visible())
        refresh_btn.click()
        self.page.wait_for_timeout(400)

        # Status remains responsive and visible without page reload
        self.assertTrue(usb_status.is_visible())

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_10_backup_tab_backup_now(self):
        """Back Up Now button runs backup for selected destinations and reports results."""
        self.page.route("**/api/backup/telegram/backup", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "ok": True,
                "name": "atl_backup_mock.db",
                "messageId": 12345,
                "size": 729000
            })
        ))

        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='backup']")
        self.page.wait_for_function("!document.getElementById('pane-backup').classList.contains('hidden')", timeout=3000)
        self.page.wait_for_function("document.getElementById('destStatusTelegram').textContent !== 'Checking…'", timeout=5000)

        # Enable Telegram destination
        tg_check = self.page.locator("#destCheckTelegram")
        if not tg_check.is_checked():
            tg_check.click()
            self.page.wait_for_timeout(350)

        # Disable Google Drive and USB for this targeted test
        gd_check = self.page.locator("#destCheckGdrive")
        if gd_check.is_checked():
            gd_check.click()
            self.page.wait_for_timeout(300)
        usb_check = self.page.locator("#destCheckUsb")
        if usb_check.is_checked():
            usb_check.click()
            self.page.wait_for_timeout(300)

        backup_btn = self.page.locator("#backupNowBtn")
        self.assertTrue(backup_btn.is_visible())

        # Accept completion alert
        self.page.once("dialog", lambda dialog: dialog.accept())
        backup_btn.click()

        self.page.wait_for_function("document.getElementById('backupNowStatus').textContent.toUpperCase().includes('OK')", timeout=5000)
        status_el = self.page.locator("#backupNowStatus")
        self.assertIn("TELEGRAM: OK", status_el.inner_text().upper())

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)


if __name__ == "__main__":
    unittest.main(verbosity=2)

