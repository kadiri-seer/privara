"""In-memory throttle for failed authentication attempts, keyed by client address.

Keys carry 256 bits of entropy, so this is not what keeps them safe; it limits noise from
scanners on a hosted deployment and protects an operator-chosen PRIVARA_ADMIN_API_KEY.
State is per process and resets on restart.
"""

from __future__ import annotations

import threading
import time
from collections import deque

from .errors import TooManyRequests


class AuthThrottle:
    def __init__(self, max_failures: int, window_seconds: float = 60.0, clock=time.monotonic):
        self.max_failures = max_failures
        self.window = window_seconds
        self.clock = clock
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        bucket = self._failures.setdefault(key, deque())
        while bucket and now - bucket[0] > self.window:
            bucket.popleft()
        return bucket

    def check(self, key: str) -> None:
        with self._lock:
            now = self.clock()
            if len(self._prune(key, now)) >= self.max_failures:
                raise TooManyRequests("Too many failed authentication attempts. Wait a minute and try again.")
            if len(self._failures) > 10_000:  # bound memory under address churn
                for stale in [k for k, v in self._failures.items() if not v]:
                    del self._failures[stale]

    def record_failure(self, key: str) -> None:
        with self._lock:
            self._prune(key, self.clock()).append(self.clock())
