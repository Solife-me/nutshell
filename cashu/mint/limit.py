from typing import Optional

from fastapi import WebSocket, status
from fastapi.responses import JSONResponse
from limits import RateLimitItemPerMinute
from loguru import logger
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

from ..core.settings import settings


def _trusted_proxies() -> set[str]:
    """Peers whose forwarding headers may be believed.

    `mint_forwarded_allow_ips` is already the uvicorn-level trusted-proxy list;
    the rate limiter uses the same list so the two cannot disagree. "*" trusts
    any peer, which is only safe when nothing but a proxy can reach the mint.
    """
    return {
        entry.strip()
        for entry in settings.mint_forwarded_allow_ips.split(",")
        if entry.strip()
    }


def _peer_is_trusted_proxy(peer: Optional[str]) -> bool:
    trusted = _trusted_proxies()
    if "*" in trusted:
        return True
    return peer is not None and peer in trusted


def _rate_limit_exceeded_handler(request: Request, exc: Exception) -> JSONResponse:
    remote_address = _get_client_ip(request)
    logger.warning(
        f"Rate limit {settings.mint_global_rate_limit_per_minute}/minute exceeded:"
        f" {remote_address}"
    )
    return JSONResponse(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        content={"detail": "Rate limit exceeded."},
    )


def _client_ip_from_headers(
    peer: Optional[str], get_header
) -> Optional[str]:
    """Resolve the client IP from forwarding headers, or None.

    Forwarding headers are attacker-controlled on any request that did not come
    through a proxy, so they are only believed when the *peer* is a proxy we
    trust. Reading them unconditionally would let a client mint a fresh
    rate-limit bucket per request simply by varying `X-Forwarded-For`, which
    defeats the limiter entirely.

    Header priority:
      1. CF-Connecting-IP  – set by Cloudflare
      2. X-Forwarded-For   – set by most reverse proxies (first entry)
    """
    if not settings.mint_rate_limit_proxy_trust:
        return None
    if not _peer_is_trusted_proxy(peer):
        return None

    cf_ip = get_header("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    xff = get_header("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return None


def _get_client_ip(request: Request) -> str:
    """Extract the client IP, preferring headers from a trusted proxy."""
    peer = get_remote_address(request)
    forwarded = _client_ip_from_headers(peer, request.headers.get)
    return forwarded or peer


def get_remote_address_excluding_local(request: Request) -> str:
    remote_address = _get_client_ip(request)
    if remote_address == "127.0.0.1":
        return ""
    return remote_address


limiter_global = Limiter(
    key_func=get_remote_address_excluding_local,
    strategy="fixed-window-elastic-expiry",
    default_limits=[f"{settings.mint_global_rate_limit_per_minute}/minute"],
    enabled=settings.mint_rate_limit,
)

limiter = Limiter(
    key_func=get_remote_address_excluding_local,
    strategy="fixed-window-elastic-expiry",
    default_limits=[f"{settings.mint_transaction_rate_limit_per_minute}/minute"],
    enabled=settings.mint_rate_limit,
)


def assert_limit(identifier: str, limit: Optional[int] = None):
    """Custom rate limit handler that accepts a string identifier
    and raises an exception if the rate limit is exceeded. Uses the
    setting `mint_transaction_rate_limit_per_minute` for the rate limit.

    Args:
        identifier (str): The identifier to use for the rate limit. IP address for example.
        limit (Optional[int], optional): The rate limit per minute to use. Defaults to None

    Raises:
        Exception: If the rate limit is exceeded.
    """
    global limiter
    limit_per_minute = limit or settings.mint_transaction_rate_limit_per_minute
    success = limiter._limiter.hit(
        RateLimitItemPerMinute(limit_per_minute),
        identifier,
    )
    if not success:
        logger.warning(f"Rate limit {limit_per_minute}/minute exceeded: {identifier}")
        raise Exception("Rate limit exceeded")


def get_ws_remote_address(ws: WebSocket) -> str:
    """Returns the ip address for the current websocket (or 127.0.0.1 if none found)

    Args:
        ws (WebSocket): The FastAPI WebSocket object.

    Returns:
        str: The ip address for the current websocket.
    """
    peer = ws.client.host if ws.client and ws.client.host else "127.0.0.1"
    forwarded = _client_ip_from_headers(peer, ws.headers.get)
    return forwarded or peer


def limit_websocket(ws: WebSocket):
    """Websocket rate limit handler that accepts a FastAPI WebSocket object.
    This function will raise an exception if the rate limit is exceeded.

    Args:
        ws (WebSocket): The FastAPI WebSocket object.

    Raises:
        Exception: If the rate limit is exceeded.
    """
    remote_address = get_ws_remote_address(ws)
    if remote_address == "127.0.0.1":
        return
    assert_limit(remote_address)
