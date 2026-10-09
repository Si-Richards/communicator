import copy
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from fastapi import HTTPException
from app.ejabberd import EjabberdError
from app.messaging_rooms import checked_rooms
import test_messaging_attachments as attachment_fixture
import test_messaging_notifications as notification_fixture
from app.messaging_notifications import dispatch_jobs

HOST = 'ejabberd.voicehost.io'
ROOM = 'vh-' + 'a' * 32 + '@rooms.' + HOST
BASE = '/api/v1/device/messaging/rooms'

def member(extension, role='member', account='10000'):
    return {'jid': account + '*' + extension + '@' + HOST, 'name': 'User ' + extension,
            'extension': extension, 'role': role}

class RoomAPI:
    def __init__(self):
        self.rows = [{'jid': ROOM, 'name': 'Team', 'revision': 1,
                     'members': [member('213', 'owner'), member('230')]}]
        self.calls = []
        self.result = 0
    def _request(self, command, **args):
        self.calls.append((command, args))
        if command == 'voicehost_room_list':
            return copy.deepcopy([r for r in self.rows if any(m['jid'] == args['user'] + '@' + args['host'] for m in r['members'])])
        return self.result
    @contextmanager
    def client(self, settings): yield self

class RoomTests(unittest.TestCase):
    setUp = attachment_fixture.AttachmentTests.setUp
    device = attachment_fixture.AttachmentTests.device
    upload = attachment_fixture.AttachmentTests.upload
    download = attachment_fixture.AttachmentTests.download
    def api(self):
        api = RoomAPI()
        patch('app.messaging_rooms.room_client', api.client).start()
        return api
    def test_authentication_and_device_eligibility(self):
        self.api()
        self.assertEqual(self.client.get(BASE).status_code, 401)
        response = self.client.get(BASE, headers={'Authorization': 'Bearer ' + self.access})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['rooms'][0]['jid'], ROOM)
        self.store.set_device_state(self.owner, 'locked')
        self.assertIn(self.client.get(BASE, headers={'Authorization': 'Bearer ' + self.access}).status_code, [403, 423])
    def test_actor_is_canonical_shared_user_and_cannot_be_overridden(self):
        api = self.api()
        body = {'id': ROOM.split('@')[0], 'name': ' Team ', 'members': ['10000*230@' + HOST]}
        response = self.client.post(BASE, json=body, headers={'Authorization': 'Bearer ' + self.access})
        self.assertEqual(response.status_code, 201)
        _, args = next(c for c in api.calls if c[0] == 'voicehost_room_create')
        self.assertEqual(args, {'user': '10000*213', 'host': HOST, 'room': ROOM.split('@')[0], 'name': 'Team', 'users': '10000*230'})
        self.assertEqual(self.client.post(BASE, json=body | {'user': '10000*230'},
            headers={'Authorization': 'Bearer ' + self.access}).status_code, 422)
    def test_cross_tenant_foreign_legacy_members_rejected_before_remote_mutation(self):
        api = self.api()
        for jid in ['20000*230@' + HOST, '10000*230@outside.example', '10000*230t@' + HOST]:
            response = self.client.post(BASE, json={'id': ROOM.split('@')[0], 'name': 'Team', 'members': [jid]},
                headers={'Authorization': 'Bearer ' + self.access})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(api.calls, [])
    def test_results_and_revision_pass_through(self):
        api = self.api()
        for result, status in [(1, 403), (2, 503), (3, 409), (0, 200)]:
            api.result = result
            response = self.client.post(BASE + '/' + ROOM.split('@')[0],
                json={'action': 'rename', 'revision': 7, 'value': 'Sales'},
                headers={'Authorization': 'Bearer ' + self.access})
            self.assertEqual(response.status_code, status)
        call = next(args for command, args in api.calls if command == 'voicehost_room_manage')
        self.assertEqual(call['revision'], 7)
        self.assertEqual(call['user'], '10000*213')
    def test_untrusted_directory_cannot_leak_another_account(self):
        api = RoomAPI()
        api.rows[0]['members'].append(member('230', account='20000'))
        with self.assertRaises(EjabberdError): checked_rooms(api, '10000*213@' + HOST)
        api.rows[0]['members'] = [member('213')]
        with self.assertRaises(EjabberdError): checked_rooms(api, '10000*213@' + HOST)
    def test_room_file_current_members_full_history_and_removal(self):
        api = self.api()
        result = self.upload(peer=ROOM)
        self.assertEqual(result.status_code, 201)
        id = result.json()['id']
        self.assertEqual(self.download(id, peer=ROOM).status_code, 200)
        self.assertEqual(self.download(id, self.other_access, ROOM).status_code, 404)
        api.rows[0]['members'].append(member('231'))
        self.assertEqual(self.download(id, self.other_access, ROOM).status_code, 200)
        api.rows[0]['members'] = [member('230', 'owner'), member('231')]
        self.assertEqual(self.download(id, self.access, ROOM).status_code, 404)
        self.assertEqual(self.download(id, self.other_access, ROOM).status_code, 200)
        self.assertEqual(self.upload(peer=ROOM).status_code, 404)
        self.assertEqual(self.download(id, self.foreign_access, ROOM).status_code, 404)
        self.assertEqual(self.download(id, peer='10000*213@' + HOST).status_code, 404)
        api.rows = []
        self.assertEqual(self.download(id, self.peer_access, ROOM).status_code, 404)
    def test_shared_identity_second_device_sees_membership(self):
        self.api()
        device, token = self.device('10000*213D', 'android')
        with self.store._connect() as conn:
            conn.execute("UPDATE devices SET config_json=json_set(config_json,'$.messaging.ready',1) WHERE id=?", (device,))
        response = self.client.get(BASE, headers={'Authorization': 'Bearer ' + token})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['rooms'][0]['jid'], ROOM)

class RoomPushTests(unittest.TestCase):
    setUp = notification_fixture.NotificationTests.setUp
    device = notification_fixture.NotificationTests.device
    event = notification_fixture.NotificationTests.event
    jobs = notification_fixture.NotificationTests.jobs
    queue = notification_fixture.NotificationTests.queue
    def test_room_membership_checked_again_before_alert(self):
        with patch('app.messaging_rooms.check_room', return_value={}) as checker:
            self.queue(peer=ROOM)
            apns = notification_fixture.FakeAPNs()
            dispatch_jobs(self.store, apns, self.now)
            self.assertEqual(self.jobs()[0]['status'], 'sent')
            self.assertEqual(checker.call_count, 2)
            self.assertEqual(apns.calls[0][2]['peer_jid'], ROOM)
    def test_removed_member_queued_alert_discarded(self):
        with patch('app.messaging_rooms.check_room', return_value={}): self.queue(peer=ROOM)
        with patch('app.messaging_rooms.check_room', side_effect=HTTPException(status_code=404)):
            apns = notification_fixture.FakeAPNs()
            dispatch_jobs(self.store, apns, self.now)
            self.assertEqual(apns.calls, [])
            self.assertEqual(self.jobs()[0]['status'], 'discarded')
    def test_room_service_outage_defers_instead_of_discarding(self):
        with patch('app.messaging_rooms.check_room', return_value={}): self.queue(peer=ROOM)
        with patch('app.messaging_rooms.check_room', side_effect=HTTPException(status_code=503)):
            apns = notification_fixture.FakeAPNs()
            dispatch_jobs(self.store, apns, self.now)
            self.assertEqual(apns.calls, [])
            self.assertEqual(self.jobs()[0]['status'], 'pending')
            self.assertEqual(self.jobs()[0]['next_retry'], self.now + 15)
