"""Typed errors with a consistent wire format: {"error": {"code", "message", "details"}}.

Messages are written by Privara itself and never interpolate user-supplied values, so
errors cannot echo sensitive input back to callers or into logs.
"""

from __future__ import annotations

from typing import Any


class PrivaraError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, code: str | None = None, details: Any = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            body["details"] = self.details
        return {"error": body}


class AuthenticationError(PrivaraError):
    status_code = 401
    code = "unauthenticated"


class ForbiddenError(PrivaraError):
    status_code = 403
    code = "forbidden"


class NotFoundError(PrivaraError):
    status_code = 404
    code = "not_found"


class ConflictError(PrivaraError):
    status_code = 409
    code = "conflict"


class ValidationFailed(PrivaraError):
    status_code = 422
    code = "validation_failed"


class PayloadTooLarge(PrivaraError):
    status_code = 413
    code = "payload_too_large"


class TooManyRequests(PrivaraError):
    status_code = 429
    code = "too_many_attempts"
