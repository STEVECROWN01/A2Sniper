"""
Base de Données (Supabase / PostgreSQL) — CDC A2Sniper 3.0
Intégration cloud production-ready.
"""

import os
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, JSON, Numeric, ForeignKey, Index
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
connect_args = {"statement_cache_size": 0} if _is_pg else {}

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    connect_args=connect_args,
    pool_pre_ping=True if _is_pg else False,
    pool_size=5 if _is_pg else 5,
    max_overflow=10 if _is_pg else 0,
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
    subscription = relationship("UserSubscription", back_populates="user", uselist=False, cascade="all, delete-orphan")

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


# OTP brute force tracking (in-memory, with DB fallback)
otp_attempt_tracker = {}  # {email: {"count": int, "last_attempt": datetime}}

async def get_db():
    """Dépendance pour obtenir une session de DB asynchrone."""
    async with AsyncSessionLocal() as session:
        yield session

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

        # Same fix for signal_records.timestamp and system_logs.timestamp
        try:
            async with engine.begin() as conn:
                for table_name, col in [("signal_records", "timestamp"), ("system_logs", "timestamp")]:
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
