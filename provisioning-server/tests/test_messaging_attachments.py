import hashlib
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main
from app.ejabberd import EjabberdClient
from app.messaging_attachments import Attachments, MAX_BYTES
from app.messaging_worker import reconcile_accounts
from app.models import AdminActivationRequest
from app.store import Store
from test_ejabberd_lifecycle import FakeEjabberd

HOST = "ejabberd.voicehost.io"
BASE = "/api/v1/device/messaging/attachments"


class AttachmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(str(Path(self.tmp.name) / "attachments.db"))
        self.settings = replace(main.settings, ejabberd_management_enabled=True,
            messaging_attachment_directory=str(Path(self.tmp.name) / "blobs"))
        self.addCleanup(patch.stopall)
        patch.object(main, "store", self.store).start()
        patch.object(main, "settings", self.settings).start()
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.n = 0
        self.owner, self.access = self.device("10000*213T")
        self.peer, self.peer_access = self.device("10000*230D")
        self.other, self.other_access = self.device("10000*231")
        self.foreign, self.foreign_access = self.device("20000*230")
        ej = EjabberdClient("https://private.example/api/v2", "api@example", "fixture",
            httpx.MockTransport(FakeEjabberd().handle))
        self.addCleanup(ej.close)
        reconcile_accounts(self.store, ej)
        self.actor = self.store.get_device(self.owner) | {"_access_token": self.access}
        self.blobs = Attachments(self.store, self.settings)

    def device(self, username, platform="ios"):
        self.n += 1
        source = AdminActivationRequest(extension=username.split("*")[1].rstrip("TD"),
            sip_username=username, messaging_enabled=True, messaging_managed=True).model_dump()
        _, code, _ = self.store.create_activation(source, 900)
        result, failure = self.store.activate_device(code, {"installation_id": str(self.n),
            "platform": platform, "device_type": "mobile", "app_version": "fixture", "app_build": 37},
            main.build_configuration, None, 900)
        self.assertIsNone(failure)
        return result[0], result[1]

    def upload(self, data=b"private file", peer="10000*230@" + HOST, name="notes.pdf", **kwargs):
        return self.client.post(BASE, params={"peer": peer, "name": name}, content=data,
            headers={"Authorization": "Bearer " + self.access} | kwargs)

    def download(self, id, token=None, peer="10000*213@" + HOST):
        return self.client.get(BASE + "/" + id, params={"peer": peer},
            headers={"Authorization": "Bearer " + (token or self.peer_access)})

    def test_upload_and_participant_download_verified_metadata_no_public_urls(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201)
        item = response.json()
        self.assertEqual(item["sha256"], hashlib.sha256(b"private file").hexdigest())
        self.assertEqual(item["media_type"], "application/octet-stream")
        self.assertEqual(item["size"], 12)
        self.assertNotIn("url", item)
        result = self.download(item["id"])
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.content, b"private file")
        self.assertEqual(result.headers["cache-control"], "no-store")
        self.assertEqual(result.headers["x-content-type-options"], "nosniff")
        self.assertIn("attachment", result.headers["content-disposition"])
        self.assertEqual(self.download(item["id"], self.access, "10000*230@" + HOST).status_code, 200)

    def test_other_tenant_other_conversation_and_anonymous_are_denied(self):
        id = self.upload().json()["id"]
        self.assertEqual(self.download(id, self.foreign_access).status_code, 404)
        self.assertEqual(self.download(id, self.other_access).status_code, 404)
        self.assertEqual(self.download(id, peer="10000*231@" + HOST).status_code, 404)
        self.assertEqual(self.client.get(BASE + "/" + id, params={"peer": "10000*213@" + HOST}).status_code, 401)
        self.assertEqual(self.client.post(BASE, params={"peer": "10000*230@" + HOST, "name": "file"}, content=b"x").status_code, 401)

    def test_outside_unknown_legacy_and_self_recipients_denied(self):
        for peer in ["20000*230@" + HOST, "10000*230@outside.example", "10000*999@" + HOST,
                     "10000*230d@" + HOST, "10000*213@" + HOST]:
            with self.subTest(peer=peer):
                self.assertEqual(self.upload(peer=peer).status_code, 404)

    def test_locked_revoked_retired_and_messaging_disabled_devices_denied(self):
        for state in ["locked", "revoked", "retired"]:
            with self.subTest(state=state):
                id = self.upload().json()["id"]
                self.store.set_device_state(self.peer, state)
                self.assertIn(self.download(id).status_code, [401, 403, 423])
                self.store.set_device_state(self.peer, "active")
                # Revocation invalidates the old credential permanently.
                if state != "locked":
                    self.peer, self.peer_access = self.device("10000*230D")
                    with self.store._connect() as conn:
                        conn.execute("UPDATE devices SET config_json=json_set(config_json,'$.messaging.ready',1) WHERE id=?", (self.peer,))
        config = self.store.get_device(self.owner)["config"]
        config["features"]["messaging"] = False
        self.store.update_device_configuration(self.owner, config)
        self.assertEqual(self.upload().status_code, 403)

    def test_same_identity_on_another_device_can_download(self):
        id = self.upload().json()["id"]
        device, token = self.device("10000*213D", "android")
        with self.store._connect() as conn:
            conn.execute("UPDATE devices SET config_json=json_set(config_json,'$.messaging.ready',1) WHERE id=?", (device,))
        self.assertEqual(self.download(id, token, "10000*230@" + HOST).status_code, 200)

    def test_access_rechecked_at_upload_commit(self):
        id = self.blobs.reserve(self.actor, "10000*230@" + HOST, "file", 1)
        self.blobs.path(id, True).write_bytes(b"x")
        self.store.set_device_state(self.owner, "locked")
        with self.assertRaises(HTTPException):
            self.blobs.finish(id, self.actor, "10000*230@" + HOST, "a" * 64, b"x")
        self.blobs.discard(id)
        self.assertFalse(self.blobs.path(id, True).exists())
        self.assertFalse(self.blobs.path(id).exists())

    def test_filename_sanitized_and_content_type_not_trusted(self):
        response = self.upload(name="../../evil.html\r\n", data=b"<script>bad</script>", **{"Content-Type": "image/png"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["name"], "evil.html")
        self.assertEqual(response.json()["media_type"], "application/octet-stream")
        image = self.upload(data=b"\x89PNG\r\n\x1a\nfixture").json()
        self.assertEqual(image["media_type"], "image/png")
        self.assertEqual(self.download("../file").status_code, 404)

    def test_declared_size_limits_and_mismatch_leave_no_partial_files(self):
        for content, size in [(b"", "0"), (b"x", str(MAX_BYTES + 1)), (b"abc", "2"), (b"x", "2")]:
            with self.subTest(size=size):
                self.assertIn(self.upload(data=content, **{"Content-Length": size}).status_code, [400, 413])
        self.assertEqual(list(Path(self.settings.messaging_attachment_directory).glob("*")), [])
        with self.store._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM messaging_attachments").fetchone()[0], 0)

    def test_quota_reservations_are_atomic(self):
        settings = replace(self.settings, messaging_attachment_quota_bytes=10)
        blobs = Attachments(self.store, settings)
        def reserve(_):
            try:
                return blobs.reserve(self.actor, "10000*230@" + HOST, "file", 10)
            except HTTPException as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, [1, 2]))
        self.assertEqual(sum(isinstance(v, str) for v in results), 1)
        self.assertIn(413, results)

    def test_expired_ready_and_interrupted_uploads_are_cleaned(self):
        id = self.upload().json()["id"]
        partial = self.blobs.reserve(self.actor, "10000*230@" + HOST, "file", 1)
        self.blobs.path(partial, True).write_bytes(b"x")
        with self.store._connect() as conn:
            conn.execute("UPDATE messaging_attachments SET expires=?", (int(time.time()) - 1,))
        self.assertEqual(self.download(id).status_code, 404)
        self.assertEqual(self.upload().status_code, 201)
        self.assertFalse(self.blobs.path(id).exists())
        self.assertFalse(self.blobs.path(partial, True).exists())
