#!/usr/bin/env python3
"""
ATL Smart Attendance — Google Drive OAuth 2.0 Resumable Backup Engine
Offline-first, non-blocking cloud backup using SQLite Online Backup API.
Scope: https://www.googleapis.com/auth/drive.file (least-privilege).
"""

import os
import json
import time
import sqlite3
import hashlib
import datetime
import urllib.request
import urllib.parse
import urllib.error

# Dedicated folder name in user's Google Drive
DEFAULT_FOLDER_NAME = "ATL-Attendance-Backups"
OAUTH_DEVICE_CODE_URI = "https://oauth2.googleapis.com/device/code"
OAUTH_TOKEN_URI = "https://oauth2.googleapis.com/token"
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"

CHUNK_SIZE = 1024 * 1024  # 1 MB chunk for resumable upload


class GDriveBackupError(Exception):
    """Base exception for Google Drive backup operations."""
    pass


class GDriveAuthError(GDriveBackupError):
    """Authentication or token error requiring operator action."""
    pass


class GDriveNetworkError(GDriveBackupError):
    """Transient network error suitable for retry."""
    pass


# ---------------------------------------------------------------------------
# 1. SQLite Online Snapshot & Validation
# ---------------------------------------------------------------------------

def create_online_snapshot(src_db_path: str, staging_path: str, db_lock=None) -> dict:
    """
    Creates an atomic, consistent SQLite snapshot using the SQLite Online Backup API.
    Locks DB_LOCK only during the brief snapshot creation, releasing it immediately.
    Validates integrity, header, tables, and computes SHA-256.
    """
    if not os.path.exists(src_db_path):
        raise GDriveBackupError(f"Source database not found: {src_db_path}")

    os.makedirs(os.path.dirname(staging_path) or ".", exist_ok=True)
    if os.path.exists(staging_path):
        try:
            os.remove(staging_path)
        except Exception:
            pass

    # Step 1: Perform online backup
    try:
        src_conn = sqlite3.connect(src_db_path, timeout=10)
        # Flush outstanding WAL pages first if possible
        try:
            src_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass

        dest_conn = sqlite3.connect(staging_path)
        if db_lock:
            with db_lock:
                src_conn.backup(dest_conn)
        else:
            src_conn.backup(dest_conn)

        dest_conn.close()
        src_conn.close()
    except Exception as e:
        if os.path.exists(staging_path):
            try: os.remove(staging_path)
            except Exception: pass
        raise GDriveBackupError(f"Snapshot backup failed: {e}")

    # Step 2: Validate snapshot
    try:
        with open(staging_path, "rb") as f:
            header = f.read(16)
            if not header.startswith(b"SQLite format 3\x00"):
                raise GDriveBackupError("Snapshot validation failed: invalid SQLite header")

        val_conn = sqlite3.connect(staging_path)
        val_cur = val_conn.cursor()

        # PRAGMA integrity_check
        row = val_cur.execute("PRAGMA integrity_check").fetchone()
        if not row or row[0] != "ok":
            val_conn.close()
            raise GDriveBackupError(f"Snapshot integrity check failed: {row[0] if row else 'null'}")

        # Required tables check
        tables = {r[0] for r in val_cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        required_tables = {"students", "events", "daily", "settings"}
        if not required_tables.issubset(tables):
            val_conn.close()
            raise GDriveBackupError(f"Snapshot missing required tables: {required_tables - tables}")

        # Sanity counts
        student_count = val_cur.execute("SELECT COUNT(*) FROM students").fetchone()[0]
        val_conn.close()

        # Step 3: Compute SHA-256 and byte size
        sha256 = hashlib.sha256()
        total_bytes = 0
        with open(staging_path, "rb") as f:
            while chunk := f.read(65536):
                sha256.update(chunk)
                total_bytes += len(chunk)

        checksum = sha256.hexdigest()
        return {
            "path": staging_path,
            "bytes": total_bytes,
            "sha256": checksum,
            "students": student_count
        }
    except Exception as e:
        if os.path.exists(staging_path):
            try: os.remove(staging_path)
            except Exception: pass
        raise GDriveBackupError(f"Snapshot validation error: {e}")


# ---------------------------------------------------------------------------
# 2. OAuth 2.0 Credentials & Token Management
# ---------------------------------------------------------------------------

class GDriveClient:
    """Manages Google Drive OAuth 2.0 authentication and API requests."""

    def __init__(self, client_config: dict, token_file_path: str):
        self.client_id = client_config.get("client_id", "")
        self.client_secret = client_config.get("client_secret", "")
        self.token_file_path = token_file_path
        self.tokens = self._load_tokens()

    def is_configured(self) -> bool:
        """Returns True if client_id and client_secret are present."""
        return bool(self.client_id and self.client_secret)

    def is_authenticated(self) -> bool:
        """Returns True if a valid or refreshable token is present."""
        return bool(self.tokens and (self.tokens.get("refresh_token") or self.tokens.get("access_token")))

    def _load_tokens(self) -> dict:
        if not self.token_file_path or not os.path.exists(self.token_file_path):
            return {}
        try:
            with open(self.token_file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_tokens(self, tokens: dict):
        self.tokens = tokens
        if not self.token_file_path:
            return
        os.makedirs(os.path.dirname(self.token_file_path) or ".", exist_ok=True)
        with open(self.token_file_path, "w", encoding="utf-8") as f:
            json.dump(tokens, f, indent=2)
        try:
            if hasattr(os, "chmod"):
                os.chmod(self.token_file_path, 0o600)
        except Exception:
            pass

    def disconnect(self):
        """Clears local tokens and unlinks the token file."""
        self.tokens = {}
        if self.token_file_path and os.path.exists(self.token_file_path):
            try:
                os.remove(self.token_file_path)
            except Exception:
                pass

    def start_device_flow(self) -> dict:
        """Requests a device code and user code from Google Device Authorization endpoint."""
        if not self.is_configured():
            raise GDriveAuthError("Google OAuth Client ID and Secret are not configured.")
        data = urllib.parse.urlencode({
            "client_id": self.client_id,
            "scope": DRIVE_SCOPE
        }).encode("utf-8")
        req = urllib.request.Request(OAUTH_DEVICE_CODE_URI, data=data, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                user_code = res.get("user_code", "")
                v_url = res.get("verification_url", "https://www.google.com/device")
                v_url_complete = res.get("verification_url_complete") or f"{v_url}?user_code={user_code}"
                return {
                    "device_code": res.get("device_code", ""),
                    "user_code": user_code,
                    "verification_url": v_url,
                    "verification_url_complete": v_url_complete,
                    "expires_in": res.get("expires_in", 1800),
                    "interval": max(int(res.get("interval", 5)), 5)
                }
        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                msg = err_body.get("error_description") or err_body.get("error") or str(e)
            except Exception:
                msg = str(e)
            raise GDriveAuthError(f"Google Device Authorization error ({e.code}): {msg}")
        except urllib.error.URLError as e:
            raise GDriveNetworkError(f"Network error contacting Google: {e.reason}")

    def poll_device_flow(self, device_code: str) -> dict:
        """
        Polls Google token endpoint for device authorization grant completion.
        Returns {"status": "pending"} | {"status": "slow_down"} | {"status": "success", "tokens": ...}
        Raises GDriveAuthError on denial or expiration.
        """
        if not self.is_configured():
            raise GDriveAuthError("Google OAuth Client ID and Secret are not configured.")
        data = urllib.parse.urlencode({
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "device_code": device_code.strip(),
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
        }).encode("utf-8")
        req = urllib.request.Request(OAUTH_TOKEN_URI, data=data, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                tokens = {
                    "access_token": res["access_token"],
                    "refresh_token": res.get("refresh_token") or (self.tokens.get("refresh_token") if self.tokens else ""),
                    "expires_at": int(time.time()) + int(res.get("expires_in", 3600)),
                    "token_type": res.get("token_type", "Bearer"),
                    "scope": res.get("scope", DRIVE_SCOPE)
                }
                self._save_tokens(tokens)
                return {"status": "success", "tokens": tokens}
        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                err_code = err_body.get("error", "")
            except Exception:
                err_code = ""
            if err_code == "authorization_pending":
                return {"status": "pending"}
            elif err_code == "slow_down":
                return {"status": "slow_down"}
            elif err_code in ("expired_token", "access_denied"):
                raise GDriveAuthError(f"Google authorization {err_code.replace('_', ' ')}.")
            else:
                msg = err_body.get("error_description") or err_code or str(e)
                raise GDriveAuthError(f"Google authorization failed ({e.code}): {msg}")
        except urllib.error.URLError as e:
            raise GDriveNetworkError(f"Network error contacting Google: {e.reason}")

    def get_valid_access_token(self) -> str:
        """Returns a valid access token, automatically refreshing if expired."""
        if not self.tokens:
            raise GDriveAuthError("Google Drive is not authorized. Please connect your account.")

        now = int(time.time())
        expires_at = self.tokens.get("expires_at", 0)
        access_token = self.tokens.get("access_token", "")

        # Refresh if within 5 minutes of expiration
        if access_token and (expires_at - now > 300):
            return access_token

        refresh_token = self.tokens.get("refresh_token")
        if not refresh_token:
            raise GDriveAuthError("No refresh token available. Re-authorization required.")

        data = urllib.parse.urlencode({
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token"
        }).encode("utf-8")
        req = urllib.request.Request(OAUTH_TOKEN_URI, data=data, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                token_data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            if e.code in (400, 401):
                raise GDriveAuthError(f"Token refresh rejected ({e.code}): {err_body}. Re-authorization required.")
            raise GDriveNetworkError(f"Google OAuth server error ({e.code}): {err_body}")
        except Exception as e:
            raise GDriveNetworkError(f"Network error during token refresh: {e}")

        new_access_token = token_data.get("access_token")
        if not new_access_token:
            raise GDriveAuthError("Google OAuth server returned no access token.")

        self.tokens["access_token"] = new_access_token
        self.tokens["expires_at"] = now + token_data.get("expires_in", 3600)
        if "refresh_token" in token_data:
            self.tokens["refresh_token"] = token_data["refresh_token"]
        self._save_tokens(self.tokens)
        return new_access_token


# ---------------------------------------------------------------------------
# 3. Google Drive API Operations & Resumable Upload
# ---------------------------------------------------------------------------

class GDriveStorage:
    """Handles Drive API calls: folder management, resumable uploads, listing, and pruning."""

    def __init__(self, client: GDriveClient, folder_name: str = DEFAULT_FOLDER_NAME):
        self.client = client
        self.folder_name = folder_name
        self._folder_id = None

    def get_or_create_backup_folder(self) -> str:
        """Finds or creates the dedicated backup folder inside Google Drive."""
        if self._folder_id:
            return self._folder_id

        token = self.client.get_valid_access_token()
        # Query existing folder
        q = f"name = '{self.folder_name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
        url = f"{DRIVE_API_BASE}/files?{urllib.parse.urlencode({'q': q, 'fields': 'files(id, name)'})}"
        req = urllib.request.Request(url)
        req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                files = data.get("files", [])
                if files:
                    self._folder_id = files[0]["id"]
                    return self._folder_id
        except urllib.error.HTTPError as e:
            raise GDriveNetworkError(f"Failed to query backup folder ({e.code}): {e.read().decode()}")
        except Exception as e:
            raise GDriveNetworkError(f"Network error querying backup folder: {e}")

        # Create folder if not found
        create_url = f"{DRIVE_API_BASE}/files"
        meta = json.dumps({
            "name": self.folder_name,
            "mimeType": "application/vnd.google-apps.folder",
            "description": "Automated backups for ATL Smart Attendance System"
        }).encode("utf-8")
        create_req = urllib.request.Request(create_url, data=meta, method="POST")
        create_req.add_header("Authorization", f"Bearer {token}")
        create_req.add_header("Content-Type", "application/json; charset=UTF-8")
        try:
            with urllib.request.urlopen(create_req, timeout=15) as resp:
                new_folder = json.loads(resp.read().decode("utf-8"))
                self._folder_id = new_folder["id"]
                return self._folder_id
        except Exception as e:
            raise GDriveNetworkError(f"Failed to create backup folder: {e}")

    def upload_snapshot_resumable(self, snapshot_info: dict, max_retries: int = 3) -> dict:
        """
        Uploads a validated snapshot to Google Drive using the Resumable Upload protocol.
        Handles chunking, byte-range tracking, and transient network retries.
        """
        staging_path = snapshot_info["path"]
        file_size = snapshot_info["bytes"]
        checksum = snapshot_info["sha256"]
        file_name = os.path.basename(staging_path)

        folder_id = self.get_or_create_backup_folder()
        token = self.client.get_valid_access_token()

        # Step 1: Initiate Resumable Session
        init_url = f"{DRIVE_UPLOAD_BASE}/files?uploadType=resumable"
        metadata = json.dumps({
            "name": file_name,
            "parents": [folder_id],
            "description": f"ATL Attendance Backup — SHA256: {checksum}",
            "appProperties": {
                "sha256": checksum,
                "students": str(snapshot_info.get("students", 0)),
                "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()
            }
        }).encode("utf-8")

        init_req = urllib.request.Request(init_url, data=metadata, method="POST")
        init_req.add_header("Authorization", f"Bearer {token}")
        init_req.add_header("Content-Type", "application/json; charset=UTF-8")
        init_req.add_header("X-Upload-Content-Type", "application/octet-stream")
        init_req.add_header("X-Upload-Content-Length", str(file_size))

        try:
            with urllib.request.urlopen(init_req, timeout=20) as resp:
                upload_uri = resp.headers.get("Location")
                if not upload_uri:
                    raise GDriveNetworkError("Resumable upload session initiated but no Location header received")
        except urllib.error.HTTPError as e:
            raise GDriveNetworkError(f"Failed to initiate resumable upload ({e.code}): {e.read().decode()}")
        except Exception as e:
            raise GDriveNetworkError(f"Network error initiating resumable upload: {e}")

        # Step 2: Stream chunks
        with open(staging_path, "rb") as f:
            start_byte = 0
            while start_byte < file_size:
                end_byte = min(start_byte + CHUNK_SIZE, file_size) - 1
                chunk_len = end_byte - start_byte + 1
                f.seek(start_byte)
                chunk_data = f.read(chunk_len)

                # Attempt chunk upload with retry
                chunk_success = False
                last_chunk_err = None
                for attempt in range(max_retries):
                    try:
                        chunk_req = urllib.request.Request(upload_uri, data=chunk_data, method="PUT")
                        chunk_req.add_header("Content-Type", "application/octet-stream")
                        chunk_req.add_header("Content-Range", f"bytes {start_byte}-{end_byte}/{file_size}")

                        with urllib.request.urlopen(chunk_req, timeout=30) as chunk_resp:
                            resp_code = getattr(chunk_resp, "status", getattr(chunk_resp, "code", 200))
                            if resp_code in (200, 201):
                                resp_bytes = chunk_resp.read()
                                body = json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {}
                                return {
                                    "fileId": body.get("id"),
                                    "name": body.get("name"),
                                    "size": file_size,
                                    "sha256": checksum,
                                    "status": "success"
                                }
                            elif resp_code == 308:
                                range_hdr = chunk_resp.headers.get("Range")
                                if range_hdr:
                                    start_byte = int(range_hdr.split("-")[1]) + 1
                                else:
                                    start_byte = end_byte + 1
                                chunk_success = True
                                break
                    except urllib.error.HTTPError as e:
                        if e.code == 308:
                            range_hdr = e.headers.get("Range")
                            if range_hdr:
                                start_byte = int(range_hdr.split("-")[1]) + 1
                            else:
                                start_byte = end_byte + 1
                            chunk_success = True
                            break
                        last_chunk_err = e
                        time.sleep(1 + attempt * 2)
                    except Exception as e:
                        last_chunk_err = e
                        time.sleep(1 + attempt * 2)

                if not chunk_success:
                    raise GDriveNetworkError(f"Chunk upload failed after {max_retries} attempts: {last_chunk_err}")

        raise GDriveNetworkError("Resumable upload ended without completion confirmation")

    def list_backups(self) -> list:
        """Lists all attendance backup snapshots available in the Google Drive folder."""
        folder_id = self.get_or_create_backup_folder()
        token = self.client.get_valid_access_token()
        q = f"'{folder_id}' in parents and trashed = false and name contains 'atl_backup_'"
        fields = "files(id, name, size, createdTime, appProperties, md5Checksum)"
        url = f"{DRIVE_API_BASE}/files?{urllib.parse.urlencode({'q': q, 'fields': fields, 'orderBy': 'name desc'})}"
        req = urllib.request.Request(url)
        req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("files", [])
        except Exception as e:
            raise GDriveNetworkError(f"Failed to list cloud backups: {e}")

    def download_backup(self, file_id: str, dest_path: str):
        """Downloads a remote backup snapshot to local destination."""
        token = self.client.get_valid_access_token()
        url = f"{DRIVE_API_BASE}/files/{file_id}?alt=media"
        req = urllib.request.Request(url)
        req.add_header("Authorization", f"Bearer {token}")
        os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                with open(dest_path, "wb") as out:
                    while chunk := resp.read(65536):
                        out.write(chunk)
        except Exception as e:
            if os.path.exists(dest_path):
                try: os.remove(dest_path)
                except Exception: pass
            raise GDriveNetworkError(f"Failed to download cloud backup ({file_id}): {e}")

    def prune_retention(self, keep_daily=7, keep_weekly=4, keep_monthly=12) -> list:
        """
        Prunes older backups using Grandfather-Father-Son retention:
        - Keeps last 7 daily backups
        - Keeps last 4 weekly backups (Saturdays)
        - Keeps last 12 monthly backups (1st of month)
        """
        files = self.list_backups()
        if len(files) <= keep_daily:
            return []

        import re
        date_pattern = re.compile(r"atl_backup_(\d{4}-\d{2}-\d{2})")

        entries = []
        for f in files:
            m = date_pattern.search(f["name"])
            if m:
                try:
                    d = datetime.date.fromisoformat(m.group(1))
                    entries.append({"file": f, "date": d})
                except Exception:
                    pass

        entries.sort(key=lambda x: x["date"], reverse=True)

        to_keep = set()
        dailies_kept = 0
        weeklies_kept = 0
        monthlies_kept = 0

        for item in entries:
            fid = item["file"]["id"]
            d = item["date"]
            kept = False

            if dailies_kept < keep_daily:
                to_keep.add(fid)
                dailies_kept += 1
                kept = True

            if not kept and d.weekday() == 5 and weeklies_kept < keep_weekly:
                to_keep.add(fid)
                weeklies_kept += 1
                kept = True

            if not kept and d.day == 1 and monthlies_kept < keep_monthly:
                to_keep.add(fid)
                monthlies_kept += 1
                kept = True

        deleted = []
        token = self.client.get_valid_access_token()
        for item in entries:
            fid = item["file"]["id"]
            if fid not in to_keep:
                del_url = f"{DRIVE_API_BASE}/files/{fid}"
                del_req = urllib.request.Request(del_url, method="DELETE")
                del_req.add_header("Authorization", f"Bearer {token}")
                try:
                    with urllib.request.urlopen(del_req, timeout=10):
                        deleted.append(fid)
                except Exception:
                    pass

        return deleted
