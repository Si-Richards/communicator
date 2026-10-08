"""Canonical, server-assigned account membership for shared SIP identities."""
import re


def canonical_identity(username: str) -> tuple[str, str]:
    """SIP endpoint suffixes identify devices, not separate messaging people."""
    value = (username or "").strip().lower()
    match = re.fullmatch(r"([0-9]+)\*([0-9]{3,5})[a-z]*", value)
    if len(value) > 240 or not match:
        raise ValueError("Managed messaging requires a numeric account number and a 3–5 digit extension, with an optional alphabetic SIP endpoint suffix.")
    return match.group(1), match.group(2)


def canonical_jid(jid: str) -> str:
    username, separator, host = jid.partition("@")
    if not separator or not host or "@" in host or "/" in host:
        raise ValueError("Managed messaging requires a bare account JID.")
    account, extension = canonical_identity(username)
    return f"{account}*{extension}@{host}"


def provisioned_extension(value: str, username: str) -> str:
    account, extension = canonical_identity(username)
    supplied = (value or "").strip().lower()
    # Legacy provisioning sometimes stored the full SIP login in Extension.
    # Accept only that exact identity or its suffix; never another account/user.
    if supplied not in {extension, username.strip().lower(), username.strip().lower().split("*", 1)[1]}:
        raise ValueError("The provisioned extension must match the SIP username's 3–5 digit extension.")
    return extension


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
