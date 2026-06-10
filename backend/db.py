"""
Base de Données (Supabase / PostgreSQL) — CDC A2Sniper 3.0
Intégration cloud production-ready.
"""

import os
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, JSON

logger = logging.getLogger(__name__)

from dotenv import load_dotenv
load_dotenv()

# URL de connexion Supabase (PostgreSQL)
_raw_db_url = os.getenv("DATABASE_URL", "")

# Basculer sur SQLite local si l'URL n'est pas configurée ou contient encore des placeholders
if not _raw_db_url or '[' in _raw_db_url or 'PASSWORD' in _raw_db_url or 'PROJECT_ID' in _raw_db_url:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(os.path.dirname(BASE_DIR), "a2sniper.db")
    DATABASE_URL = f"sqlite+aiosqlite:///{db_path}"
    logger.warning(f"[DB] DATABASE_URL non configurée ou invalide → Fallback SQLite local absolu ({db_path})")
else:
    DATABASE_URL = _raw_db_url
    logger.info(f"[DB] Connexion PostgreSQL/Supabase configurée.")

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()

# ═══════════ MODÈLES DE DONNÉES ═══════════

class SignalRecord(Base):
    """Stockage persistant et immuable des signaux émis."""
    __tablename__ = "signals"

    id = Column(String, primary_key=True, index=True)
    pair = Column(String, index=True)
    direction = Column(String)
    entry_price = Column(Float)
    expiration = Column(Integer)
    winrate = Column(Float)
    payout = Column(Integer)
    classification = Column(String)
    timestamp = Column(DateTime)
    is_win = Column(Boolean, nullable=True)
    # Données analytiques stockées en JSON
    analysis_details = Column(JSON)
    # Hash cryptographique pour immutabilité (Compliance CDC)
    hash_signature = Column(String)

class User(Base):
    """Utilisateur du système."""
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    full_name = Column(String)
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime)

class UserSubscription(Base):
    """Gestion des plans utilisateurs."""
    __tablename__ = "subscriptions"

    user_id = Column(String, primary_key=True, index=True)
    plan_name = Column(String, default="Standard")  # Standard, Premium, Pro
    active_until = Column(DateTime)
    telegram_chat_id = Column(String, nullable=True)

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
    email = Column(String, index=True)
    otp_code = Column(String)
    expires_at = Column(DateTime)
    created_at = Column(DateTime)

# ═══════════ DÉPENDANCES FASTAPI ═══════════

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
