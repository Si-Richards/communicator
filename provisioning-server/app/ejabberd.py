"""Private ejabberd API v2 client; never return remote responses containing secrets."""
import hashlib
from urllib.parse import urlsplit

import httpx


class EjabberdError(Exception):
    pass


class EjabberdClient:
    def __init__(self, url, username, password, transport=None):
        uri = urlsplit(url)
        if (uri.scheme != "https" or not uri.hostname or uri.username or uri.password
                or uri.query or uri.fragment or not uri.path.rstrip("/").endswith("/api/v2")
                or not username or not password):
            raise ValueError("Configure an HTTPS /api/v2 URL and dedicated ejabberd API credentials.")
        self.url = url.rstrip("/")
        self.client = httpx.Client(auth=(username, password), timeout=3.0,
                                   follow_redirects=False, transport=transport, trust_env=False)

    def close(self):
        self.client.close()

    def call(self, command, **arguments):
        try:
            response = self.client.post(f"{self.url}/{command}", json=arguments)
            response.raise_for_status()
            result = response.json()
        except httpx.HTTPStatusError as exc:
            raise EjabberdError(
                f"ejabberd {command} failed (HTTP {exc.response.status_code}); check API access and server logs."
            ) from None
        except httpx.HTTPError as exc:
            raise EjabberdError(
                f"ejabberd {command} failed ({type(exc).__name__}); check network access and TLS."
            ) from None
        except ValueError:
            raise EjabberdError(f"ejabberd {command} returned invalid JSON.") from None
        if command in {"check_account", "check_password"}:
            if type(result) is int and result in {0, 1}:
                return result == 0
        elif command == "get_ban_details":
            # ejabberd's HTTP formatter serializes name/value tuples as an
            # object, including {} for an unbanned account. Its API reference
            # also documents the array form. Accept both without accepting
            # an error object as proof that the account is not banned.
            if (isinstance(result, dict)
                    and result.keys() <= {"reason", "bandate", "lastdate", "lastreason"}
                    and all(isinstance(value, str) for value in result.values())):
                return result
            if isinstance(result, list) and all(
                    isinstance(item, dict) and isinstance(item.get("name"), str)
                    and isinstance(item.get("value"), str) for item in result):
                return {item["name"]: item["value"] for item in result}
        elif (type(result) is int and result == 0) or result in ("", "Success"):
            return True
        raise EjabberdError(f"ejabberd {command} was rejected or returned an unexpected result.")

    def reconcile(self, account, enabled):
        user, host = account["jid"].split("@", 1)
        args = {"user": user, "host": host}
        owned = bool(account["owned"])
        exists = self.call("check_account", **args)
        if not exists:
            if not enabled:
                return False
            self.call("register", **args, password=account["password"])
            owned = True
        ban = self.call("get_ban_details", **args)
        reason = "VoiceHost provisioning: " + hashlib.sha256(account["password"].encode()).hexdigest()[:24]
        if not owned:
            # Also recover a lost register/ban response when the last device
            # was disabled before its next synchronization attempt.
            proven = ban.get("reason") == reason or self.call("check_password", **args, password=account["password"])
            if not proven:
                if not enabled:
                    return False
                raise EjabberdError("Messaging identity already exists outside provisioning management.")
            # A register response may have been lost; the durable secret proves ownership.
            owned = True

        if "reason" in ban:
            if ban["reason"] != reason:
                raise EjabberdError("Messaging account has an external ban; administrator action is required.")
            if enabled:
                self.call("unban_account", **args)
        elif not enabled:
            self.call("ban_account", **args, reason=reason)
        return owned

    def publish_identity(self, account, enabled, display_name, directory_extension):
        user, host = account["jid"].split("@", 1)
        self.call("voicehost_set_identity", user=user, host=host,
                  account=account["account_number"], extension=account["extension"],
                  name=display_name, address=directory_extension, enabled=1 if enabled else 0)
