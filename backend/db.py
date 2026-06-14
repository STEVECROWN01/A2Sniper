"""
Base de Données (Supabase / PostgreSQL) — CDC A2Sniper 3.0
Intégration cloud production-ready.
"""

import os
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, JSON, Numeric
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
    pool_size=5 if _is_pg else None,
    max_overflow=10 if _is_pg else None,
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
    """Crée les tables si elles n'existent pas."""
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("[DB] Base de données initialisée avec succès.")
    except Exception as e:
        logger.error(f"[DB] Erreur lors de l'initialisation de la DB : {e}")
        raise  # Don't silently swallow errors
