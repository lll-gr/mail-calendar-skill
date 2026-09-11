import contextlib
import datetime as dt
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import xml.etree.ElementTree as ET


MODULE_PATH = Path(__file__).with_name("mailcal.py")
SPEC = importlib.util.spec_from_file_location("mailcal", MODULE_PATH)
assert SPEC and SPEC.loader
mailcal = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mailcal
SPEC.loader.exec_module(mailcal)


class MailCalTests(unittest.TestCase):
    def test_provider_detection(self):
        self.assertEqual(mailcal.detect_mail_provider("person@qq.com"), "qq")
        self.assertEqual(mailcal.detect_mail_provider("person@163.com"), "netease163")
        self.assertEqual(mailcal.detect_mail_provider("person@example.com"), "generic")

    def test_storage_directory_is_always_under_home(self):
        home = Path("C:/Users/example")
        with mock.patch.object(mailcal.Path, "home", return_value=home):
            self.assertEqual(mailcal.storage_directory(), home / ".mail-calendar-skill")

    def test_relative_since(self):
        self.assertEqual(mailcal.parse_since("7d"), dt.date.today() - dt.timedelta(days=7))
        self.assertEqual(mailcal.parse_since("2w"), dt.date.today() - dt.timedelta(days=14))
        self.assertEqual(mailcal.parse_since("2026-09-01"), dt.date(2026, 9, 1))

    def test_html_text_and_attachment_parsing(self):
        raw = (
            b"From: HR <hr@example.com>\r\nTo: User <user@example.com>\r\n"
            b"Subject: Interview\r\nMessage-ID: <test@example.com>\r\n"
            b"Date: Fri, 11 Sep 2026 10:00:00 +0800\r\nMIME-Version: 1.0\r\n"
            b"Content-Type: multipart/mixed; boundary=x\r\n\r\n"
            b"--x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
            b"<p>Interview at <b>14:00</b></p><script>ignore()</script>\r\n"
            b"--x\r\nContent-Type: application/pdf\r\n"
            b"Content-Disposition: attachment; filename=guide.pdf\r\n\r\nPDF\r\n--x--\r\n"
        )
        parsed = mailcal.parse_message(raw, "42")
        self.assertIn("Interview at 14:00", parsed["text"])
        self.assertNotIn("ignore", parsed["text"])
        self.assertEqual(parsed["attachments"][0]["filename"], "guide.pdf")

    def test_datetime_event_and_stable_uid(self):
        event = {"source_id": "<test@example.com>#1", "summary": "Interview",
                 "start": "2026-09-15T14:00:00+08:00", "end": "2026-09-15T15:00:00+08:00",
                 "alarms": ["-PT1H"]}
        uid1, body1 = mailcal.event_to_ics(event)
        uid2, _ = mailcal.event_to_ics(event)
        self.assertEqual(uid1, uid2)
        text = body1.decode()
        self.assertIn("DTSTART:20260915T060000Z", text)
        self.assertIn("DTEND:20260915T070000Z", text)
        self.assertIn("TRIGGER:-PT1H", text)

    def test_all_day_defaults_to_one_day(self):
        _, body = mailcal.event_to_ics({"summary": "Deadline", "start": "2026-09-20"})
        text = body.decode()
        self.assertIn("DTSTART;VALUE=DATE:20260920", text)
        self.assertIn("DTEND;VALUE=DATE:20260921", text)

    def test_calendar_discovery(self):
        first = ET.fromstring(
            '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:response><d:propstat><d:prop><d:current-user-principal>'
            '<d:href>/principals/user/</d:href></d:current-user-principal>'
            '</d:prop></d:propstat></d:response></d:multistatus>'
        )
        principal = ET.fromstring(
            '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:response><d:propstat><d:prop><c:calendar-home-set>'
            '<d:href>/calendars/user/</d:href></c:calendar-home-set>'
            '</d:prop></d:propstat></d:response></d:multistatus>'
        )
        listing = ET.fromstring(
            '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:response><d:href>/calendars/user/recruiting/</d:href><d:propstat><d:prop>'
            '<d:displayname>Recruiting</d:displayname><d:resourcetype><d:collection/>'
            '<c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>'
        )
        settings = {"base_url": "https://dav.example/", "auth": "basic", "username": "u", "secret": "password"}
        with mock.patch.object(mailcal, "propfind", side_effect=[first, principal, listing]) as propfind:
            result = mailcal.calendar_list(settings)
        self.assertEqual(result, [{"name": "Recruiting", "url": "https://dav.example/calendars/user/recruiting/"}])
        self.assertEqual(propfind.call_count, 3)

    def test_calendar_create_uses_stable_resource_url(self):
        settings = {
            "base_url": "https://dav.example/", "collection_url": "https://dav.example/cal/recruiting/",
            "auth": "basic", "username": "u", "secret": "password",
        }
        event = {"source_id": "message-1", "summary": "Interview", "start": "2026-09-15T14:00:00+08:00"}
        expected_uid, _ = mailcal.event_to_ics(event)
        with mock.patch.object(mailcal, "dav_request", return_value=(201, b"", {"ETag": '"v1"'})) as request:
            result = mailcal.calendar_create(settings, event, None)
        self.assertEqual(result["uid"], expected_uid)
        self.assertEqual(result["url"], f"https://dav.example/cal/recruiting/{expected_uid}.ics")
        self.assertEqual(request.call_args.args[1], "PUT")

    def test_config_init_separates_settings_and_plaintext_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / ".mail-calendar-skill"
            with mock.patch.object(mailcal, "storage_directory", return_value=root), \
                    mock.patch.object(mailcal, "getpass", side_effect=["mail-pass", "calendar-pass"]), \
                    mock.patch.object(mailcal, "_make_private"), \
                    contextlib.redirect_stdout(io.StringIO()):
                code = mailcal.main([
                    "config", "init", "--email", "person@163.com",
                    "--calendar-provider", "qq", "--calendar-user", "person@qq.com",
                ])
            self.assertEqual(code, 0)
            settings = json.loads((root / "settings.json").read_text(encoding="utf-8"))
            credentials = json.loads((root / "credentials.json").read_text(encoding="utf-8"))
            self.assertEqual(settings["mail"]["host"], "imap.163.com")
            self.assertEqual(settings["calendar"]["base_url"], "https://dav.qq.com/")
            self.assertNotIn("mail-pass", json.dumps(settings))
            self.assertNotIn("calendar-pass", json.dumps(settings))
            self.assertEqual(credentials["mail"]["secret"], "mail-pass")
            self.assertEqual(credentials["calendar"]["secret"], "calendar-pass")

    def test_config_show_never_outputs_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = mailcal.ConfigStore(root)
            settings = {
                "version": 1, "timezone": "Asia/Shanghai",
                "mail": {"address": "person@example.com", "host": "imap.example.com", "port": 993,
                         "security": "ssl", "auth": "password"},
                "calendar": {"base_url": "https://dav.example/", "auth": "basic", "username": "person"},
            }
            credentials = {"version": 1, "mail": {"secret": "mail-pass"},
                           "calendar": {"secret": "calendar-pass"}}
            with mock.patch.object(mailcal, "_make_private"):
                store.initialize(settings, credentials, force=False)
            args = mailcal.build_parser().parse_args(["config", "show"])
            result = mailcal.cmd_config(args, store)
            serialized = json.dumps(result)
            self.assertNotIn("mail-pass", serialized)
            self.assertNotIn("calendar-pass", serialized)
            self.assertTrue(result["credentials_present"])

    def test_runtime_settings_are_merged_only_by_config_store(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "settings.json").write_text(json.dumps({
                "version": 1, "timezone": "Asia/Shanghai",
                "mail": {"address": "a@example.com", "host": "imap.example.com", "port": 993,
                         "security": "ssl", "auth": "password"},
                "calendar": {"base_url": "https://dav.example/", "auth": "bearer"},
            }), encoding="utf-8")
            (root / "credentials.json").write_text(json.dumps({
                "version": 1, "mail": {"secret": "m"}, "calendar": {"secret": "c"},
            }), encoding="utf-8")
            store = mailcal.ConfigStore(root)
            self.assertEqual(store.mail()["secret"], "m")
            self.assertEqual(store.calendar()["secret"], "c")

    def test_unsupported_settings_fields_are_rejected(self):
        settings = {
            "mail": {"address": "a@example.com", "host": "imap.example.com", "port": 993,
                     "security": "ssl", "auth": "password", "legacy_credential": "legacy"},
        }
        with self.assertRaisesRegex(mailcal.ConfigError, "Unsupported mail fields"):
            mailcal.validate_mail_settings(settings)

    def test_posix_private_permissions(self):
        path = Path("credentials.json")
        with mock.patch.object(mailcal.os, "chmod") as chmod:
            mailcal._make_private(path, directory=False, platform="posix")
        chmod.assert_called_once_with(path, 0o600)

    def test_posix_private_directory_permissions(self):
        path = Path(".mail-calendar-skill")
        with mock.patch.object(mailcal.os, "chmod") as chmod:
            mailcal._make_private(path, directory=True, platform="posix")
        chmod.assert_called_once_with(path, 0o700)

    def test_windows_acl_grants_before_disabling_inheritance(self):
        completed = mock.Mock(returncode=0, stdout="desktop\\person\n")
        with mock.patch.object(mailcal.subprocess, "run", return_value=completed) as run:
            self.assertTrue(mailcal._tighten_windows_acl(Path("credentials.json"), directory=False))
        self.assertEqual(run.call_count, 3)
        self.assertEqual(run.call_args_list[0].args[0], ["whoami"])
        self.assertIn("desktop\\person:F", run.call_args_list[1].args[0])
        self.assertEqual(run.call_args_list[2].args[0][-1], "/inheritance:r")

    def test_json_state_cursor_ack_and_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = mailcal.StateStore(path)
            headers = [{
                "uid": "10", "message_id": "<m10@example.com>", "subject": "Interview",
                "from": "hr@example.com", "to": "user@example.com", "date": "2026-09-11T10:00:00+08:00",
            }]
            store.record_discovered("mailbox-1", "INBOX", "777", headers, 10)
            self.assertEqual(store.cursor("mailbox-1", "INBOX", "777"), 10)
            self.assertEqual([item["uid"] for item in store.pending("mailbox-1", "INBOX", "777", 10)], ["10"])
            store.acknowledge("mailbox-1", "INBOX", "777", [{"uid": "10", "outcome": "created", "event_uid": "event-10"}])
            self.assertEqual(store.pending("mailbox-1", "INBOX", "777", 10), [])
            self.assertEqual(store.summary("mailbox-1", "INBOX")["counts"], {"processed": 1})
            store.retry("mailbox-1", "INBOX", "777", ["10"])
            self.assertEqual([item["uid"] for item in store.pending("mailbox-1", "INBOX", "777", 10)], ["10"])
            store.close()
            persisted = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["folders"]["INBOX"]["last_scanned_uid"], 10)

    def test_uidvalidity_change_starts_new_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            store = mailcal.StateStore(Path(directory) / "state.json")
            store.record_discovered("mailbox-1", "INBOX", "old", [{"uid": "10"}], 10)
            self.assertEqual(store.cursor("mailbox-1", "INBOX", "new"), 0)
            store.record_discovered("mailbox-1", "INBOX", "new", [{"uid": "1"}], 1)
            self.assertEqual([item["uid"] for item in store.pending("mailbox-1", "INBOX", "new", 10)], ["1"])
            store.close()


if __name__ == "__main__":
    unittest.main()
