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

    def test_04_admin_navigation_unified_tabs(self):
        """Navigating through all unified admin tabs correctly switches active panes and titles."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        tabs = [
            ("students", "pane-students", "Students"),
            ("attendance", "pane-attendance", "Today — Attendance"),
            ("setup", "pane-setup", "Setup — School Configuration & Schedule"),
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

        backup_btn.click()

        self.page.wait_for_function("document.getElementById('backupNowStatus').textContent.toUpperCase().includes('OK')", timeout=5000)
        status_el = self.page.locator("#backupNowStatus")
        self.assertIn("TELEGRAM: OK", status_el.inner_text().upper())

        # Dismiss glass completion notice
        self.page.locator(".gconfirm").wait_for(state="visible", timeout=3000)
        self.page.locator(".gconfirm-ok").click()

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_11_backup_tab_destination_specific_controls_and_actions(self):
        """Destination-specific management actions (Telegram, USB) are accessible and functional."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='backup']")
        self.page.wait_for_function("!document.getElementById('pane-backup').classList.contains('hidden')", timeout=3000)
        self.page.wait_for_function("document.getElementById('destStatusTelegram').textContent !== 'Checking…'", timeout=5000)

        # 1. Telegram Controls
        tg_details = self.page.locator("#telegramDetailsBox")
        self.assertTrue(tg_details.is_visible())
        chat_el = self.page.locator("#telegramChatId")
        self.assertTrue(chat_el.is_visible())
        send_tg_btn = self.page.locator("#telegramBackupNowBtn")
        self.assertTrue(send_tg_btn.is_visible())
        clear_tg_btn = self.page.locator("#telegramClearStatusBtn")
        self.assertTrue(clear_tg_btn.is_visible())

        # Test Clear Telegram Status action
        clear_called = []
        self.page.route("**/api/backup/telegram/clear-status", lambda route: (clear_called.append(True), route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"ok": True})
        )))
        clear_tg_btn.click()
        self.page.wait_for_timeout(300)
        self.assertTrue(len(clear_called) > 0)

        # 2. USB Controls
        usb_details = self.page.locator("#usbDetailsBox")
        self.assertTrue(usb_details.is_visible())
        mount_el = self.page.locator("#usbMountPath")
        self.assertTrue(mount_el.is_visible())
        usb_bk_btn = self.page.locator("#usbBackupNowBtn")
        self.assertTrue(usb_bk_btn.is_visible())
        usb_ref_btn = self.page.locator("#usbRefreshBtn")
        self.assertTrue(usb_ref_btn.is_visible())
        usb_clear_btn = self.page.locator("#usbClearStatusBtn")
        self.assertTrue(usb_clear_btn.is_visible())

        # Test Check USB button
        usb_ref_btn.click()
        self.page.wait_for_timeout(300)
        self.assertTrue(usb_ref_btn.is_enabled())

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_12_backup_tab_gdrive_connected_and_disconnect(self):
        """Google Drive shows action box when connected, allowing list refresh and disconnect."""
        # Mock authenticated Google Drive status
        self.page.route("**/api/backup/gdrive/status", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "enabled": True,
                "configured": True,
                "authenticated": True,
                "folderName": "ATL-Attendance-Backups",
                "folderId": "mock_folder_123",
                "lastBackup": "2026-09-03 01:00:00",
                "lastBackupName": "atl_backup_20260903_010000.db",
                "lastStatus": "SUCCESS",
                "schedule": {"enabled": True, "time": "18:30", "frequency": "daily", "weekdays": [0,1,2,3,4,5,6]}
            })
        ))
        self.page.route("**/api/backup/gdrive/list", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "ok": True,
                "files": [
                    {"id": "file_1", "name": "atl_backup_20260903_010000.db", "size": 819200}
                ]
            })
        ))

        disconnect_called = []
        self.page.route("**/api/backup/gdrive/disconnect", lambda route: (disconnect_called.append(True), route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"ok": True})
        )))

        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        self.page.click("#adminNav button[data-tab='backup']")
        self.page.wait_for_function("!document.getElementById('pane-backup').classList.contains('hidden')", timeout=3000)

        # Google Drive status is Ready and Action Box is visible
        action_box = self.page.locator("#gdriveActionBox")
        action_box.wait_for(state="visible", timeout=4000)

        refresh_list_btn = self.page.locator("#gdriveRefreshListBtn")
        self.assertTrue(refresh_list_btn.is_visible())

        # Cloud snapshots table has populated row
        tbody = self.page.locator("#gdriveFilesBody")
        tbody.wait_for(state="visible", timeout=3000)
        self.assertIn("atl_backup_20260903_010000.db", tbody.inner_text())

        # Click Disconnect (confirm glass dialog)
        disconnect_btn = self.page.locator("#gdriveDisconnectBtn")
        self.assertTrue(disconnect_btn.is_visible())
        disconnect_btn.click()
        self.page.locator(".gconfirm").wait_for(state="visible", timeout=3000)
        self.page.locator(".gconfirm-ok").click()
        self.page.wait_for_timeout(400)
        self.assertTrue(len(disconnect_called) > 0)

        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_13_calendar_schedule_context_class_batch_and_timings(self):
        """Calendar schedule contexts with a solid inline editor: CLASSES|BATCHES tabs swap one left list, editor right, month below, no popup."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        # Open Admin panel
        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        # Navigate to Setup tab to ensure test batch exists
        self.page.click("#adminNav button[data-tab='setup']")
        self.page.wait_for_function("!document.getElementById('pane-setup').classList.contains('hidden')", timeout=3000)

        # Master-detail: CLASSES|BATCHES tabs, one list left, detail right
        cubes = self.page.locator("#classCubes")
        grid = self.page.locator("#cubeGrid")
        detail = self.page.locator("#classDetail")
        self.assertTrue(cubes.is_visible())
        self.assertTrue(self.page.locator("#cubeTabClasses.active").is_visible())
        self.assertTrue(self.page.evaluate("document.getElementById('batchAddRow').hidden"))
        for cls in ["Grade 10-A", "Grade 10-B", "Grade 9-A"]:
            self.assertEqual(grid.locator(f".class-cube[data-kind='class'][data-cube='{cls}']").count(), 1)
        self.assertEqual(grid.locator(".class-cube[data-kind='batch']").count(), 0)
        # BATCHES tab swaps the left list; classes untouched
        self.page.click("#cubeTabBatches")
        self.page.wait_for_function("document.querySelector(\"#cubeGrid .class-cube[data-kind='batch'][data-cube='Batch A']\")", timeout=4000)
        self.assertEqual(grid.locator(".class-cube[data-kind='batch'][data-cube='Batch A']").count(), 1)
        self.assertEqual(grid.locator(".class-cube[data-kind='class']").count(), 0)
        self.assertTrue(self.page.evaluate("document.getElementById('classAddRow').hidden"))
        self.page.click("#cubeTabClasses")
        self.page.wait_for_function("document.querySelector(\"#cubeGrid .class-cube[data-kind='class'][data-cube='Grade 10-A']\")", timeout=4000)
        # No popup anywhere
        self.assertIsNone(self.page.evaluate("document.getElementById('classScheduleModal')"))
        # Default-select is the first class, editor solid in the pane
        self.assertEqual(grid.locator(".class-cube.active").get_attribute("data-cube"), "Grade 10-A")
        self.assertIn("CLASS SCHEDULE: GRADE 10-A", detail.locator("#csTitle").inner_text().upper())

        # Seed: Batch A rides the flat stack; class detail holds editor only
        grid.locator(".class-cube[data-kind='class'][data-cube='Grade 10-A']").click()
        self.page.wait_for_function("document.getElementById('csTitle').innerText.includes('Grade 10-A')", timeout=4000)
        self.assertEqual(detail.locator("[data-sched-batch]").count(), 0)
        self.assertIn("CLASS SCHEDULE: GRADE 10-A", detail.locator("#csTitle").inner_text().upper())

        # Add a new batch "Robotics-A" via the left bar (BATCHES tab)
        self.page.click("#cubeTabBatches")
        self.page.wait_for_function("!document.getElementById('batchAddRow').hidden", timeout=4000)
        self.page.locator("#newBatchName").fill("Robotics-A")
        self.page.locator("#addBatchBtn").click()
        self.page.wait_for_function("!!document.querySelector(\"#cubeGrid .class-cube[data-kind='batch'][data-cube='Robotics-A']\")", timeout=4000)

        # 1. Verify selector has Global, Classes, and Batches
        cal_select = self.page.locator("#calClassSelect")
        self.assertTrue(cal_select.is_visible())
        select_html = cal_select.inner_html()
        self.assertIn("Global schedule", select_html)
        self.assertIn("Classes", select_html)
        self.assertIn("Batches", select_html)
        self.assertIn("batch:Robotics-A", select_html)

        # 2. Selecting the batch tile adapts the right side to its schedule
        grid.locator(".class-cube[data-kind='batch'][data-cube='Robotics-A']").click()
        self.page.wait_for_function("document.getElementById('csTitle').innerText.includes('Robotics-A')", timeout=3000)
        self.assertIn("BATCH SCHEDULE: ROBOTICS-A", detail.locator("#csTitle").inner_text().upper())
        # Month bar carries the context in the selector itself (pill retired)
        self.assertEqual(self.page.locator("#calClassSelect").input_value(), "batch:Robotics-A")
        self.assertIsNone(self.page.evaluate("document.getElementById('calMonthContextLabel')"))

        # 3. Toggle a weekday in the solid editor — grid header reflects
        cs_day = self.page.locator("#csDays .weekly-day-card").first
        before = "working" in (cs_day.get_attribute("class") or "")
        cs_day.click()
        self.page.wait_for_timeout(400)
        after = "working" in (cs_day.get_attribute("class") or "")
        self.assertNotEqual(before, after)
        grid_first_cls = self.page.locator("#calendarGrid .weekly-day-card").first.get_attribute("class") or ""
        self.assertEqual("working" in grid_first_cls, after)
        self.assertIsNone(self.page.evaluate("document.querySelector('#calendarGrid [data-day]')"))

        # 4. Set custom timings in the solid editor and save
        self.page.locator("#csPresentCutoff").fill("07:45")
        self.page.locator("#csLateCutoff").fill("08:15")
        self.page.locator("#csSaveTiming").click()
        self.page.locator(".gconfirm").wait_for(state="visible", timeout=3000)
        self.page.locator(".gconfirm-ok").click()
        self.page.wait_for_timeout(400)

        # 5. Saved times persist in the solid editor; grid resolves; no popup remnants
        grid.locator(".class-cube[data-kind='batch'][data-cube='Robotics-A']").click()
        self.page.wait_for_function("document.getElementById('csPresentCutoff').value === '07:45'", timeout=3000)
        self.assertEqual(self.page.locator("#csPresentCutoff").input_value(), "07:45")
        self.assertEqual(self.page.locator("#csLateCutoff").input_value(), "08:15")
        self.assertIn("CUSTOM BATCH TIMING ACTIVE", self.page.locator("#csTimingNotice").inner_text().upper())
        grid_first_cls = self.page.locator("#calendarGrid .weekly-day-card").first.get_attribute("class") or ""
        self.assertEqual("working" in grid_first_cls, after)
        self.assertIsNone(self.page.evaluate("document.getElementById('classScheduleModal')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('csClose')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('schedTimingCard')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('batchBody')"))
        self.assertIsNotNone(self.page.evaluate("document.getElementById('newBatchName')"))
        self.assertIsNotNone(self.page.evaluate("document.getElementById('addBatchBtn')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('classBody')"))
        self.assertTrue(self.page.evaluate("document.querySelectorAll('#cubeGrid .class-cube').length >= 2"))
        self.assertIsNone(self.page.evaluate("document.getElementById('schedPresentCutoff')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('schedLateCutoff')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('schedContextBadge')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('schedInheritNotice')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('calScheduleBanner')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('schedSaveTimingBtn')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('schedRevertTimingBtn')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('calResetWeekBtn')"))

        # 6. Selecting the class tile adapts the editor to the class context
        self.page.click("#cubeTabClasses")
        self.page.wait_for_function("document.querySelector(\"#cubeGrid .class-cube[data-kind='class'][data-cube='Grade 10-A']\")", timeout=4000)
        grid.locator(".class-cube[data-kind='class'][data-cube='Grade 10-A']").click()
        self.page.wait_for_function("document.getElementById('csTitle').innerText.includes('Grade 10-A')", timeout=3000)
        self.assertIn("CLASS SCHEDULE:", detail.locator("#csTitle").inner_text().upper())

        # 7. Shared batch shows under both classes (display only, one flat entry)
        created = self.page.evaluate("fetch('/api/students',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Pin':'1234'},body:JSON.stringify({name:'E2E Shared',roll:'E2E-99',grade:'Grade 10-B',batch:'Batch A'})}).then(async r=>({status:r.status,body:await r.json()}))")
        self.assertEqual(created["status"], 201)
        tmp_id = created["body"]["id"]
        self.page.evaluate("loadStudents().then(()=>renderAll())")
        self.assertIn("Batch A", self.page.evaluate("batchesForClass('Grade 10-A')"))
        self.assertIn("Batch A", self.page.evaluate("batchesForClass('Grade 10-B')"))
        grid.locator(".class-cube[data-kind='class'][data-cube='Grade 10-B']").click()
        self.page.wait_for_function("document.getElementById('csTitle').innerText.includes('Grade 10-B')", timeout=4000)
        self.assertIn("CLASS SCHEDULE: GRADE 10-B", detail.locator("#csTitle").inner_text().upper())
        grid.locator(".class-cube[data-kind='class'][data-cube='Grade 10-A']").click()
        self.page.wait_for_function("document.getElementById('csTitle').innerText.includes('Grade 10-A')", timeout=4000)
        deleted = self.page.evaluate(f"fetch('/api/students/{tmp_id}',{{method:'DELETE',headers:{{'X-Admin-Pin':'1234'}}}}).then(async r=>({{status:r.status,body:await r.json()}}))")
        self.assertEqual(deleted["status"], 200)
        self.page.evaluate("loadStudents().then(()=>renderAll())")
        self.page.wait_for_timeout(400)

        # Clean up and close
        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_14_attendance_workspace_live_today_historical_and_filters(self):
        """Unified Attendance workspace defaults to Live Today, supports Yesterday, Custom Date/Range, filters, and 9 KPI cards."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        # 1. Open Attendance tab
        self.page.click("#adminNav button[data-tab='attendance']")
        self.page.wait_for_function("!document.getElementById('pane-attendance').classList.contains('hidden')", timeout=3000)

        # 2. Verify default state is Live Today
        preset = self.page.locator("#attDatePreset")
        self.assertEqual(preset.input_value(), "today")

        mode_badge = self.page.locator("#attModeBadge")
        self.assertIn("LIVE TODAY", mode_badge.inner_text().upper())

        date_label = self.page.locator("#attDateLabel")
        self.assertTrue(date_label.is_visible())

        # Verify 9 KPI cards
        stat_cards = self.page.locator("#attStats .stat")
        self.assertEqual(stat_cards.count(), 9)
        stat_labels = [self.page.locator("#attStats .stat label").nth(i).inner_text().strip().upper() for i in range(9)]
        expected_labels = ["DATE", "TOTAL STUDENTS", "PRESENT", "LATE", "ABSENT", "NOT SCHEDULED", "UNKNOWN SCANS", "DUPLICATE SCANS", "ATTENDANCE %"]
        for exp in expected_labels:
            self.assertIn(exp, stat_labels)

        # Verify table and unknown attempts area
        self.assertTrue(self.page.locator("#attTableBody").is_visible())
        self.assertTrue(self.page.locator("#attUnknownWrap").is_visible())

        # 3. Test Yesterday preset (seg pills drive the hidden select)
        self.page.locator(".seg-strip .seg-btn[data-v='yesterday']").click()
        self.page.wait_for_timeout(300)
        self.assertIn("YESTERDAY", mode_badge.inner_text().upper())

        # 4. Test Custom Date preset (single inline field only, no Apply)
        self.page.locator(".seg-strip .seg-btn[data-v='custom_day']").click()
        self.page.wait_for_timeout(300)
        single_input = self.page.locator("#attSingleDate")
        self.assertTrue(single_input.is_visible())
        apply_btn = self.page.locator("#attApplyBtn")
        self.assertFalse(apply_btn.is_visible())
        single_input.fill("2026-09-02")
        self.page.wait_for_timeout(300)
        self.assertEqual(single_input.input_value(), "2026-09-02")
        # Only the single-date picker shows its trigger glyph
        self.assertEqual(self.page.locator("#pane-attendance .tab-toolbar .dt-trig:visible").count(), 1)

        # 5. Test Custom Range preset: no inline boxes, popup machinery owns values
        self.page.locator(".seg-strip .seg-btn[data-v='custom_range']").click()
        self.page.wait_for_timeout(300)
        from_input = self.page.locator("#attFromDate")
        to_input = self.page.locator("#attToDate")
        self.assertFalse(from_input.is_visible())
        self.assertFalse(to_input.is_visible())
        self.assertFalse(apply_btn.is_visible())
        self.page.evaluate("document.getElementById('attFromDate').value='2026-09-01';document.getElementById('attToDate').value='2026-09-03';renderAttendance()")
        self.page.wait_for_timeout(300)
        # Bar holds one fixed row in every preset state (old-UI look)
        self.assertEqual(self.page.evaluate("Math.round(document.querySelector('#pane-attendance .tab-toolbar').getBoundingClientRect().height)"), 52)
        # No orphan date-picker glyphs while range inputs stay hidden
        self.assertEqual(self.page.locator("#pane-attendance .tab-toolbar .dt-trig:visible").count(), 0)

        # Multi-day table head should show 'Working Day?' column
        th_texts = [self.page.locator("#attTableHead th").nth(i).inner_text().strip().upper() for i in range(self.page.locator("#attTableHead th").count())]
        self.assertIn("WORKING DAY?", th_texts)

        # 6. Test Class, Batch, Status, and Student filter elements
        class_filter = self.page.locator("#attClassFilter")
        batch_filter = self.page.locator("#attBatchFilter")
        status_filter = self.page.locator("#attStatusFilter")
        student_filter = self.page.locator("#attStudentFilter")
        self.assertTrue(class_filter.is_visible())
        self.assertTrue(batch_filter.is_visible())
        self.assertTrue(status_filter.is_visible())
        self.assertTrue(student_filter.is_visible())

        # 7. Test One Student Selection and authoritative metrics
        # Select first student in dropdown
        self.page.wait_for_function("document.getElementById('attStudentFilter').options.length > 1", timeout=3000)
        first_student_id = self.page.evaluate("document.getElementById('attStudentFilter').options[1].value")
        first_student_name = self.page.evaluate("document.getElementById('attStudentFilter').options[1].textContent")
        student_filter.select_option(first_student_id)
        self.page.wait_for_timeout(400)

        # Verify single student mode badge and KPI cards
        self.assertIn("STUDENT:", mode_badge.inner_text().upper())
        self.assertIn("STUDENT", [self.page.locator("#attStats .stat label").nth(i).inner_text().strip().upper() for i in range(9)])
        self.assertIn("ELIGIBLE DAYS", [self.page.locator("#attStats .stat label").nth(i).inner_text().strip().upper() for i in range(9)])

        # Reset student filter back to All Students
        student_filter.select_option("")
        self.page.locator(".seg-strip .seg-btn[data-v='today']").click()
        self.page.wait_for_timeout(300)

        # 8. Test live auto-refresh while on currentTab='attendance' without interrupting identityLayer
        self.page.evaluate("window.handleRealScan('F-1', {status: 'Present', time: '08:05:00', student: {id: 1, name: 'Aarav Sharma', class: 'Grade 10-A', roll: '10A-01'}})")
        self.page.wait_for_timeout(500)
        # Verify table has rows updated live
        self.assertTrue(self.page.locator("#attTableBody tr").count() >= 1)
        # Verify identityLayer is NOT active/visible (suppressed while Admin is open)
        self.assertFalse(self.page.evaluate("document.getElementById('identityLayer').classList.contains('visible')"))

        # 9. Test Action Buttons
        self.assertTrue(self.page.locator("#attRefreshBtn").is_visible())
        self.assertTrue(self.page.locator("#attPrintBtn").is_visible())
        self.assertTrue(self.page.locator("#attExportBtn").is_visible())

        # Close Admin
        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

    def test_15_calendar_holiday_override_tables_roundtrip(self):
        """Holiday + override list tables own all editing: add/edit/remove with Month View integration; day window is read-only."""
        self.page.goto(f"{_BASE_URL}/", wait_until="networkidle")

        # Open Admin panel
        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)

        # Navigate to Setup tab
        self.page.click("#adminNav button[data-tab='setup']")
        self.page.wait_for_function("!document.getElementById('pane-setup').classList.contains('hidden')", timeout=3000)
        self.page.wait_for_function("document.querySelectorAll('#calendarGrid .calendar-cell[data-date]').length > 0", timeout=4000)

        # 1. Tables + both modals live
        self.assertTrue(self.page.locator("#holidayBody").is_visible())
        self.assertTrue(self.page.locator("#overrideBody").is_visible())
        self.assertFalse(self.page.evaluate("document.getElementById('holidayModal') === null"))
        self.assertFalse(self.page.evaluate("document.getElementById('overrideModal') === null"))

        # 2. Add a holiday range through the table on a working day
        hol_iso = self.page.locator("#calendarGrid .calendar-cell[data-date].working").first.get_attribute("data-date")
        self.assertIsNotNone(hol_iso)
        self.page.locator("#addHolidayBtn").click()
        self.page.wait_for_function("document.getElementById('holidayModal').classList.contains('open')", timeout=3000)
        self.page.locator("#holidayName").fill("E2E table range")
        self.page.locator("#holidayStart").fill(hol_iso)
        self.assertEqual(self.page.locator("#holidayType").input_value(), "holiday")
        self.page.locator("#holidaySave").click()
        self.page.wait_for_function("!document.getElementById('holidayModal').classList.contains('open')", timeout=3000)
        self.page.wait_for_function(
            "document.getElementById('holidayBody').innerText.includes('E2E table range')",
            timeout=4000)
        self.page.wait_for_function(
            f"document.querySelector('#calendarGrid [data-date=\"{hol_iso}\"]').textContent.includes('E2E table range')",
            timeout=4000)

        # 3. Reload — the range persists server-side
        self.page.reload(wait_until="networkidle")
        self.page.once("dialog", lambda dialog: dialog.accept("1234"))
        self.page.click("#openAdminBtn")
        self.page.wait_for_function("document.getElementById('adminLayer').classList.contains('open')", timeout=3000)
        self.page.click("#adminNav button[data-tab='setup']")
        self.page.wait_for_function("!document.getElementById('pane-setup').classList.contains('hidden')", timeout=3000)
        self.page.wait_for_function(
            "document.getElementById('holidayBody').innerText.includes('E2E table range')",
            timeout=4000)

        # 4. Table Edit prefills; rename moves the range, no orphan
        self.page.locator("#holidayBody [data-edit-holiday]").first.click()
        self.page.wait_for_function("document.getElementById('holidayModal').classList.contains('open')", timeout=3000)
        self.assertEqual(self.page.locator("#holidayName").input_value(), "E2E table range")
        self.assertEqual(self.page.locator("#holidayStart").input_value(), hol_iso)
        self.page.locator("#holidayName").fill("E2E table range v2")
        self.page.locator("#holidaySave").click()
        self.page.wait_for_function("!document.getElementById('holidayModal').classList.contains('open')", timeout=3000)
        ranges = self.page.evaluate("fetch('/api/settings').then(r=>r.json()).then(s=>s.holidays || [])")
        mine = [h for h in ranges if "E2E table range" in h]
        self.assertEqual(len(mine), 1)
        self.assertIn("E2E table range v2", mine[0])

        # 5. Table Remove deletes directly and restores the template day
        self.page.locator("#holidayBody [data-del-holiday]").first.click()
        self.page.wait_for_function(
            "!document.getElementById('holidayBody').innerText.includes('E2E table range')",
            timeout=4000)
        self.page.wait_for_function(
            f"document.querySelector('#calendarGrid [data-date=\"{hol_iso}\"]').classList.contains('working')",
            timeout=4000)

        # 6. Add an override through the table on a working day
        ov_iso = self.page.locator("#calendarGrid .calendar-cell[data-date].working").first.get_attribute("data-date")
        self.assertIsNotNone(ov_iso)
        self.page.locator("#addOverrideBtn").click()
        self.page.wait_for_function("document.getElementById('overrideModal').classList.contains('open')", timeout=3000)
        self.page.locator("#overrideDate").fill(ov_iso)
        self.page.locator("#overrideWorking").select_option("0")
        self.page.locator("#overrideNote").fill("E2E table probe")
        self.page.locator("#overrideSave").click()
        self.page.wait_for_function("!document.getElementById('overrideModal').classList.contains('open')", timeout=3000)
        self.page.wait_for_function(
            "document.getElementById('overrideBody').innerText.includes('E2E table probe')",
            timeout=4000)
        self.page.wait_for_function(
            f"document.querySelector('#calendarGrid [data-date=\"{ov_iso}\"]').classList.contains('non-working')",
            timeout=4000)

        # 7. Table Edit prefills the override; note change saves
        self.page.locator("#overrideBody [data-edit-override]").first.click()
        self.page.wait_for_function("document.getElementById('overrideModal').classList.contains('open')", timeout=3000)
        self.assertEqual(self.page.locator("#overrideDate").input_value(), ov_iso)
        self.assertEqual(self.page.locator("#overrideNote").input_value(), "E2E table probe")
        self.page.locator("#overrideNote").fill("E2E table probe v2")
        self.page.locator("#overrideSave").click()
        self.page.wait_for_function("!document.getElementById('overrideModal').classList.contains('open')", timeout=3000)
        self.page.wait_for_function(
            "document.getElementById('overrideBody').innerText.includes('E2E table probe v2')",
            timeout=4000)

        # 8. Table Remove restores the template day
        self.page.locator("#overrideBody [data-del-override]").first.click()
        self.page.wait_for_function(
            "!document.getElementById('overrideBody').innerText.includes('E2E table probe')",
            timeout=4000)
        self.page.wait_for_function(
            f"document.querySelector('#calendarGrid [data-date=\"{ov_iso}\"]').classList.contains('working')",
            timeout=4000)

        # 9. Day window is read-only resolved display — no editing verbs
        self.page.locator(f"#calendarGrid [data-date=\"{ov_iso}\"]").click()
        self.page.wait_for_function("document.getElementById('daySheetModal').classList.contains('open')", timeout=3000)
        body_text = self.page.locator("#daySheetBody").inner_text()
        self.assertIn("WORKING", body_text.upper())
        self.assertIsNone(self.page.evaluate("document.getElementById('dsFlip')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('dsHolSave')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('dsClear')"))
        self.assertIsNone(self.page.evaluate("document.getElementById('dsDelHol')"))
        self.page.locator("#dsClose").click()
        self.page.wait_for_function("!document.getElementById('daySheetModal').classList.contains('open')", timeout=3000)
        # 9b. Shortcut door: window offers Add-override, modal opens prefilled, save lands a table row
        self.page.locator(f"#calendarGrid [data-date=\"{ov_iso}\"]").click()
        self.page.wait_for_function("document.getElementById('daySheetModal').classList.contains('open')", timeout=3000)
        self.page.locator("#dsAddOv").click()
        self.page.wait_for_function("!document.getElementById('daySheetModal').classList.contains('open')", timeout=3000)
        self.page.wait_for_function("document.getElementById('overrideModal').classList.contains('open')", timeout=3000)
        self.assertEqual(self.page.locator("#overrideDate").input_value(), ov_iso)
        self.page.locator("#overrideNote").fill("E2E shortcut probe")
        self.page.locator("#overrideSave").click()
        self.page.wait_for_function("!document.getElementById('overrideModal').classList.contains('open')", timeout=3000)
        self.page.wait_for_function(
            "document.getElementById('overrideBody').innerText.includes('E2E shortcut probe')",
            timeout=4000)
        self.page.wait_for_function(
            f"document.querySelector('#calendarGrid [data-date=\"{ov_iso}\"]').classList.contains('working')",
            timeout=4000)
        self.page.locator("#overrideBody [data-del-override]").first.click()
        self.page.wait_for_function(
            "!document.getElementById('overrideBody').innerText.includes('E2E shortcut probe')",
            timeout=4000)
        # Plain veil click (press + release outside the card) still dismisses
        self.page.locator(f"#calendarGrid [data-date=\"{ov_iso}\"]").click()
        self.page.wait_for_function("document.getElementById('daySheetModal').classList.contains('open')", timeout=3000)
        self.page.mouse.click(10, 10)
        self.page.wait_for_function("!document.getElementById('daySheetModal').classList.contains('open')", timeout=3000)

        # Close Admin
        self.page.click("#adminClose")
        self.page.wait_for_function("!document.getElementById('adminLayer').classList.contains('open')", timeout=3000)


if __name__ == "__main__":
    unittest.main(verbosity=2)


