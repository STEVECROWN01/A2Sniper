"""
Base de Données (Supabase / PostgreSQL) — CDC A2Sniper 3.0
Intégration cloud production-ready.
"""

import os
import logging
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, JSON, Numeric, ForeignKey, Index, Text
from sqlalchemy.orm import relationship

logger = logging.getLogger(__name__)

from dotenv import load_dotenv
load_dotenv()

# URL de connexion Supabase (PostgreSQL)
_raw_db_url = os.getenv("DATABASE_URL", "")

# Determine if we should use PostgreSQL or fallback to SQLite
_use_pg = bool(_raw_db_url and _raw_db_url.startswith("postgresql"))

if _use_pg:
    # SQLAlchemy needs the +asyncpg dialect specifier for async PostgreSQL.
    # Railway provides URLs like "postgresql://user:pass@host:port/db"
    # but create_async_engine needs "postgresql+asyncpg://user:pass@host:port/db"
    if _raw_db_url.startswith("postgresql://"):
        DATABASE_URL = _raw_db_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    elif _raw_db_url.startswith("postgresql+asyncpg://"):
        DATABASE_URL = _raw_db_url  # Already correct
    else:
        DATABASE_URL = _raw_db_url
    logger.info(f"[DB] Connexion PostgreSQL configurée (asyncpg).")
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(os.path.dirname(BASE_DIR), "a2sniper.db")
    DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"
    logger.warning(f"[DB] DATABASE_URL non configurée ou invalide → Fallback SQLite local absolu ({db_path})")

# PgBouncer compatibility: disable prepared statement cache for Supabase pooler
_is_pg = DATABASE_URL.startswith("postgresql")

# Strip query parameters that asyncpg doesn't understand (pgbouncer, etc.)
# Supabase pooler URLs include ?pgbouncer=true which breaks asyncpg connect()
if _is_pg and '?' in DATABASE_URL:
    # Keep only the base URL without query params
    DATABASE_URL = DATABASE_URL.split('?')[0]
    logger.info(f"[DB] Stripped query parameters from DATABASE_URL for asyncpg compatibility")

connect_args = {"statement_cache_size": 0} if _is_pg else {}

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    connect_args=connect_args,
    pool_pre_ping=True if _is_pg else False,
    pool_size=5 if _is_pg else 5,
    max_overflow=10 if _is_pg else 0,
    pool_recycle=300,  # Recycle connections every 5 minutes
    pool_timeout=30,   # Wait 30s for a connection before giving up
)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()

VALID_PLANS = ('Standard', 'Premium', 'Pro')

class SignalRecord(Base):
    """Stockage persistant et immuable des signaux émis."""
    __tablename__ = "signals"

    id = Column(String, primary_key=True, index=True)
    pair = Column(String, index=True, nullable=False)
    direction = Column(String, nullable=False)
    entry_price = Column(Numeric(18, 5))  # Fixed precision for financial data
    expiration = Column(Integer)
    winrate = Column(Float)
    score = Column(Integer)  # CDC Section 7: confluence score out of 10
    payout = Column(Integer)
    classification = Column(String)
    timestamp = Column(DateTime(timezone=True))
    is_win = Column(Boolean, nullable=True)
    analysis_details = Column(JSON)
    hash_signature = Column(String)
    session_id = Column(String, index=True, nullable=True)  # Trading session (10 trades per session)


class CandleRecord(Base):
    """Historical candle storage — persists across Railway redeploys.
    
    When the backend restarts, candles are loaded from this table so the
    sniper engine has data immediately (no 15-minute warm-up needed).
    Each candle is uniquely identified by (pair, timestamp) to prevent duplicates.
    """
    __tablename__ = "candles"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    pair = Column(String, index=True, nullable=False)  # e.g., "EURUSD_otc"
    timestamp = Column(Integer, index=True, nullable=False)  # Unix timestamp (seconds)
    open = Column(Float, nullable=False)
    high = Column(Float, nullable=False)
    low = Column(Float, nullable=False)
    close = Column(Float, nullable=False)
    volume = Column(Float, default=0)
    timeframe = Column(String, default="1m")  # e.g., "1m", "5m"
    
    # Unique constraint to prevent duplicate candles
    __table_args__ = (
        Index('idx_candles_pair_ts', 'pair', 'timestamp', unique=True),
    )

class User(Base):
    """Utilisateur du système."""
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    full_name = Column(String)
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True))
    auth_provider = Column(String, default="email")  # "email" or "google" — tracks how the user signed up
    avatar = Column(Text, nullable=True)  # Base64-encoded profile picture
    notification_sound = Column(String, default="bell")  # bell, chime, alert, coin, digital
    subscription = relationship("UserSubscription", back_populates="user", uselist=False, cascade="all, delete-orphan")
    push_subscriptions = relationship("PushSubscription", back_populates="user", cascade="all, delete-orphan")

class UserSubscription(Base):
    """Gestion des plans utilisateurs."""
    __tablename__ = "subscriptions"

    user_id = Column(String, ForeignKey("users.id"), primary_key=True, index=True, nullable=False)
    plan_name = Column(String, default="Standard", nullable=False)
    active_until = Column(DateTime(timezone=True))
    telegram_chat_id = Column(String, nullable=True)
    user = relationship("User", back_populates="subscription")

class SystemLog(Base):
    """Logs système pour audit PDF mensuel."""
    __tablename__ = "system_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime(timezone=True))
    level = Column(String)
    module = Column(String)
    message = Column(String)

class PasswordResetOTP(Base):
    """Stockage temporaire des codes OTP pour la réinitialisation de mot de passe."""
    __tablename__ = "password_reset_otps"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, index=True, nullable=False)
    otp_code = Column(String, index=True, nullable=False)  # Added index for OTP lookups
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True))
    purpose = Column(String, default="password_reset")  # "password_reset", "registration", "account_deletion"

class DeletedAccount(Base):
    """Audit trail for deleted accounts — persists after user is removed."""
    __tablename__ = "deleted_accounts"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    email = Column(String, index=True, nullable=False)
    full_name = Column(String)
    auth_provider = Column(String)
    plan_name = Column(String)
    is_admin = Column(Boolean, default=False)
    deleted_at = Column(DateTime(timezone=True), nullable=False)
    deletion_reason = Column(String, default="user_requested")  # "user_requested", "admin_forced"


class RefreshToken(Base):
    """Persistent refresh tokens for JWT authentication. Survives server restarts."""
    __tablename__ = "refresh_tokens"

    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    token_jti = Column(String, unique=True, index=True, nullable=False)  # JWT ID for targeted revocation
    hashed_token = Column(String, nullable=False)  # Hashed refresh token for verification
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False)
    is_revoked = Column(Boolean, default=False, index=True)  # Soft-revoke flag
    # Device/browser info for user visibility
    user_agent = Column(String, nullable=True)
    ip_address = Column(String, nullable=True)

    __table_args__ = (
        Index('ix_refresh_tokens_user_active', 'user_id', 'is_revoked'),
    )


class RevokedToken(Base):
    """Token blacklist — both access and refresh tokens can be revoked here."""
    __tablename__ = "revoked_tokens"

    id = Column(String, primary_key=True, index=True)
    token_jti = Column(String, unique=True, index=True, nullable=False)  # JWT ID
    token_type = Column(String, nullable=False)  # "access" or "refresh"
    user_id = Column(String, index=True, nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=False)
    reason = Column(String, default="user_logout")  # "user_logout", "security", "password_change", "admin_revoke"
    expires_at = Column(DateTime(timezone=True), nullable=False)  # When the token naturally expires (for cleanup)

    __table_args__ = (
        Index('ix_revoked_tokens_jti', 'token_jti'),
        Index('ix_revoked_tokens_expires', 'expires_at'),
    )


class RateLimitEntry(Base):
    """Persistent rate limit tracking — survives server restarts."""
    __tablename__ = "rate_limit_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ip_address = Column(String, index=True, nullable=False)
    endpoint = Column(String, nullable=False)  # e.g., "login", "register", "global"
    timestamp = Column(DateTime(timezone=True), nullable=False, index=True)

    __table_args__ = (
        Index('ix_rate_limit_ip_timestamp', 'ip_address', 'timestamp'),
    )


class PushSubscription(Base):
    """Web Push notification subscriptions — one user can have multiple devices."""
    __tablename__ = "push_subscriptions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    endpoint = Column(Text, nullable=False)  # Push service endpoint URL
    p256dh_key = Column(Text, nullable=False)  # ECDH public key (base64url)
    auth_key = Column(Text, nullable=False)  # Authentication secret (base64url)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="push_subscriptions")


class MarketSession(Base):
    """Encrypted Pocket Option SSID storage — survives Railway redeploys.

    Replaces backend/data/last_ssid.txt (which was wiped on every container
    restart). The SSID is Fernet-encrypted (AES-128-CBC + HMAC-SHA256)
    before being stored here, so it's encrypted both at rest (DB layer +
    our Fernet layer) and in transit (HTTPS).

    One row per user — when a user connects, their row is upserted. The
    auto_reconnect_scanner picks the most recently updated SSID across
    all users (preserves the "single shared scanner" model).
    """
    __tablename__ = "market_sessions"
    user_id = Column(String, ForeignKey("users.id"), primary_key=True, index=True)
    encrypted_ssid = Column(Text, nullable=False)  # Fernet token (base64url)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class AppState(Base):
    """Generic key-value store for app state — replaces JSON files.

    Replaces:
      - compliance_hash_chain.json  (key: 'compliance_hash_chain')
      - risk_state.json             (key: 'risk_state')
      - bot_state.json              (key: 'bot_state')

    All three were previously stored on the ephemeral Railway filesystem
    and wiped on every redeploy. Moving them here makes them durable
    across redeploys, backups (Supabase PITR), and DB failovers.

    The `value` column uses SQLAlchemy's JSON type, which maps to JSONB
    on PostgreSQL and TEXT on SQLite (for local dev fallback).
    """
    __tablename__ = "app_state"
    key = Column(String, primary_key=True, index=True)
    value = Column(JSON, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


# OTP brute force tracking (in-memory, with DB fallback)
otp_attempt_tracker = {}  # {email: {"count": int, "last_attempt": datetime}}

async def get_db():
    """Dépendance pour obtenir une session de DB asynchrone."""
    async with AsyncSessionLocal() as session:
        yield session


# ═══════════ APP STATE HELPERS (replaces JSON state files) ═══════════
# Generic key-value store for app state that needs to survive Railway
# redeploys. Replaces:
#   - backend/compliance_hash_chain.json   (key: 'compliance_hash_chain')
#   - backend/risk_state.json              (key: 'risk_state')
#   - backend/bot_state.json               (key: 'bot_state')
#
# All methods are async — callers must `await` them. The sync `_save_state()`
# methods on ComplianceManager / RiskManager / TelegramSignalBot wrap these
# with asyncio.create_task (fire-and-forget) so they can be called from sync
# contexts without blocking.

async def get_app_state(key: str, default=None):
    """Read a JSON-serializable value from the app_state table.

    Returns `default` if the key doesn't exist or the DB is unreachable.
    Never raises — state reads are best-effort.
    """
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(AppState).where(AppState.key == key)
            )
            row = result.scalar_one_or_none()
            return row.value if row else default
    except Exception as e:
        logger.warning(f"[APP_STATE] get('{key}') failed: {e}")
        return default


async def set_app_state(key: str, value) -> None:
    """Upsert a JSON-serializable value into the app_state table.

    Never raises — state writes are best-effort. If the DB is unreachable,
    the in-memory state remains correct for the current process (but won't
    survive a restart).
    """
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(AppState).where(AppState.key == key)
            )
            row = result.scalar_one_or_none()
            if row:
                row.value = value
            else:
                session.add(AppState(key=key, value=value))
            await session.commit()
    except Exception as e:
        logger.warning(f"[APP_STATE] set('{key}') failed: {e}")


async def delete_app_state(key: str) -> None:
    """Delete a key from the app_state table. No-op if the key doesn't exist."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(AppState).where(AppState.key == key)
            )
            row = result.scalar_one_or_none()
            if row:
                await session.delete(row)
                await session.commit()
    except Exception as e:
        logger.warning(f"[APP_STATE] delete('{key}') failed: {e}")


# ═══════════ MARKET SESSION HELPERS (replaces last_ssid.txt) ═══════════

async def save_market_session(user_id: str, encrypted_ssid: str) -> None:
    """Upsert the encrypted SSID for a user. The SSID must already be
    Fernet-encrypted by the caller — this helper stores the opaque token.
    """
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(MarketSession).where(MarketSession.user_id == user_id)
            )
            row = result.scalar_one_or_none()
            if row:
                row.encrypted_ssid = encrypted_ssid
            else:
                session.add(MarketSession(user_id=user_id, encrypted_ssid=encrypted_ssid))
            await session.commit()
    except Exception as e:
        logger.warning(f"[MARKET_SESSION] save for user_id={user_id[:8]}... failed: {e}")


async def get_market_session(user_id: str) -> str | None:
    """Return the encrypted SSID token for a user, or None if not saved."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(MarketSession).where(MarketSession.user_id == user_id)
            )
            row = result.scalar_one_or_none()
            return row.encrypted_ssid if row else None
    except Exception as e:
        logger.warning(f"[MARKET_SESSION] get for user_id={user_id[:8]}... failed: {e}")
        return None


async def get_latest_market_session() -> tuple[str, str] | None:
    """Return (user_id, encrypted_ssid) for the most recently updated row.

    Used by auto_reconnect_scanner on backend startup — picks the most
    recently connected user's SSID (preserves the "single shared scanner"
    model where the last user to connect wins).
    """
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(MarketSession).order_by(MarketSession.updated_at.desc()).limit(1)
            )
            row = result.scalar_one_or_none()
            return (row.user_id, row.encrypted_ssid) if row else None
    except Exception as e:
        logger.warning(f"[MARKET_SESSION] get_latest failed: {e}")
        return None


async def has_market_session(user_id: str) -> bool:
    """Check whether a saved SSID exists for a user (without decrypting it)."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(MarketSession.user_id).where(MarketSession.user_id == user_id)
            )
            return result.scalar_one_or_none() is not None
    except Exception as e:
        logger.warning(f"[MARKET_SESSION] has for user_id={user_id[:8]}... failed: {e}")
        return False


async def delete_market_session(user_id: str) -> None:
    """Delete the saved SSID for a user (on disconnect)."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(MarketSession).where(MarketSession.user_id == user_id)
            )
            row = result.scalar_one_or_none()
            if row:
                await session.delete(row)
                await session.commit()
    except Exception as e:
        logger.warning(f"[MARKET_SESSION] delete for user_id={user_id[:8]}... failed: {e}")


async def init_db():
    """Crée les tables si elles n'existent pas, et ajoute les colonnes manquantes."""
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("[DB] Base de données initialisée avec succès.")
    except Exception as e:
        logger.error(f"[DB] Erreur lors de l'initialisation de la DB : {e}")
        # Fallback: create tables individually
        try:
            async with engine.begin() as conn:
                for table in Base.metadata.sorted_tables:
                    try:
                        await conn.run_sync(table.create)
                        logger.info(f"[DB] Created table: {table.name}")
                    except Exception as te:
                        if "already exists" in str(te).lower():
                            logger.info(f"[DB] Table {table.name} already exists")
                        else:
                            logger.warning(f"[DB] Could not create table {table.name}: {te}")
            logger.info("[DB] Fallback table creation completed.")
        except Exception as fe:
            logger.error(f"[DB] Fallback table creation also failed: {fe}")

    # Migrate: add missing columns to existing tables (PostgreSQL only)
    if _use_pg:
        try:
            async with engine.begin() as conn:
                # Add is_admin column if missing
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='users' AND column_name='is_admin'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE"
                    ))
                    logger.info("[DB] Migration: Added is_admin column to users table")

                # Add is_active column if missing
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='users' AND column_name='is_active'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE"
                    ))
                    logger.info("[DB] Migration: Added is_active column to users table")

                # Add created_at column if missing
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='users' AND column_name='created_at'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE users ADD COLUMN created_at TIMESTAMP WITH TIME ZONE"
                    ))
                    logger.info("[DB] Migration: Added created_at column to users table")
                else:
                    # Column exists — ensure it's WITH TIME ZONE (was originally naive)
                    tz_result = await conn.execute(
                        __import__('sqlalchemy').text(
                            "SELECT data_type FROM information_schema.columns "
                            "WHERE table_name='users' AND column_name='created_at'"
                        )
                    )
                    tz_row = tz_result.fetchone()
                    if tz_row and tz_row[0] != "timestamp with time zone":
                        await conn.execute(__import__('sqlalchemy').text(
                            "ALTER TABLE users ALTER COLUMN created_at "
                            "TYPE TIMESTAMP WITH TIME ZONE USING created_at AT TIME ZONE 'UTC'"
                        ))
                        logger.info("[DB] Migration: Changed users.created_at to TIMESTAMP WITH TIME ZONE")

                # Add full_name column if missing
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='users' AND column_name='full_name'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE users ADD COLUMN full_name VARCHAR"
                    ))
                    logger.info("[DB] Migration: Added full_name column to users table")

                # Add avatar column to users table (for profile picture storage)
                try:
                    async with engine.begin() as conn:
                        result = await conn.execute(
                            __import__('sqlalchemy').text(
                                "SELECT column_name FROM information_schema.columns "
                                "WHERE table_name='users' AND column_name='avatar'"
                            )
                        )
                        if not result.fetchone():
                            await conn.execute(__import__('sqlalchemy').text(
                                "ALTER TABLE users ADD COLUMN avatar TEXT"
                            ))
                            logger.info("[DB] Migration: Added avatar column to users table")
                except Exception as e:
                    logger.warning(f"[DB] Migration for users.avatar failed (non-fatal): {e}")

                # Check users table has notification_sound column
                # Uses a FRESH connection to avoid issues with the outer
                # transaction being in an aborted state from prior migrations.
                try:
                    async with engine.begin() as ns_conn:
                        ns_result = await ns_conn.execute(
                            __import__('sqlalchemy').text(
                                "SELECT column_name FROM information_schema.columns "
                                "WHERE table_name='users' AND column_name='notification_sound'"
                            )
                        )
                        if not ns_result.fetchone():
                            await ns_conn.execute(__import__('sqlalchemy').text(
                                "ALTER TABLE users ADD COLUMN notification_sound VARCHAR DEFAULT 'bell'"
                            ))
                            logger.info("[DB] Migration: Added notification_sound column to users table")
                        else:
                            logger.info("[DB] Migration: notification_sound column already exists")
                except Exception as e:
                    logger.error(f"[DB] Migration for users.notification_sound FAILED (CRITICAL): {e}")

                # Create push_subscriptions table if it doesn't exist
                # Also uses a fresh connection.
                try:
                    async with engine.begin() as ps_conn:
                        ps_result = await ps_conn.execute(
                            __import__('sqlalchemy').text(
                                "SELECT table_name FROM information_schema.tables WHERE table_name='push_subscriptions'"
                            )
                        )
                        if not ps_result.fetchone():
                            await ps_conn.execute(__import__('sqlalchemy').text("""
                                CREATE TABLE push_subscriptions (
                                    id SERIAL PRIMARY KEY,
                                    user_id VARCHAR NOT NULL,
                                    endpoint TEXT NOT NULL,
                                    p256dh_key TEXT NOT NULL,
                                    auth_key TEXT NOT NULL,
                                    created_at TIMESTAMPTZ DEFAULT NOW()
                                )
                            """))
                            await ps_conn.execute(__import__('sqlalchemy').text(
                                "CREATE INDEX ix_push_subscriptions_user_id ON push_subscriptions (user_id)"
                            ))
                            logger.info("[DB] Migration: Created push_subscriptions table")
                except Exception as e:
                    logger.error(f"[DB] Migration for push_subscriptions table FAILED (CRITICAL): {e}")

                # Check subscriptions table has telegram_chat_id
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='subscriptions' AND column_name='telegram_chat_id'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE subscriptions ADD COLUMN telegram_chat_id VARCHAR"
                    ))
                    logger.info("[DB] Migration: Added telegram_chat_id column to subscriptions table")

                # Add auth_provider column if missing
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='users' AND column_name='auth_provider'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE users ADD COLUMN auth_provider VARCHAR DEFAULT 'email'"
                    ))
                    logger.info("[DB] Migration: Added auth_provider column to users table")
                    # Backfill: mark existing users with google_oauth_no_password_ as 'google'
                    await conn.execute(__import__('sqlalchemy').text(
                        "UPDATE users SET auth_provider = 'google' "
                        "WHERE hashed_password LIKE 'google_oauth_no_password_%'"
                    ))
                    logger.info("[DB] Migration: Backfilled auth_provider for existing Google OAuth users")

                logger.info("[DB] Schema migration check completed.")
        except Exception as e:
            logger.warning(f"[DB] Schema migration check failed (non-fatal): {e}")

        # Ensure purpose column exists on password_reset_otps
        try:
            async with engine.begin() as conn:
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='password_reset_otps' AND column_name='purpose'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE password_reset_otps ADD COLUMN purpose VARCHAR DEFAULT 'password_reset'"
                    ))
                    logger.info("[DB] Migration: Added purpose column to password_reset_otps table")
        except Exception as e:
            logger.warning(f"[DB] Migration for purpose column failed (non-fatal): {e}")

        # Ensure password_reset_otps.expires_at and created_at are TIMESTAMP WITH TIME ZONE
        # (was originally declared without timezone, causing "can't subtract offset-naive and
        #  offset-aware datetimes" errors when code passes tz-aware datetimes)
        try:
            async with engine.begin() as conn:
                for col in ("expires_at", "created_at"):
                    result = await conn.execute(
                        __import__('sqlalchemy').text(
                            f"SELECT data_type FROM information_schema.columns "
                            f"WHERE table_name='password_reset_otps' AND column_name='{col}'"
                        )
                    )
                    row = result.fetchone()
                    if row and row[0] != "timestamp with time zone":
                        await conn.execute(__import__('sqlalchemy').text(
                            f"ALTER TABLE password_reset_otps ALTER COLUMN {col} "
                            f"TYPE TIMESTAMP WITH TIME ZONE USING {col} AT TIME ZONE 'UTC'"
                        ))
                        logger.info(f"[DB] Migration: Changed password_reset_otps.{col} to TIMESTAMP WITH TIME ZONE")
        except Exception as e:
            logger.warning(f"[DB] Migration for password_reset_otps timestamp tz failed (non-fatal): {e}")

        # Same fix for signals.timestamp and system_logs.timestamp
        # Note: table name is "signals" (not "signal_records") — matches SignalRecord.__tablename__
        try:
            async with engine.begin() as conn:
                for table_name, col in [("signals", "timestamp"), ("system_logs", "timestamp")]:
                    result = await conn.execute(
                        __import__('sqlalchemy').text(
                            f"SELECT data_type FROM information_schema.columns "
                            f"WHERE table_name='{table_name}' AND column_name='{col}'"
                        )
                    )
                    row = result.fetchone()
                    if row and row[0] != "timestamp with time zone":
                        await conn.execute(__import__('sqlalchemy').text(
                            f"ALTER TABLE {table_name} ALTER COLUMN {col} "
                            f"TYPE TIMESTAMP WITH TIME ZONE USING {col} AT TIME ZONE 'UTC'"
                        ))
                        logger.info(f"[DB] Migration: Changed {table_name}.{col} to TIMESTAMP WITH TIME ZONE")
        except Exception as e:
            logger.warning(f"[DB] Migration for signal_logs timestamp tz failed (non-fatal): {e}")

        # Add session_id column to signals table (10-trades-per-session feature)
        try:
            async with engine.begin() as conn:
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name='signals' AND column_name='session_id'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text(
                        "ALTER TABLE signals ADD COLUMN session_id VARCHAR"
                    ))
                    await conn.execute(__import__('sqlalchemy').text(
                        "CREATE INDEX IF NOT EXISTS ix_signals_session_id ON signals (session_id)"
                    ))
                    logger.info("[DB] Migration: Added session_id column to signals table")
        except Exception as e:
            logger.warning(f"[DB] Migration for signals.session_id failed (non-fatal): {e}")

        # Ensure deleted_accounts table exists
        try:
            async with engine.begin() as conn:
                result = await conn.execute(
                    __import__('sqlalchemy').text(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_name='deleted_accounts'"
                    )
                )
                if not result.fetchone():
                    await conn.execute(__import__('sqlalchemy').text("""
                        CREATE TABLE deleted_accounts (
                            id VARCHAR PRIMARY KEY,
                            user_id VARCHAR NOT NULL,
                            email VARCHAR NOT NULL,
                            full_name VARCHAR,
                            auth_provider VARCHAR,
                            plan_name VARCHAR,
                            is_admin BOOLEAN DEFAULT FALSE,
                            deleted_at TIMESTAMP WITH TIME ZONE NOT NULL,
                            deletion_reason VARCHAR DEFAULT 'user_requested'
                        )
                    """))
                    logger.info("[DB] Migration: Created deleted_accounts table")
        except Exception as e:
            logger.warning(f"[DB] Migration for deleted_accounts table failed (non-fatal): {e}")

        # Ensure new security tables exist (refresh_tokens, revoked_tokens, rate_limit_entries)
        for table_name, create_sql in [
            ("refresh_tokens", """
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    id VARCHAR PRIMARY KEY,
                    user_id VARCHAR NOT NULL,
                    token_jti VARCHAR UNIQUE NOT NULL,
                    hashed_token VARCHAR NOT NULL,
                    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    is_revoked BOOLEAN DEFAULT FALSE,
                    user_agent VARCHAR,
                    ip_address VARCHAR
                )
            """),
            ("revoked_tokens", """
                CREATE TABLE IF NOT EXISTS revoked_tokens (
                    id VARCHAR PRIMARY KEY,
                    token_jti VARCHAR UNIQUE NOT NULL,
                    token_type VARCHAR NOT NULL,
                    user_id VARCHAR NOT NULL,
                    revoked_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    reason VARCHAR DEFAULT 'user_logout',
                    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
                )
            """),
            ("rate_limit_entries", """
                CREATE TABLE IF NOT EXISTS rate_limit_entries (
                    id SERIAL PRIMARY KEY,
                    ip_address VARCHAR NOT NULL,
                    endpoint VARCHAR NOT NULL,
                    timestamp TIMESTAMP WITH TIME ZONE NOT NULL
                )
            """),
        ]:
            try:
                async with engine.begin() as conn:
                    await conn.execute(__import__('sqlalchemy').text(create_sql))
                    # Create indexes if they don't exist
                    index_sqls = {
                        "refresh_tokens": [
                            "CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user_active ON refresh_tokens (user_id, is_revoked)",
                            "CREATE INDEX IF NOT EXISTS ix_refresh_tokens_jti ON refresh_tokens (token_jti)",
                        ],
                        "revoked_tokens": [
                            "CREATE INDEX IF NOT EXISTS ix_revoked_tokens_jti ON revoked_tokens (token_jti)",
                            "CREATE INDEX IF NOT EXISTS ix_revoked_tokens_expires ON revoked_tokens (expires_at)",
                        ],
                        "rate_limit_entries": [
                            "CREATE INDEX IF NOT EXISTS ix_rate_limit_ip_timestamp ON rate_limit_entries (ip_address, timestamp)",
                        ],
                    }
                    for idx_sql in index_sqls.get(table_name, []):
                        try:
                            await conn.execute(__import__('sqlalchemy').text(idx_sql))
                        except Exception:
                            pass  # Index may already exist
                    logger.info(f"[DB] Migration: Ensured {table_name} table exists")
            except Exception as e:
                logger.warning(f"[DB] Migration for {table_name} table failed (non-fatal): {e}")

    # Clean up expired rate limit entries on startup (older than 2 hours)
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
            await session.execute(
                sql_text("DELETE FROM rate_limit_entries WHERE timestamp < :cutoff"),
                {"cutoff": cutoff}
            )
            await session.commit()
            logger.info("[DB] Cleaned up expired rate limit entries")
    except Exception as e:
        logger.warning(f"[DB] Rate limit cleanup failed (non-fatal): {e}")

    # Clean up expired revoked tokens on startup
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            cutoff = datetime.now(timezone.utc)
            await session.execute(
                sql_text("DELETE FROM revoked_tokens WHERE expires_at < :cutoff"),
                {"cutoff": cutoff}
            )
            await session.commit()
            logger.info("[DB] Cleaned up expired revoked tokens")
    except Exception as e:
        logger.warning(f"[DB] Revoked tokens cleanup failed (non-fatal): {e}")

    # Clean up expired refresh tokens on startup
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            cutoff = datetime.now(timezone.utc)
            await session.execute(
                sql_text("DELETE FROM refresh_tokens WHERE expires_at < :cutoff"),
                {"cutoff": cutoff}
            )
            await session.commit()
            logger.info("[DB] Cleaned up expired refresh tokens")
    except Exception as e:
        logger.warning(f"[DB] Refresh tokens cleanup failed (non-fatal): {e}")
