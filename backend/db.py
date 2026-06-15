"""
Base de Données (Supabase / PostgreSQL) — CDC A2Sniper 3.0
Intégration cloud production-ready.
"""

import os
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, JSON, Numeric, ForeignKey
from sqlalchemy.orm import relationship

logger = logging.getLogger(__name__)

from dotenv import load_dotenv
load_dotenv()

# URL de connexion Supabase (PostgreSQL)
_raw_db_url = os.getenv("DATABASE_URL", "")

# Determine if we should use PostgreSQL or fallback to SQLite
_use_pg = bool(_raw_db_url and _raw_db_url.startswith("postgresql"))

if _use_pg:
    DATABASE_URL = _raw_db_url
    logger.info(f"[DB] Connexion PostgreSQL/Supabase configurée.")
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
    timestamp = Column(DateTime)
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
    timestamp = Column(DateTime)
    level = Column(String)
    module = Column(String)
    message = Column(String)

class PasswordResetOTP(Base):
    """Stockage temporaire des codes OTP pour la réinitialisation de mot de passe."""
    __tablename__ = "password_reset_otps"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, index=True, nullable=False)
    otp_code = Column(String, index=True, nullable=False)  # Added index for OTP lookups
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime)

# OTP brute force tracking
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
        except Exception as me:
            logger.warning(f"[DB] Schema migration check failed (non-fatal): {me}")

