#!/usr/bin/env python3
"""Protocol-only CLI for one IMAP mailbox and one CalDAV calendar."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import email
import email.policy
import email.utils
import imaplib
import json
import os
import re
import ssl
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from email.header import decode_header, make_header
from email.message import Message
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen


VERSION = "0.1.0"
DAV = "DAV:"
CALDAV = "urn:ietf:params:xml:ns:caldav"
ET.register_namespace("d", DAV)
ET.register_namespace("c", CALDAV)

MAIL_PROVIDERS: dict[str, dict[str, Any]] = {
    "qq": {"domains": ["qq.com", "foxmail.com"], "host": "imap.qq.com", "port": 993, "security": "ssl", "auth": "password"},
    "netease163": {"domains": ["163.com"], "host": "imap.163.com", "port": 993, "security": "ssl", "auth": "password"},
    "netease126": {"domains": ["126.com"], "host": "imap.126.com", "port": 993, "security": "ssl", "auth": "password"},
    "netease-yeah": {"domains": ["yeah.net"], "host": "imap.yeah.net", "port": 993, "security": "ssl", "auth": "password"},
    "aliyun": {"domains": ["aliyun.com"], "host": "imap.aliyun.com", "port": 993, "security": "ssl", "auth": "password"},
    "gmail": {"domains": ["gmail.com", "googlemail.com"], "host": "imap.gmail.com", "port": 993, "security": "ssl", "auth": "xoauth2"},
    "outlook": {"domains": ["outlook.com", "hotmail.com", "live.com"], "host": "outlook.office365.com", "port": 993, "security": "ssl", "auth": "xoauth2"},
}

CALENDAR_PROVIDERS: dict[str, dict[str, Any]] = {
    "qq": {"base_url": "https://dav.qq.com/", "auth": "basic"},
    "google": {"base_url": "https://apidata.googleusercontent.com/caldav/v2/", "auth": "bearer"},
    "generic": {"base_url": "", "auth": "basic"},
}


class MailCalError(Exception):
    code = "MAILCAL_ERROR"
    exit_code = 1


class ConfigError(MailCalError):
    code = "CONFIG_ERROR"
    exit_code = 2


class ConnectionFailure(MailCalError):
    code = "CONNECTION_FAILED"
    exit_code = 3


class NotFoundError(MailCalError):
    code = "NOT_FOUND"
    exit_code = 4


class InputError(MailCalError):
    code = "INVALID_INPUT"
    exit_code = 5


def emit(data: Any) -> None:
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False, indent=2))


def default_config_path() -> Path:
    override = os.environ.get("MAILCAL_CONFIG")
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        root = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "mail-calendar" / "config.json"


def config_path(args: argparse.Namespace) -> Path:
    return Path(args.config).expanduser() if getattr(args, "config", None) else default_config_path()


def load_config(args: argparse.Namespace) -> dict[str, Any]:
    path = config_path(args)
    if not path.exists():
        raise ConfigError(f"Configuration not found: {path}. Run 'config init' first.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"Cannot read configuration {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ConfigError("Configuration root must be a JSON object")
    return value


def save_config(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def state_path(args: argparse.Namespace) -> Path:
    if getattr(args, "state", None):
        return Path(args.state).expanduser()
    override = os.environ.get("MAILCAL_STATE")
    if override:
        return Path(override).expanduser()
    return config_path(args).parent / "state.json"


def resolve_secret(reference: str) -> str:
    if not reference:
        raise ConfigError("Missing secret reference")
    if reference.startswith("env:"):
        name = reference[4:]
        value = os.environ.get(name)
        if value is None:
            raise ConfigError(f"Environment variable is not set: {name}")
        return value
    if reference.startswith("keyring:"):
        parts = reference.split(":", 2)
        if len(parts) != 3 or not parts[1] or not parts[2]:
            raise ConfigError("Keyring reference must be keyring:SERVICE:USERNAME")
        try:
            import keyring  # type: ignore
        except ImportError as exc:
            raise ConfigError("The optional 'keyring' package is required for keyring references") from exc
        value = keyring.get_password(parts[1], parts[2])
        if value is None:
            raise ConfigError(f"No credential found in keyring for {parts[1]}:{parts[2]}")
        return value
    raise ConfigError("Secret references must start with env: or keyring:")


def detect_mail_provider(address: str) -> str:
    if "@" not in address:
        raise InputError("Email address must contain @")
    domain = address.rsplit("@", 1)[1].lower()
    for name, preset in MAIL_PROVIDERS.items():
        if domain in preset["domains"]:
            return name
    return "generic"


def mail_settings(config: dict[str, Any]) -> dict[str, Any]:
    section = config.get("mail")
    if not isinstance(section, dict):
        raise ConfigError("Missing mail configuration")
    required = ("address", "host", "port", "security", "auth", "secret_ref")
    missing = [key for key in required if section.get(key) in (None, "")]
    if missing:
        raise ConfigError("Missing mail fields: " + ", ".join(missing))
    return section


def calendar_settings(config: dict[str, Any]) -> dict[str, Any]:
    section = config.get("calendar")
    if not isinstance(section, dict):
        raise ConfigError("Missing calendar configuration")
    required = ("base_url", "auth", "secret_ref")
    missing = [key for key in required if section.get(key) in (None, "")]
    if missing:
        raise ConfigError("Missing calendar fields: " + ", ".join(missing))
    if section["auth"] == "basic" and not section.get("username"):
        raise ConfigError("Calendar username is required for basic authentication")
    return section


def mailbox_key(settings: dict[str, Any]) -> str:
    identity = f"{str(settings['host']).lower()}\x1f{str(settings['address']).lower()}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, identity))


class StateStore:
    """Persistent IMAP cursor and per-message processing state in one JSON file."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.data: dict[str, Any] = {"version": 1, "mailbox_key": "", "folders": {}}
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ConfigError(f"Cannot read state file {path}: {exc}") from exc
            if not isinstance(loaded, dict) or loaded.get("version") != 1 or not isinstance(loaded.get("folders"), dict):
                raise ConfigError(f"Unsupported or invalid state file: {path}")
            self.data = loaded

    def close(self) -> None:
        return None

    def _save(self) -> None:
        handle = tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.path.parent, prefix=self.path.name + ".",
            suffix=".tmp", delete=False,
        )
        temporary = Path(handle.name)
        try:
            with handle:
                json.dump(self.data, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        finally:
            if temporary.exists():
                temporary.unlink()

    def _ensure_mailbox(self, key: str) -> None:
        current = str(self.data.get("mailbox_key", ""))
        if current and current != key:
            self.data = {"version": 1, "mailbox_key": key, "folders": {}}
        else:
            self.data["mailbox_key"] = key

    def _folder(self, key: str, folder: str, uidvalidity: str, *, create: bool) -> dict[str, Any] | None:
        self._ensure_mailbox(key)
        folders = self.data.setdefault("folders", {})
        value = folders.get(folder)
        if not isinstance(value, dict) or str(value.get("uidvalidity", "")) != uidvalidity:
            if not create:
                return None
            value = {"uidvalidity": uidvalidity, "last_scanned_uid": 0, "updated_at": "", "messages": {}}
            folders[folder] = value
        if not isinstance(value.get("messages"), dict):
            raise ConfigError(f"Invalid message state for folder: {folder}")
        return value

    def cursor(self, key: str, folder: str, uidvalidity: str) -> int:
        value = self._folder(key, folder, uidvalidity, create=False)
        return int(value.get("last_scanned_uid", 0)) if value else 0

    def record_discovered(
        self, key: str, folder: str, uidvalidity: str, headers: list[dict[str, Any]], last_uid: int,
    ) -> None:
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        value = self._folder(key, folder, uidvalidity, create=True)
        assert value is not None
        messages = value["messages"]
        for item in headers:
            uid = str(int(item["uid"]))
            if uid not in messages:
                messages[uid] = {
                    "message_id": item.get("message_id", ""), "subject": item.get("subject", ""),
                    "from": item.get("from", ""), "to": item.get("to", ""), "date": item.get("date", ""),
                    "status": "pending", "outcome": "", "event_uid": "",
                    "discovered_at": now, "processed_at": "",
                }
        value["last_scanned_uid"] = last_uid
        value["updated_at"] = now
        self._save()

    def pending(self, key: str, folder: str, uidvalidity: str, limit: int) -> list[dict[str, Any]]:
        value = self._folder(key, folder, uidvalidity, create=False)
        if not value:
            return []
        result: list[dict[str, Any]] = []
        for uid in sorted(value["messages"], key=int):
            item = value["messages"][uid]
            if item.get("status") != "pending":
                continue
            result.append({
                "uid": uid, "uidvalidity": uidvalidity, "message_id": item.get("message_id", ""),
                "subject": item.get("subject", ""), "from": item.get("from", ""),
                "to": item.get("to", ""), "date": item.get("date", ""),
                "discovered_at": item.get("discovered_at", ""),
            })
            if len(result) >= limit:
                break
        return result

    def acknowledge(
        self, key: str, folder: str, uidvalidity: str, items: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        acknowledged: list[dict[str, Any]] = []
        value = self._folder(key, folder, uidvalidity, create=False)
        if not value:
            raise NotFoundError(f"No stored messages for folder: {folder}")
        messages = value["messages"]
        normalized = [(str(int(str(item.get("uid", "")))), item) for item in items]
        for uid, _ in normalized:
            if uid not in messages:
                raise NotFoundError(f"Pending message UID not found: {uid}")
        for uid, item in normalized:
            outcome = str(item.get("outcome", "processed"))
            event_uid = str(item.get("event_uid", ""))
            messages[uid].update({"status": "processed", "outcome": outcome, "event_uid": event_uid, "processed_at": now})
            acknowledged.append({"uid": uid, "outcome": outcome, "event_uid": event_uid})
        value["updated_at"] = now
        self._save()
        return acknowledged

    def retry(self, key: str, folder: str, uidvalidity: str, uids: list[str]) -> list[str]:
        retried: list[str] = []
        value = self._folder(key, folder, uidvalidity, create=False)
        if not value:
            raise NotFoundError(f"No stored messages for folder: {folder}")
        messages = value["messages"]
        normalized = [str(int(raw_uid)) for raw_uid in uids]
        for uid in normalized:
            if uid not in messages:
                raise NotFoundError(f"Stored message UID not found: {uid}")
        for uid in normalized:
            messages[uid].update({"status": "pending", "outcome": "", "event_uid": "", "processed_at": ""})
            retried.append(uid)
        value["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        self._save()
        return retried

    def summary(self, key: str, folder: str) -> dict[str, Any]:
        self._ensure_mailbox(key)
        value = self.data.get("folders", {}).get(folder)
        if not isinstance(value, dict):
            value = {}
        counts: dict[str, int] = {}
        for item in value.get("messages", {}).values():
            status = str(item.get("status", "pending"))
            counts[status] = counts.get(status, 0) + 1
        return {
            "path": str(self.path),
            "folder": folder,
            "uidvalidity": value.get("uidvalidity", ""),
            "last_scanned_uid": value.get("last_scanned_uid", 0),
            "updated_at": value.get("updated_at", ""),
            "counts": counts,
        }

    def current_uidvalidity(self, key: str, folder: str) -> str:
        if str(self.data.get("mailbox_key", "")) != key:
            raise ConfigError("State belongs to another mailbox. Run 'mail pending' first.")
        value = self.data.get("folders", {}).get(folder)
        if not isinstance(value, dict) or not value.get("uidvalidity"):
            raise ConfigError("No mailbox cursor exists. Run 'mail pending' first.")
        return str(value["uidvalidity"])


def decode_mime_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except (LookupError, UnicodeDecodeError):
        return value


class _HTMLText(HTMLParser):
    BLOCKS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.ignored += 1
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self.ignored:
            self.ignored -= 1
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.ignored:
            self.parts.append(data)

    def text(self) -> str:
        value = "".join(self.parts).replace("\xa0", " ")
        value = re.sub(r"[ \t]+", " ", value)
        value = re.sub(r"\n\s*\n\s*\n+", "\n\n", value)
        return value.strip()


def html_to_text(value: str) -> str:
    parser = _HTMLText()
    parser.feed(value)
    parser.close()
    return parser.text()


def part_text(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        raw = part.get_payload()
        return raw if isinstance(raw, str) else ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def normalize_mail_date(value: str) -> str:
    if not value:
        return ""
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        return parsed.isoformat() if parsed else value
    except (TypeError, ValueError):
        return value


def parse_message(raw: bytes, uid: str) -> dict[str, Any]:
    message = email.message_from_bytes(raw, policy=email.policy.default)
    plain: list[str] = []
    html: list[str] = []
    attachments: list[dict[str, Any]] = []
    for part in message.walk():
        if part.is_multipart():
            continue
        disposition = part.get_content_disposition()
        filename = part.get_filename()
        if disposition == "attachment" or filename:
            payload = part.get_payload(decode=True) or b""
            attachments.append({
                "filename": decode_mime_header(filename),
                "content_type": part.get_content_type(),
                "size": len(payload),
            })
            continue
        if part.get_content_type() == "text/plain":
            plain.append(part_text(part))
        elif part.get_content_type() == "text/html":
            html.append(part_text(part))
    text = "\n\n".join(item.strip() for item in plain if item.strip())
    if not text and html:
        text = html_to_text("\n".join(html))
    return {
        "uid": uid,
        "message_id": str(message.get("Message-ID", "")),
        "subject": decode_mime_header(message.get("Subject")),
        "from": decode_mime_header(message.get("From")),
        "to": decode_mime_header(message.get("To")),
        "date": normalize_mail_date(str(message.get("Date", ""))),
        "text": text,
        "attachments": attachments,
    }


def extract_fetch_bytes(response: Iterable[Any]) -> bytes:
    for item in response:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], bytes):
            return item[1]
    raise ConnectionFailure("IMAP server returned no message data")


@dataclass
class IMAPSession:
    settings: dict[str, Any]
    client: imaplib.IMAP4

    @classmethod
    def connect(cls, settings: dict[str, Any]) -> "IMAPSession":
        secret = resolve_secret(str(settings["secret_ref"]))
        host = str(settings["host"])
        port = int(settings["port"])
        try:
            if settings["security"] == "ssl":
                client: imaplib.IMAP4 = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context())
            else:
                client = imaplib.IMAP4(host, port)
                if settings["security"] == "starttls":
                    client.starttls(ssl_context=ssl.create_default_context())
            if settings["auth"] == "xoauth2":
                token = f"user={settings['address']}\x01auth=Bearer {secret}\x01\x01".encode()
                client.authenticate("XOAUTH2", lambda _: token)
            elif settings["auth"] == "password":
                client.login(str(settings["address"]), secret)
            else:
                raise ConfigError(f"Unsupported IMAP auth mode: {settings['auth']}")
        except ConfigError:
            raise
        except (imaplib.IMAP4.error, OSError, ssl.SSLError) as exc:
            raise ConnectionFailure(f"IMAP connection failed: {exc}") from exc
        return cls(settings, client)

    def close(self) -> None:
        try:
            self.client.logout()
        except (imaplib.IMAP4.error, OSError):
            pass

    def select(self, folder: str) -> None:
        status, _ = self.client.select(folder, readonly=True)
        if status != "OK":
            raise NotFoundError(f"Cannot open mail folder: {folder}")

    def uidvalidity(self, folder: str) -> str:
        _, values = self.client.response("UIDVALIDITY")
        raw = values[0] if values else None
        if raw:
            text = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
            match = re.search(r"\d+", text)
            if match:
                return match.group(0)
        status, values = self.client.status(folder, "(UIDVALIDITY)")
        if status == "OK" and values:
            text = values[0].decode(errors="replace") if isinstance(values[0], bytes) else str(values[0])
            match = re.search(r"UIDVALIDITY\s+(\d+)", text, re.IGNORECASE)
            if match:
                return match.group(1)
        raise ConnectionFailure("IMAP server did not report UIDVALIDITY")


def imap_folders(settings: dict[str, Any]) -> list[dict[str, str]]:
    session = IMAPSession.connect(settings)
    try:
        status, values = session.client.list()
        if status != "OK":
            raise ConnectionFailure("IMAP LIST failed")
        result = []
        for value in values or []:
            text = value.decode(errors="replace") if isinstance(value, bytes) else str(value)
            match = re.match(r"\((.*?)\)\s+\"?(.*?)\"?\s+(.+)$", text)
            result.append({"raw": text, "name": match.group(3).strip('"') if match else text})
        return result
    finally:
        session.close()


def parse_since(value: str) -> dt.date:
    relative = re.fullmatch(r"(\d+)([dDwW])", value.strip())
    if relative:
        amount = int(relative.group(1))
        days = amount * (7 if relative.group(2).lower() == "w" else 1)
        return dt.date.today() - dt.timedelta(days=days)
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise InputError("--since must be YYYY-MM-DD, Nd, or Nw") from exc


def imap_quoted(value: str) -> str:
    if "\r" in value or "\n" in value:
        raise InputError("IMAP search text cannot contain newlines")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def fetch_header(session: IMAPSession, uid: str) -> dict[str, Any] | None:
    status, fetched = session.client.uid(
        "fetch", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM TO DATE)] RFC822.SIZE)"
    )
    if status != "OK":
        return None
    header = email.message_from_bytes(extract_fetch_bytes(fetched), policy=email.policy.default)
    return {
        "uid": uid,
        "message_id": str(header.get("Message-ID", "")),
        "subject": decode_mime_header(header.get("Subject")),
        "from": decode_mime_header(header.get("From")),
        "to": decode_mime_header(header.get("To")),
        "date": normalize_mail_date(str(header.get("Date", ""))),
    }


def search_uids(session: IMAPSession, args: argparse.Namespace) -> list[str]:
    criteria: list[str] = ["SINCE", parse_since(args.since).strftime("%d-%b-%Y")]
    if getattr(args, "unseen", False):
        criteria.append("UNSEEN")
    if getattr(args, "subject", None):
        criteria.extend(["SUBJECT", imap_quoted(args.subject)])
    if getattr(args, "sender", None):
        criteria.extend(["FROM", imap_quoted(args.sender)])
    status, values = session.client.uid("search", None, *criteria)
    if status != "OK":
        raise ConnectionFailure("IMAP UID SEARCH failed")
    raw_uids = (values[0] or b"").split() if values else []
    return [value.decode() for value in raw_uids]


def imap_search(settings: dict[str, Any], args: argparse.Namespace) -> list[dict[str, Any]]:
    session = IMAPSession.connect(settings)
    try:
        session.select(args.folder)
        uids = search_uids(session, args)[-args.limit:]
        result = []
        for uid in reversed(uids):
            item = fetch_header(session, uid)
            if item is not None:
                result.append(item)
        return result
    finally:
        session.close()


def imap_get(settings: dict[str, Any], folder: str, uid: str) -> dict[str, Any]:
    session = IMAPSession.connect(settings)
    try:
        session.select(folder)
        status, fetched = session.client.uid("fetch", uid, "(BODY.PEEK[])")
        if status != "OK":
            raise NotFoundError(f"Message UID not found: {uid}")
        return parse_message(extract_fetch_bytes(fetched), uid)
    finally:
        session.close()


def imap_pending(settings: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    key = mailbox_key(settings)
    store = StateStore(state_path(args))
    session = IMAPSession.connect(settings)
    try:
        session.select(args.folder)
        uidvalidity = session.uidvalidity(args.folder)
        last_scanned = store.cursor(key, args.folder, uidvalidity)
        new_uids = sorted(
            (uid for uid in search_uids(session, args) if int(uid) > last_scanned),
            key=int,
        )
        discovered: list[dict[str, Any]] = []
        new_cursor = last_scanned
        for uid in new_uids[:args.scan_limit]:
            item = fetch_header(session, uid)
            if item is None:
                break
            discovered.append(item)
            new_cursor = int(uid)
        if discovered or last_scanned == 0:
            store.record_discovered(key, args.folder, uidvalidity, discovered, new_cursor)
        pending = store.pending(key, args.folder, uidvalidity, args.limit)
        return {
            "folder": args.folder,
            "uidvalidity": uidvalidity,
            "cursor_before": last_scanned,
            "cursor_after": new_cursor,
            "discovered": len(discovered),
            "pending": pending,
        }
    finally:
        session.close()
        store.close()


def read_ack_input(path: str) -> list[dict[str, Any]]:
    try:
        raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
        value = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise InputError(f"Cannot read acknowledgement JSON: {exc}") from exc
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise InputError("Acknowledgement JSON must be an array of objects")
    return value


def state_ack(settings: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    store = StateStore(state_path(args))
    try:
        key = mailbox_key(settings)
        uidvalidity = store.current_uidvalidity(key, args.folder)
        if args.input:
            items = read_ack_input(args.input)
        else:
            if not args.uid:
                raise InputError("mail ack requires --uid or --input")
            items = [{"uid": uid, "outcome": args.outcome, "event_uid": args.event_uid or ""} for uid in args.uid]
        return {"folder": args.folder, "uidvalidity": uidvalidity,
                "acknowledged": store.acknowledge(key, args.folder, uidvalidity, items)}
    finally:
        store.close()


def state_retry(settings: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    store = StateStore(state_path(args))
    try:
        key = mailbox_key(settings)
        uidvalidity = store.current_uidvalidity(key, args.folder)
        return {"folder": args.folder, "uidvalidity": uidvalidity,
                "retried": store.retry(key, args.folder, uidvalidity, args.uid)}
    finally:
        store.close()


def state_summary(settings: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    store = StateStore(state_path(args))
    try:
        return store.summary(mailbox_key(settings), args.folder)
    finally:
        store.close()


def auth_headers(settings: dict[str, Any]) -> dict[str, str]:
    secret = resolve_secret(str(settings["secret_ref"]))
    if settings["auth"] == "basic":
        raw = f"{settings['username']}:{secret}".encode("utf-8")
        return {"Authorization": "Basic " + base64.b64encode(raw).decode("ascii")}
    if settings["auth"] == "bearer":
        return {"Authorization": "Bearer " + secret}
    raise ConfigError(f"Unsupported CalDAV auth mode: {settings['auth']}")


def dav_request(
    settings: dict[str, Any], method: str, url: str, *, body: bytes | None = None,
    depth: str | None = None, content_type: str | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    headers = {"User-Agent": f"mailcal/{VERSION}", **auth_headers(settings)}
    if depth is not None:
        headers["Depth"] = depth
    if content_type:
        headers["Content-Type"] = content_type
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30, context=ssl.create_default_context()) as response:
            return response.status, response.read(), dict(response.headers.items())
    except HTTPError as exc:
        if exc.code == 404:
            raise NotFoundError(f"CalDAV resource not found: {url}") from exc
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise ConnectionFailure(f"CalDAV {method} failed with HTTP {exc.code}: {detail}") from exc
    except (URLError, OSError, ssl.SSLError) as exc:
        raise ConnectionFailure(f"CalDAV {method} failed: {exc}") from exc


def propfind(settings: dict[str, Any], url: str, properties: list[tuple[str, str]], depth: str) -> ET.Element:
    prop = ET.Element(f"{{{DAV}}}prop")
    for namespace, name in properties:
        ET.SubElement(prop, f"{{{namespace}}}{name}")
    root = ET.Element(f"{{{DAV}}}propfind")
    root.append(prop)
    _, body, _ = dav_request(
        settings, "PROPFIND", url,
        body=ET.tostring(root, encoding="utf-8", xml_declaration=True),
        depth=depth, content_type="application/xml; charset=utf-8",
    )
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        raise ConnectionFailure("CalDAV server returned invalid XML") from exc


def find_text(element: ET.Element, namespace: str, name: str) -> str:
    node = element.find(f".//{{{namespace}}}{name}")
    return node.text.strip() if node is not None and node.text else ""


def find_property_href(element: ET.Element, namespace: str, name: str) -> str:
    node = element.find(f".//{{{namespace}}}{name}/{{{DAV}}}href")
    return node.text.strip() if node is not None and node.text else ""


def calendar_list(settings: dict[str, Any]) -> list[dict[str, str]]:
    base_url = str(settings["base_url"])
    first = propfind(settings, base_url, [(DAV, "current-user-principal"), (CALDAV, "calendar-home-set")], "0")
    home_href = find_property_href(first, CALDAV, "calendar-home-set")
    principal_href = find_property_href(first, DAV, "current-user-principal")
    if home_href:
        home_url = urljoin(base_url, home_href)
    elif principal_href:
        principal_url = urljoin(base_url, principal_href)
        principal = propfind(settings, principal_url, [(CALDAV, "calendar-home-set")], "0")
        home_href = find_property_href(principal, CALDAV, "calendar-home-set")
        home_url = urljoin(principal_url, home_href) if home_href else base_url
    else:
        home_url = base_url
    listing = propfind(settings, home_url, [(DAV, "displayname"), (DAV, "resourcetype")], "1")
    calendars: list[dict[str, str]] = []
    for response in listing.findall(f".//{{{DAV}}}response"):
        if response.find(f".//{{{CALDAV}}}calendar") is None:
            continue
        href = find_text(response, DAV, "href")
        if not href:
            continue
        name = find_text(response, DAV, "displayname") or href.rstrip("/").rsplit("/", 1)[-1]
        calendars.append({"name": name, "url": urljoin(home_url, href)})
    return calendars


def ics_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;")


def fold_ics_line(line: str) -> list[str]:
    if len(line.encode("utf-8")) <= 75:
        return [line]
    result: list[str] = []
    remaining = line
    while remaining:
        limit = 75 if not result else 74
        chunk = ""
        for char in remaining:
            if len((chunk + char).encode("utf-8")) > limit:
                break
            chunk += char
        if not chunk:
            chunk = remaining[0]
        result.append(("" if not result else " ") + chunk)
        remaining = remaining[len(chunk):]
    return result


def format_event_time(value: str, *, end: bool = False) -> tuple[str, bool, dt.date | dt.datetime]:
    prop = "DTEND" if end else "DTSTART"
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            parsed_date = dt.date.fromisoformat(value)
            return f"{prop};VALUE=DATE:{parsed_date:%Y%m%d}", True, parsed_date
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InputError(f"Invalid ISO 8601 date/time: {value}") from exc
    if parsed.tzinfo is None:
        raise InputError(f"Datetime must include a UTC offset: {value}")
    utc = parsed.astimezone(dt.timezone.utc)
    return f"{prop}:{utc:%Y%m%dT%H%M%SZ}", False, parsed


def validate_alarm(value: str) -> str:
    pattern = r"-?P(?:\d+W|\d+D(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?|T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)"
    if not re.fullmatch(pattern, value):
        raise InputError(f"Unsupported alarm trigger: {value}")
    return value


def event_to_ics(event_data: dict[str, Any]) -> tuple[str, bytes]:
    summary = str(event_data.get("summary", "")).strip()
    start_value = str(event_data.get("start", "")).strip()
    if not summary or not start_value:
        raise InputError("Event requires non-empty summary and start")
    uid = str(event_data.get("uid", "")).strip()
    if not uid:
        source_id = str(event_data.get("source_id", "")).strip()
        uid = str(uuid.uuid5(uuid.NAMESPACE_URL, "\x1f".join([source_id, summary, start_value]))) if source_id else str(uuid.uuid4())
    start_line, all_day, parsed_start = format_event_time(start_value)
    end_value = str(event_data.get("end", "")).strip()
    if end_value:
        end_line, end_all_day, _ = format_event_time(end_value, end=True)
        if end_all_day != all_day:
            raise InputError("Event start and end must both be dates or both be datetimes")
    elif all_day:
        assert isinstance(parsed_start, dt.date)
        end_line = "DTEND;VALUE=DATE:" + (parsed_start + dt.timedelta(days=1)).strftime("%Y%m%d")
    else:
        end_line = ""
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//mail-calendar//mailcal 0.1//EN",
        "CALSCALE:GREGORIAN", "BEGIN:VEVENT", "UID:" + ics_escape(uid),
        "DTSTAMP:" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"), start_line,
    ]
    if end_line:
        lines.append(end_line)
    lines.append("SUMMARY:" + ics_escape(summary))
    for key, prop in (("description", "DESCRIPTION"), ("location", "LOCATION")):
        value = str(event_data.get(key, "")).strip()
        if value:
            lines.append(prop + ":" + ics_escape(value))
    event_url = str(event_data.get("url", "")).strip().replace("\r", "").replace("\n", "")
    if event_url:
        lines.append("URL:" + event_url)
    status = str(event_data.get("status", "CONFIRMED")).upper()
    if status not in {"CONFIRMED", "TENTATIVE", "CANCELLED"}:
        raise InputError("Event status must be CONFIRMED, TENTATIVE, or CANCELLED")
    lines.append("STATUS:" + status)
    alarms = event_data.get("alarms", [])
    if not isinstance(alarms, list):
        raise InputError("Event alarms must be an array")
    for alarm in alarms:
        trigger = validate_alarm(str(alarm))
        lines.extend(["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + ics_escape(summary), "TRIGGER:" + trigger, "END:VALARM"])
    lines.extend(["END:VEVENT", "END:VCALENDAR"])
    folded = [piece for line in lines for piece in fold_ics_line(line)]
    return uid, ("\r\n".join(folded) + "\r\n").encode("utf-8")


def calendar_url(settings: dict[str, Any], override: str | None) -> str:
    value = override or settings.get("collection_url")
    if not value:
        raise ConfigError("Calendar collection URL is missing. Run 'calendar list' or pass --calendar-url.")
    return str(value).rstrip("/") + "/"


def calendar_create(settings: dict[str, Any], event_data: dict[str, Any], override: str | None) -> dict[str, Any]:
    uid, body = event_to_ics(event_data)
    resource_url = calendar_url(settings, override) + quote(uid, safe="") + ".ics"
    status, _, headers = dav_request(settings, "PUT", resource_url, body=body, content_type="text/calendar; charset=utf-8")
    return {"uid": uid, "url": resource_url, "http_status": status, "etag": headers.get("ETag", "")}


def calendar_delete(settings: dict[str, Any], uid: str | None, resource_url: str | None, override: str | None) -> dict[str, Any]:
    if resource_url:
        target = resource_url
    elif uid:
        target = calendar_url(settings, override) + quote(uid, safe="") + ".ics"
    else:
        raise InputError("calendar delete requires --uid or --url")
    status, _, _ = dav_request(settings, "DELETE", target)
    return {"uid": uid or "", "url": target, "http_status": status, "deleted": True}


def cmd_provider(args: argparse.Namespace) -> Any:
    if args.provider_command == "list":
        return {"mail": sorted(MAIL_PROVIDERS), "calendar": sorted(CALENDAR_PROVIDERS)}
    source = MAIL_PROVIDERS if args.kind == "mail" else CALENDAR_PROVIDERS
    if args.name not in source:
        raise NotFoundError(f"Unknown {args.kind} provider: {args.name}")
    return {"kind": args.kind, "name": args.name, **source[args.name]}


def cmd_config_init(args: argparse.Namespace) -> Any:
    provider = detect_mail_provider(args.email) if args.mail_provider == "auto" else args.mail_provider
    if provider == "generic":
        if not args.mail_host:
            raise InputError("Unknown email domain; provide --mail-host for the generic provider")
        mail = {"provider": "generic", "address": args.email, "host": args.mail_host, "port": args.mail_port or 993,
                "security": args.mail_security or "ssl", "auth": args.mail_auth or "password", "secret_ref": args.mail_secret_ref}
    else:
        if provider not in MAIL_PROVIDERS:
            raise InputError(f"Unknown mail provider: {provider}")
        mail = {"provider": provider, "address": args.email, **{k: v for k, v in MAIL_PROVIDERS[provider].items() if k != "domains"},
                "secret_ref": args.mail_secret_ref}
        for key, value in (("host", args.mail_host), ("port", args.mail_port), ("security", args.mail_security), ("auth", args.mail_auth)):
            if value is not None:
                mail[key] = value
    if args.calendar_provider not in CALENDAR_PROVIDERS:
        raise InputError(f"Unknown calendar provider: {args.calendar_provider}")
    calendar = {"provider": args.calendar_provider, **CALENDAR_PROVIDERS[args.calendar_provider]}
    if args.calendar_url:
        calendar["base_url"] = args.calendar_url
    if not calendar["base_url"]:
        raise InputError("Generic calendar provider requires --calendar-url")
    if args.calendar_collection_url:
        calendar["collection_url"] = args.calendar_collection_url
    if args.calendar_user:
        calendar["username"] = args.calendar_user
    if args.calendar_auth:
        calendar["auth"] = args.calendar_auth
    calendar["secret_ref"] = args.calendar_secret_ref
    if calendar["auth"] == "basic" and not calendar.get("username"):
        raise InputError("Basic CalDAV authentication requires --calendar-user")
    value = {"version": 1, "timezone": args.timezone, "mail": mail, "calendar": calendar}
    path = config_path(args)
    if path.exists() and not args.force:
        raise InputError(f"Configuration already exists: {path}. Use --force to replace it.")
    save_config(path, value)
    return {"path": str(path), "mail_provider": provider, "calendar_provider": args.calendar_provider}


def cmd_config(args: argparse.Namespace) -> Any:
    if args.config_command == "init":
        return cmd_config_init(args)
    config = load_config(args)
    if args.config_command == "show":
        return {"path": str(config_path(args)), "config": config}
    mail = mail_settings(config)
    calendar = calendar_settings(config)
    session = IMAPSession.connect(mail)
    try:
        imap_result = {"ok": True, "server": f"{mail['host']}:{mail['port']}"}
    finally:
        session.close()
    calendars = calendar_list(calendar)
    return {"imap": imap_result, "caldav": {"ok": True, "calendars": calendars}}


def read_event_input(path: str) -> dict[str, Any]:
    try:
        raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
        value = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise InputError(f"Cannot read event JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise InputError("Event JSON must be an object")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mailcal", description=__doc__)
    parser.add_argument("--config", help="Configuration path; overrides MAILCAL_CONFIG")
    parser.add_argument("--state", help="State JSON file path; overrides MAILCAL_STATE")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    groups = parser.add_subparsers(dest="group", required=True)

    provider = groups.add_parser("provider", help="Inspect built-in provider presets")
    provider_sub = provider.add_subparsers(dest="provider_command", required=True)
    provider_sub.add_parser("list", help="List provider names")
    provider_show = provider_sub.add_parser("show", help="Show one provider")
    provider_show.add_argument("kind", choices=["mail", "calendar"])
    provider_show.add_argument("name")

    config = groups.add_parser("config", help="Create or inspect the single-user configuration")
    config_sub = config.add_subparsers(dest="config_command", required=True)
    init = config_sub.add_parser("init", help="Create the local configuration")
    init.add_argument("--email", required=True)
    init.add_argument("--mail-provider", default="auto")
    init.add_argument("--mail-host")
    init.add_argument("--mail-port", type=int)
    init.add_argument("--mail-security", choices=["ssl", "starttls", "plain"])
    init.add_argument("--mail-auth", choices=["password", "xoauth2"])
    init.add_argument("--mail-secret-ref", required=True)
    init.add_argument("--calendar-provider", choices=sorted(CALENDAR_PROVIDERS), required=True)
    init.add_argument("--calendar-url")
    init.add_argument("--calendar-collection-url")
    init.add_argument("--calendar-user")
    init.add_argument("--calendar-auth", choices=["basic", "bearer"])
    init.add_argument("--calendar-secret-ref", required=True)
    init.add_argument("--timezone", default="Asia/Shanghai")
    init.add_argument("--force", action="store_true")
    config_sub.add_parser("show", help="Show local configuration without resolving secrets")
    config_sub.add_parser("test", help="Test IMAP and CalDAV connectivity")

    mail = groups.add_parser("mail", help="Read the configured mailbox")
    mail_sub = mail.add_subparsers(dest="mail_command", required=True)
    mail_sub.add_parser("folders", help="List IMAP folders")
    search = mail_sub.add_parser("search", help="Search message headers without marking messages read")
    search.add_argument("--folder", default="INBOX")
    search.add_argument("--since", default="30d")
    search.add_argument("--limit", type=int, default=50)
    search.add_argument("--subject")
    search.add_argument("--from", dest="sender")
    search.add_argument("--unseen", action="store_true")
    pending = mail_sub.add_parser("pending", help="Discover new messages and return only unprocessed headers")
    pending.add_argument("--folder", default="INBOX")
    pending.add_argument("--since", default="30d")
    pending.add_argument("--limit", type=int, default=50, help="Maximum pending messages returned")
    pending.add_argument("--scan-limit", type=int, default=200, help="Maximum new headers fetched per run")
    get = mail_sub.add_parser("get", help="Get a complete message without marking it read")
    get.add_argument("--folder", default="INBOX")
    get.add_argument("--uid", required=True)
    ack = mail_sub.add_parser("ack", help="Mark stored messages processed after semantic handling")
    ack.add_argument("--folder", default="INBOX")
    ack.add_argument("--uid", action="append", help="UID to acknowledge; repeat for multiple messages")
    ack.add_argument("--input", help="Acknowledgement JSON array path, or - for stdin")
    ack.add_argument("--outcome", default="processed")
    ack.add_argument("--event-uid")
    retry = mail_sub.add_parser("retry", help="Return stored processed messages to pending state")
    retry.add_argument("--folder", default="INBOX")
    retry.add_argument("--uid", action="append", required=True)
    state = mail_sub.add_parser("state", help="Show cursor and processing counts")
    state.add_argument("--folder", default="INBOX")

    calendar = groups.add_parser("calendar", help="Manage the configured CalDAV calendar")
    calendar_sub = calendar.add_subparsers(dest="calendar_command", required=True)
    calendar_sub.add_parser("list", help="Discover calendar collections")
    create = calendar_sub.add_parser("create", help="Create or replace an event by UID")
    create.add_argument("--input", required=True, help="Event JSON path, or - for stdin")
    create.add_argument("--calendar-url")
    delete = calendar_sub.add_parser("delete", help="Delete an event created by this CLI")
    delete.add_argument("--uid")
    delete.add_argument("--url")
    delete.add_argument("--calendar-url")
    return parser


def dispatch(args: argparse.Namespace) -> Any:
    if args.group == "provider":
        return cmd_provider(args)
    if args.group == "config":
        return cmd_config(args)
    config = load_config(args)
    if args.group == "mail":
        settings = mail_settings(config)
        if args.mail_command == "folders":
            return imap_folders(settings)
        if args.mail_command == "search":
            if args.limit < 1:
                raise InputError("--limit must be positive")
            return imap_search(settings, args)
        if args.mail_command == "pending":
            if args.limit < 1 or args.scan_limit < 1:
                raise InputError("--limit and --scan-limit must be positive")
            return imap_pending(settings, args)
        if args.mail_command == "get":
            return imap_get(settings, args.folder, args.uid)
        if args.mail_command == "ack":
            return state_ack(settings, args)
        if args.mail_command == "retry":
            return state_retry(settings, args)
        return state_summary(settings, args)
    settings = calendar_settings(config)
    if args.calendar_command == "list":
        return calendar_list(settings)
    if args.calendar_command == "create":
        return calendar_create(settings, read_event_input(args.input), args.calendar_url)
    return calendar_delete(settings, args.uid, args.url, args.calendar_url)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        emit(dispatch(args))
        return 0
    except MailCalError as exc:
        payload = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
        print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        payload = {"ok": False, "error": {"code": "INTERRUPTED", "message": "Operation interrupted"}}
        print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
