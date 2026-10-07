"""Canonical, server-assigned account membership for shared SIP identities."""
import re


def split_identity(username: str) -> tuple[str, str]:
    value = (username or "").strip().lower()
    if len(value) > 240 or not re.fullmatch(r"[a-z0-9._+\-]+\*[a-z0-9._+\-]+", value):
        raise ValueError("Managed messaging requires an accountnumber*extension SIP username.")
    return tuple(value.split("*", 1))


def identity_for_jid(jid: str) -> tuple[str, str]:
    username, separator, host = jid.partition("@")
    if not separator or not host or "@" in host:
        raise ValueError("Managed messaging requires a bare account JID.")
    return split_identity(username)


def directory_address(value: str) -> str:
    address = (value or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9._+\-]{1,80}", address):
        raise ValueError("Managed messaging requires a simple provisioned extension of up to 80 characters.")
    return address
