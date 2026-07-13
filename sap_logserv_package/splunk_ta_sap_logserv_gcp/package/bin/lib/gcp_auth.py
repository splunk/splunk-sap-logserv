"""
gcp_auth.py - Google service-account OAuth2 token minting, pure stdlib.

GCP's data planes (Pub/Sub, GCS JSON API) require an OAuth2 Bearer token.
Minting one from a service-account JSON key means signing an RS256 JWT and
exchanging it at the token endpoint. Python's stdlib has no RSA, and the
usual libraries are disqualified here: google-auth pulls `cryptography`
(compiled wheels -> the AArch64 AppInspect-Cloud failure class), and even the
pure-python `rsa` package drags in `pyasn1`. RSASSA-PKCS1-v1_5 signing is
deterministic and small, so this module implements exactly the needed slice
with zero dependencies:

  - a ~40-line DER TLV walker to unwrap the key (PKCS#8 -> PKCS#1) and read
    the RSA integers (n, e, d),
  - EMSA-PKCS1-v1_5 padding with the fixed SHA-256 DigestInfo prefix,
  - the signature itself via Python's native big-int pow(m, d, n),
  - JWT assembly (base64url) + the jwt-bearer grant POST, with an in-process
    token cache (Google tokens live 3600s; we refresh at expiry - 300s).

Security note: this signs with OUR OWN configured key; no untrusted input is
parsed beyond that key file. Signing (unlike decryption/verification against
attacker-controlled input) has no padding-oracle exposure, and v1_5 signing
is deterministic (no nonce to get wrong).
"""

from __future__ import annotations

import base64
import hashlib
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
TOKEN_TIMEOUT_SEC = 30
TOKEN_EARLY_REFRESH_SEC = 300
# ASN.1 DigestInfo prefix for SHA-256 (RFC 8017 section 9.2 note 1).
_DIGESTINFO_SHA256 = bytes.fromhex(
    "3031300d060960864801650304020105000420"
)


class GcpAuthError(Exception):
    """Raised when the key can't be parsed or the token exchange fails."""


# ----- DER / key parsing -----

def _der_read(buf, i):
    """Read one DER TLV at offset i -> (tag, value_bytes, next_offset)."""
    if i + 2 > len(buf):
        raise GcpAuthError("DER truncated")
    tag = buf[i]
    length = buf[i + 1]
    i += 2
    if length & 0x80:
        n_len = length & 0x7F
        if n_len == 0 or n_len > 4 or i + n_len > len(buf):
            raise GcpAuthError("DER bad length")
        length = int.from_bytes(buf[i:i + n_len], "big")
        i += n_len
    if i + length > len(buf):
        raise GcpAuthError("DER value truncated")
    return tag, buf[i:i + length], i + length


def _der_children(seq_value):
    """Iterate the TLVs inside a constructed value (e.g., a SEQUENCE body)."""
    out = []
    i = 0
    while i < len(seq_value):
        tag, value, i = _der_read(seq_value, i)
        out.append((tag, value))
    return out


def _pem_to_der(pem):
    lines = [
        ln.strip() for ln in pem.strip().splitlines()
        if ln.strip() and not ln.startswith("-----")
    ]
    try:
        return base64.b64decode("".join(lines), validate=True)
    except (ValueError, TypeError) as exc:
        raise GcpAuthError("private_key PEM decode failed: %s" % exc)


def _parse_rsa_private_key(pem):
    """Return (n, e, d) from a PKCS#8 ('BEGIN PRIVATE KEY', what Google
    issues) or PKCS#1 ('BEGIN RSA PRIVATE KEY') PEM."""
    der = _pem_to_der(pem)
    tag, body, _ = _der_read(der, 0)
    if tag != 0x30:
        raise GcpAuthError("key is not a DER SEQUENCE")
    children = _der_children(body)
    if "BEGIN RSA PRIVATE KEY" not in pem:
        # PKCS#8: SEQUENCE { INTEGER v, SEQUENCE algId, OCTET STRING pkcs1 }
        octet = next((v for t, v in children if t == 0x04), None)
        if octet is None:
            raise GcpAuthError("PKCS#8 wrapper has no OCTET STRING")
        tag, body, _ = _der_read(octet, 0)
        if tag != 0x30:
            raise GcpAuthError("inner PKCS#1 is not a SEQUENCE")
        children = _der_children(body)
    ints = [int.from_bytes(v, "big") for t, v in children if t == 0x02]
    # RSAPrivateKey: version, n, e, d, p, q, dp, dq, qInv
    if len(ints) < 4:
        raise GcpAuthError("RSAPrivateKey has too few INTEGERs")
    return ints[1], ints[2], ints[3]


# ----- RS256 -----

def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _sign_rs256(signing_input, n, d):
    digest = hashlib.sha256(signing_input).digest()
    t = _DIGESTINFO_SHA256 + digest
    k = (n.bit_length() + 7) // 8
    if k < len(t) + 11:
        raise GcpAuthError("RSA modulus too small")
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    sig = pow(int.from_bytes(em, "big"), d, n)
    return sig.to_bytes(k, "big")


class TokenMinter:
    """Mints + caches OAuth2 access tokens for a service-account key.

    `key_json` is the full service-account key file content (str or dict):
    client_email + private_key (+ optional token_uri) are used. Tokens are
    cached per scope string and refreshed TOKEN_EARLY_REFRESH_SEC early.
    """

    def __init__(self, key_json, logger, verify_ssl=True):
        self._logger = logger
        self._verify_ssl = verify_ssl
        try:
            key = json.loads(key_json) if isinstance(key_json, str) else key_json
            self._client_email = key["client_email"]
            self._token_uri = key.get("token_uri") or DEFAULT_TOKEN_URI
            self._n, self._e, self._d = _parse_rsa_private_key(
                key["private_key"]
            )
        except GcpAuthError:
            raise
        except (KeyError, ValueError, TypeError) as exc:
            raise GcpAuthError(
                "service-account key unusable (%s: %s)"
                % (type(exc).__name__, exc)
            )
        self._cache = {}  # scope string -> (token, expiry_epoch)

    @property
    def client_email(self):
        return self._client_email

    def get_token(self, scopes):
        """Return a Bearer token valid for `scopes` (space-separated str)."""
        cached = self._cache.get(scopes)
        if cached and time.time() < cached[1] - TOKEN_EARLY_REFRESH_SEC:
            return cached[0]
        token, expiry = self._mint(scopes)
        self._cache[scopes] = (token, expiry)
        return token

    def _mint(self, scopes):
        now = int(time.time())
        header = _b64url(json.dumps(
            {"alg": "RS256", "typ": "JWT"}, separators=(",", ":"),
        ).encode())
        claims = _b64url(json.dumps({
            "iss": self._client_email,
            "scope": scopes,
            "aud": self._token_uri,
            "iat": now - 10,          # small skew allowance
            "exp": now + 3600,
        }, separators=(",", ":")).encode())
        signing_input = (header + "." + claims).encode("ascii")
        assertion = "%s.%s" % (
            signing_input.decode("ascii"),
            _b64url(_sign_rs256(signing_input, self._n, self._d)),
        )
        body = urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }).encode("ascii")
        req = urllib.request.Request(
            self._token_uri, data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        ctx = None
        if self._token_uri.startswith("https"):
            ctx = ssl.create_default_context()
            if not self._verify_ssl:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
        # Transient network resets / 5xx happen in the wild; retry with
        # backoff. 4xx (other than 429) means a bad assertion -> permanent.
        payload = None
        last_err = "unknown"
        for attempt in range(3):
            try:
                with urllib.request.urlopen(
                    req, timeout=TOKEN_TIMEOUT_SEC, context=ctx,
                ) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                detail = ""
                try:
                    detail = exc.read().decode("utf-8", "replace")[:300]
                except Exception:  # noqa: BLE001
                    pass
                last_err = "token exchange HTTP %s: %s" % (exc.code, detail)
                if exc.code not in (429, 500, 502, 503, 504):
                    raise GcpAuthError(last_err)
            except (urllib.error.URLError, OSError) as exc:
                last_err = "token exchange failed: %s" % exc
            if attempt < 2:
                time.sleep(0.5 * (2 ** attempt))
        if payload is None:
            raise GcpAuthError(last_err)
        token = payload.get("access_token")
        if not token:
            raise GcpAuthError("token exchange returned no access_token")
        expires_in = int(payload.get("expires_in") or 3600)
        self._logger.debug(
            "Minted GCP token for %s (expires_in=%ss)",
            self._client_email, expires_in,
        )
        return token, time.time() + expires_in
