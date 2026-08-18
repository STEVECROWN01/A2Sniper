import jwt
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
import bcrypt
from fastapi import HTTPException
from fastapi.security import HTTPBearer

SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("JWT_SECRET_KEY environment variable is required. Set it in .env.local")
if len(SECRET_KEY) < 32:
    raise RuntimeError("JWT_SECRET_KEY must be at least 32 characters for security")
ALGORITHM = "HS256"

# Access token: short-lived (15 minutes) — industry standard.
# The frontend proxy (app/api/[[...path]]/route.ts) transparently refreshes
# expired access tokens using the httpOnly refresh_token cookie, so the
# user stays logged in for up to REFRESH_TOKEN_EXPIRE_DAYS without noticing
# the short access token lifetime. A stolen access token is only valid for
# 15 minutes max, limiting the blast radius.
#
# Previously this was set to 7 days as a workaround for a buggy proxy refresh
# implementation. The proxy now correctly handles token refresh (30s buffer,
# 10s timeout, cookie rotation on response) so the workaround is no longer
# needed.
ACCESS_TOKEN_EXPIRE_MINUTES = 15

# Refresh token: long-lived (30 days) — used to obtain new access tokens.
# Rotated on every use (the backend revokes the old refresh token when
# issuing a new one, so a stolen refresh token can only be used once
# before the legitimate user's next refresh invalidates it).
REFRESH_TOKEN_EXPIRE_DAYS = 30

MIN_PASSWORD_LENGTH = 8

security = HTTPBearer()


def validate_password_strength(password: str) -> bool:
    """Validate password meets minimum strength requirements."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return False
    if not re.search(r'[A-Z]', password):
        return False
    if not re.search(r'[0-9]', password):
        return False
    if not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        return False
    return True


def get_password_hash(password: str) -> str:
    """Hash a password using bcrypt directly (avoids passlib compatibility issues)."""
    # Truncate to 72 bytes (bcrypt limit) and encode
    password_bytes = password.encode('utf-8')[:72]
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password_bytes, salt)
    return hashed.decode('utf-8')


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against a bcrypt hash."""
    try:
        # Handle both passlib-style ($2b$...) and direct bcrypt hashes
        password_bytes = plain_password.encode('utf-8')[:72]
        hashed_bytes = hashed_password.encode('utf-8')
        return bcrypt.checkpw(password_bytes, hashed_bytes)
    except Exception:
        # Fallback: try passlib-compatible verification for existing hashes
        try:
            from passlib.context import CryptContext
            pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
            return pwd_context.verify(plain_password, hashed_password)
        except Exception:
            return False


def create_access_token(data: dict) -> str:
    """Create a short-lived access token (15 min). Refreshed transparently by the proxy."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({
        "exp": expire,
        "type": "access",
        "jti": secrets.token_hex(16),  # Unique token ID for revocation
    })
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(data: dict) -> str:
    """Create a long-lived refresh token (30 days). Rotated on every use."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({
        "exp": expire,
        "type": "refresh",
        "jti": secrets.token_hex(16),  # Unique token ID for revocation
    })
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token. Raises HTTPException on invalid/expired tokens."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token invalid")


def decode_access_token(token: str) -> dict:
    """Decode and validate an access token specifically. Rejects refresh tokens."""
    payload = decode_token(token)
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type — access token required")
    return payload


def decode_refresh_token(token: str) -> dict:
    """Decode and validate a refresh token specifically. Rejects access tokens."""
    payload = decode_token(token)
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type — refresh token required")
    return payload
