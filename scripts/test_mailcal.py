import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
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

    def test_secret_from_environment(self):
        os.environ["MAILCAL_TEST_SECRET"] = "value"
        try:
            self.assertEqual(mailcal.resolve_secret("env:MAILCAL_TEST_SECRET"), "value")
        finally:
            del os.environ["MAILCAL_TEST_SECRET"]

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
        settings = {"base_url": "https://dav.example/", "auth": "basic", "username": "u", "secret_ref": "env:X"}
        with mock.patch.object(mailcal, "propfind", side_effect=[first, principal, listing]) as propfind:
            result = mailcal.calendar_list(settings)
        self.assertEqual(result, [{"name": "Recruiting", "url": "https://dav.example/calendars/user/recruiting/"}])
        self.assertEqual(propfind.call_count, 3)

    def test_calendar_create_uses_stable_resource_url(self):
        settings = {
            "base_url": "https://dav.example/", "collection_url": "https://dav.example/cal/recruiting/",
            "auth": "basic", "username": "u", "secret_ref": "env:X",
        }
        event = {"source_id": "message-1", "summary": "Interview", "start": "2026-09-15T14:00:00+08:00"}
        expected_uid, _ = mailcal.event_to_ics(event)
        with mock.patch.object(mailcal, "dav_request", return_value=(201, b"", {"ETag": '"v1"'})) as request:
            result = mailcal.calendar_create(settings, event, None)
        self.assertEqual(result["uid"], expected_uid)
        self.assertEqual(result["url"], f"https://dav.example/cal/recruiting/{expected_uid}.ics")
        self.assertEqual(request.call_args.args[1], "PUT")

    def test_config_init_writes_no_raw_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            with contextlib.redirect_stdout(io.StringIO()):
                code = mailcal.main([
                    "--config", str(path), "config", "init", "--email", "person@163.com",
                    "--mail-secret-ref", "env:MAIL_SECRET", "--calendar-provider", "qq",
                    "--calendar-user", "person@qq.com", "--calendar-secret-ref", "env:CAL_SECRET",
                ])
            self.assertEqual(code, 0)
            value = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(value["mail"]["host"], "imap.163.com")
            self.assertEqual(value["calendar"]["base_url"], "https://dav.qq.com/")
            self.assertEqual(value["mail"]["secret_ref"], "env:MAIL_SECRET")

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
