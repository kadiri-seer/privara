"""Credential generation and verification.

Keys look like ``pv_agent_<key_id>_<secret>`` or ``pv_admin_<key_id>_<secret>``. The key id
is a non-secret lookup handle; only a SHA-256 digest of the full key is stored. The secret
carries 256 bits of entropy, so a fast hash is appropriate (no password stretching needed).
Comparisons use :func:`hmac.compare_digest`, and an unknown key id is compared against a
dummy digest so that timing does not reveal whether a key id exists.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass

KEY_RE = re.compile(r"^pv_(agent|admin)_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$")
_DUMMY_DIGEST = hashlib.sha256(b"privara-dummy-key").hexdigest()


@dataclass(frozen=True)
class GeneratedKey:
    kind: str
    key_id: str
    plaintext: str
    digest: str


def digest_key(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def generate_key(kind: str) -> GeneratedKey:
    if kind not in ("agent", "admin"):
        raise ValueError("unknown key kind")
    key_id = secrets.token_hex(6)
    secret = secrets.token_urlsafe(32)
    plaintext = f"pv_{kind}_{key_id}_{secret}"
    return GeneratedKey(kind=kind, key_id=key_id, plaintext=plaintext, digest=digest_key(plaintext))


def parse_key(plaintext: str | None) -> tuple[str, str] | None:
    """Return (kind, key_id) for a well-formed key, otherwise None."""
    if not plaintext:
        return None
    match = KEY_RE.match(plaintext.strip())
    if not match:
        return None
    return match.group(1), match.group(2)


def verify_digest(plaintext: str, stored_digest: str | None) -> bool:
    candidate = digest_key(plaintext)
    return hmac.compare_digest(candidate, stored_digest or _DUMMY_DIGEST) and stored_digest is not None


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def new_token() -> str:
    return "pv_appr_" + secrets.token_urlsafe(32)


def bearer_from_header(value: str | None) -> str | None:
    if not value:
        return None
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()
