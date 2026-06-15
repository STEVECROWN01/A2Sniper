import jwt
import os
import re
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
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours
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

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def decode_token(token: str):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expiré")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token invalide")
