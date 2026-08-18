"""Short-lived, in-memory evaOS authentication for Pipedream MCP."""
from __future__ import annotations
import asyncio, os, re, stat
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional
from urllib.parse import urlparse
import httpx
from agent.redact import redact_untrusted_error_detail

_APP_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")
_ACCOUNT_RE = re.compile(r"^apn_[A-Za-z0-9_-]+$")
_EXTERNAL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,180}$")
_CREDENTIAL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_ENDPOINT_PATH = "/functions/v1/desktop-runtime-session"
_MCP_ORIGIN = ("https", "remote.mcp.pipedream.net")
_LEASE_HEADERS = frozenset({"Authorization", "x-pd-project-id",
    "x-pd-environment", "x-pd-external-user-id", "x-pd-app-slug", "x-pd-account-id"})
class EvaosLeaseError(RuntimeError):
    """Sanitized failure while resolving or refreshing a managed lease."""
@dataclass(frozen=True, repr=False)
class _SourceMaterial:
    endpoint: str; broker_secret: str; app_slug: str
    external_user_id: Optional[str]; account_id: Optional[str]
@dataclass(frozen=True, repr=False)
class EvaosMcpLease:
    mcp_url: str; headers: Mapping[str, str]; expires_at: datetime
    @property
    def authorization(self) -> str: return self.headers["Authorization"]
    def __repr__(self) -> str: return (
        f"EvaosMcpLease(mcp_url={self.mcp_url!r}, "
        f"expires_at={self.expires_at!r}, headers=<redacted>)")
def _default_secret_reader(name: str) -> Optional[str]:
    from agent.secret_scope import get_secret; return get_secret(name)
def _default_profile_resolver() -> str:
    from hermes_constants import get_hermes_home; return str(get_hermes_home().expanduser().resolve())
class EvaosLeaseSource:
    """Resolve global broker material only for the current Hermes profile."""
    def __init__(self, *, profile_key: str, app_slug: str,
        external_user_id: Optional[str] = None, account_id: Optional[str] = None,
        secret_reader: Optional[Callable[[str], Optional[str]]] = None,
        profile_resolver: Optional[Callable[[], str]] = None, root_uid: int = 0,
        service_uid: Optional[int] = None):
        if not isinstance(profile_key, str) or not profile_key:
            raise EvaosLeaseError("managed MCP profile authority is missing")
        if not isinstance(app_slug, str) or not _APP_RE.fullmatch(app_slug):
            raise EvaosLeaseError("managed MCP app slug is invalid")
        if (external_user_id is None) != (account_id is None):
            raise EvaosLeaseError(
                "managed MCP external_user_id and account_id must be configured together"
            )
        if external_user_id is not None and (
            not isinstance(external_user_id, str)
            or not _EXTERNAL_RE.fullmatch(external_user_id)
            or not isinstance(account_id, str)
            or not _ACCOUNT_RE.fullmatch(account_id)
        ):
            raise EvaosLeaseError("managed MCP direct identity is invalid")
        self._profile_key = profile_key
        self._app_slug = app_slug
        self._external_user_id = external_user_id
        self._account_id = account_id
        self._secret_reader = secret_reader or _default_secret_reader
        self._profile_resolver = profile_resolver or _default_profile_resolver
        self._root_uid = root_uid
        geteuid = getattr(os, "geteuid", None)
        self._service_uid = ((geteuid() if callable(geteuid) else root_uid)
            if service_uid is None else service_uid)
    def __repr__(self) -> str: return f"EvaosLeaseSource(profile_key={self._profile_key!r}, app_slug={self._app_slug!r})"
    def _setting(self, name: str) -> str:
        try:
            value = self._secret_reader(name)
        except Exception as exc:
            raise EvaosLeaseError(
                "managed MCP profile-scoped configuration is unavailable") from exc
        if not isinstance(value, str) or not value.strip():
            raise EvaosLeaseError("managed MCP profile-scoped configuration is incomplete")
        return value.strip()
    def _secure_file_text(self, raw_path: str, *, label: str) -> str:
        credentials_dir = os.environ.get("CREDENTIALS_DIRECTORY", "").strip()
        if raw_path.startswith("%d/"):
            name = raw_path[3:]
            base = Path(credentials_dir)
            if not _CREDENTIAL_RE.fullmatch(name) or not base.is_absolute():
                raise EvaosLeaseError(
                    f"{label} has an invalid systemd credential pointer"
                )
            path = base / name
        else:
            path = Path(raw_path)
        if not path.is_absolute():
            raise EvaosLeaseError(f"{label} must use an absolute path")
        flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0))
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise EvaosLeaseError(f"{label} is unavailable") from exc
        try:
            metadata = os.fstat(descriptor)
            mode = stat.S_IMODE(metadata.st_mode)
            systemd_dir = Path(credentials_dir) if credentials_dir else None
            in_systemd = bool(systemd_dir and systemd_dir.is_absolute()
                and path.parent == systemd_dir)
            direct = metadata.st_uid == self._root_uid and mode == 0o600
            copied = (in_systemd
                and metadata.st_uid in {self._root_uid, self._service_uid}
                and (mode == 0o400
                    or (metadata.st_uid == self._root_uid and mode == 0o440)))
            if not stat.S_ISREG(metadata.st_mode):
                raise EvaosLeaseError(f"{label} must be a regular file")
            if not direct and not copied:
                raise EvaosLeaseError(
                    f"{label} does not have secure managed credential ownership and mode"
                )
            if metadata.st_size <= 0 or metadata.st_size > 64 * 1024:
                raise EvaosLeaseError(f"{label} has an invalid size")
            chunks: list[bytes] = []
            remaining = metadata.st_size
            while remaining:
                chunk = os.read(descriptor, remaining)
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            if remaining:
                raise EvaosLeaseError(f"{label} is unreadable")
            return b"".join(chunks).decode("utf-8")
        except (OSError, UnicodeError) as exc:
            raise EvaosLeaseError(f"{label} is unreadable") from exc
        finally:
            os.close(descriptor)
    def _endpoint(self) -> str:
        endpoint = self._setting("EVAOS_DESKTOP_RUNTIME_SESSION_URL")
        try:
            parsed = urlparse(endpoint)
            host = (parsed.hostname or "").lower()
            port = parsed.port
        except ValueError as exc:
            raise EvaosLeaseError("managed MCP lease endpoint is invalid") from exc
        if (parsed.scheme != "https" or not host.endswith(".supabase.co")
            or host == ".supabase.co" or port not in (None, 443)
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment
            or parsed.path.rstrip("/") != _ENDPOINT_PATH):
            raise EvaosLeaseError("managed MCP lease endpoint is invalid")
        return endpoint
    def read(self) -> _SourceMaterial:
        try:
            current = self._profile_resolver()
        except Exception as exc:
            raise EvaosLeaseError("managed MCP profile authority is unavailable") from exc
        if current != self._profile_key:
            raise EvaosLeaseError("managed MCP profile authority changed")
        secret = self._secure_file_text(
            self._setting("PIPEDREAM_AGENT_BROKER_SECRET_FILE"),
            label="managed MCP broker secret file",
        ).strip()
        if not secret or "\n" in secret or "\r" in secret:
            raise EvaosLeaseError("managed MCP broker secret file is malformed")
        return _SourceMaterial(self._endpoint(), secret, self._app_slug,
            self._external_user_id, self._account_id)
LeaseTransport = Callable[[str, Mapping[str, str], Mapping[str, str]], Awaitable[Any]]
async def _default_transport(url: str, headers: Mapping[str, str],
    payload: Mapping[str, str]):
    async with httpx.AsyncClient(follow_redirects=False,
        timeout=httpx.Timeout(15.0)) as client:
        return await client.post(url, headers=headers, json=payload)
class EvaosLeaseManager:
    """Single-flight, memory-only lease cache."""
    def __init__(self, *, source: EvaosLeaseSource,
        transport: Optional[LeaseTransport] = None,
        now: Optional[Callable[[], datetime]] = None,
        refresh_skew_seconds: float = 60,
        on_mint_failure: Optional[Callable[[Exception], None]] = None):
        if refresh_skew_seconds < 0:
            raise ValueError("refresh_skew_seconds must be non-negative")
        self._source = source
        self._transport = transport or _default_transport
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._refresh_skew = timedelta(seconds=refresh_skew_seconds)
        self._on_mint_failure = on_mint_failure
        self._lock = asyncio.Lock()
        self._lease: Optional[EvaosMcpLease] = None
    def __repr__(self) -> str: return "EvaosLeaseManager(lease=<redacted>)"
    def _usable(self, lease: Optional[EvaosMcpLease]) -> bool: return bool(lease and lease.expires_at > self._now() + self._refresh_skew)
    async def get_lease(self, *, force_refresh: bool = False,
        rejected_authorization: Optional[str] = None) -> EvaosMcpLease:
        lease = self._lease
        if not force_refresh and self._usable(lease):
            return lease
        async with self._lock:
            lease = self._lease
            if force_refresh:
                if (rejected_authorization and lease
                    and lease.authorization != rejected_authorization
                    and self._usable(lease)):
                    return lease
            elif self._usable(lease):
                return lease
            try:
                minted = await self._mint(self._source.read())
            except Exception as exc:
                if self._on_mint_failure:
                    self._on_mint_failure(exc)
                raise
            self._lease = minted
            return minted
    async def _mint(self, material: _SourceMaterial) -> EvaosMcpLease:
        headers = {
            "Content-Type": "application/json",
            "X-Evaos-Desktop-Broker-Secret": material.broker_secret,
        }
        body = {"action": "pipedream_mcp_lease", "app_slug": material.app_slug}
        if material.external_user_id is not None:
            body["external_user_id"] = material.external_user_id
            body["account_id"] = material.account_id
        try:
            response = await self._transport(material.endpoint, headers, body)
        except Exception as exc:
            raise EvaosLeaseError("managed MCP lease service is unavailable") from exc
        status = getattr(response, "status_code", None)
        if status != 200:
            labels = {
                400: "managed MCP lease request was rejected",
                401: "managed MCP lease rejected",
                403: "managed MCP profile authority is no longer valid",
                429: "managed MCP lease service is temporarily unavailable",
                502: "managed MCP lease service is temporarily unavailable",
                503: "managed MCP lease service is temporarily unavailable",
            }
            message = labels.get(
                status, "managed MCP lease service returned an unexpected status"
            )
            detail = self._sanitized_detail(response, material.broker_secret)
            rendered = f"{message} ({status})"
            raise EvaosLeaseError(f"{rendered}: {detail}" if detail else rendered)
        try:
            payload = response.json()
        except Exception as exc:
            raise EvaosLeaseError("managed MCP lease response is malformed") from exc
        return self._parse(payload, material.app_slug,
            material.external_user_id, material.account_id)
    @staticmethod
    def _sanitized_detail(response: Any, broker_secret: str) -> str:
        try:
            body = response.text
        except Exception:
            return ""
        if not isinstance(body, str):
            return ""
        detail = redact_untrusted_error_detail(body,
            known_secrets=(broker_secret,), limit=512)
        return "".join(c for c in detail if c.isprintable()).strip()
    def _parse(self, payload: Any, app_slug: str,
        external_user_id: Optional[str],
        account_id: Optional[str]) -> EvaosMcpLease:
        if not isinstance(payload, dict) or set(payload) != {
            "mcp_url",
            "headers",
            "expires_at",
        }:
            raise EvaosLeaseError("managed MCP lease response is malformed")
        mcp_url = payload.get("mcp_url")
        try:
            parsed = urlparse(mcp_url) if isinstance(mcp_url, str) else None
            port = parsed.port if parsed else None
        except ValueError as exc:
            raise EvaosLeaseError("managed MCP lease response is malformed") from exc
        if (parsed is None or (parsed.scheme, parsed.hostname) != _MCP_ORIGIN
            or port not in (None, 443) or parsed.username is not None
            or parsed.password is not None or parsed.path.rstrip("/") != "/v3"
            or parsed.query or parsed.fragment):
            raise EvaosLeaseError("managed MCP lease response is malformed")
        headers = payload.get("headers")
        if (not isinstance(headers, dict) or set(headers) != _LEASE_HEADERS
            or not all(isinstance(k, str) and isinstance(v, str) and v.strip()
                and "\r" not in v and "\n" not in v for k, v in headers.items())
            or not headers.get("Authorization", "").startswith("Bearer ")
            or len(headers["Authorization"]) <= len("Bearer ")
            or headers.get("x-pd-app-slug") != app_slug
            or not _ACCOUNT_RE.fullmatch(headers.get("x-pd-account-id", ""))
            or (external_user_id is not None
                and headers.get("x-pd-external-user-id") != external_user_id)
            or (account_id is not None
                and headers.get("x-pd-account-id") != account_id)):
            raise EvaosLeaseError("managed MCP lease response is malformed")
        try:
            expiry = datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
        except (AttributeError, TypeError, ValueError) as exc:
            raise EvaosLeaseError("managed MCP lease response is malformed") from exc
        if expiry.tzinfo is None:
            raise EvaosLeaseError("managed MCP lease response is malformed")
        expiry = expiry.astimezone(timezone.utc)
        if expiry <= self._now() + self._refresh_skew:
            raise EvaosLeaseError("managed MCP lease response expires too soon")
        return EvaosMcpLease(mcp_url, dict(headers), expiry)
def _sdk_httpx_auth_base() -> type:
    """Select the Auth base used by the installed MCP HTTP transport.

    MCP 2.x builds its client on ``httpx2`` while older MCP releases use
    standard ``httpx``.  The two packages intentionally expose the same API
    but their Auth classes are unrelated, and AsyncClient rejects an Auth
    object from the other package.  Keep the fallback standard-library path
    available when the MCP transport is not installed.
    """
    try:
        from tools.mcp_tool import sdk_httpx

        module = sdk_httpx()
    except Exception:
        module = None
    return getattr(module, "Auth", httpx.Auth)


_SDK_HTTPX_AUTH_BASE = _sdk_httpx_auth_base()


class _EvaosLeaseAuthMixin:
    """Shared lease flow for the SDK and legacy HTTPX Auth bases."""
    requires_request_body = True

    def __init__(self, manager: EvaosLeaseManager):
        self._manager = manager

    def __repr__(self) -> str: return "EvaosLeaseHttpAuth(manager=<redacted>)"

    @staticmethod
    def _apply(request: Any, lease: EvaosMcpLease) -> None:
        # Preserve the Request/URL family supplied by the transport.  This
        # keeps direct legacy-httpx callers working while ensuring MCP2's
        # httpx2 request remains entirely inside its own type boundary.
        request.url = type(request.url)(lease.mcp_url)
        for name in _LEASE_HEADERS:
            request.headers.pop(name, None)
            request.headers.pop(name.lower(), None)
        request.headers.update(lease.headers)
    async def async_auth_flow(self, request: Any):
        lease = await self._manager.get_lease()
        self._apply(request, lease)
        response = yield request
        if response.status_code != 401:
            return
        await response.aread()
        refreshed = await self._manager.get_lease(
            force_refresh=True, rejected_authorization=lease.authorization
        )
        self._apply(request, refreshed)
        yield request


if _SDK_HTTPX_AUTH_BASE is httpx.Auth:
    class EvaosLeaseHttpAuth(_EvaosLeaseAuthMixin, httpx.Auth):
        """Apply a lease and retry exactly once after a 401."""
else:
    class EvaosLeaseHttpAuth(
        _EvaosLeaseAuthMixin,
        _SDK_HTTPX_AUTH_BASE,
        httpx.Auth,
    ):
        """Apply a lease and retry exactly once after a 401."""
