"""Shared HTTP helpers for direct-API loaders: per-host throttling + JSON/CSV GET.

Several free providers — Eastmoney most notably — rate-limit by source IP and
will temporarily ban a client that bursts requests. Rather than scatter sleep
calls across loaders, every ban-prone call routes through :func:`throttled_get`
here, which enforces a minimum spacing between consecutive requests to the same
*host bucket* (plus a little jitter so concurrent workers don't lock-step) and
reuses one :class:`requests.Session` per process so TCP/TLS setup is amortized.

This module is intentionally provider-agnostic: it knows nothing about
Eastmoney/Sina/Stooq field layouts, only how to space requests politely. A
loader picks its own ``host_key`` and ``min_interval`` and stays ignorant of
the locking mechanics.

All spacing is best-effort and process-local — it does not coordinate across
machines. For batch jobs raise the relevant ``*_MIN_INTERVAL`` env var.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from typing import Any
from urllib3.exceptions import ProtocolError

import requests
from requests.exceptions import ConnectionError, Timeout

from backtest.loaders.base import positive_env_float

logger = logging.getLogger(__name__)

# Default User-Agent. Many free quote endpoints reject the bare urllib/requests
# UA, so we present a normal desktop browser string. Loaders may override.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Upper bound on the random jitter (seconds) added on top of the configured
# minimum interval, so parallel callers de-synchronize instead of all firing
# the instant the interval elapses.
_JITTER_MAX_S = 0.4

# Retry configuration for transient network errors.
_MAX_RETRIES = 2
_RETRY_BACKOFF_BASE = 1.0  # seconds, doubled each retry
_RETRYABLE_EXCEPTIONS = (ConnectionError, Timeout, ProtocolError)


class HostThrottle:
    """Process-wide minimum-spacing gate keyed by an arbitrary host bucket.

    One instance guards all callers; ``wait(bucket, min_interval)`` blocks until
    at least ``min_interval`` seconds (plus jitter) have elapsed since the last
    request tagged with the same ``bucket``. The lock is held only for the
    bookkeeping arithmetic, not across the sleep, so distinct buckets never block
    one another.
    """

    def __init__(self) -> None:
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, bucket: str, min_interval: float) -> None:
        """Block until ``bucket`` is allowed to fire again, then record the slot.

        The *reserved fire time* — jitter included — is what gets stored, so the
        next caller spaces off this caller's actual fire instant rather than an
        earlier un-jittered one. This keeps consecutive requests at least
        ``min_interval`` apart even when many callers burst concurrently (the
        exact scenario the throttle exists for); the jitter only ever pushes a
        slot later, never earlier.
        """
        if min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            last = self._last.get(bucket)
            if last is None or now >= last + min_interval:
                # Slot is free right now — fire immediately, no jitter needed.
                fire_at = now
            else:
                # Chain off the previous reservation and add jitter to desync
                # concurrent callers, baking the jitter into the stored slot.
                fire_at = last + min_interval + random.uniform(0.0, _JITTER_MAX_S)
            self._last[bucket] = fire_at
        sleep_for = fire_at - time.monotonic()
        if sleep_for > 0:
            time.sleep(sleep_for)


# One shared gate for the whole process.
_THROTTLE = HostThrottle()

# Per-process session reuse, keyed by host bucket so different providers keep
# independent connection pools and cookie jars.
_SESSIONS: dict[str, requests.Session] = {}
_SESSIONS_LOCK = threading.Lock()


def _session_for(bucket: str) -> requests.Session:
    with _SESSIONS_LOCK:
        session = _SESSIONS.get(bucket)
        if session is None:
            session = requests.Session()
            _SESSIONS[bucket] = session
        return session


def resolve_min_interval(env_name: str, default: float) -> float:
    """Resolve a per-provider minimum request interval from the environment.

    Args:
        env_name: Env var carrying an override in seconds (e.g.
            ``VIBE_TRADING_EASTMONEY_MIN_INTERVAL``).
        default: Fallback interval when the env var is absent or invalid.

    Returns:
        The override when it parses to a positive float, else ``default``.
    """
    return positive_env_float(env_name, default)


def throttled_get(
    url: str,
    *,
    host_key: str,
    min_interval: float,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 15.0,
    max_retries: int = _MAX_RETRIES,
) -> requests.Response:
    """GET ``url`` after waiting out the per-host minimum interval.

    Retries transient network errors (connection resets, timeouts) with
    exponential backoff to survive brief server-side hiccups.

    Args:
        url: Fully-qualified request URL.
        host_key: Throttle/session bucket. All calls sharing a key are spaced
            by ``min_interval`` and reuse one session.
        min_interval: Minimum seconds between consecutive calls to ``host_key``.
        params: Optional query parameters.
        headers: Optional headers merged over the default browser UA.
        timeout: Per-request socket timeout in seconds.
        max_retries: Number of retry attempts after the first failure.

    Returns:
        The :class:`requests.Response`; the caller decides how to parse it.

    Raises:
        requests.RequestException: Propagated unchanged for the caller's retry
            policy to classify as transient.
    """
    merged_headers = {"User-Agent": DEFAULT_USER_AGENT}
    if headers:
        merged_headers.update(headers)
    _THROTTLE.wait(host_key, min_interval)
    session = _session_for(host_key)

    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return session.get(url, params=params, headers=merged_headers, timeout=timeout)
        except _RETRYABLE_EXCEPTIONS as exc:
            last_exc = exc
            if attempt < max_retries:
                backoff = _RETRY_BACKOFF_BASE * (2 ** attempt) + random.uniform(0, 0.3)
                logger.info(
                    "throttled_get retry %d/%d for %s after %s: %s",
                    attempt + 1, max_retries, host_key, type(exc).__name__, exc,
                )
                time.sleep(backoff)
                # Re-wait for throttle spacing before retry.
                _THROTTLE.wait(host_key, min_interval)
            else:
                logger.warning(
                    "throttled_get exhausted retries for %s: %s",
                    host_key, exc,
                )
    raise last_exc  # type: ignore[misc]


def throttled_get_json(
    url: str,
    *,
    host_key: str,
    min_interval: float,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 15.0,
) -> Any:
    """Throttled GET that decodes the response body as JSON.

    Same contract as :func:`throttled_get`, plus ``response.raise_for_status()``
    and ``response.json()``. A non-2xx status or undecodable body raises, which
    the caller's bounded-retry wrapper treats as transient.
    """
    response = throttled_get(
        url,
        host_key=host_key,
        min_interval=min_interval,
        params=params,
        headers=headers,
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()
