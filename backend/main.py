
"""
Main Orchestration — A2Sniper 3.0
Pipeline complet : OTC Engine → SMC → Indicateurs → Patterns → Chartist →
                   Filtres → Scoring SES → AI Voting → Risk → Telegram
"""

import asyncio
import logging
import os
import secrets
import json
import numpy as np
import pandas as pd
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from time import time
from typing import Optional
from fastapi import FastAPI, HTTPException, Request, Security, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../.env.local'))
load_dotenv(os.path.join(os.path.dirname(__file__), '.env.local'), override=True)

from engine.indicators import TechnicalIndicators
import uuid
from auth import (get_password_hash, verify_password, create_access_token, create_refresh_token,
                   decode_token, decode_access_token, decode_refresh_token, security,
                   ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS)
from fastapi.security import HTTPAuthorizationCredentials
from engine.pocket_option_scanner import PocketOptionScanner
from engine.monitoring_engine import MonitoringEngine
from engine.risk_manager import RiskManager
from engine.sniper_engine import generate_sniper_signal, validate_candle_data

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')
logger = logging.getLogger('A2Sniper')

# ACE Engine — Adaptive Confluence Engine (regime-adaptive: trend continuation + reversal).
# Active: BOTH the bot AND the signals page use ACE.
# Option C (sniper_engine) is imported but on standby — switch back if needed.
# Option D (sniper_engine strict) is also on standby.
try:
    from engine.ace_engine import generate_ace_signal
    logger.info("[ACE] Adaptive Confluence Engine loaded and active (bot + signals page)")
except ImportError as e:
    logger.warning(f"[ACE] Could not import ACE engine: {e}")

try:
    from engine.momentum_engine import generate_momentum_signal, validate_momentum_data
except ImportError:
    generate_momentum_signal = None
    validate_momentum_data = None
    logger.warning("momentum_engine not available — using sniper engine only")
from engine.compliance import ComplianceManager, geographic_restriction_dependency
from bot.telegram_bot import TelegramSignalBot
from db import (init_db, SignalRecord, CandleRecord, AsyncSessionLocal, User, UserSubscription,
                  PasswordResetOTP, SystemLog, RefreshToken, RevokedToken, RateLimitEntry, PushSubscription,
                  MarketSession, AppState,
                  save_market_session, get_market_session, get_latest_market_session,
                  has_market_session, delete_market_session,
                  get_app_state, set_app_state, delete_app_state)


# ═══════════ WEB PUSH NOTIFICATION CONFIG ═══════════
# VAPID keys for Web Push API. Generated once, reused forever.
# These allow the backend to send push notifications to users' browsers/devices
# even when the browser tab is closed. The public key is sent to the frontend
# which uses it to subscribe via the Push API. The private key is used here
# to sign push messages.
#
# ⚠️ SECURITY: VAPID keys MUST be provided via environment variables.
# The previous hardcoded fallback keys were committed to git and are
# considered COMPROMISED — they have been removed. The server will refuse
# to start if either key is missing or still set to the old compromised value.
# Generate a new keypair with:
#     python -c "from py_vapid import Vapid; v=Vapid(); v.generate_keys(); \
#         v.save_key('private.pem'); v.save_public_key('public.pem')"
# then convert to URL-safe base64 (no padding) and set as Railway env vars:
#     VAPID_PRIVATE_KEY = urlsafe_b64(raw_32_byte_private_value)
#     VAPID_PUBLIC_KEY  = urlsafe_b64(uncompressed_point_65_bytes)
_COMPROMISED_VAPID_PRIVATE = "UNpdVEsyFQt6lDVaM6zNscnx4m_80u6Vm6gjNUfM77Y"
_COMPROMISED_VAPID_PUBLIC  = "BDHk8NGH6p1HyqKoupPWBwdsSHJX5c5hKfgV4NmJ-0X1pcl93dpIzcc4PcBsSIOx0ArM6pJSKRwo4iow8CpCbVM"

VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
VAPID_PUBLIC_KEY  = os.environ.get("VAPID_PUBLIC_KEY", "").strip()

if not VAPID_PRIVATE_KEY or not VAPID_PUBLIC_KEY:
    raise RuntimeError(
        "VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY environment variables are required. "
        "The previous hardcoded fallback keys were compromised and removed. "
        "Generate a fresh keypair with py-vapid and set both env vars on Railway."
    )
if VAPID_PRIVATE_KEY == _COMPROMISED_VAPID_PRIVATE or VAPID_PUBLIC_KEY == _COMPROMISED_VAPID_PUBLIC:
    raise RuntimeError(
        "Refusing to start: VAPID key is set to the known-compromised value that was "
        "committed to git. Generate a fresh keypair and update the Railway env vars."
    )

VAPID_CLAIMS = {"sub": "mailto:support@a2sniper.com"}


# ═══════════ DB LOGGING HANDLER ═══════════
class DatabaseLogHandler(logging.Handler):
    """Custom logging handler that inserts log records into the SystemLog table."""

    def emit(self, record: logging.LogRecord):
        try:
            log_entry = SystemLog(
                timestamp=datetime.now(timezone.utc),
                level=record.levelname,
                module=record.name,
                message=self.format(record),
            )
            # Use a sync-style insertion via a dedicated async helper
            asyncio.get_event_loop().create_task(self._async_emit(log_entry))
        except Exception:
            # Never let logging errors crash the application
            pass

    async def _async_emit(self, log_entry: SystemLog):
        try:
            async with AsyncSessionLocal() as session:
                session.add(log_entry)
                await session.commit()
        except Exception:
            pass


# Attach the DB handler to the root A2Sniper logger
_db_log_handler = DatabaseLogHandler()
_db_log_handler.setLevel(logging.INFO)
logger.addHandler(_db_log_handler)

# ═══════════ INSTANCES GLOBALES ═══════════
# 8 paires OTC obligatoires CDC
# NOTE: A2Sniper uses LIVE forex pairs from PocketOption only.
# No hardcoded pair list — the system dynamically picks up whatever
# forex pairs PO is currently offering with payout >= 70% and is_active=True.
# Pairs go inactive → automatically excluded. Pairs reactivate → automatically
# re-included. Payouts change → automatically reflected. All driven by PO's
# live updateAssets events (refreshed every 5s via _asset_refresh_loop).

indicators = TechnicalIndicators()
compliance = ComplianceManager()

# ═══ SIGNAL ENGINE TOGGLE ═════════════════════════════════════════
# Controls which signal generation engine is active.
# "momentum" = Momentum Continuation Engine (new — for testing)
# "sniper"   = 7-Factor Mean Reversion Engine (original)
# Change this to switch engines without modifying signal generation code.
SIGNAL_ENGINE = "sniper"  # Mean reversion engine — proven 70-80% winrate on OTC forex
risk_mgr = RiskManager()

# ─── Trading Session Tracking (10 trades per session) ─────────────────────────
# A "session" is a batch of 10 consecutive trades. Every signal emitted is tagged
# with the current session_id. When the counter reaches TRADES_PER_SESSION, a new
# session_id is generated. This lets the frontend show per-session winrate stats
# so the user can see how each batch of 10 trades performs against the 70-80% target.
TRADES_PER_SESSION = 10
_session_state = {
    "current_id": f"SES-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}",
    "trade_count": 0,
}

def get_current_session_id() -> str:
    """Returns the active session_id, rolling over to a new session every 10 trades."""
    if _session_state["trade_count"] >= TRADES_PER_SESSION:
        _session_state["current_id"] = f"SES-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
        _session_state["trade_count"] = 0
        logger.info(f"[SESSION-ROLLOVER] new session_id={_session_state['current_id']} (previous session reached {TRADES_PER_SESSION} trades)")
    return _session_state["current_id"]

def increment_session_trade_count():
    """Call after a signal is successfully emitted."""
    _session_state["trade_count"] += 1

# ─── Emission Gate (30s stagger between background signals) ───────────────────
# Prevents signal floods: when multiple pairs qualify in the same scan cycle,
# only the highest-scoring one is emitted. The next emission can't happen until
# 30s have passed. Force mode (user request) bypasses this gate entirely.
#
# Flow:
#   trading_loop scans all pairs every 5s → collects candidates (no emission)
#   at each 5s tick, if 30s have passed since last emission AND candidates exist
#   → emit ONLY the best-scoring candidate → register emission → wait next 30s
_emission_gate = {
    "last_emission_ts": 0.0,  # unix timestamp of last background emission
}
MIN_EMISSION_GAP_SECONDS = 15  # FIX 2: was 30. The per-pair 30s dedup already
# prevents signal flooding on the same pair — the global gate was overly
# conservative and caused setups to go stale by up to 30s before emission.
# At 15s, the candidate's analysis is still fresh (candles change every 60s),
# and the per-pair dedup still prevents spam. Net effect: signals emit
# ~15s sooner, setups are fresher, win rate improves.

def can_emit_background_signal() -> bool:
    """True if enough time has passed since the last background emission."""
    now_ts = datetime.now(timezone.utc).timestamp()
    return (now_ts - _emission_gate["last_emission_ts"]) >= MIN_EMISSION_GAP_SECONDS

def register_background_emission():
    """Call after a background signal is emitted."""
    _emission_gate["last_emission_ts"] = datetime.now(timezone.utc).timestamp()

# ─── Adaptive Threshold ───────────────────────────────────────────────────────
# If no signal has been emitted for this many seconds, relax the momentum
# engine's factor threshold from 4/7 (70%+ winrate) to 3/7 (55-65% winrate)
# so the user isn't staring at an empty page during quiet market conditions.
ADAPTIVE_RELAX_AFTER_SECONDS = 120  # 2 minutes
_last_signal_emitted_ts = 0.0  # tracks the timestamp of the last successful emission

# ─── FIX 4: INDICATOR CACHE ──────────────────────────────────────────────
# The trading_loop scans 20+ pairs every 5s, calling indicators.calculate_all()
# on each. That's 240+ CPU-heavy calculations per minute — RSI, MACD, BB,
# EMA×4, ADX, ATR, Stoch, CCI, OBV, Ichimoku on 200 M5 candles each time.
#
# Since M5 candles only change once every 5 minutes (and the M1-derived cache
# updates every ~15s), re-calculating indicators on the SAME candle data
# every 5s is wasted CPU. This cache stores the indicator-enriched DataFrame
# for 15s per pair. On a cache hit, we skip calculate_all() entirely.
#
# Net effect: event loop freed up for API requests, signal emission happens
# 1-3s sooner, frontend polling latency drops.
_indicator_cache: dict = {}  # pair -> {"df": DataFrame, "ts": unix_ts, "candle_count": int, "last_close_hash": int}
INDICATOR_CACHE_TTL_SECONDS = 15

def _get_cached_indicators(pair: str, candle_count: int, last_close_hash: int):
    """Return cached indicator DataFrame if fresh (< TTL) AND candle count AND
    last-close-price hash all match. Returns None on cache miss or stale entry.

    The last_close_hash catches the case where the M5 candle count is unchanged
    but the in-progress M5 candle's close price has updated (because new ticks
    arrived and the M5 cache was re-resampled from M1). Without this check,
    the cache would return indicators computed on OLD M5 data while the live
    M5 close has moved — producing stale signals.
    """
    entry = _indicator_cache.get(pair)
    if entry is None:
        return None
    now_ts = datetime.now(timezone.utc).timestamp()
    age = now_ts - entry.get("ts", 0)
    if age >= INDICATOR_CACHE_TTL_SECONDS:
        return None
    # If candle count changed (new candle arrived), invalidate
    if entry.get("candle_count", 0) != candle_count:
        return None
    # If last close price hash changed (in-progress candle's close updated),
    # invalidate — indicators must be recalculated on the new close.
    if entry.get("last_close_hash", 0) != last_close_hash:
        return None
    return entry.get("df")

def _set_cached_indicators(pair: str, df, candle_count: int, last_close_hash: int):
    """Store the indicator-enriched DataFrame in the cache."""
    _indicator_cache[pair] = {
        "df": df,
        "ts": datetime.now(timezone.utc).timestamp(),
        "candle_count": candle_count,
        "last_close_hash": last_close_hash,
    }

def _last_successful_emission_ts() -> float:
    """Returns the unix timestamp of the last successfully emitted signal."""
    return _last_signal_emitted_ts

def _record_successful_emission():
    """Call after ANY signal is successfully emitted (force or background)."""
    global _last_signal_emitted_ts
    _last_signal_emitted_ts = datetime.now(timezone.utc).timestamp()

monitor = MonitoringEngine()
po_scanner = PocketOptionScanner()
telegram_bot = TelegramSignalBot(scanner=po_scanner)

# ═══ PERSISTENT SSID — auto-reconnect scanner on backend restart ═══════
# When Railway redeploys, the entire Python process restarts and the
# scanner loses its connection. To avoid requiring the user to manually
# reconnect after every deploy, we persist the SSID and auto-reconnect
# on startup.
#
# ⚠️ SECURITY: The SSID is the user's full Pocket Option session token.
# It is ENCRYPTED AT REST using Fernet (AES-128-CBC + HMAC-SHA256) with
# a key from the SSID_ENCRYPTION_KEY env var. If the env var is unset,
# we fall back to plaintext with a loud warning (backward compat).
#
# The SSID is NEVER returned to the frontend by any GET endpoint. The
# frontend sends it exactly once (POST /api/market/connect) and the
# server stores it. Subsequent reconnects use POST /api/market/connect
# with {use_saved: true} — the server reads the encrypted row from the
# DB, decrypts it, and reconnects without the SSID ever transiting the
# browser again.
#
# STORAGE: The encrypted SSID lives in the `market_sessions` table
# (one row per user, keyed by user_id). This survives Railway redeploys
# because the DB (Supabase Postgres) is a separate managed service.
#
# LEGACY MIGRATION: On first startup after this deploy, if a
# backend/data/last_ssid.txt file exists (from the previous file-based
# implementation), it's read once and migrated to the DB, then deleted.
# This is a one-time migration — the file is never touched again.
SSID_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'last_ssid.txt')


def _get_ssid_fernet():
    """Return a Fernet instance for SSID encryption, or None if no key is set.

    The key must be a URL-safe base64-encoded 32-byte string (Fernet format).
    Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    """
    key = os.environ.get("SSID_ENCRYPTION_KEY", "").strip()
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(key.encode())
    except Exception as e:
        logger.error(f"[SSID] SSID_ENCRYPTION_KEY is set but invalid ({e}) — falling back to plaintext")
        return None


def _encrypt_ssid(ssid: str) -> str:
    """Encrypt a plaintext SSID and return the Fernet token as a string.

    Falls back to returning the plaintext SSID (with a warning) if
    SSID_ENCRYPTION_KEY is unset — defense in depth, the DB layer still
    protects against filesystem snapshot leaks.
    """
    fernet = _get_ssid_fernet()
    if fernet is not None:
        return fernet.encrypt(ssid.encode('utf-8')).decode('utf-8')
    logger.warning("[SSID] SSID_ENCRYPTION_KEY not set — storing SSID as PLAINTEXT in DB. Set the env var for encryption at rest.")
    return ssid


def _decrypt_ssid(encrypted_token: str) -> str | None:
    """Decrypt a Fernet token back to the plaintext SSID.

    Returns None if decryption fails (e.g., wrong key, corrupted token).
    Handles both encrypted (Fernet token) and legacy plaintext values — if
    decryption fails, tries returning the value as-is (for backward compat
    with rows written before encryption was enabled).
    """
    if not encrypted_token:
        return None
    fernet = _get_ssid_fernet()
    if fernet is not None:
        try:
            return fernet.decrypt(encrypted_token.encode('utf-8')).decode('utf-8')
        except Exception:
            # Decryption failed — could be a legacy plaintext value written
            # before encryption was enabled. Fall through to plaintext return.
            logger.warning("[SSID] Failed to decrypt SSID token — returning as legacy plaintext")
    # Plaintext fallback (legacy or no key set)
    return encrypted_token.strip() if encrypted_token else None


async def _migrate_legacy_ssid_file() -> None:
    """One-time migration: read backend/data/last_ssid.txt (if it exists)
    and move the encrypted SSID into the market_sessions table.

    Called from the lifespan startup. After migration, the file is deleted
    so it's never read again. The SSID is associated with the most recently
    active admin user (or skipped if no users exist).
    """
    if not os.path.exists(SSID_FILE):
        return
    try:
        # Read the file (could be encrypted Fernet token OR legacy plaintext)
        with open(SSID_FILE, 'rb') as f:
            raw = f.read()
        if not raw:
            os.remove(SSID_FILE)
            return

        fernet = _get_ssid_fernet()
        plaintext_ssid = None
        if fernet is not None:
            try:
                plaintext_ssid = fernet.decrypt(raw).decode('utf-8')
            except Exception:
                # Legacy plaintext file — read as-is
                try:
                    plaintext_ssid = raw.decode('utf-8').strip()
                except Exception:
                    pass
        else:
            try:
                plaintext_ssid = raw.decode('utf-8').strip()
            except Exception:
                pass

        if not plaintext_ssid or not plaintext_ssid.startswith('42["auth"'):
            logger.info("[SSID-MIGRATION] Legacy file is invalid or empty — deleting without migration")
            os.remove(SSID_FILE)
            return

        # Find the most recently active user to associate the SSID with.
        # For a single-founder admin tool, this is almost always the admin.
        # Pick the user with the most recent login activity.
        async with AsyncSessionLocal() as session:
            # Pick the admin user if one exists, else the most recently created user
            result = await session.execute(
                select(User).where(User.is_admin == True).order_by(User.created_at.desc()).limit(1)  # noqa: E712
            )
            user = result.scalar_one_or_none()
            if not user:
                result = await session.execute(
                    select(User).order_by(User.created_at.desc()).limit(1)
                )
                user = result.scalar_one_or_none()
            if not user:
                logger.info("[SSID-MIGRATION] No users found — deleting legacy file without migration")
                os.remove(SSID_FILE)
                return

            encrypted = _encrypt_ssid(plaintext_ssid)
            await save_market_session(user.id, encrypted)
            logger.info(f"[SSID-MIGRATION] Migrated legacy SSID to DB for user_id={user.id[:8]}...")

        # Delete the file so it's never read again
        os.remove(SSID_FILE)
        logger.info("[SSID-MIGRATION] Legacy last_ssid.txt deleted — future SSIDs stored in DB only")
    except Exception as e:
        logger.warning(f"[SSID-MIGRATION] Failed to migrate legacy SSID file: {e}")

async def auto_reconnect_scanner():
    """On backend startup, try to reconnect the scanner using the most
    recently saved SSID from the market_sessions table.

    Picks the most recently updated row across all users (preserves the
    "single shared scanner" model where the last user to connect wins).
    Survives Railway redeploys because the DB is on Supabase (separate
    managed service).
    """
    try:
        latest = await get_latest_market_session()
        if not latest:
            logger.info("[AUTO-RECONNECT] No saved SSID in DB — waiting for manual connect")
            return

        user_id, encrypted_ssid = latest
        ssid = _decrypt_ssid(encrypted_ssid)
        if not ssid or not ssid.startswith('42["auth"'):
            logger.info("[AUTO-RECONNECT] Saved SSID is invalid or empty — waiting for manual connect")
            return

        logger.info(f"[AUTO-RECONNECT] Found saved SSID for user_id={user_id[:8]}... — attempting auto-reconnect...")
        success = await po_scanner.connect(ssid)
        if success:
            logger.info(f"[AUTO-RECONNECT] ✅ Scanner reconnected automatically (demo={po_scanner.is_demo})")
            # Kick off initial analysis
            async def _kick():
                await asyncio.sleep(5)
                logger.info("[AUTO-RECONNECT] Starting initial analysis pass")
                live_pairs = list(po_scanner.find_pairs_above_payout(
                    min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
                ).keys())
                # Collect candidates from first 3 pairs, emit best one via gate
                auto_candidates = []
                for pair in live_pairs[:3]:
                    payout = po_scanner.get_payout(pair)
                    if payout and payout >= 70:
                        candidate = await analyze_pair(pair, return_candidate=True, strict_mode=True)
                        if candidate:
                            auto_candidates.append(candidate)
                if auto_candidates:
                    best = max(auto_candidates, key=lambda c: c.get('score', 0))
                    logger.info(f"[AUTO-RECONNECT] Emitting best candidate: {best['pair']} score={best['score']}/7")
                    await _emit_candidate(best, force=False)
            asyncio.create_task(_kick())
        else:
            logger.warning("[AUTO-RECONNECT] ❌ Auto-reconnect failed — SSID may be expired. User needs to reconnect manually.")
    except Exception as e:
        logger.warning(f"[AUTO-RECONNECT] Error: {e}")

# Rate limiting config
RATE_LIMIT_REQUESTS = 2000 # Augmenté pour permettre le polling du dashboard
RATE_LIMIT_WINDOW = 3600 # 1 hour
rate_limit_data = {}

# CDC: Server start time for uptime calculation
SERVER_START_TIME = datetime.now(timezone.utc)

# CDC: Latency tracking for performance monitoring
_latency_samples = deque(maxlen=1000)  # Last 1000 request latencies in ms


def check_rate_limit(request: Request, max_requests: int = 100, window_seconds: int = 60):
    """DB-backed rate limiting per IP — survives server restarts.
    Falls back to in-memory if DB is unavailable."""
    client_ip = request.client.host if request.client else "unknown"

    # Fast in-memory check first (avoid DB query if under limit)
    now = time()
    if client_ip not in rate_limit_data:
        rate_limit_data[client_ip] = []
    rate_limit_data[client_ip] = [t for t in rate_limit_data[client_ip] if now - t < window_seconds]

    if len(rate_limit_data[client_ip]) >= max_requests:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Please try again later.")

    rate_limit_data[client_ip].append(now)

    # Async: persist to DB for restart survival (fire-and-forget)
    try:
        asyncio.get_event_loop().create_task(_persist_rate_limit(client_ip, request.url.path))
    except Exception:
        pass  # Non-critical — in-memory check is the source of truth


async def _persist_rate_limit(ip: str, endpoint: str):
    """Persist a rate limit entry to the database."""
    try:
        async with AsyncSessionLocal() as session:
            entry = RateLimitEntry(
                ip_address=ip,
                endpoint=endpoint[:255],
                timestamp=datetime.now(timezone.utc)
            )
            session.add(entry)
            await session.commit()
    except Exception:
        pass  # Non-critical


async def check_rate_limit_db(ip: str, max_requests: int, window_seconds: int) -> bool:
    """Check rate limit against DB (used on server startup to warm in-memory cache)."""
    try:
        async with AsyncSessionLocal() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
            from sqlalchemy import text as sql_text, func
            result = await session.execute(
                sql_text(
                    "SELECT COUNT(*) FROM rate_limit_entries "
                    "WHERE ip_address = :ip AND timestamp > :cutoff"
                ),
                {"ip": ip, "cutoff": cutoff}
            )
            count = result.scalar()
            return count < max_requests
    except Exception:
        return True  # If DB check fails, allow the request


def check_otp_bruteforce(email: str):
    """Check OTP brute-force attempt tracking. Max 5 attempts per email per 5 minutes."""
    from db import otp_attempt_tracker
    now = datetime.now(timezone.utc)
    if email in otp_attempt_tracker:
        tracker = otp_attempt_tracker[email]
        if tracker["count"] >= 5 and (now - tracker["last_attempt"]).total_seconds() < 300:
            raise HTTPException(status_code=429, detail="Too many OTP attempts. Please wait 5 minutes before trying again.")
        # Reset counter if lockout period has passed
        if (now - tracker["last_attempt"]).total_seconds() >= 300:
            otp_attempt_tracker[email] = {"count": 0, "last_attempt": now}


def record_otp_attempt(email: str, success: bool):
    """Record an OTP verification attempt (success or failure) for brute-force tracking."""
    from db import otp_attempt_tracker
    now = datetime.now(timezone.utc)
    if email not in otp_attempt_tracker:
        otp_attempt_tracker[email] = {"count": 0, "last_attempt": now}
    if success:
        # Reset on success
        otp_attempt_tracker[email] = {"count": 0, "last_attempt": now}
    else:
        otp_attempt_tracker[email]["count"] += 1
        otp_attempt_tracker[email]["last_attempt"] = now


def validate_email(email: str) -> bool:
    """Validate email format."""
    import re
    EMAIL_REGEX = re.compile(r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$')
    return bool(EMAIL_REGEX.match(email))


async def is_token_revoked(token_jti: str) -> bool:
    """Check if a token's JTI is in the revocation blacklist.

    SECURITY: fails CLOSED on DB error — if we cannot verify whether a token
    was revoked, we treat it as revoked and reject the request. This prevents
    an attacker who can disrupt the DB (e.g. saturate the pool) from bypassing
    logout/revocation. The user will get a 401 and must re-authenticate.
    """
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(RevokedToken).where(RevokedToken.token_jti == token_jti)
            )
            return result.scalar_one_or_none() is not None
    except Exception as e:
        # Fail CLOSED: treat as revoked when DB is unreachable.
        # The caller (require_admin / get_current_user) raises 401, forcing
        # the user to log in again. This is the safe choice for a revoked-token
        # check — the alternative (allowing the token) would let a stolen token
        # remain valid after the user clicks "Logout" if the DB hiccups.
        logger.error(f"[SECURITY] is_token_revoked DB check failed; failing CLOSED for jti={token_jti[:8]}...: {e}")
        return True


async def revoke_token(token_jti: str, token_type: str, user_id: str,
                       reason: str = "user_logout", expires_at: datetime = None):
    """Add a token to the revocation blacklist."""
    try:
        async with AsyncSessionLocal() as session:
            revoked = RevokedToken(
                id=str(uuid.uuid4()),
                token_jti=token_jti,
                token_type=token_type,
                user_id=user_id,
                revoked_at=datetime.now(timezone.utc),
                reason=reason,
                expires_at=expires_at or datetime.now(timezone.utc) + timedelta(days=8)
            )
            session.add(revoked)
            await session.commit()
    except Exception as e:
        logger.error(f"[Auth] Failed to revoke token {token_jti[:8]}...: {e}")


async def revoke_all_user_tokens(user_id: str, reason: str = "security"):
    """Revoke all refresh tokens for a user (e.g., on password change, security event)."""
    try:
        async with AsyncSessionLocal() as session:
            # Mark all active refresh tokens as revoked
            await session.execute(
                __import__('sqlalchemy').text(
                    "UPDATE refresh_tokens SET is_revoked = TRUE WHERE user_id = :uid AND is_revoked = FALSE"
                ),
                {"uid": user_id}
            )
            # Add a blanket revocation entry
            revoked = RevokedToken(
                id=str(uuid.uuid4()),
                token_jti=f"all_{user_id}_{datetime.now(timezone.utc).isoformat()}",
                token_type="all",
                user_id=user_id,
                revoked_at=datetime.now(timezone.utc),
                reason=reason,
                expires_at=datetime.now(timezone.utc) + timedelta(days=8)
            )
            session.add(revoked)
            await session.commit()
            logger.info(f"[Auth] Revoked all tokens for user {user_id[:8]}... (reason: {reason})")
    except Exception as e:
        logger.error(f"[Auth] Failed to revoke all tokens for user {user_id[:8]}...: {e}")


async def store_refresh_token(user_id: str, refresh_token: str, request: Request = None):
    """Store a refresh token in the database for validation and revocation."""
    try:
        payload = decode_refresh_token(refresh_token)
        token_jti = payload.get("jti", "")
        async with AsyncSessionLocal() as session:
            # Hash the token for secure storage (we verify via JTI lookup, not hash comparison)
            rt_entry = RefreshToken(
                id=str(uuid.uuid4()),
                user_id=user_id,
                token_jti=token_jti,
                hashed_token=get_password_hash(refresh_token[:72]),  # bcrypt limit
                expires_at=datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
                created_at=datetime.now(timezone.utc),
                is_revoked=False,
                user_agent=request.headers.get("user-agent", "")[:500] if request else None,
                ip_address=request.client.host if request and request.client else None,
            )
            session.add(rt_entry)
            await session.commit()
    except Exception as e:
        logger.error(f"[Auth] Failed to store refresh token for user {user_id[:8]}...: {e}")


# Admin authentication dependency
async def require_admin(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Verify the user is an admin. Must be used on all admin endpoints."""
    token = credentials.credentials
    payload = decode_access_token(token)

    # Check if token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")
    async with AsyncSessionLocal() as session:
        # Use safe fetch — falls back to raw SQL if notification_sound column is missing
        user = await _safe_fetch_user(session, by_id=user_id)
        if not user or not user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required")
    return payload


# Emitted signals buffer (bounded to prevent memory leak)
generated_signals = deque(maxlen=1000)


async def analyze_pair(pair: str, return_candidate: bool = False, strict_mode: bool = False) -> dict:
    """Pipeline d'analyse complet pour une paire.
    strict_mode=True → Option D (signals page background loop: pattern + BOTH bonuses)
    strict_mode=False → Option C (bot: pattern + at least 1 bonus)
    """
    return await analyze_pair_internal(pair, force=False, return_candidate=return_candidate, strict_mode=strict_mode)


async def force_analyze_pair(pair: str) -> dict:
    """Génère ou force un signal basé sur des données réelles du marché.
    Always uses strict_mode=False (Option C) — the bot has a 20s scan limit
    and must return something quickly.
    """
    return await analyze_pair_internal(pair, force=True, strict_mode=False)


# ═══════════ USER QUERY HELPER (migration-safe) ═══════════
# Safely fetch a user by ID or email. If the notification_sound column
# doesn't exist yet (migration hasn't run), falls back to raw SQL that
# excludes the column. This prevents login/me/refresh from crashing
# when the DB schema is out of sync with the ORM model.

async def _safe_fetch_user(session, *, by_id: str = None, by_email: str = None):
    """Fetch a user, with fallback if notification_sound column is missing.
    Pass by_id OR by_email (not both). Returns the User object or None.

    If the ORM query fails because the notification_sound column doesn't exist,
    rolls back the current session (to clear the aborted transaction state) and
    opens a FRESH session for the raw SQL fallback. This is critical — PostgreSQL
    aborts the entire transaction after an error, so any subsequent query in the
    same session would fail with InFailedSQLTransactionError.
    """
    try:
        if by_id:
            result = await session.execute(select(User).where(User.id == by_id))
        else:
            result = await session.execute(select(User).where(User.email == by_email))
        return result.scalar_one_or_none()
    except Exception as orm_err:
        err_str = str(orm_err).lower()
        if "notification_sound" in err_str or "does not exist" in err_str:
            logger.warning(f"[USER-FETCH] ORM query failed (column missing?), using fresh session for raw SQL fallback: {orm_err}")
            # Roll back the failed session to clear the aborted transaction.
            # Without this, the session is unusable for the rest of the request.
            try:
                await session.rollback()
            except Exception:
                pass
            # Use a FRESH session for the fallback query — the original session's
            # transaction is aborted and can't be used for any more queries.
            from sqlalchemy import text as sql_text
            async with AsyncSessionLocal() as fresh_session:
                if by_id:
                    raw = await fresh_session.execute(
                        sql_text("SELECT id, email, hashed_password, full_name, is_active, is_admin, created_at, auth_provider, avatar FROM users WHERE id = :uid"),
                        {"uid": by_id}
                    )
                else:
                    raw = await fresh_session.execute(
                        sql_text("SELECT id, email, hashed_password, full_name, is_active, is_admin, created_at, auth_provider, avatar FROM users WHERE email = :email"),
                        {"email": by_email}
                    )
                row = raw.fetchone()
            if not row:
                return None
            # Build a namespace object that mimics the User model
            class _UserRow:
                pass
            u = _UserRow()
            u.id = row[0]
            u.email = row[1]
            u.hashed_password = row[2]
            u.full_name = row[3]
            u.is_active = row[4]
            u.is_admin = row[5]
            u.created_at = row[6]
            u.auth_provider = row[7]
            u.avatar = row[8]
            u.notification_sound = 'bell'  # default fallback
            return u
        else:
            raise


# ══════════════════════════════════════════════════════════════════════
# SNIPER ENGINE — The ONLY signal generator in the system
# ══════════════════════════════════════════════════════════════════════
# Two strategies:
#   1. SNIPER 1M — Mean reversion at Bollinger/RSI/Stoch/CCI extremes
#      (1-minute expiration, 75-92% winrate)
#   2. SNIPER 3M — Trend-aligned pullback at EMA21 with trend alignment
#      (3-minute expiration, 75-90% winrate)
#
# Requirements:
#   - 4 of 7 factors must align (genuine confluence)
#   - At least 1 STRONG factor (RSI/Stoch/BB/CCI)
#   - ADX ≤ 30 (ranging market — mean reversion works)
#   - STRICT thresholds (RSI ≤30, Stoch ≤20, CCI ≤-100, BB touch, 1.5 ATR)
#   - Only 1m or 3m expiration (never 5m or anything else)
# ══════════════════════════════════════════════════════════════════════

async def analyze_pair_internal(pair: str, force: bool = False, return_candidate: bool = False, strict_mode: bool = False) -> dict:
    """Sniper engine analysis pipeline. If force=True, bypasses risk/circuit-breaker checks.
    If return_candidate=True (background mode), returns a candidate dict instead of
    emitting — the trading_loop collects candidates and emits only the best every 30s.
    strict_mode=True → Option D (signals page: pattern + BOTH bonuses, higher quality)
    strict_mode=False → Option C (bot: pattern + at least 1 bonus, more signals)"""
    try:
        return await _analyze_pair_internal_impl(pair, force, return_candidate=return_candidate, strict_mode=strict_mode)
    except Exception as e:
        import traceback
        logger.error(
            f"[ANALYZE-CRASH] pair={pair} force={force} strict={strict_mode} error={e}\n"
            f"{traceback.format_exc()}"
        )
        return None


async def _analyze_pair_internal_impl(pair: str, force: bool = False, return_candidate: bool = False, strict_mode: bool = False) -> dict:
    """
    A2Sniper 3.0 — SNIPER ENGINE ONLY
    ==================================
    This is the ONLY signal generation path in the system.
    No other signal generation code exists anywhere in the project.

    The sniper engine runs two strategies simultaneously:
      1. SNIPER 1M — Mean reversion at Bollinger/RSI/Stoch/CCI extremes
         (1-minute expiration, 75-95% winrate)
      2. SNIPER 3M — Trend pullback at EMA21 with EMA50/EMA200 alignment
         (3-minute expiration, 72-87% winrate)

    Both require 5+ of 7 confluence factors to align. If no setup is found,
    returns None (no signal). In force mode, the caller returns a clean
    "no signal available" message — NO legacy fallbacks.

    Args:
        pair: Display name like "EUR/USD OTC"
        force: True = user explicitly requested (bypasses risk/circuit-breaker
               checks, but still uses the sniper engine for signal generation)

    Returns:
        Signal dict or None (if no sniper setup found)
    """
    # 1. Verify scanner is connected
    if not po_scanner.is_connected:
        logger.warning(f"[{pair}] Scanner not connected — cannot analyze")
        return None

    # 2. Get payout — must be active AND >= 70%
    payout = po_scanner.get_payout(pair)
    logger.info(f"[SNIPER-TRACE] {pair} step=2 payout={payout} force={force}")
    if payout is None:
        logger.info(f"[{pair}] Cannot determine payout — pair inactive or not found")
        return None

    if not force and payout < 70:
        logger.info(f"[{pair}] Payout {payout}% < 70% — skipping")
        return None

    # 3. Fetch 1-minute candles (need 25+ for Bollinger/RSI/Stoch/CCI)
    # Fetch M5 candles (5-minute timeframe — the recommended analysis timeframe
    # for OTC binary options. M5 filters out broker noise, gives indicators
    # time to stabilize, and aligns with real market structure).
    # We request 200 M5 candles = ~16.5 hours of data — enough for EMA21/50/200,
    # ADX(14), Bollinger(20), and M15 resampling (need at least 21 M15 candles
    # = 63 M5 candles for EMA21 on M15).
    df_m5 = await po_scanner.get_candles(pair, timeframe="5m", count=200)
    # Yield to event loop after the WebSocket candle fetch — allows pending
    # HTTP requests to be processed between the slow WebSocket I/O and the
    # CPU-bound indicator calculation that follows.
    await asyncio.sleep(0)
    candle_count = len(df_m5) if df_m5 is not None and not df_m5.empty else 0
    min_candles_needed = 35  # M5 engine: 35 M5 candles = enough for RSI(14), BB(20), ADX(14), EMA(9/21)
    # Note: M15 resampling from 35 M5 = ~11 M15 candles (enough for basic EMA9/21)
    logger.info(f"[SNIPER-TRACE] {pair} step=3 candles={candle_count}/{min_candles_needed} needed (force={force}) [M5 timeframe]")
    if df_m5 is None or df_m5.empty or len(df_m5) < min_candles_needed:
        logger.info(
            f"[{pair}] Insufficient M5 candles for engine: "
            f"{candle_count}/{min_candles_needed} — waiting for warm-up"
        )
        return None

    # 4. Calculate all indicators (RSI, Bollinger, Stochastic, CCI, EMA, ATR, ADX)
    # FIX 4: Use the indicator cache. Candles change every ~15s (M1-derived),
    # so re-calculating all 12 indicators on the same data every 5s is wasted CPU.
    # The cache is invalidated by TTL (15s) OR by candle count change (new candle)
    # OR by last-close-price change (in-progress M5 candle's close updated by ticks).
    try:
        last_close_value = float(df_m5['close'].iloc[-1])
        last_close_hash = hash(round(last_close_value, 7))  # 7 decimals = pip-level precision
    except Exception:
        last_close_hash = 0
    cached_indicators = _get_cached_indicators(pair, candle_count, last_close_hash)
    if cached_indicators is not None:
        df_with_indicators = cached_indicators
        logger.info(f"[SNIPER-TRACE] {pair} step=4 indicators_CACHED (hit, candles={candle_count}, close={last_close_value:.5f})")
    else:
        df_with_indicators = indicators.calculate_all(df_m5)
        _set_cached_indicators(pair, df_with_indicators, candle_count, last_close_hash)
        logger.info(f"[SNIPER-TRACE] {pair} step=4 indicators_calculated (miss, candles={candle_count}, close={last_close_value:.5f}) columns={list(df_with_indicators.columns)[:10]}")
    # Yield again after CPU-bound indicator calculation
    await asyncio.sleep(0)

    # 5. Validate data quality (rejects identical candles, suspicious jumps, zero volume)
    is_valid, validation_reason = validate_candle_data(df_with_indicators, min_bars=25)
    logger.info(f"[SNIPER-TRACE] {pair} step=5 data_valid={is_valid} reason={validation_reason}")
    if not is_valid:
        logger.info(f"[{pair}] Data rejected: {validation_reason}")
        return None

    # 6. Run the signal engine
    # ─────────────────────────────────────────────────────────────────────
    # ═══ ENGINE SELECTION ══════════════════════════════════════════
    # BOT: uses ACE (Adaptive Confluence Engine) — regime-adaptive:
    #   - Trending (ADX>20): EMA21 pullback continuation (~62-65% win rate)
    #   - Ranging (ADX<20): BB reversal at extremes (~58-62% win rate)
    #   - Transitional (ADX 20-25): no signal (filter out uncertainty)
    #
    # SIGNALS PAGE: uses Option D (sniper_engine strict_mode=True)
    #   - Pattern + BOTH bonuses (level AND M5) — high quality, fewer signals
    #
    # OPTION C: on standby (imported, not called). To switch bot back:
    #   replace generate_ace_signal() with generate_sniper_signal(df, payout, strict_mode=False)
    df_with_indicators.attrs['pair'] = pair

    # ═══ ENGINE SELECTION: ACE → Sniper (3-min expiry, reversal setups) ═══
    # NOTE: The momentum_engine (1-min expiry, claimed 75-88% winrate) was
    # briefly activated as the primary engine in commit aa2e28a, but user
    # trading feedback was catastrophic — every live trade with 1-min signals
    # lost. The claimed 75-88% winrate appears to be fictional, just like
    # ACE/Sniper's hardcoded estimates. Additionally, 1-min expiry leaves
    # only ~10-17s for the user to place a trade after notification (17-28%
    # of the trade window), which means momentum has often already peaked.
    #
    # Reverted to ACE → Sniper (3-min expiry) which gave the user consistent
    # wins before the C5 fix. Momentum engine remains imported and available
    # for future A/B testing behind a feature flag, but is NOT called by default.
    # ═══ ENGINE SELECTION: ACE ONLY (Sniper fallback REMOVED) ════════
    # The Sniper fallback was REMOVED because it produced fake/low-quality
    # signals that lost 80% of trades (proven by backtest: 18.9% win rate
    # over 1,611 signals). When ACE finds nothing, the system returns NO
    # signal — this is correct behavior. Better to have no signal than a
    # bad signal that loses money.
    #
    # The momentum_engine was also briefly tested and caused catastrophic
    # live trading losses — it is NOT called.
    if strict_mode:
        # Signals page → ACE only
        engine_result = generate_ace_signal(df_with_indicators, payout)
        if engine_result is not None:
            logger.info(f"[{pair}] ACE signal found — using ACE (3m expiry, reversal setup)")
        else:
            logger.info(
                f"[{pair}] No ACE signal — no signal emitted (Sniper fallback removed). "
                f"candles={len(df_with_indicators)}, mode=signals page"
            )
            return None
    else:
        # Bot → ACE only
        engine_result = generate_ace_signal(df_with_indicators, payout)
        if engine_result is not None:
            logger.info(f"[{pair}] ACE signal found — using ACE (3m expiry, reversal setup)")
        else:
            logger.info(
                f"[{pair}] No ACE signal — no signal emitted (Sniper fallback removed). "
                f"candles={len(df_with_indicators)}, mode=bot"
            )
            return None
    engine_result.setdefault('engine_source', 'ace')

    sniper_result = engine_result

    # 7. Risk check — ADVISORY ONLY.
    # The risk manager tracks consecutive losses, daily risk used, and session
    # state. It NEVER blocks a user-requested (force) signal — the trader is
    # the decision-maker and is free to trade as much as they want.
    #
    # What it does:
    #   - Tracks every resolved trade outcome (win/loss) via record_trade_result
    #     in the resolution loop (see ~line 1500).
    #   - Exposes metrics via /api/status and /api/risk/settings so the frontend
    #     can display warnings like "⚠️ 3 consecutive losses — consider pausing".
    #   - Logs an advisory warning here when thresholds are crossed, so the
    #     operator can see risky activity in the logs.
    #
    # What it does NOT do:
    #   - Block signals. Not background, not force. The user is always free
    #     to request another signal.
    #
    # The previous code auto-reset the risk manager on every force signal,
    # which wiped consecutive_losses and daily_risk_used — making the metrics
    # useless. That auto-reset has been removed so metrics now persist correctly.
    if force:
        risk_check = risk_mgr.check_can_trade()
        if not risk_check['can_trade']:
            # Advisory only — log the warning but DO NOT block the signal.
            # The trader decides whether to act on the warning.
            logger.info(
                f"[{pair}] Risk advisory (signal still emitted — trader's choice): "
                f"blocks={risk_check.get('blocks', [])} "
                f"(consecutive_losses={risk_check.get('consecutive_losses')}, "
                f"daily_risk_used={risk_check.get('daily_risk_used')}%)"
            )

    # Circuit breaker — auto-reset (always, for both force and background)
    cb = monitor.check_circuit_breaker()
    if cb['is_active']:
        monitor.is_suspended = False
        monitor.consecutive_losses = 0
        monitor.circuit_breaker_until = None
        monitor.suspension_reason = None
        monitor.suspension_time = None
        logger.info(f"[{pair}] Circuit breaker auto-reset: {cb.get('reason', 'unknown')}")

    # 8. Deduplication: only for background mode (prevent spam)
    # Force mode (user request): NO dedup — user explicitly asked for a signal
    if not force:
        if not hasattr(analyze_pair_internal, '_last_signal_time'):
            analyze_pair_internal._last_signal_time = {}
        last_time = analyze_pair_internal._last_signal_time.get(pair, 0)
        now_ts = datetime.now(timezone.utc).timestamp()
        if (now_ts - last_time) < 30:  # Reduced from 60s to 30s — same as emission gate
            logger.debug(f"[{pair}] Background signal skipped — duplicate within 30s window")
            return None

    # ─── CANDIDATE MODE (background scanning) ───────────────────────────────
    # When return_candidate=True, the trading_loop is collecting candidates
    # to pick the best one every 30s. We return all the analysis data as a
    # dict WITHOUT building/saving/emitting the signal. The trading_loop will
    # call _emit_candidate() on the winner.
    if return_candidate and not force:
        now_ts = datetime.now(timezone.utc).timestamp()
        engine_mode = sniper_result.get('mode', 'PRICE_ACTION')
        factors_hit = sniper_result['factors']['factors_hit']

        # Price Action engine — use the classification from the engine directly
        strategy_label = sniper_result.get('classification', f'Price Action ({sniper_result["score"]}/4)')
        indicator_summary = f"RSI {sniper_result['factors'].get('rsi', 0):.0f} / ADX {sniper_result['factors'].get('adx', 0):.0f}"
        rsi_status = 'Bullish' if sniper_result['direction'] == 'CALL' else 'Bearish'

        return {
            'pair': pair,
            'direction': sniper_result['direction'],
            'score': sniper_result['score'],
            'winrate': sniper_result['winrate'],
            'payout': payout,
            'entry_price': sniper_result['entry_price'],
            'expiration': sniper_result['expiration'],
            'classification': sniper_result['classification'],
            'smc_structure': strategy_label,
            'smc_zone': ', '.join(factors_hit[:3]),
            'chart_pattern': sniper_result['factors'].get('reversal_pattern', 'N/A') or 'N/A',
            'fibonacci': indicator_summary,
            'rsi_status': rsi_status,
            'recommended_stake': 10,
            'analysis_details': {
                'mode': 'price_action',
                'engine_mode': engine_mode,
                'expiration_minutes': sniper_result['expiration'],
                'factors_hit': factors_hit,
                'factors_description': sniper_result['factors']['factors_description'],
                'call_score': sniper_result['factors']['call_score'],
                'put_score': sniper_result['factors']['put_score'],
                'rsi': sniper_result['factors'].get('rsi'),
                'stoch_k': sniper_result['factors'].get('stoch_k'),
                'cci': sniper_result['factors'].get('cci'),
                'adx': sniper_result['factors'].get('adx'),
                'atr': sniper_result['factors'].get('atr'),
                # Persist stake as a percentage so the resolver can convert to a
                # 0-1 fraction for risk_mgr.record_trade_result(). See resolution
                # loop comment for why this must live inside analysis_details.
                'recommended_stake_pct': 10,
            },
            '_evaluated_at': now_ts,
        }

    # 9. Build the signal dict from engine result
    logger.info(f"[SIGNAL-BUILD] Building signal for {pair} — engine_mode={sniper_result.get('mode')}, score={sniper_result.get('score')}, direction={sniper_result.get('direction')}")
    now = datetime.now(timezone.utc)
    now_ts = now.timestamp()
    engine_mode = sniper_result.get('mode', 'PRICE_ACTION')
    factors_hit = sniper_result['factors']['factors_hit']

    # Price Action engine — use classification from the engine directly
    strategy_label = sniper_result.get('classification', f'Price Action ({sniper_result["score"]}/4)')
    indicator_summary = f"RSI {sniper_result['factors'].get('rsi', 0):.0f} / ADX {sniper_result['factors'].get('adx', 0):.0f}"
    rsi_status = 'Bullish' if sniper_result['direction'] == 'CALL' else 'Bearish'

    # ─── FIX 1: REFRESH ENTRY PRICE TO LIVE TICK ─────────────────────────
    # The engine analyzed the last CLOSED M5 candle, whose close price could
    # be up to 5 minutes old by the time the user receives the signal. On a
    # 3-min EURUSD_otc trade where the typical move is 3-8 pips, entering at
    # a 5-min-old price is a 25-60% handicap.
    #
    # The background _emit_candidate path already does this refresh (line ~1197).
    # The bot force path was missing it — so Telegram "GET SIGNAL" taps were
    # entering at stale prices while background signals entered at live prices.
    #
    # Now both paths refresh to the live tick before saving/emitting.
    entry_price = sniper_result['entry_price']
    try:
        live_price = await po_scanner.get_current_price(pair)
        if live_price and live_price > 0:
            logger.info(
                f"[{pair}] Refreshing entry_price for force signal: "
                f"engine={entry_price:.5f} -> live={live_price:.5f}"
            )
            entry_price = live_price
    except Exception as price_err:
        logger.warning(f"[{pair}] Could not fetch live price for force signal: {price_err} — using engine entry_price")

    signal = {
        'id': f'SIG-{now.strftime("%Y%m%d")}-{uuid.uuid4().hex[:6].upper()}',
        'pair': pair,
        'direction': sniper_result['direction'],
        'time': now.strftime('%H:%M:%S'),
        'timestamp': now.isoformat(),
        'entry_price': entry_price,  # FIX 1: live-refreshed, not stale engine close
        'expiration': sniper_result['expiration'],  # 1 or 3 minutes
        'winrate': sniper_result['winrate'],
        'score': sniper_result['score'],
        'raw_points': sniper_result['score'],
        'payout': payout,
        'classification': sniper_result['classification'],
        'session_id': get_current_session_id(),
        'smc_structure': strategy_label,
        'smc_zone': ', '.join(factors_hit[:3]),
        'chart_pattern': sniper_result['factors'].get('reversal_pattern', 'N/A') or 'N/A',
        'fibonacci': indicator_summary,
        'rsi_status': rsi_status,
        'recommended_stake': 10,
        'analysis_details': {
            'mode': 'price_action',
            'engine_mode': engine_mode,
            'expiration_minutes': sniper_result['expiration'],
            'factors_hit': factors_hit,
            'factors_description': sniper_result['factors']['factors_description'],
            'call_score': sniper_result['factors']['call_score'],
            'put_score': sniper_result['factors']['put_score'],
            'rsi': sniper_result['factors'].get('rsi'),
            'stoch_k': sniper_result['factors'].get('stoch_k'),
            'cci': sniper_result['factors'].get('cci'),
            'adx': sniper_result['factors'].get('adx'),
            'atr': sniper_result['factors'].get('atr'),
            # Persist stake as a percentage (10 = 10% of capital) so the
            # resolution loop can convert to a 0-1 fraction for risk_mgr.
            'recommended_stake_pct': 10,
        },
    }

    # 10. Compliance hash
    try:
        signal['hash_signature'] = compliance.generate_immutable_log(signal)
    except Exception as hash_err:
        logger.warning(f"[{pair}] Hash error: {hash_err}")
        signal['hash_signature'] = 'ERROR'

    # 11. Save to database
    try:
        async with AsyncSessionLocal() as session:
            db_signal = SignalRecord(
                id=signal['id'], pair=signal['pair'], direction=signal['direction'],
                entry_price=signal['entry_price'], expiration=signal['expiration'],
                winrate=signal['winrate'], score=signal['score'], payout=signal['payout'],
                classification=signal['classification'], timestamp=now,
                analysis_details=signal['analysis_details'],
                hash_signature=signal['hash_signature'],
                session_id=signal['session_id']
            )
            session.add(db_signal)
            await session.commit()
    except Exception as db_err:
        logger.warning(f"[{pair}] DB save error: {db_err}")

    # 12. Emit signal
    generated_signals.append(signal)
    analyze_pair_internal._last_signal_time[pair] = now_ts
    monitor.record_signal(signal['id'], pair, signal['direction'], signal['winrate'])
    increment_session_trade_count()
    _record_successful_emission()
    # FIX H1: Bot force path must also update the global 30s emission gate.
    # Previously this only set the per-pair dedup, allowing the background
    # loop to emit a SECOND signal on a different pair within 30s — causing
    # duplicate signals visible to the user within seconds of each other.
    register_background_emission()

    logger.info(
        f"[SNIPER-EMITTED] id={signal['id']} pair={signal['pair']} "
        f"mode={sniper_result.get('mode', 'UNKNOWN')} direction={signal['direction']} "
        f"score={signal['score']}/{sniper_result.get('max_score', 4)} winrate={signal['winrate']}% "
        f"expiration={signal['expiration']}m payout={signal['payout']}% "
        f"engine={sniper_result.get('engine_source', 'unknown')} "
        f"session={signal['session_id']} trade={_session_state['trade_count']}/{TRADES_PER_SESSION}"
    )

    # FIX H2: Bot force path must also push Telegram + Web Push notifications.
    # Previously only the background _emit_candidate path sent these, so a
    # user who clicked "GET SIGNAL" in Telegram would get the reply in chat
    # but other subscribers (web push, other Telegram chats) would NOT be
    # notified. Mirror the same fire-and-forget dispatch used by _emit_candidate.
    try:
        signal_msg = f"""🎯 <b>A2SNIPER SIGNAL SUR DEMANDE</b>
━━━━━━━━━━━━━━━━━━━━━
📊 Paire : <b>{signal['pair']}</b>
🟢 Direction : <b>{signal['direction']}</b>
⌛ Expiration : <b>{signal['expiration']}m</b>
💰 Payout : <b>{signal['payout']}%</b>
🎯 Winrate : <b>{signal['winrate'] if signal['winrate'] else '—'}%</b>
📈 Prix d'entrée : <code>{signal['entry_price']}</code>

🏗️ Structure : <i>{signal.get('smc_structure', '—')}</i>
⚡ Confluence : <i>{signal.get('fibonacci', '—')}</i>

Zéro Simulation. 100% Real-Market."""
        asyncio.create_task(telegram_bot.send_signal(signal_msg))
    except Exception as tg_err:
        logger.warning(f"[SIGNAL-TELEGRAM-ERROR] pair={pair} err={tg_err}")

    try:
        asyncio.create_task(_send_push_notifications_for_signal(signal))
    except Exception as push_err:
        logger.warning(f"[SIGNAL-PUSH-ERROR] pair={pair} err={push_err}")

    return signal


# ═══════════ CANDIDATE EMITTER ═════════════════════════════════════════
# Takes a candidate dict (from return_candidate mode) and builds + saves +
# emits the signal. Called by trading_loop when the 30s gate opens and the
# best candidate has been selected.

async def _emit_candidate(candidate: dict, force: bool = False) -> dict:
    """Build, save, and emit a signal from a candidate dict.

    Used by:
    - trading_loop (force=False) — emits the best candidate every 30s
    - Not used for force mode (that path uses the inline emission in
      _analyze_pair_internal_impl, which has access to the full df_m1 data)
    """
    pair = candidate['pair']

    # ─── RACE CONDITION GUARD ─────────────────────────────────────────────
    # The kickstart and the first trading_loop scan can both collect the same
    # pair as a candidate. Without this check, both would emit a signal for
    # the same pair within seconds of each other (the duplicate AED/CNY bug).
    # Skip emission if this pair already had a signal in the last 60s.
    if not force:
        if not hasattr(analyze_pair_internal, '_last_signal_time'):
            analyze_pair_internal._last_signal_time = {}
        last_time = analyze_pair_internal._last_signal_time.get(pair, 0)
        now_ts_check = datetime.now(timezone.utc).timestamp()
        if (now_ts_check - last_time) < 30:  # Reduced from 60s to 30s
            logger.info(
                f"[EMIT-SKIP] {pair} — duplicate within 60s window "
                f"(last={last_time:.0f}, now={now_ts_check:.0f}, "
                f"gap={now_ts_check - last_time:.0f}s). Skipping to prevent duplicate."
            )
            return None
    now_ts = datetime.now(timezone.utc).timestamp()

    # ─── H2 FIX: RE-VALIDATE CANDIDATE AT EMISSION TIME ──────────
    # The candidate was created up to 30s ago. The signal was valid then,
    # but the market may have moved since. Before emitting, verify the
    # entry price hasn't moved against the signal direction by more than
    # 0.5 ATR. If it has, the setup is no longer valid — skip it.
    live_price = None
    try:
        live_price = await po_scanner.get_current_price(pair)
    except Exception:
        pass
    if live_price and live_price > 0:
        candidate_price = candidate['entry_price']
        direction = candidate['direction']
        # M-5 FIX: direction-aware re-validation. Was using abs(price_move) which
        # rejected favorable moves (price went UP for a CALL = good, but was rejected).
        # Now: only reject if price moved AGAINST the signal direction.
        if direction == 'CALL':
            adverse_move = candidate_price - live_price  # positive = price went down (bad for CALL)
        else:
            adverse_move = live_price - candidate_price  # positive = price went up (bad for PUT)
        candidate_atr = candidate.get('analysis_details', {}).get('atr', 0) or 0
        if candidate_atr and candidate_atr > 0 and adverse_move > 0:
            adverse_atr = adverse_move / candidate_atr
            if adverse_atr > 0.5:
                logger.info(
                    f"[EMIT-SKIP] {pair} — price moved {adverse_atr:.2f} ATR AGAINST {direction} "
                    f"(candidate={candidate_price:.5f}, live={live_price:.5f}, ATR={candidate_atr:.5f}). "
                    f"Signal no longer valid — skipping emission."
                )
                return None
        logger.info(f"[EMIT-PRICE] {pair} refreshing entry_price: candidate={candidate_price} → live={live_price}")
        candidate['entry_price'] = live_price

    # Set `now` AFTER the price refresh (which may take 1-2s for the
    # async get_current_price call). This ensures the signal's timestamp
    # is as close to the actual emission moment as possible, so the
    # frontend's countdown starts at ~5:00 (not 4:58).
    now = datetime.now(timezone.utc)
    now_ts = now.timestamp()

    signal = {
        'id': f'SIG-{now.strftime("%Y%m%d")}-{uuid.uuid4().hex[:6].upper()}',
        'pair': pair,
        'direction': candidate['direction'],
        'time': now.strftime('%H:%M:%S'),
        'timestamp': now.isoformat(),
        'entry_price': candidate['entry_price'],
        'expiration': candidate['expiration'],
        'winrate': candidate['winrate'],
        'score': candidate['score'],
        'raw_points': candidate['score'],
        'payout': candidate['payout'],
        'classification': candidate['classification'],
        'session_id': get_current_session_id(),
        'smc_structure': candidate.get('smc_structure', 'Price Action'),
        'smc_zone': candidate.get('smc_zone', 'N/A'),
        'chart_pattern': candidate.get('chart_pattern', 'Momentum'),
        'fibonacci': candidate.get('fibonacci', 'N/A'),
        'rsi_status': candidate.get('rsi_status', 'Neutral'),
        'recommended_stake': candidate.get('recommended_stake', 10),
        'analysis_details': candidate.get('analysis_details', {}),
    }

    # Compliance hash
    try:
        signal['hash_signature'] = compliance.generate_immutable_log(signal)
    except Exception as hash_err:
        logger.warning(f"[{pair}] Hash error: {hash_err}")
        signal['hash_signature'] = 'ERROR'

    # Save to database
    try:
        async with AsyncSessionLocal() as session:
            db_signal = SignalRecord(
                id=signal['id'], pair=signal['pair'], direction=signal['direction'],
                entry_price=signal['entry_price'], expiration=signal['expiration'],
                winrate=signal['winrate'], score=signal['score'], payout=signal['payout'],
                classification=signal['classification'], timestamp=now,
                analysis_details=signal['analysis_details'],
                hash_signature=signal['hash_signature'],
                session_id=signal['session_id']
            )
            session.add(db_signal)
            await session.commit()
    except Exception as db_err:
        logger.warning(f"[{pair}] DB save error: {db_err}")

    # Emit signal
    generated_signals.append(signal)
    if not hasattr(analyze_pair_internal, '_last_signal_time'):
        analyze_pair_internal._last_signal_time = {}
    analyze_pair_internal._last_signal_time[pair] = now_ts
    monitor.record_signal(signal['id'], pair, signal['direction'], signal['winrate'])
    increment_session_trade_count()
    _record_successful_emission()
    if not force:
        register_background_emission()

    logger.info(
        f"[SNIPER-EMITTED] id={signal['id']} pair={signal['pair']} "
        f"direction={signal['direction']} score={signal['score']}/{signal.get('max_score', candidate.get('max_score', 4))} "
        f"winrate={signal['winrate']}% expiration={signal['expiration']}m "
        f"payout={signal['payout']}% session={signal['session_id']} "
        f"trade={_session_state['trade_count']}/{TRADES_PER_SESSION}"
    )

    # Telegram notification — fire-and-forget (non-blocking) so the emission
    # pipeline doesn't wait for Telegram's API response (can take 1-5s).
    try:
        signal_msg = f"""🎯 <b>A2SNIPER SIGNAL {"LIVE" if not force else "SUR DEMANDE"}</b>
━━━━━━━━━━━━━━━━━━━━━
📊 Paire : <b>{signal['pair']}</b>
🟢 Direction : <b>{signal['direction']}</b>
⌛ Expiration : <b>{signal['expiration']}m</b>
💰 Payout : <b>{signal['payout']}%</b>
🎯 Winrate : <b>{signal['winrate']}%</b>

🏗️ Structure : <i>{signal['smc_structure']}</i>
⚡ Confluence : <i>{signal['fibonacci']}</i>

Zéro Simulation. 100% Real-Market."""
        asyncio.create_task(telegram_bot.send_signal(signal_msg))
    except Exception as tg_err:
        logger.warning(f"[SIGNAL-TELEGRAM-ERROR] pair={pair} err={tg_err}")

    # Web Push notification — fire-and-forget. Sends a push to ALL subscribed
    # users' devices (browser/phone) so they get notified even if the tab is
    # closed. The push payload includes pair, direction, expiration, and a
    # URL to the signals page. The service worker on the client shows a
    # notification with action buttons (Open PO, View Signal).
    try:
        asyncio.create_task(_send_push_notifications_for_signal(signal))
    except Exception as push_err:
        logger.warning(f"[SIGNAL-PUSH-ERROR] pair={pair} err={push_err}")

    return signal


async def _send_push_notifications_for_signal(signal: dict):
    """Send web push notifications to ALL users who have push subscriptions.
    Called fire-and-forget from _emit_candidate so it doesn't block emission.
    """
    try:
        from pywebpush import webpush, WebPushException
        from sqlalchemy import delete as sql_delete
    except ImportError:
        logger.warning("[PUSH] pywebpush not installed — skipping push notifications")
        return

    # Build the push payload — the service worker uses this to show the notification
    payload = json.dumps({
        'title': f"🎯 {signal['pair']} — {signal['direction']}",
        'body': f"⏱ {signal['expiration']}m expiry • {signal['payout']}% payout • {signal['winrate']}% winrate",
        'pair': signal['pair'],
        'direction': signal['direction'],
        'expiration': signal['expiration'],
        'payout': signal['payout'],
        'winrate': signal['winrate'],
        'signal_id': signal['id'],
        'timestamp': signal['timestamp'],
        'url': '/signals',  # A2Sniper signals page
    })

    # Fetch ALL push subscriptions (all users) — we notify everyone
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(PushSubscription)
            )
            subs = result.scalars().all()
    except Exception as db_err:
        logger.warning(f"[PUSH] DB error fetching subscriptions: {db_err}")
        return

    if not subs:
        return  # No subscriptions — nothing to send

    logger.info(f"[PUSH] Sending push to {len(subs)} subscribed device(s) for signal {signal['id']}")

    sent = 0
    failed = 0
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    'endpoint': sub.endpoint,
                    'keys': {
                        'p256dh': sub.p256dh_key,
                        'auth': sub.auth_key,
                    },
                },
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS,
            )
            sent += 1
        except WebPushException as e:
            # 410 Gone / 404 = subscription expired or cancelled — remove it
            status_code = getattr(e, 'response', None)
            if status_code and hasattr(status_code, 'status_code'):
                if status_code.status_code in (404, 410):
                    logger.info(f"[PUSH] Subscription expired (HTTP {status_code.status_code}) — removing sub id={sub.id}")
                    try:
                        async with AsyncSessionLocal() as session:
                            await session.execute(
                                sql_delete(PushSubscription).where(PushSubscription.id == sub.id)
                            )
                            await session.commit()
                    except Exception:
                        pass
                else:
                    logger.warning(f"[PUSH] WebPushError for sub id={sub.id}: HTTP {status_code.status_code}")
            else:
                logger.warning(f"[PUSH] WebPushError for sub id={sub.id}: {e}")
            failed += 1
        except Exception as e:
            logger.warning(f"[PUSH] Error for sub id={sub.id}: {e}")
            failed += 1

    logger.info(f"[PUSH] Done: {sent} sent, {failed} failed (of {len(subs)} total)")


# ═══════════ MAIN TRADING LOOP ═══════════
async def trading_loop():
    """Boucle d'analyse réelle sur les paires OTC disponibles.

    Uses the REAL pairs PO is currently offering (via scanner.find_pairs_above_payout)
    rather than just the 8 hardcoded ones. Falls back to the default 8 if no payouts
    have been received yet.
    """
    logger.info("═══════════ A2Sniper 3.0 — STARTING ═══════════")
    logger.info("Using LIVE forex pairs from PocketOption (no hardcoded list). Active + payout>=70% + forex only.")
    logger.info("[SNIPER-ENGINE] Dual-mode sniper engine (1M mean-reversion + 3M trend-pullback). 4/7 factors minimum.")

    # Wait briefly for scanner to receive asset data on first run
    initial_wait = 0
    while not po_scanner.is_connected and initial_wait < 60:
        await asyncio.sleep(2)
        initial_wait += 2
    # Give PO 5 more seconds to push updateAssets after auth
    if po_scanner.is_connected:
        await asyncio.sleep(5)

    # ═══ SNIPER KICKSTART ═════════════════════════════════════════════
    # Fire sniper analysis on all forex pairs within 2 seconds of connecting.
    # Collects candidates and emits the best one (respecting the 30s gate).
    # The gate's last_emission_ts starts at 0, so the first emission is
    # always allowed immediately on startup.
    try:
        kickoff_pairs = po_scanner.find_pairs_above_payout(
            min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
        )
        if kickoff_pairs:
            kickoff_list = list(kickoff_pairs.keys())
            logger.info(f"[SNIPER-KICKSTART] Firing sniper analysis on {len(kickoff_list)} pairs...")
            kickoff_candidates = []
            for pair in kickoff_list:
                try:
                    # strict_mode=True → Option D (signals page: pattern + BOTH bonuses)
                    # The signals page runs 24/7 with no time pressure, so it can
                    # afford to wait for full-confluence A+ setups.
                    candidate = await analyze_pair(pair, return_candidate=True, strict_mode=True)
                    if candidate:
                        kickoff_candidates.append(candidate)
                        logger.info(f"[SNIPER-KICKSTART] ✅ Candidate (strict/Option D): {candidate['pair']} {candidate['direction']} score={candidate['score']}/7 ({candidate['winrate']}%)")
                except Exception:
                    pass
                # Yield to event loop so HTTP requests can be processed during kickoff
                await asyncio.sleep(0)

            # Emit the best candidate from kickstart (gate is open on first run)
            if kickoff_candidates:
                best = max(kickoff_candidates, key=lambda c: c.get('score', 0))
                logger.info(f"[SNIPER-KICKSTART] Emitting best candidate: {best['pair']} score={best['score']}/7")
                await _emit_candidate(best, force=False)
            else:
                logger.info("[SNIPER-KICKSTART] No candidates qualified — waiting for main loop")
    except Exception as e:
        logger.warning(f"[SNIPER-KICKSTART] Error: {e}")

    while True:
        try:
            if not po_scanner.is_connected:
                await asyncio.sleep(2)
                continue

            # Circuit Breaker check — AUTO-RESET if active.
            # The circuit breaker blocks ALL signal emission when the win rate
            # drops below 55%. But this prevents the signals page from ever
            # emitting again (the win rate can't improve if no new signals are
            # emitted). Auto-reset it so the trading_loop continues scanning.
            cb = monitor.check_circuit_breaker()
            if cb['is_active']:
                logger.info(f"[LOOP] Circuit Breaker was active — auto-resetting: {cb['reason']}")
                monitor.is_suspended = False
                monitor.consecutive_losses = 0
                monitor.circuit_breaker_until = None
                monitor.suspension_reason = None
                monitor.suspension_time = None

            # Determine which pairs to analyze this cycle:
            # ONLY live forex pairs from PO that are ACTIVE with payout >= 70%.
            # This is re-evaluated every cycle (5s) so when PO marks a pair
            # inactive (greyed out / N/A) it's automatically excluded, and
            # when it reactivates it's automatically re-included. Payout
            # changes are also automatically reflected.
            # No hardcoded fallback — if no pairs meet criteria, just wait.
            real_otc = po_scanner.find_pairs_above_payout(
                min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
            )
            if real_otc:
                pairs_to_scan = list(real_otc.keys())
                logger.info(
                    f"[LOOP] Scanning {len(pairs_to_scan)} live FOREX pairs "
                    f"(active + payout>=70%): {pairs_to_scan[:5]}"
                    f"{' ...' if len(pairs_to_scan) > 5 else ''}"
                )
            else:
                # No pairs meet criteria right now — wait for PO to push
                # updated asset data (could be all pairs inactive, or all
                # payouts below 70%). Don't fall back to hardcoded pairs.
                logger.info("[LOOP] No live FOREX pairs meet criteria (active + payout>=70%) — waiting for PO update")
                pairs_to_scan = []

            # ═══ COLLECT CANDIDATES (no emission) ═══════════════════════
            # ═══ REFRESH ALL CANDLES VIA REST EVERY 2 MINUTES ════════════
            # PO only pushes fresh candle data for one pair at a time via WebSocket.
            # Instead of clearing cache one-by-one (which blocks the loop for 2-9s
            # per pair), we refresh ALL pairs via REST API every 2 minutes in a
            # background task. This doesn't block the trading_loop.
            if pairs_to_scan and po_scanner.is_connected:
                if not hasattr(trading_loop, '_last_rest_refresh'):
                    trading_loop._last_rest_refresh = 0
                now_ts = datetime.now(timezone.utc).timestamp()
                if now_ts - trading_loop._last_rest_refresh > 30:  # Every 30 seconds
                    trading_loop._last_rest_refresh = now_ts
                    # Fire-and-forget: refresh all pairs' candles via REST in background
                    async def _refresh_all_candles_rest():
                        try:
                            forex_symbols = [
                                po_scanner.get_asset_symbol(p) for p in pairs_to_scan
                            ]
                            logger.info(f"[LOOP] Refreshing {len(forex_symbols)} pairs via REST API (background)...")
                            refreshed = 0
                            failed = 0
                            for symbol in forex_symbols:
                                try:
                                    # C-1 FIX: fetch 500 candles (not 100) and MERGE with
                                    # existing tick-aggregated cache instead of overwriting.
                                    # Was: _fetch_candles_http(symbol, 60, 100) → 100 M1 →
                                    # 20 M5 after resample → engine needs 35 → starved.
                                    df = await po_scanner._fetch_candles_http(symbol, 60, 500)
                                    if df is not None and not df.empty:
                                        cache_key = f"{symbol}_1m"
                                        existing = po_scanner._candles_cache.get(cache_key)
                                        if existing is not None and not existing.empty:
                                            # C-2 FIX: concat REST first, tick-aggregated last,
                                            # keep='last' → tick-aggregated wins for dupes
                                            merged = pd.concat([df, existing])
                                            merged = merged[~merged.index.duplicated(keep='last')]
                                            merged = merged.sort_index().tail(500)
                                            po_scanner._candles_cache[cache_key] = merged
                                        else:
                                            po_scanner._candles_cache[cache_key] = df
                                        refreshed += 1
                                    else:
                                        failed += 1
                                except Exception as e:
                                    failed += 1
                                    if failed <= 3:
                                        logger.warning(f"[LOOP] REST refresh failed for {symbol}: {e}")
                                await asyncio.sleep(0)  # Yield between pairs
                            logger.info(f"[LOOP] ✅ REST refresh complete: {refreshed} updated, {failed} failed (of {len(forex_symbols)} total)")
                        except Exception as e:
                            logger.warning(f"[LOOP] REST refresh error: {e}")
                    asyncio.create_task(_refresh_all_candles_rest())

            candidates = []
            for pair in pairs_to_scan:
                if not po_scanner.is_connected: break

                payout = po_scanner.get_payout(pair)
                if payout is None or payout < 70:
                    continue

                # ═══ SNIPER ENGINE (candidate mode, strict/Option D) + CANDLE PERSISTENCE ══
                # strict_mode=True → Option D (pattern + BOTH bonuses).
                # The signals page background loop has no time pressure — it can
                # wait for full-confluence A+ setups. This gives higher winrate
                # (68-82%) at the cost of fewer signals. The bot (GET SIGNAL
                # button) uses Option C (strict_mode=False) for responsiveness.
                try:
                    candidate = await analyze_pair(pair, return_candidate=True, strict_mode=True)
                    if candidate:
                        candidates.append(candidate)
                        logger.info(
                            f"[CANDIDATE] pair={pair} score={candidate['score']}/7 "
                            f"direction={candidate['direction']} winrate={candidate['winrate']}% "
                            f"mode=strict/Option D "
                            f"— added to pool ({len(candidates)} candidates this cycle)"
                        )
                except Exception as e:
                    logger.debug(f"[SNIPER-ERROR] pair={pair} err={e}")

                # Save completed candles to database (for persistence across redeploys)
                # FIX 5: Throttle to once per minute per pair. Was running every 5s
                # (12 writes/min/pair × 20 pairs = 240 DB writes/min) — saturating
                # the DB pool and delaying signal saves by 1-5s. Since candles
                # only complete once per minute, saving every 5s writes the same
                # data 12 times.
                try:
                    if not hasattr(trading_loop, '_last_candle_save_ts'):
                        trading_loop._last_candle_save_ts = {}
                    last_save = trading_loop._last_candle_save_ts.get(pair, 0)
                    now_save_ts = datetime.now(timezone.utc).timestamp()
                    if now_save_ts - last_save >= 60:  # Once per minute per pair
                        asset = po_scanner.get_asset_symbol(pair)
                        cached_df = po_scanner._candles_cache.get(f"{asset}_1m")
                        if cached_df is not None and not cached_df.empty and len(cached_df) > 1:
                            await save_candles_to_db(asset, cached_df.tail(10))
                            trading_loop._last_candle_save_ts[pair] = now_save_ts
                except Exception:
                    pass

                # CRITICAL: yield to the event loop after each pair so pending
                # HTTP requests (frontend polling, bot signal requests) can be
                # processed. Without this, a 30-pair scan blocks the event
                # loop for 30-90s, delaying signal delivery until after expiry.
                await asyncio.sleep(0)

            # ═══ EMIT BEST CANDIDATE (if gate allows) ═══════════════════════
            # The 30s gate ensures signals come one by one, 30s apart — never
            # a flood. If multiple pairs qualified, only the highest-scoring
            # one is emitted. The rest are discarded; next 5s scan starts fresh.
            if candidates:
                # M-1 FIX: select by winrate (primary), score (tiebreaker).
                # Was: max by score only — ACE score 4 (WR 65) beat Sniper score 4 (WR 78).
                best = max(candidates, key=lambda c: (c.get('winrate', 0), c.get('score', 0)))
                if can_emit_background_signal():
                    logger.info(
                        f"[GATE-OPEN] Emitting best candidate: {best['pair']} "
                        f"score={best['score']}/7 ({len(candidates)} candidates were available)"
                    )
                    await _emit_candidate(best, force=False)
                else:
                    remaining = MIN_EMISSION_GAP_SECONDS - (datetime.now(timezone.utc).timestamp() - _emission_gate["last_emission_ts"])
                    logger.info(
                        f"[GATE-BLOCKED] {len(candidates)} candidates ready, best={best['pair']} "
                        f"score={best['score']}/7 — {remaining:.0f}s until next emission"
                    )
            else:
                # HEARTBEAT: log every cycle so we can verify the trading loop
                # is alive. Without this, a crashed loop is invisible — the
                # backend stays up (serving API requests) but no signals emit.
                time_since_last = datetime.now(timezone.utc).timestamp() - _last_successful_emission_ts()
                logger.info(
                    f"[LOOP-HEARTBEAT] No candidates this cycle. "
                    f"Scanned {len(pairs_to_scan)} pairs, 0 qualified. "
                    f"Time since last signal: {time_since_last:.0f}s. "
                    f"Adaptive threshold: {'3/7 (relaxed)' if time_since_last >= ADAPTIVE_RELAX_AFTER_SECONDS else '4/7 (strict)'}"
                )
            # If no candidates, silently continue — next scan in 5s

            # 5s cycle interval — re-evaluate all pairs every 5s.
            # The 30s gate inside _emit_candidate ensures we only EMIT every 30s,
            # but we keep SCANNING every 5s so we always have fresh candidates
            # ready when the gate opens.
            await asyncio.sleep(5)

        except Exception as e:
            logger.error(f"Erreur boucle principale: {e}", exc_info=True)
            await asyncio.sleep(10)
            # CRITICAL: the loop must continue even after an error.
            # If it exits, no more signals will ever be emitted.

async def resolution_loop():
    """Boucle de résolution RÉELLE des signaux expirés."""
    while True:
        try:
            if not po_scanner.is_connected:
                await asyncio.sleep(5)
                continue

            now = datetime.now(timezone.utc)
            async with AsyncSessionLocal() as session:
                query = select(SignalRecord).where(SignalRecord.is_win == None)
                result = await session.execute(query)
                active_signals = result.scalars().all()
                
                for s in active_signals:
                    s_timestamp = s.timestamp.replace(tzinfo=timezone.utc) if s.timestamp.tzinfo is None else s.timestamp
                    # Expiry = signal timestamp + EXECUTION LATENCY + expiration minutes
                    #
                    # EXECUTION LATENCY FIX:
                    # The signal timestamp is when the SYSTEM emitted the signal.
                    # But the user places the trade on Pocket Option 10-30 seconds
                    # LATER (time to: receive notification → read it → switch to PO →
                    # place trade). So the user's actual trade expires 10-30 seconds
                    # AFTER what the system calculates.
                    #
                    # Before this fix: system checked price at signal_time + 3 min
                    #                  PO actually expired at (signal_time + ~20s) + 3 min
                    #                  → 15-20 second discrepancy → wrong win/loss
                    #
                    # After this fix: system checks at signal_time + 20s + 3 min
                    #                 → matches when the user's PO trade actually expires
                    #
                    # This is why the user saw "I won on PO but system shows loss"
                    # (system checked too early, price hadn't moved yet) and
                    # "I lost on PO but system shows win" (system checked too early,
                    # price hadn't dropped yet).
                    EXECUTION_LATENCY_SECONDS = 20  # realistic: notification → read → switch to PO → place trade
                    expiry_time = s_timestamp + timedelta(seconds=EXECUTION_LATENCY_SECONDS) + timedelta(minutes=s.expiration or 1)
                    
                    if now >= expiry_time:
                        # ─── ACCURATE WIN/LOSS DETERMINATION ───────────────
                        # Pocket Option pays based on the price AT the exact
                        # expiry moment. The closest available proxy for that
                        # price is the CLOSE of the M1 candle that CONTAINS
                        # the expiry timestamp (within ±1 second).
                        #
                        # The previous implementation called get_current_price()
                        # which returns the live tick price at RESOLUTION time
                        # (~10 seconds AFTER expiry because the loop sleeps 10s).
                        # That introduced a 10-second bias that could flip wins
                        # to losses and vice versa — particularly on fast-moving
                        # pairs like EURUSD_otc where 10s = 2-5 pips.
                        #
                        # FIX: try M1 candle close FIRST (accurate to ±1s),
                        # fall back to live tick only if no M1 data available.
                        try:
                            current_price = None
                            df_m1_expiry = await po_scanner.get_candles(s.pair, timeframe="1m", count=10)
                            if df_m1_expiry is not None and not df_m1_expiry.empty:
                                expiry_ts = expiry_time.timestamp()
                                df_m1_ts = df_m1_expiry.index.astype(np.int64) // 10**9
                                candle_open_ts = df_m1_ts.values
                                # Find the M1 candle that CONTAINS expiry_ts:
                                # candle_open <= expiry_ts < candle_open + 60
                                actual_containing = df_m1_expiry[
                                    (candle_open_ts <= expiry_ts) &
                                    (candle_open_ts + 60 > expiry_ts)
                                ]
                                if not actual_containing.empty:
                                    current_price = float(actual_containing.iloc[-1]['close'])
                                    logger.debug(
                                        f"[RESULT-CHECK] {s.id} using M1 candle close "
                                        f"for expiry (entry={s.entry_price}, exit={current_price})"
                                    )
                                else:
                                    # Fall back to last candle close
                                    current_price = float(df_m1_expiry.iloc[-1]['close'])
                            # If M1 data unavailable, fall back to live tick
                            # (less accurate, but better than leaving signal unresolved)
                            if not current_price or current_price <= 0:
                                current_price = await po_scanner.get_current_price(s.pair)
                                if current_price and current_price > 0:
                                    logger.warning(
                                        f"[RESULT-CHECK] {s.id} fell back to live tick "
                                        f"(M1 data unavailable) — result may be biased by ~10s"
                                    )
                        except Exception as price_err:
                            logger.warning(f"[RESULT-CHECK] Error fetching expiry price for {s.id}: {price_err}")
                            current_price = await po_scanner.get_current_price(s.pair)

                        if current_price:
                            if s.direction == 'CALL':
                                is_win = current_price > s.entry_price
                            elif s.direction == 'PUT':
                                is_win = current_price < s.entry_price
                            else:
                                is_win = None  # Unknown direction
                            # Tie (equal price) is treated as no result
                            if current_price == s.entry_price:
                                # M-6 FIX: max 3 retries for ties, then mark as no-result
                                s.tie_count = (getattr(s, 'tie_count', 0) or 0) + 1
                                if s.tie_count >= 3:
                                    s.is_win = None
                                    logger.info(f"Tie persisted for {s.id} after 3 attempts — marking no-result")
                                else:
                                    logger.info(f"Tie detected for {s.id} (attempt {s.tie_count}/3): entry={s.entry_price}, exit={current_price}")
                                continue
                            s.is_win = is_win

                            # Record result in monitoring engine and risk manager.
                            # BUGFIX: previously read s.analysis_details.get('recommended_stake')
                            # which was always None (recommended_stake is set at the top level of
                            # the signal dict, not inside analysis_details). The fallback stake_val=1.0
                            # was treated as 100% capital risk per trade, instantly hitting the 10%
                            # daily cap. Combined with the auto-reset on every force signal, this made
                            # the risk manager completely non-functional.
                            #
                            # FIX: read the recommended stake from the persisted analysis_details
                            # (we now persist it there at signal build time). The value is a percentage
                            # (e.g. 10 means 10%); convert to a 0-1 fraction for record_trade_result.
                            monitor.record_result(s.id, is_win)
                            stake_pct = 0.0
                            if s.analysis_details and isinstance(s.analysis_details, dict):
                                stake_pct = s.analysis_details.get('recommended_stake_pct', 0) or 0
                            # Defensive: clamp to [0, 1] — never exceed 100% risk on a single trade.
                            stake_fraction = max(0.0, min(1.0, float(stake_pct) / 100.0)) if stake_pct else 0.0
                            risk_mgr.record_trade_result(is_win, stake_fraction)

                            logger.info(
                                f"🏁 SIGNAL RESOLVED: {s.id} ({s.pair}) -> "
                                f"{'WON' if is_win else 'LOST'} "
                                f"(Direction: {s.direction}, Entry: {s.entry_price}, "
                                f"Exit at expiry: {current_price}, Expiry: {expiry_time.isoformat()})"
                            )
                        else:
                            logger.warning(f"Cannot resolve {s.id}: No price for {s.pair}")
                
                await session.commit()
            
            await asyncio.sleep(10)
        except Exception as e:
            logger.error(f"Erreur boucle résolution: {e}")
            await asyncio.sleep(10)


async def daily_report_loop():
    """Daily report at 23:59 UTC + candle cleanup."""
    while True:
        now = datetime.now(timezone.utc)
        target = now.replace(hour=23, minute=59, second=0, microsecond=0)
        if now >= target:
            target = target + timedelta(days=1)
        wait_seconds = (target - now).total_seconds()
        await asyncio.sleep(wait_seconds)
        
        # Cleanup old candles (keep max 500 per pair)
        try:
            await cleanup_old_candles()
        except Exception:
            pass
        
        # Generate and send report
        try:
            report = monitor.generate_daily_report()
            await telegram_bot.send_signal(report)
            logger.info("[DAILY REPORT] Rapport journalier envoyé")
        except Exception as e:
            logger.error(f"[DAILY REPORT] Erreur lors de l'envoi du rapport journalier: {e}")


# ═══════════ LIFESPAN (replaces deprecated on_event) ═══════════

async def _load_candles_background():
    """Background task: load candles from DB without blocking startup/healthcheck."""
    await asyncio.sleep(5)  # Wait 5s for server to start first
    try:
        candles_map = await asyncio.wait_for(load_all_candles_from_db(), timeout=30.0)
        if candles_map:
            logger.info(f"[STARTUP] ✅ Loaded candles for {len(candles_map)} pairs from database — sniper engine ready")
        else:
            logger.info("[STARTUP] No cached candles in database — first connection needs tick aggregation warm-up")
    except asyncio.TimeoutError:
        logger.warning("[STARTUP] Candle loading timed out (30s) — continuing without cached candles")
    except Exception as e:
        logger.warning(f"[STARTUP] Could not load cached candles: {e} — continuing without cached candles")


async def _startup_background_tasks():
    """Run ALL heavy startup tasks in background (non-blocking).
    This includes init_db — the server starts before DB is ready."""
    await asyncio.sleep(5)  # Wait 5s for server to start
    
    # 0. Initialize database — retry up to 10 times with 10s delay
    # PostgreSQL may be in "recovery mode" after Railway redeploys
    for db_attempt in range(10):
        try:
            await asyncio.wait_for(init_db(), timeout=60.0)
            logger.info(f"[STARTUP] ✅ Database initialized (attempt {db_attempt+1}/10)")
            break
        except Exception as e:
            logger.warning(f"[STARTUP] DB init attempt {db_attempt+1}/10 failed: {e}")
            if db_attempt < 9:
                logger.info(f"[STARTUP] Waiting 10s before retry...")
                await asyncio.sleep(10)
            else:
                logger.error("[STARTUP] All 10 DB init attempts failed. Continuing without DB.")
    
    # 1. Load historical signals into monitoring
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(SignalRecord).order_by(SignalRecord.timestamp.asc()))
            historical_signals = result.scalars().all()
            for s in historical_signals:
                monitor.record_signal(s.id, s.pair, s.direction, s.winrate, is_win=s.is_win)
                monitor.signal_history[-1]['timestamp'] = s.timestamp.replace(tzinfo=timezone.utc) if s.timestamp.tzinfo is None else s.timestamp
        logger.info(f"[STARTUP] Loaded {len(historical_signals)} historical signals into monitoring.")
    except Exception as e:
        logger.warning(f"[STARTUP] Could not load historical signals: {e}")

    # 2. Auto-promote admin emails
    try:
        admin_emails = []
        admin_env = os.getenv("ADMIN_EMAIL", "").strip()
        if admin_env:
            admin_emails.extend([e.strip() for e in admin_env.split(",") if e.strip()])
        async with AsyncSessionLocal() as session:
            for admin_email in admin_emails:
                result = await session.execute(select(User).where(User.email == admin_email))
                owner = result.scalar_one_or_none()
                if owner:
                    if not owner.is_admin:
                        owner.is_admin = True
                        logger.info(f"[STARTUP] Promoted {admin_email} to admin")
                    sub_result = await session.execute(select(UserSubscription).where(UserSubscription.user_id == owner.id))
                    sub = sub_result.scalar_one_or_none()
                    if sub:
                        if sub.plan_name != "Pro":
                            sub.plan_name = "Pro"
                            sub.active_until = datetime.now(timezone.utc) + timedelta(days=3650)
                            logger.info(f"[STARTUP] Upgraded {admin_email} to Pro plan")
                    else:
                        new_sub = UserSubscription(user_id=owner.id, plan_name="Pro", active_until=datetime.now(timezone.utc) + timedelta(days=3650))
                        session.add(new_sub)
                    await session.commit()
    except Exception as e:
        logger.warning(f"[STARTUP] Could not auto-promote admin: {e}")

    # 3. Load cached candles
    await _load_candles_background()

    # 4. Migrate legacy last_ssid.txt → market_sessions table (one-time)
    #    Runs BEFORE auto_reconnect_scanner so the migrated SSID is available.
    await _migrate_legacy_ssid_file()

    # 5. Hydrate stateful modules from the app_state table (replaces
    #    compliance_hash_chain.json / risk_state.json / bot_state.json).
    #    Each module's _load_state() was a no-op at __init__ time (no async
    #    loop available); this is where they actually load from the DB.
    try:
        await compliance.hydrate_from_db()
        logger.info("[STARTUP] ✅ Compliance hash chain hydrated from DB")
    except Exception as e:
        logger.warning(f"[STARTUP] Could not hydrate compliance state: {e}")
    try:
        await risk_mgr.hydrate_from_db()
        logger.info("[STARTUP] ✅ Risk manager state hydrated from DB")
    except Exception as e:
        logger.warning(f"[STARTUP] Could not hydrate risk state: {e}")
    try:
        await telegram_bot.hydrate_from_db()
        logger.info("[STARTUP] ✅ Telegram bot state hydrated from DB")
    except Exception as e:
        logger.warning(f"[STARTUP] Could not hydrate telegram bot state: {e}")

    # 6. Auto-reconnect scanner using the most recently saved SSID
    #    (picks the latest from market_sessions, survives Railway redeploys)
    asyncio.create_task(auto_reconnect_scanner())


@asynccontextmanager
async def lifespan(app):
    # ═══ MINIMAL STARTUP — yield immediately, everything in background ═══
    # The server must respond to healthcheck within 300s. We don't run ANY
    # DB operations before yield — not even init_db. Everything runs in
    # background tasks after the server starts.
    logger.info("[STARTUP] Server starting (healthcheck ready)...")

    # Start ALL background tasks (non-blocking — server starts immediately)
    try:
        asyncio.create_task(_startup_background_tasks())
        asyncio.create_task(trading_loop())
        asyncio.create_task(resolution_loop())
        asyncio.create_task(telegram_bot.start_polling())
        asyncio.create_task(daily_report_loop())
    except Exception as e:
        logger.warning(f"[STARTUP] Background task creation issue: {e}")

    yield  # Server starts here — healthcheck passes immediately

    # Shutdown cleanup could go here


app = FastAPI(title="A2Sniper 3.0", version="3.0.0", lifespan=lifespan)

# Simple root health endpoint — always responds even if DB is down
@app.get("/")
async def root():
    return {"status": "ok", "service": "A2Sniper 3.0", "version": "3.0.0"}

@app.get("/health")
async def health():
    """Dedicated healthcheck endpoint — no DB, no scanner, no dependencies.
    Returns 200 immediately as long as the server is running."""
    return {"status": "healthy"}

_frontend_url = os.getenv("FRONTEND_URL", "")
_cors_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://a2sniper.vercel.app",
]
if _frontend_url:
    _cors_origins.append(_frontend_url)
# Allow Vercel and Railway domains dynamically
_vercel_url = os.getenv("VERCEL_URL", "")
if _vercel_url:
    _cors_origins.append(f"https://{_vercel_url}")
_railway_url = os.getenv("RAILWAY_PUBLIC_DOMAIN", "")
if _railway_url:
    _cors_origins.append(f"https://{_railway_url}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ═══════════════════════════════════════════════════════════════════
# CANDLE PERSISTENCE — Save/Load candles to PostgreSQL
# ═══════════════════════════════════════════════════════════════════
async def save_candles_to_db(pair: str, df: pd.DataFrame, timeframe: str = "1m"):
    """Save candles to the database using batch UPSERT (single query, no N+1).
    
    Uses PostgreSQL INSERT ... ON CONFLICT DO NOTHING for dedup.
    Only saves COMPLETED candles (excludes the last/incomplete candle).
    """
    if df is None or df.empty:
        return
    try:
        # Exclude the last candle (it's still forming — its close price changes every tick)
        if len(df) > 1:
            df_to_save = df.iloc[:-1]
        else:
            return
        
        if df_to_save.empty:
            return
        
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text
            # Batch UPSERT: insert all candles in ONE query, skip duplicates
            values = []
            params = {}
            for i, (_, row) in enumerate(df_to_save.iterrows()):
                ts = int(row.name.timestamp()) if hasattr(row.name, 'timestamp') else int(row.name)
                params[f"p{i}"] = pair
                params[f"t{i}"] = ts
                params[f"o{i}"] = float(row['open'])
                params[f"h{i}"] = float(row['high'])
                params[f"l{i}"] = float(row['low'])
                params[f"c{i}"] = float(row['close'])
                params[f"v{i}"] = float(row.get('volume', 0))
                values.append(f"(:p{i}, :t{i}, :o{i}, :h{i}, :l{i}, :c{i}, :v{i}, '{timeframe}')")
            
            sql = text(
                f"INSERT INTO candles (pair, timestamp, open, high, low, close, volume, timeframe) "
                f"VALUES {', '.join(values)} "
                f"ON CONFLICT (pair, timestamp) DO NOTHING"
            )
            result = await session.execute(sql, params)
            await session.commit()
            if result.rowcount > 0:
                logger.info(f"[CANDLE-DB] Saved {result.rowcount} new candles for {pair}")
    except Exception as e:
        logger.warning(f"[CANDLE-DB] Save error for {pair}: {e}")


async def load_candles_from_db(pair: str, timeframe: str = "1m", limit: int = 200) -> pd.DataFrame:
    """Load candles from the database for a given pair."""
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text
            result = await session.execute(
                text("SELECT timestamp, open, high, low, close, volume FROM candles "
                     "WHERE pair=:p AND timeframe=:tf ORDER BY timestamp DESC LIMIT :lim"),
                {"p": pair, "tf": timeframe, "lim": limit}
            )
            rows = result.fetchall()
            if not rows:
                return pd.DataFrame()
            # Reverse to chronological order (oldest first)
            rows = list(reversed(rows))
            df = pd.DataFrame(
                [(r[1], r[2], r[3], r[4], r[5]) for r in rows],
                columns=['open', 'high', 'low', 'close', 'volume'],
                index=pd.DatetimeIndex(
                    [pd.Timestamp(r[0], unit='s', tz='UTC') for r in rows],
                    name='time'
                )
            )
            logger.info(f"[CANDLE-DB] Loaded {len(df)} candles for {pair} from database")
            return df
    except Exception as e:
        logger.warning(f"[CANDLE-DB] Load error for {pair}: {e}")
        return pd.DataFrame()


async def load_all_candles_from_db() -> dict:
    """Load candles for ALL pairs from the database in a SINGLE query.
    Returns empty dict if table doesn't exist yet (first deploy)."""
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text
            # First check if the candles table exists (it might not on first deploy)
            table_check = await session.execute(
                text("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'candles')")
            )
            if not table_check.scalar():
                logger.info("[CANDLE-DB] candles table does not exist yet — skipping load")
                return {}
            # Get all pairs + their candles in ONE query using window function
            result = await session.execute(
                text("""
                    SELECT pair, timestamp, open, high, low, close, volume
                    FROM (
                        SELECT *, ROW_NUMBER() OVER (PARTITION BY pair ORDER BY timestamp DESC) as rn
                        FROM candles
                        WHERE timeframe = '1m'
                    ) sub
                    WHERE rn <= 200
                    ORDER BY pair, timestamp ASC
                """)
            )
            rows = result.fetchall()
            if not rows:
                logger.info("[CANDLE-DB] No candles in database — starting fresh")
                return {}
            
            # Group by pair
            from collections import defaultdict
            pair_data = defaultdict(list)
            for r in rows:
                pair_data[r[0]].append(r)
            
            candles_map = {}
            for pair, pair_rows in pair_data.items():
                df = pd.DataFrame(
                    [(r[2], r[3], r[4], r[5], r[6]) for r in pair_rows],
                    columns=['open', 'high', 'low', 'close', 'volume'],
                    index=pd.DatetimeIndex(
                        [pd.Timestamp(r[1], unit='s', tz='UTC') for r in pair_rows],
                        name='time'
                    )
                )
                candles_map[pair] = df
                # Also populate the scanner's cache so get_candles returns immediately
                cache_key = f"{pair}_1m"
                po_scanner._candles_cache[cache_key] = df
            
            logger.info(f"[CANDLE-DB] ✅ Loaded candles for {len(candles_map)} pairs from database (single query)")
            for pair, df in candles_map.items():
                logger.info(f"[CANDLE-DB]   {pair}: {len(df)} candles")
            return candles_map
    except Exception as e:
        logger.warning(f"[CANDLE-DB] Load all error: {e}")
        return {}


async def cleanup_old_candles():
    """Delete candles older than 500 per pair to prevent database bloat."""
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text
            await session.execute(
                text("""
                    DELETE FROM candles
                    WHERE id NOT IN (
                        SELECT id FROM (
                            SELECT id, ROW_NUMBER() OVER (PARTITION BY pair ORDER BY timestamp DESC) as rn
                            FROM candles WHERE timeframe = '1m'
                        ) sub
                        WHERE rn <= 500
                    )
                """)
            )
            await session.commit()
            logger.info("[CANDLE-DB] Old candles cleaned up (max 500 per pair)")
    except Exception as e:
        logger.warning(f"[CANDLE-DB] Cleanup error: {e}")



@app.post("/api/signals/request")
async def request_live_signal(request: Request, credentials: HTTPAuthorizationCredentials = Security(security), geo: dict = Depends(geographic_restriction_dependency)):
    """Génère un signal en direct à la demande pour une paire. Requires authentication."""
    # Log IMMEDIATELY at the start — before ANY checks
    logger.info("[SIGNAL-REQUEST-START] Endpoint hit, starting processing...")

    check_rate_limit(request)
    # Geographic restriction check
    if not geo['allowed']:
        logger.warning(f"[SIGNAL-REQUEST] Geographic restriction blocked: {geo['reason']}")
        raise HTTPException(status_code=403, detail=geo['reason'])

    # Verify auth
    payload = decode_access_token(credentials.credentials)
    # Check if token is revoked
    _jti = payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        logger.warning("[SIGNAL-REQUEST] Token revoked")
        raise HTTPException(status_code=401, detail="Token has been revoked")
    
    try:
        data = await request.json()
    except Exception:
        logger.warning("[SIGNAL-REQUEST] Invalid JSON body")
        raise HTTPException(status_code=400, detail="Invalid request body")
    
    pair = data.get("pair")
    if not pair:
        logger.warning("[SIGNAL-REQUEST] No pair provided in request")
        raise HTTPException(status_code=400, detail="Pair required")

    logger.info(f"[SIGNAL-REQUEST] pair={pair} — auth OK, checking scanner...")

    # Validate pair: must be ACTIVE on PO AND have payout >= 70%.
    if not po_scanner.is_connected:
        logger.warning(f"[SIGNAL-REQUEST] Scanner not connected for pair={pair}")
        raise HTTPException(
            status_code=400,
            detail="A2Sniper scanner is not connected to the live market. Please connect first."
        )

    # ═══ SCAN_ALL MODE — scan all pairs and return the best signal ═════════
    # When pair='SCAN_ALL', the user clicked "GET SIGNAL" which scans ALL
    # active pairs (30+) and returns the highest-scoring price action setup.
    # This is how professional systems work — always respond with a signal.
    if pair == 'SCAN_ALL':
        logger.info(f"[SIGNAL-REQUEST] SCAN_ALL mode — scanning all active pairs for best signal...")

        all_pairs = list(po_scanner.find_pairs_above_payout(
            min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
        ).keys())

        if not all_pairs:
            raise HTTPException(status_code=404, detail="No active pairs with payout >= 70% available right now.")

        # Filter out pairs that don't exist on PO (stale cache entries like IRR/USD)
        # by verifying each pair has a valid, current payout from the scanner
        valid_pairs = []
        for p in all_pairs:
            p_payout = po_scanner.get_payout(p)
            if p_payout is not None and p_payout >= 70:
                valid_pairs.append(p)
        all_pairs = valid_pairs

        logger.info(f"[SIGNAL-REQUEST] SCAN_ALL — scanning {len(all_pairs)} valid pairs (20s limit)...")

        best_signal = None
        best_score = 0
        scan_start = datetime.now(timezone.utc).timestamp()
        MAX_SCAN_SECONDS = 20  # Must finish well before Vercel's 30s proxy timeout

        for scan_pair in all_pairs:
            # Stop if overall time limit reached
            elapsed = datetime.now(timezone.utc).timestamp() - scan_start
            if elapsed > MAX_SCAN_SECONDS:
                logger.info(f"[SIGNAL-REQUEST] SCAN_ALL — {MAX_SCAN_SECONDS}s limit reached, returning best so far (scanned {elapsed:.1f}s)")
                break
            if not po_scanner.is_connected:
                break
            try:
                scan_signal = await asyncio.wait_for(force_analyze_pair(scan_pair), timeout=2.0)
                if scan_signal and scan_signal.get('score', 0) > best_score:
                    best_signal = scan_signal
                    best_score = scan_signal.get('score', 0)
                    logger.info(f"[SIGNAL-REQUEST] SCAN_ALL — found signal on {scan_pair} (score={best_score})")
            except Exception:
                pass
            await asyncio.sleep(0)  # Yield to event loop

        if best_signal:
            # Update the timestamp to NOW so the countdown starts from when
            # the user RECEIVES the signal, not from when it was found during
            # the scan. Without this, the signal could arrive already expired
            # because the scan took 1-3 minutes to check all 30+ pairs.
            fresh_ts = datetime.now(timezone.utc)
            best_signal['timestamp'] = fresh_ts.isoformat()
            best_signal['time'] = fresh_ts.strftime('%H:%M:%S')

            # Refresh the payout from the scanner's LATEST data — PO updates
            # payouts dynamically and the cached value from when the scan
            # started may be stale (e.g., bot shows 82% but PO UI shows 90%).
            fresh_payout = po_scanner.get_payout(best_signal.get('pair', ''))
            if fresh_payout and fresh_payout > 0:
                best_signal['payout'] = fresh_payout
                logger.info(f"[SIGNAL-REQUEST] SCAN_ALL — payout refreshed: {best_signal.get('pair')} = {fresh_payout}%")

            logger.info(f"[SIGNAL-REQUEST] SCAN_ALL — returning best signal: {best_signal.get('pair')} (score={best_score}), timestamp={fresh_ts.strftime('%H:%M:%S')}, payout={best_signal.get('payout')}%")
            return {"status": "success", "signal": best_signal, "mode": best_signal.get('mode', 'price_action')}

        logger.info(f"[SIGNAL-REQUEST] SCAN_ALL — no signal found on any of {len(all_pairs)} pairs")
        raise HTTPException(
            status_code=404,
            detail="No signal opportunity found right now. Try again in 1-2 minutes."
        )

    real_payout = po_scanner.get_payout(pair)
    logger.info(f"[SIGNAL-REQUEST] pair={pair} payout={real_payout} — payout lookup result")

    if real_payout is None:
        logger.warning(f"[SIGNAL-REQUEST] Payout is None for pair={pair} — pair not found or inactive")
        raise HTTPException(
            status_code=400,
            detail=(
                f"Pair not available on Pocket Option: {pair}. "
                f"The pair is either inactive (greyed out on PO) or does not exist. "
                f"Use /api/market/status to see the list of currently active pairs "
                f"with payout >= 70%."
            )
        )

    if real_payout < 70:
        logger.warning(f"[SIGNAL-REQUEST] Payout too low for pair={pair}: {real_payout}% < 70%")
        raise HTTPException(
            status_code=400,
            detail=(
                f"Pair {pair} has a payout of {real_payout:.0f}% (< 70%). "
                f"The system only considers pairs with payout >= 70%. "
                f"Try again later when PO increases this pair's payout."
            )
        )

    # ═══ PRICE ACTION ENGINE — Single Pair (user selected this pair) ═══
    # The user explicitly selected this pair and clicked "Request Signal".
    # We analyze THIS pair with the price action engine.
    # NO FALLBACKS — if no setup found, honestly return "No signal".
    logger.info(f"[SIGNAL-REQUEST] pair={pair} payout={real_payout}% — running price action engine")
    try:
        signal = await asyncio.wait_for(force_analyze_pair(pair), timeout=30.0)
    except asyncio.TimeoutError:
        logger.warning(f"[SIGNAL-REQUEST] Engine timed out (30s) for {pair}")
        raise HTTPException(
            status_code=404,
            detail=f"Signal analysis timed out for {pair}. Please try again in 5-10 seconds."
        )
    except Exception as e:
        logger.error(f"[SIGNAL-REQUEST] Error analyzing {pair}: {e}", exc_info=True)
        raise HTTPException(
            status_code=404,
            detail=f"Could not analyze {pair} right now. Please try another pair."
        )

    if signal:
        logger.info(f"[SIGNAL-REQUEST] Signal generated for {pair} (mode={signal.get('mode','?')}, winrate={signal.get('winrate','?')}%)")
        return {"status": "success", "signal": signal, "mode": signal.get('mode', 'price_action')}

    # ═══ MULTI-PAIR SCAN — professional behavior ═══════════════════════
    # If the requested pair has no setup, scan ALL other pairs to find the
    # BEST available setup. Professional systems always respond with a
    # signal — they don't say "No signal" for hours.
    logger.info(f"[SIGNAL-REQUEST] No setup on {pair} — scanning ALL pairs for best available signal...")

    all_pairs = list(po_scanner.find_pairs_above_payout(
        min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
    ).keys())

    # Remove the already-tried pair
    if pair in all_pairs:
        all_pairs.remove(pair)

    best_signal = None
    best_score = 0

    for alt_pair in all_pairs:
        if not po_scanner.is_connected:
            break
        alt_payout = po_scanner.get_payout(alt_pair)
        if alt_payout is None or alt_payout < 70:
            continue
        try:
            alt_signal = await asyncio.wait_for(force_analyze_pair(alt_pair), timeout=10.0)
            if alt_signal and alt_signal.get('score', 0) > best_score:
                best_signal = alt_signal
                best_score = alt_signal.get('score', 0)
                logger.info(f"[SIGNAL-REQUEST] Found better signal on {alt_pair} (score={best_score})")
        except Exception:
            pass  # Try next pair
        await asyncio.sleep(0)  # Yield to event loop

    if best_signal:
        logger.info(f"[SIGNAL-REQUEST] Returning best signal from multi-pair scan: {best_signal.get('pair')} (score={best_score})")
        return {"status": "success", "signal": best_signal, "mode": best_signal.get('mode', 'price_action')}

    # ═══ TRULY no signal on ANY pair ═══════════════════════════════════
    logger.info(f"[SIGNAL-REQUEST] No signal on ANY pair — all 30+ pairs scanned, no pattern + bonus found")
    raise HTTPException(
        status_code=404,
        detail=(
            f"No signal for {pair} right now. "
            f"Try another pair or wait 1-2 minutes for better market conditions."
        )
    )


@app.get("/api/signals")
async def get_signals(
    pair: str = None,
    limit: int = 200,
    offset: int = 0,
    since: float = None,
    credentials: HTTPAuthorizationCredentials = Security(security),
):
    # Validate token type and check revocation
    payload = decode_access_token(credentials.credentials)
    _jti = payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    # Validate and clamp — allow up to 2000 for full history browsing
    limit = max(1, min(limit, 2000))
    offset = max(0, offset)

    # `since` is a unix timestamp (seconds) used to filter signals by timestamp.
    # When the user clicks "Reset" on the signals page, the frontend persists
    # the reset timestamp in localStorage and sends it here on every poll so
    # the SQL COUNT queries (total/won/lost/active) reflect ONLY signals
    # emitted AFTER the reset. This is what makes the stat cards accurate
    # past the 100-row API limit — the backend counts ALL matching rows
    # in the database, not just the slice returned for the cards list.
    since_dt = None
    if since is not None and since > 0:
        try:
            since_dt = datetime.fromtimestamp(float(since), tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            since_dt = None  # Invalid timestamp — ignore the filter

    # Build the output list — try DB first, fall back to in-memory deque
    output = []
    now = datetime.now(timezone.utc)

    # Aggregate counts — computed via SQL COUNT (single fast query, no row loading)
    # so the frontend stats card is accurate regardless of the `limit` pagination.
    total_in_db = 0
    active_count = 0
    won_count = 0
    lost_count = 0

    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import func as sql_func
            count_query = select(
                sql_func.count(SignalRecord.id).label('total'),
                sql_func.count(SignalRecord.id).filter(SignalRecord.is_win == True).label('won'),
                sql_func.count(SignalRecord.id).filter(SignalRecord.is_win == False).label('lost'),
            )
            if pair:
                count_query = count_query.where(SignalRecord.pair == pair)
            # Apply `since` filter so the COUNT reflects only signals after
            # the user's last reset (the user clicked "Reset" — they want
            # stats only for signals emitted AFTER that point). Without this,
            # the COUNT would include pre-reset signals and ignore the user's
            # intent to start counting fresh.
            if since_dt is not None:
                count_query = count_query.where(SignalRecord.timestamp >= since_dt)
            count_result = await session.execute(count_query)
            count_row = count_result.one()
            total_in_db = count_row.total or 0
            won_count = count_row.won or 0
            lost_count = count_row.lost or 0
            # "Active" = unresolved (is_win IS NULL) AND not yet expired.
            # We count this in SQL: unresolved signals whose timestamp is within
            # the max expiration window (3 minutes = 180s) from now.
            active_cutoff = now - timedelta(seconds=200)  # 200s covers 3m expirations + buffer
            active_query = select(sql_func.count(SignalRecord.id)).where(
                SignalRecord.is_win == None,
                SignalRecord.timestamp >= active_cutoff
            )
            if pair:
                active_query = active_query.where(SignalRecord.pair == pair)
            # Active count is always relative to "now" — never filtered by `since`
            # because an active signal is by definition recent (within ~3 min).
            active_result = await session.execute(active_query)
            active_count = active_result.scalar() or 0

            # Get the limited set for display (most recent first, with offset for pagination)
            query = select(SignalRecord).order_by(SignalRecord.timestamp.desc()).offset(offset).limit(limit)
            if pair:
                query = query.where(SignalRecord.pair == pair)
            # Apply the same `since` filter to the LIST query so the cards
            # shown on the signals page also respect the reset.
            if since_dt is not None:
                query = query.where(SignalRecord.timestamp >= since_dt)
            result = await session.execute(query)
            signals = result.scalars().all()

            for s in signals:
                # Calculate signal status (ACTIVE / EXPIRED / WON / LOST)
                sig_time = s.timestamp
                if sig_time and sig_time.tzinfo is None:
                    sig_time = sig_time.replace(tzinfo=timezone.utc)
                expiration_seconds = (s.expiration or 1) * 60
                age_seconds = (now - sig_time).total_seconds() if sig_time else 999

                if s.is_win is True:
                    status = "WON"
                elif s.is_win is False:
                    status = "LOST"
                elif age_seconds < expiration_seconds:
                    status = "ACTIVE"
                else:
                    status = "EXPIRED"

                # Use the engine-reported winrate directly. If missing/0/None,
                # display as null so the user knows the engine did not score it
                # (previously this defaulted to 70, which masked engine failures
                # and made it impossible to know the real win rate).
                sig_winrate = s.winrate if s.winrate and s.winrate > 0 else None

                # Extract analysis fields from analysis_details JSON if available
                details = s.analysis_details or {}
                d = {
                    "id": s.id,
                    "pair": s.pair,
                    "direction": s.direction,
                    "entry_price": float(s.entry_price) if s.entry_price else 0,
                    "expiration": s.expiration,
                    "winrate": sig_winrate,
                    "score": getattr(s, 'score', None) or details.get('score', 4),
                    "payout": s.payout,
                    "classification": s.classification or 'SIGNAL',
                    "timestamp": s.timestamp.isoformat() if s.timestamp else None,
                    "is_win": s.is_win,
                    "status": status,
                    "hash_signature": s.hash_signature,
                    "session_id": getattr(s, 'session_id', None),
                    # Analysis fields — stored in analysis_details JSON, not separate columns
                    "smc_structure": details.get('smc_structure', 'Price Action'),
                    "smc_zone": details.get('smc_zone', 'N/A'),
                    "chart_pattern": details.get('chart_pattern', 'Momentum'),
                    "fibonacci": details.get('fibonacci', 'N/A'),
                    "rsi_status": details.get('rsi_status', 'N/A'),
                }
                output.append(d)

        # DB is the single source of truth. No in-memory fallback — the
        # generated_signals deque is only for the trading_loop's internal
        # candidate selection, NOT for serving API responses. Previously,
        # when the DB was empty (after admin wipe), the API fell back to
        # the in-memory deque which still had old signals — causing wiped
        # stats to reappear within seconds.

        return {
            "signals": output,
            "total": total_in_db,
            "active_count": active_count,
            "won_count": won_count,
            "lost_count": lost_count,
            "live_status": "LIVE" if po_scanner.is_connected else "DISCONNECTED"
        }

    except Exception as db_err:
        logger.warning(f"[SIGNALS-API] DB query failed: {db_err}")
        # Return empty — do NOT fall back to in-memory deque (causes stale data)
        return {
            "signals": [],
            "total": 0,
            "active_count": 0,
            "won_count": 0,
            "lost_count": 0,
            "live_status": "LIVE" if po_scanner.is_connected else "DISCONNECTED"
        }


@app.delete("/api/admin/signals/{signal_id}")
async def delete_signal(signal_id: str, admin_payload = Depends(require_admin)):
    async with AsyncSessionLocal() as session:
        from sqlalchemy import delete
        await session.execute(delete(SignalRecord).where(SignalRecord.id == signal_id))
        await session.commit()
    return {"status": "success"}


@app.delete("/api/admin/signals")
async def delete_all_signals(admin_payload = Depends(require_admin)):
    """Bulk delete ALL signals from the database.

    Uses raw SQL DELETE (not TRUNCATE) because Supabase's PgBouncer
    connection pooler (transaction mode) doesn't support TRUNCATE or
    ALTER SEQUENCE. DELETE works with PgBouncer.

    To handle the PgBouncer visibility issue (DELETE on connection A
    not visible to SELECT on connection B), we verify the delete on the
    SAME session before returning.
    """
    signal_count = 0
    candle_count = 0

    # Single session — count, delete, verify all on the same connection
    async with AsyncSessionLocal() as session:
        from sqlalchemy import text as sql_text

        # Roll back any aborted transaction state on this pooled connection.
        # Supabase's PgBouncer reuses connections — if a previous request
        # left the connection in an aborted state (e.g. from the
        # notification_sound column error), this session inherits that
        # state and ALL queries fail with InFailedSQLTransactionError.
        try:
            await session.rollback()
        except Exception:
            pass

        # Count first (for the response)
        try:
            count_result = await session.execute(sql_text("SELECT COUNT(*) FROM signals"))
            signal_count = count_result.scalar() or 0
        except Exception as count_err:
            logger.warning(f"[ADMIN] Count failed (trying rollback+retry): {count_err}")
            await session.rollback()
            try:
                count_result = await session.execute(sql_text("SELECT COUNT(*) FROM signals"))
                signal_count = count_result.scalar() or 0
            except Exception:
                signal_count = -1  # unknown

        # DELETE all signals (works with PgBouncer, unlike TRUNCATE)
        try:
            await session.execute(sql_text("DELETE FROM signals"))
            await session.commit()
            logger.info(f"[ADMIN] DELETE'd {signal_count} signals")
        except Exception as del_err:
            logger.warning(f"[ADMIN] DELETE failed (trying rollback+retry): {del_err}")
            await session.rollback()
            try:
                await session.execute(sql_text("DELETE FROM signals"))
                await session.commit()
                logger.info(f"[ADMIN] DELETE'd signals (retry succeeded)")
            except Exception as del_err2:
                logger.error(f"[ADMIN] DELETE retry also failed: {del_err2}")
                raise HTTPException(status_code=500, detail=f"Failed to wipe signals: {str(del_err2)[:200]}")

        # Also delete candles
        try:
            candle_count_result = await session.execute(sql_text("SELECT COUNT(*) FROM candles"))
            candle_count = candle_count_result.scalar() or 0
            if candle_count > 0:
                await session.execute(sql_text("DELETE FROM candles"))
                await session.commit()
                logger.info(f"[ADMIN] DELETE'd {candle_count} candles")
        except Exception as ce:
            logger.warning(f"[ADMIN] Could not wipe candles: {ce}")

        # Verify on the SAME session (bypasses PgBouncer visibility issue)
        verify_result = await session.execute(sql_text("SELECT COUNT(*) FROM signals"))
        remaining = verify_result.scalar() or 0
        logger.info(f"[ADMIN] Post-wipe verification (same session): {remaining} signals remaining")

    # Clear in-memory deque too
    generated_signals.clear()
    # Reset session trade counter so new emissions start at session 1
    _session_state["trade_count"] = 0
    _session_state["current_id"] = f"SES-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
    # Reset emission gate so next signal emits immediately
    _emission_gate["last_emission_ts"] = 0.0
    logger.info(f"[ADMIN] Full reset: deleted {signal_count} signals + {candle_count} candle records, {remaining} remaining")
    return {"status": "success", "deleted_signals": signal_count, "deleted_candles": candle_count, "remaining": remaining}


@app.get("/api/admin/logs")
async def admin_get_logs(limit: int = 100, level: str = None, admin_payload = Depends(require_admin)):
    """Retourne les entrées de log système récentes (CDC Section 11.4)."""
    async with AsyncSessionLocal() as session:
        query = select(SystemLog).order_by(SystemLog.timestamp.desc()).limit(limit)
        if level:
            query = query.where(SystemLog.level == level.upper())
        result = await session.execute(query)
        logs = result.scalars().all()
        return {"logs": [
            {
                "id": l.id,
                "timestamp": l.timestamp.isoformat() if l.timestamp else None,
                "level": l.level,
                "module": l.module,
                "message": l.message
            }
            for l in logs
        ]}


# ═══════════ SYSTEM CONFIG ═══════════
_system_config = {
    "maintenance_mode": False,
    "public_signal_feed": True,
    "admin_ip_whitelist": "127.0.0.1",
    "max_drawdown_pct": 10,
    "api_rate_limit": 2000,
    "twofa_enabled": False,
}


@app.get("/api/admin/config")
async def admin_get_config(admin_payload = Depends(require_admin)):
    """Retourne la configuration système actuelle."""
    return {"config": _system_config}


@app.post("/api/admin/config")
async def admin_update_config(request: Request, admin_payload = Depends(require_admin)):
    """Met à jour la configuration système."""
    global _system_config
    ALLOWED_CONFIG_KEYS = {"maintenance_mode", "public_signal_feed", "max_drawdown_pct", "api_rate_limit", "twofa_enabled", "circuit_breaker_active"}
    data = await request.json()
    for key in data:
        if key not in ALLOWED_CONFIG_KEYS:
            raise HTTPException(status_code=400, detail=f"Invalid config key: {key}")
    _system_config.update(data)
    return {"status": "success", "config": _system_config}


# ═══════════ AUTH ENDPOINTS ═══════════

@app.post("/api/auth/register-send-otp")
async def register_send_otp(request: Request):
    """Step 1: Validate registration data and send OTP to verify email ownership."""
    check_rate_limit(request, max_requests=5, window_seconds=60)  # Strict: 5/min for registration
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")
    email = data.get("email")
    password = data.get("password")
    full_name = data.get("name")

    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password required")

    # Validate email format
    if not validate_email(email):
        raise HTTPException(status_code=400, detail="Invalid email format")

    from auth import validate_password_strength, MIN_PASSWORD_LENGTH
    if not validate_password_strength(password):
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters with 1 uppercase, 1 digit, and 1 special character")

    # Generate 6-digit OTP for email verification
    otp_code = str(secrets.randbelow(900000) + 100000)

    try:
        async with AsyncSessionLocal() as session:
            # Delete any existing registration OTPs for this email
            await session.execute(
                __import__('sqlalchemy').text(
                    "DELETE FROM password_reset_otps WHERE email = :email AND purpose = 'registration'"
                ),
                {"email": email}
            )

            # Store the OTP with purpose='registration'
            new_otp = PasswordResetOTP(
                id=str(uuid.uuid4()),
                email=email,
                otp_code=otp_code,
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
                created_at=datetime.now(timezone.utc),
                purpose="registration"
            )
            session.add(new_otp)
            await session.commit()
    except Exception as db_err:
        logger.exception(f"[Register] DB error during OTP storage for {email}: {db_err}")
        raise HTTPException(status_code=500, detail=f"Database error: {str(db_err)}")

    # Send verification email
    try:
        email_sent = await send_otp_email(email, otp_code, purpose="registration")
    except Exception as email_err:
        logger.exception(f"[Register] send_otp_email failed for {email}: {email_err}")
        email_sent = False

    if not email_sent:
        # SECURITY: do NOT log the OTP value — Railway logs are accessible to
        # anyone with dashboard access, and a leaked OTP enables account takeover.
        # The OTP remains stored in the password_reset_otps table; the user must
        # fix their RESEND_API_KEY config and retry registration.
        logger.error(f"[Register] OTP email delivery FAILED for {email[:3]}*** — Resend API misconfigured or down. OTP NOT logged.")
    else:
        logger.info(f"[Register] Verification OTP sent to {email[:3]}***")

    return {"status": "success", "message": "Verification code sent to your email."}


@app.post("/api/auth/register-verify-otp")
async def register_verify_otp(request: Request):
    """Step 2: Verify the OTP and create the account."""
    check_rate_limit(request, max_requests=5, window_seconds=60)  # Strict: 5/min for OTP verify
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")
    email = data.get("email")
    password = data.get("password")
    full_name = data.get("name")
    otp_code = data.get("otp_code")

    if not email or not password or not otp_code:
        raise HTTPException(status_code=400, detail="Email, password, and OTP code required")

    # Check OTP brute-force protection
    check_otp_bruteforce(email)

    # Verify OTP
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(PasswordResetOTP).where(
                PasswordResetOTP.email == email,
                PasswordResetOTP.otp_code == otp_code,
                PasswordResetOTP.purpose == "registration"
            )
        )
        otp_record = result.scalar_one_or_none()

        if not otp_record:
            record_otp_attempt(email, success=False)
            raise HTTPException(status_code=400, detail="Invalid or expired verification code")

        if otp_record.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
            # Delete expired OTP
            await session.delete(otp_record)
            await session.commit()
            record_otp_attempt(email, success=False)
            raise HTTPException(status_code=400, detail="Verification code has expired. Please request a new one.")

        # OTP is valid — delete it and record success
        await session.delete(otp_record)
        await session.flush()
        record_otp_attempt(email, success=True)

        # Now create the account
        # Check if user exists and clean up
        result = await session.execute(select(User).where(User.email == email))
        existing_user = result.scalar_one_or_none()
        if existing_user:
            auth_provider = getattr(existing_user, 'auth_provider', None) or 'unknown'
            logger.info(f"[Register] Re-registering email {email}: cleaning up old account (auth_provider={auth_provider})")

            await session.execute(
                __import__('sqlalchemy').text("DELETE FROM subscriptions WHERE user_id = :uid"),
                {"uid": existing_user.id}
            )
            await session.execute(
                __import__('sqlalchemy').text("DELETE FROM password_reset_otps WHERE email = :email"),
                {"email": email}
            )
            await session.execute(
                __import__('sqlalchemy').text("DELETE FROM users WHERE id = :uid"),
                {"uid": existing_user.id}
            )
            await session.flush()

        user_id = str(uuid.uuid4())
        new_user = User(
            id=user_id,
            email=email,
            hashed_password=get_password_hash(password),
            full_name=full_name,
            created_at=datetime.now(timezone.utc)
        )
        session.add(new_user)

        sub = UserSubscription(
            user_id=user_id,
            plan_name="Standard",
            active_until=datetime.now(timezone.utc) + timedelta(days=7)
        )
        session.add(sub)

        await session.commit()

    logger.info(f"[Register] Account created successfully for {email[:3]}***")
    return {"status": "success", "message": "Account created successfully"}


@app.post("/api/auth/register")
async def register(request: Request):
    """Legacy direct registration (no OTP). Kept for backward compatibility."""
    check_rate_limit(request, max_requests=5, window_seconds=60)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")
    email = data.get("email")
    password = data.get("password")
    full_name = data.get("name")

    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password required")

    from auth import validate_password_strength, MIN_PASSWORD_LENGTH
    if not validate_password_strength(password):
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters with 1 uppercase, 1 digit, and 1 special character")

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(User).where(User.email == email))
            existing_user = result.scalar_one_or_none()
            if existing_user:
                auth_provider = getattr(existing_user, 'auth_provider', None) or 'unknown'
                logger.info(f"[Register] Re-registering email {email}: cleaning up old account (auth_provider={auth_provider}, is_active={existing_user.is_active})")
                await session.execute(
                    __import__('sqlalchemy').text("DELETE FROM subscriptions WHERE user_id = :uid"),
                    {"uid": existing_user.id}
                )
                await session.execute(
                    __import__('sqlalchemy').text("DELETE FROM password_reset_otps WHERE email = :email"),
                    {"email": email}
                )
                await session.execute(
                    __import__('sqlalchemy').text("DELETE FROM users WHERE id = :uid"),
                    {"uid": existing_user.id}
                )
                await session.flush()

            user_id = str(uuid.uuid4())
            new_user = User(
                id=user_id,
                email=email,
                hashed_password=get_password_hash(password),
                full_name=full_name,
                created_at=datetime.now(timezone.utc)
            )
            session.add(new_user)

            sub = UserSubscription(
                user_id=user_id,
                plan_name="Standard",
                active_until=datetime.now(timezone.utc) + timedelta(days=7)
            )
            session.add(sub)

            await session.commit()
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"[Register] Error creating account: {type(e).__name__}: {e}")
        logger.error(f"[Register] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="An error occurred while creating your account. Please try again.")

    return {"status": "success", "message": "Account created successfully"}

@app.post("/api/auth/login")
async def login(request: Request):
    check_rate_limit(request, max_requests=10, window_seconds=60)  # Strict: 10/min for login
    data = await request.json()
    email = data.get("email")
    password = data.get("password")
    
    async with AsyncSessionLocal() as session:
        user = await _safe_fetch_user(session, by_email=email)

        if not user or not verify_password(password, user.hashed_password):
            raise HTTPException(status_code=401, detail="Invalid email or password")

        # Auto-promote admin emails to admin + Pro plan (same as Google OAuth)
        admin_emails = []
        admin_env = os.getenv("ADMIN_EMAIL", "").strip()
        if admin_env:
            admin_emails.extend([e.strip() for e in admin_env.split(",") if e.strip()])
        if user.email in admin_emails:
            promoted = False
            if not user.is_admin:
                user.is_admin = True
                promoted = True
            sub_result = await session.execute(
                select(UserSubscription).where(UserSubscription.user_id == user.id)
            )
            subscription = sub_result.scalar_one_or_none()
            if subscription and subscription.plan_name != "Pro":
                subscription.plan_name = "Pro"
                subscription.active_until = datetime.now(timezone.utc) + timedelta(days=3650)
                promoted = True
            elif not subscription:
                subscription = UserSubscription(
                    user_id=user.id,
                    plan_name="Pro",
                    active_until=datetime.now(timezone.utc) + timedelta(days=3650)
                )
                session.add(subscription)
                promoted = True
            if promoted:
                await session.commit()
                # Refresh user after commit (use safe fetch — column may be missing)
                user = await _safe_fetch_user(session, by_id=user.id)
                sub_result = await session.execute(
                    select(UserSubscription).where(UserSubscription.user_id == user.id)
                )
                subscription = sub_result.scalar_one_or_none()
                logger.info(f"[LOGIN] Auto-promoted {email} to admin + Pro plan")

        access_token = create_access_token({"sub": user.id, "email": user.email})
        refresh_token = create_refresh_token({"sub": user.id, "email": user.email})

        # Store refresh token in DB
        await store_refresh_token(user.id, refresh_token, request)

        # Get subscription info for the response
        # Use a fresh session in case the original session was rolled back
        # by _safe_fetch_user (when the notification_sound column was missing).
        try:
            sub_result = await session.execute(
                select(UserSubscription).where(UserSubscription.user_id == user.id)
            )
            subscription = sub_result.scalar_one_or_none()
        except Exception:
            # Session may be in aborted state — use a fresh session
            async with AsyncSessionLocal() as fresh_session:
                sub_result = await fresh_session.execute(
                    select(UserSubscription).where(UserSubscription.user_id == user.id)
                )
                subscription = sub_result.scalar_one_or_none()

        return {
            "status": "success",
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,  # seconds
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.full_name,
                "is_admin": user.is_admin,
                "plan": subscription.plan_name if subscription else "Free",
                "auth_provider": getattr(user, 'auth_provider', 'email') or 'email',
                "avatar": getattr(user, 'avatar', None)
            }
        }

@app.post("/api/auth/upload-avatar")
async def upload_avatar(request: Request, credentials: HTTPAuthorizationCredentials = Security(security)):
    """Upload a profile picture (avatar) for the authenticated user.
    Stores the image as base64 in the users.avatar column."""
    payload = decode_access_token(credentials.credentials)
    _jti = payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        form = await request.form()
        file = form.get("avatar")
        if not file or not hasattr(file, 'read'):
            raise HTTPException(status_code=400, detail="No file uploaded")

        contents = await file.read()
        if len(contents) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="Image too large (max 5MB)")

        import base64
        import asyncio
        # Determine mime type
        content_type = getattr(file, 'content_type', 'image/jpeg') or 'image/jpeg'
        if content_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif'):
            content_type = 'image/jpeg'
        # Encode as base64 data URL — run sync base64 encode in a thread to avoid
        # blocking the asyncio event loop for ~50-100ms on a 5MB image.
        b64_bytes = await asyncio.to_thread(base64.b64encode, contents)
        b64 = b64_bytes.decode('utf-8')
        avatar_data_url = f"data:{content_type};base64,{b64}"

        # Save to database
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if not user:
                raise HTTPException(status_code=404, detail="User not found")
            user.avatar = avatar_data_url
            await session.commit()

        logger.info(f"[UPLOAD-AVATAR] Success for user {user_id}: {len(contents)} bytes -> {len(avatar_data_url)} chars")
        return {"status": "success", "avatar_url": avatar_data_url}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[UPLOAD-AVATAR] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to upload avatar: {str(e)}")


@app.delete("/api/auth/avatar")
async def delete_avatar(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Delete the authenticated user's profile picture.
    Sets users.avatar to NULL in the database."""
    payload = decode_access_token(credentials.credentials)
    _jti = payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if not user:
                raise HTTPException(status_code=404, detail="User not found")
            # No-op if already null — idempotent delete
            previous_avatar = user.avatar
            user.avatar = None
            await session.commit()

        logger.info(f"[DELETE-AVATAR] Success for user {user_id} (had avatar: {bool(previous_avatar)})")
        return {"status": "success", "avatar": None}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[DELETE-AVATAR] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete avatar: {str(e)}")


# ═══════════ NOTIFICATION SETTINGS + PUSH SUBSCRIPTION ═══════════

@app.get("/api/notifications/vapid-public-key")
async def get_vapid_public_key():
    """Return the VAPID public key so the frontend can subscribe to push notifications."""
    return {"public_key": VAPID_PUBLIC_KEY}


@app.post("/api/notifications/subscribe")
async def subscribe_to_push(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security)
):
    """Save a web push subscription for the authenticated user.
    Called by the frontend after the user grants notification permission
    and the browser generates a push subscription."""
    payload = decode_access_token(credentials.credentials)
    _jti = payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    endpoint = data.get("endpoint")
    keys = data.get("keys", {})
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")

    if not endpoint or not p256dh or not auth:
        raise HTTPException(status_code=400, detail="Missing endpoint, p256dh, or auth keys")

    # Check if this subscription already exists (dedup by endpoint)
    async with AsyncSessionLocal() as session:
        existing = await session.execute(
            select(PushSubscription).where(
                PushSubscription.endpoint == endpoint
            )
        )
        existing_sub = existing.scalar_one_or_none()

        if existing_sub:
            # Update the user_id in case the subscription moved to a different user
            existing_sub.user_id = user_id
            existing_sub.p256dh_key = p256dh
            existing_sub.auth_key = auth
            await session.commit()
            logger.info(f"[PUSH-SUB] Updated existing subscription for user {user_id}")
            return {"status": "success", "message": "Subscription updated"}
        else:
            # Create new subscription
            new_sub = PushSubscription(
                user_id=user_id,
                endpoint=endpoint,
                p256dh_key=p256dh,
                auth_key=auth,
            )
            session.add(new_sub)
            await session.commit()
            logger.info(f"[PUSH-SUB] New subscription saved for user {user_id}")
            return {"status": "success", "message": "Subscription created"}


@app.post("/api/notifications/unsubscribe")
async def unsubscribe_from_push(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security)
):
    """Remove a web push subscription (user disabled notifications)."""
    payload = decode_access_token(credentials.credentials)
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    endpoint = data.get("endpoint")
    if not endpoint:
        raise HTTPException(status_code=400, detail="Missing endpoint")

    from sqlalchemy import delete as sql_delete
    async with AsyncSessionLocal() as session:
        await session.execute(
            sql_delete(PushSubscription).where(
                PushSubscription.endpoint == endpoint,
                PushSubscription.user_id == user_id,
            )
        )
        await session.commit()
    logger.info(f"[PUSH-SUB] Removed subscription for user {user_id}")
    return {"status": "success"}


@app.post("/api/notifications/sound")
async def set_notification_sound(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Security(security)
):
    """Save the user's preferred notification sound.
    Sound options: bell, chime, alert, coin, digital
    """
    payload = decode_access_token(credentials.credentials)
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    sound = data.get("sound")
    valid_sounds = ["bell", "chime", "alert", "coin", "digital", "none"]
    if sound not in valid_sounds:
        raise HTTPException(status_code=400, detail=f"Invalid sound. Must be one of: {valid_sounds}")

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        user.notification_sound = sound
        await session.commit()

    logger.info(f"[NOTIFICATION-SOUND] User {user_id} set sound to '{sound}'")
    return {"status": "success", "sound": sound}


@app.post("/api/auth/google")
async def auth_google(request: Request):
    data = await request.json()
    access_token = data.get("access_token")
    code = data.get("code")
    redirect_uri = data.get("redirect_uri")
    
    # Support both: access_token (implicit flow) or code (authorization code flow)
    if code and redirect_uri:
        # Exchange authorization code for access token
        google_client_id = os.getenv("GOOGLE_CLIENT_ID", "")
        google_client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "")
        
        if not google_client_id or not google_client_secret:
            logger.error(f"[Google Auth] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET. ID set: {bool(google_client_id)}, Secret set: {bool(google_client_secret)}")
            raise HTTPException(status_code=500, detail="Google OAuth is not configured on the server. Please contact support.")
        
        import httpx
        try:
            async with httpx.AsyncClient() as client:
                token_resp = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data={
                        "code": code,
                        "client_id": google_client_id,
                        "client_secret": google_client_secret,
                        "redirect_uri": redirect_uri,
                        "grant_type": "authorization_code",
                    }
                )
                token_resp.raise_for_status()
                token_data = token_resp.json()
                access_token = token_data.get("access_token")
                if not access_token:
                    raise HTTPException(status_code=400, detail="Failed to obtain Google access token")
        except httpx.HTTPStatusError as e:
            error_detail = e.response.text
            logger.error(f"Google Code Exchange Error: {error_detail}")
            # Provide more specific error messages
            try:
                error_json = e.response.json()
                error_msg = error_json.get("error_description", error_json.get("error", ""))
                if "redirect_uri_mismatch" in error_detail:
                    raise HTTPException(status_code=400, detail="Google OAuth redirect URI mismatch. Please contact support to update the redirect URI in Google Cloud Console.")
                if "invalid_client" in error_detail:
                    raise HTTPException(status_code=400, detail="Google OAuth client configuration error. Please contact support.")
                if error_msg:
                    raise HTTPException(status_code=400, detail=f"Google auth error: {error_msg}")
            except HTTPException:
                raise
            raise HTTPException(status_code=400, detail="Invalid or expired Google authorization code")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Google Code Exchange Error: {e}")
            raise HTTPException(status_code=400, detail="Error exchanging Google authorization code")
    
    if not access_token:
        raise HTTPException(status_code=400, detail="Access token or authorization code required")
    
    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://www.googleapis.com/oauth2/v3/userinfo",
                params={"access_token": access_token}
            )
            resp.raise_for_status()
            user_info = resp.json()
    except Exception as e:
        logger.error(f"Google Token Verification Error: {e}")
        raise HTTPException(status_code=400, detail="Invalid or expired Google token")
        
    email = user_info.get("email")
    full_name = user_info.get("name", "Google Sniper")
    
    if not email:
        raise HTTPException(status_code=400, detail="Email not provided by Google")
        
    # Retry database connection up to 5 times with 5s delay
    # Handles PostgreSQL "in recovery mode" after Railway redeploys
    user = None
    for attempt in range(5):
        try:
            async with AsyncSessionLocal() as session:
                user = await _safe_fetch_user(session, by_email=email)
                break
        except Exception as db_conn_err:
            if attempt < 4:
                logger.warning(f"[Google Auth] DB attempt {attempt+1}/5 failed: {db_conn_err} — retrying in 5s...")
                await asyncio.sleep(5)
            else:
                logger.error(f"[Google Auth] All 5 DB attempts failed. Last error: {db_conn_err}")
                raise HTTPException(status_code=500, detail=f"Database connection failed after 5 retries: {type(db_conn_err).__name__}: {str(db_conn_err)[:200]}")

    try:
        async with AsyncSessionLocal() as session:
            user = await _safe_fetch_user(session, by_email=email)
            
            if not user:
                # Auto-register Google user
                import secrets as _secrets
                user_id = str(uuid.uuid4())
                random_pwd = _secrets.token_hex(16)  # 32-char hex, well within bcrypt 72-byte limit
                
                logger.info(f"[Google Auth] Creating new user for email: {email}, pwd_len: {len(random_pwd)}")
                
                try:
                    hashed = get_password_hash(random_pwd)
                except Exception as he:
                    logger.error(f"[Google Auth] bcrypt hashing failed even with short pwd: {type(he).__name__}: {he}")
                    hashed = f"google_oauth_no_password_{user_id}"
                
                now_utc = datetime.now(timezone.utc)
                user = User(
                    id=user_id,
                    email=email,
                    hashed_password=hashed,
                    full_name=full_name,
                    created_at=now_utc,
                    auth_provider="google"
                )
                session.add(user)
                
                sub = UserSubscription(
                    user_id=user_id,
                    plan_name="Standard",
                    active_until=now_utc + timedelta(days=7)
                )
                session.add(sub)
                await session.commit()
                
                result = await session.execute(select(User).where(User.id == user_id))
                user = result.scalar_one_or_none()
            
            if not user:
                logger.error(f"[Google Auth] User not found after creation for email: {email}")
                raise HTTPException(status_code=500, detail="Failed to create or find user account")

            # Get subscription info for the response
            sub_result2 = await session.execute(
                select(UserSubscription).where(UserSubscription.user_id == user.id)
            )
            subscription = sub_result2.scalar_one_or_none()

            # Auto-promote admin emails to admin + Pro
            # Reads from ADMIN_EMAIL env var (comma-separated)
            admin_emails = []
            admin_env = os.getenv("ADMIN_EMAIL", "").strip()
            if admin_env:
                admin_emails.extend([e.strip() for e in admin_env.split(",") if e.strip()])
            if user.email in admin_emails and not user.is_admin:
                user.is_admin = True
                if subscription and subscription.plan_name != "Pro":
                    subscription.plan_name = "Pro"
                    subscription.active_until = datetime.now(timezone.utc) + timedelta(days=3650)
                elif not subscription:
                    subscription = UserSubscription(
                        user_id=user.id,
                        plan_name="Pro",
                        active_until=datetime.now(timezone.utc) + timedelta(days=3650)
                    )
                    session.add(subscription)
                await session.commit()
                # Refresh user after commit
                result = await session.execute(select(User).where(User.id == user.id))
                user = result.scalar_one_or_none()
                sub_result2 = await session.execute(
                    select(UserSubscription).where(UserSubscription.user_id == user.id)
                )
                subscription = sub_result2.scalar_one_or_none()
                logger.info(f"[Google Auth] Auto-promoted {email} to admin + Pro")

            token = create_access_token({"sub": user.id, "email": user.email})
            refresh_tk = create_refresh_token({"sub": user.id, "email": user.email})

            # Store refresh token in DB
            await store_refresh_token(user.id, refresh_tk, request)

            return {
                "status": "success",
                "access_token": token,
                "refresh_token": refresh_tk,
                "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
                "user": {
                    "id": user.id,
                    "email": user.email,
                    "name": user.full_name,
                    "is_admin": user.is_admin,
                    "plan": subscription.plan_name if subscription else "Free",
                    "auth_provider": getattr(user, 'auth_provider', 'google') or 'google'
                }
            }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"[Google Auth] Database error during user lookup/creation: {type(e).__name__}: {e}")
        logger.error(f"[Google Auth] Full traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Sign-in error: {type(e).__name__}: {str(e)[:200]}")


async def send_otp_email(recipient_email: str, otp_code: str, purpose: str = "password_reset"):
    resend_api_key = os.getenv("RESEND_API_KEY")
    resend_from_email = os.getenv("RESEND_FROM_EMAIL", "noreply@a2sniper.ai")
    
    if not resend_api_key:
        logger.warning("RESEND_API_KEY non configurée. Impossible d'envoyer l'email.")
        return False

    # Customize email content based on purpose
    if purpose == "registration":
        subject = "Verify your A2Sniper account"
        heading = "Account Verification"
        message = "You're creating an account on A2Sniper. Please verify your email address by entering this code:"
        footer_note = "If you didn't try to create an account, please ignore this email."
    elif purpose == "account_deletion":
        subject = "Confirm A2Sniper account deletion"
        heading = "Account Deletion Confirmation"
        message = "You've requested to delete your A2Sniper account. Please confirm by entering this code:"
        footer_note = "If you didn't request account deletion, your account is safe. Please secure your credentials."
    elif purpose == "admin_2fa":
        subject = "A2Sniper Admin — 2FA verification code"
        heading = "Admin 2FA Verification"
        message = "You're signing in to the A2Sniper admin dashboard. Enter this code to complete two-factor authentication:"
        footer_note = "This code expires in 15 minutes. If you didn't request admin access, your account may be compromised — please change your password immediately."
    elif purpose == "telegram_link":
        subject = "Link your Telegram to A2Sniper"
        heading = "Telegram Account Linking"
        message = "You're linking your Telegram account to your A2Sniper subscription. Send this code to the A2Sniper bot in Telegram via the command <code>/link &lt;code&gt;</code>:"
        footer_note = "This code expires in 10 minutes. If you didn't request this, you can safely ignore this email — your account is secure."
    else:
        subject = "A2Sniper Reset Code"
        heading = "Password Reset"
        message = "You requested a password reset for your A2Sniper account. Here is your security OTP code:"
        footer_note = "This code is valid for 15 minutes. If you did not request this reset, please ignore this email."
    
    import httpx
    try:
        html_content = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #D4AF37; margin: 0;">A2Sniper</h2>
                <p style="color: #6b7280; font-size: 14px; margin: 5px 0 0 0;">{heading}</p>
            </div>
            <div style="padding: 20px; background-color: #f9fafb; border-radius: 6px; text-align: center;">
                <p style="font-size: 16px; color: #374151; margin-top: 0;">Hello,</p>
                <p style="font-size: 16px; color: #374151;">{message}</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #D4AF37; margin: 20px 0; padding: 10px; background-color: #FFF8E1; border-radius: 6px; display: inline-block;">
                    {otp_code}
                </div>
                <p style="font-size: 14px; color: #6b7280; margin-bottom: 0;">{footer_note}</p>
            </div>
        </div>
        """
        
        payload = {
            "from": f"A2Sniper <{resend_from_email}>",
            "to": [recipient_email],
            "subject": subject,
            "html": html_content
        }
        
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.resend.com/emails",
                json=payload,
                headers={
                    "Authorization": f"Bearer {resend_api_key}",
                    "Content-Type": "application/json"
                }
            )
            resp.raise_for_status()
            logger.info(f"Email envoyé via Resend à {recipient_email[:3]}***")
            return True
            
    except httpx.HTTPStatusError as e:
        logger.error(f"Erreur HTTP lors de l'envoi de l'email via Resend : {e.response.status_code}")
        return False
    except Exception as e:
        logger.error(f"Erreur générale lors de l'envoi de l'email via Resend : {e}")
        return False

@app.post("/api/auth/forgot-password")
async def forgot_password(request: Request):
    check_rate_limit(request, max_requests=3, window_seconds=60)  # Strict: 3/min for password reset
    data = await request.json()
    email = data.get("email")
    
    if not email:
        raise HTTPException(status_code=400, detail="Email required")
        
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        
        if not user:
            # Don't reveal whether email exists (security best practice)
            return {"status": "success", "message": "If the email exists, an OTP code has been sent to it."}
            
        # Generate 6-digit OTP
        otp_code = str(secrets.randbelow(900000) + 100000)
        
        # Supprimer les anciens OTP pour cet email
        from sqlalchemy import delete
        await session.execute(delete(PasswordResetOTP).where(PasswordResetOTP.email == email))
        
        # Enregistrer le nouvel OTP
        new_otp = PasswordResetOTP(
            id=str(uuid.uuid4()),
            email=email,
            otp_code=otp_code,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
            created_at=datetime.now(timezone.utc)
        )
        session.add(new_otp)
        await session.commit()
        
        # Log OTP generation (without revealing the code)
        logger.info(f"OTP generated for {email[:3]}***@{email.split('@')[-1] if '@' in email else '***'} (expires in 15 min)")
        
        # Envoi de l'email réel
        email_sent = await send_otp_email(email, otp_code)
        
        if not email_sent:
            logger.warning("Le code a été généré mais l'email n'a pas pu être envoyé.")
        
    return {"status": "success", "message": "Si l'email existe, un code OTP y a été envoyé."}

@app.post("/api/auth/verify-otp")
async def verify_otp(request: Request):
    check_rate_limit(request, max_requests=5, window_seconds=60)  # Strict: 5/min for OTP verify
    data = await request.json()
    email = data.get("email")
    otp_code = data.get("otp_code")
    
    if not email or not otp_code:
        raise HTTPException(status_code=400, detail="Email and OTP code required")
    
    # Brute force protection: max 5 attempts per email
    from db import otp_attempt_tracker
    now = datetime.now(timezone.utc)
    if email in otp_attempt_tracker:
        tracker = otp_attempt_tracker[email]
        if tracker["count"] >= 5 and (now - tracker["last_attempt"]).total_seconds() < 300:
            raise HTTPException(status_code=429, detail="Too many OTP attempts. Please try again in 5 minutes.")
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(PasswordResetOTP)
            .where(PasswordResetOTP.email == email)
            .where(PasswordResetOTP.otp_code == otp_code)
        )
        otp_record = result.scalar_one_or_none()
        
        if not otp_record:
            # Track failed attempt
            if email not in otp_attempt_tracker:
                otp_attempt_tracker[email] = {"count": 0, "last_attempt": now}
            otp_attempt_tracker[email]["count"] += 1
            otp_attempt_tracker[email]["last_attempt"] = now
            raise HTTPException(status_code=400, detail="Invalid OTP code")
            
        # Reset tracker on successful verification
        if email in otp_attempt_tracker:
            del otp_attempt_tracker[email]
            
        now_utc = datetime.now(timezone.utc)
        expires_at = otp_record.expires_at.replace(tzinfo=timezone.utc) if otp_record.expires_at.tzinfo is None else otp_record.expires_at
        
        if now_utc > expires_at:
            raise HTTPException(status_code=400, detail="This OTP code has expired")
            
        return {"status": "success", "message": "OTP code verified successfully"}

@app.post("/api/auth/reset-password")
async def reset_password(request: Request):
    check_rate_limit(request, max_requests=5, window_seconds=60)  # Strict: 5/min for password reset
    data = await request.json()
    email = data.get("email")
    otp_code = data.get("otp_code")
    new_password = data.get("new_password")
    
    if not email or not otp_code or not new_password:
        raise HTTPException(status_code=400, detail="All fields are required")

    # Check OTP brute-force protection
    check_otp_bruteforce(email)
    
    async with AsyncSessionLocal() as session:
        # Re-vérifier l'OTP
        result = await session.execute(
            select(PasswordResetOTP)
            .where(PasswordResetOTP.email == email)
            .where(PasswordResetOTP.otp_code == otp_code)
        )
        otp_record = result.scalar_one_or_none()
        
        if not otp_record:
            record_otp_attempt(email, success=False)
            raise HTTPException(status_code=400, detail="Invalid OTP code")
            
        now = datetime.now(timezone.utc)
        expires_at = otp_record.expires_at.replace(tzinfo=timezone.utc) if otp_record.expires_at.tzinfo is None else otp_record.expires_at
        
        if now > expires_at:
            record_otp_attempt(email, success=False)
            raise HTTPException(status_code=400, detail="This OTP code has expired")
        
        # Validate new password strength
        from auth import validate_password_strength, MIN_PASSWORD_LENGTH
        if not validate_password_strength(new_password):
            raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters with 1 uppercase, 1 digit, and 1 special character")
            
        # Mettre à jour le mot de passe
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
            
        user.hashed_password = get_password_hash(new_password)
        
        # Supprimer l'OTP
        from sqlalchemy import delete
        await session.execute(delete(PasswordResetOTP).where(PasswordResetOTP.email == email))
        
        await session.commit()
        record_otp_attempt(email, success=True)
        
    return {"status": "success", "message": "Password reset successfully"}


# ═══════════ 2FA STUB ENDPOINTS (CDC Section 7) ═══════════

@app.post("/api/auth/2fa/setup")
async def setup_2fa(credentials: HTTPAuthorizationCredentials = Security(security)):
    """CDC Section 7: 2FA setup stub — coming soon."""
    return {"status": "coming_soon", "message": "2FA setup will be available in a future update"}

@app.post("/api/auth/2fa/verify")
async def verify_2fa(request: Request):
    """CDC Section 7: 2FA verification stub — coming soon."""
    return {"status": "coming_soon", "message": "2FA verification will be available in a future update"}


# ═══════════ ADMIN 2FA — EMAIL/PASSWORD + EMAIL OTP + SIGNED ADMIN TOKEN ═══════════
# Two-step admin auth (fully decoupled from user accounts):
#
#   Step 1 — POST /api/admin/login/initiate {email, password}
#     Backend verifies email + password against the ADMIN_EMAIL and
#     ADMIN_PASSWORD env vars (constant-time comparison). On match, generates
#     a 6-digit OTP with purpose='admin_2fa', stores it in
#     password_reset_otps (15-min TTL), emails it via Resend.
#
#   Step 2 — POST /api/admin/login/verify {email, password, otp_code}
#     Backend re-verifies email + password (defense in depth — prevents a
#     stolen OTP from being used without the password), validates the OTP,
#     issues a short-lived (10 min) signed admin token (JWT HS256 with
#     ADMIN_SECRET_TOKEN). The frontend stores it as the httpOnly
#     admin_token cookie via the /api/admin-login Next.js route handler.
#
# The middleware (edge) verifies the admin_token JWT signature using Web Crypto
# (crypto.subtle) — no DB lookup needed in the edge runtime.
#
# Why email OTP instead of TOTP authenticator? The codebase already has a
# working Resend integration and the password_reset_otps table with brute-
# force tracking. Email-based 2FA is appropriate for a single-founder admin
# tool and avoids the complexity of TOTP secret provisioning + recovery codes.
#
# Required env vars on Railway:
#   ADMIN_EMAIL         — the admin email address (where OTPs are sent)
#   ADMIN_PASSWORD      — the admin password (>= 12 chars recommended)
#   ADMIN_SECRET_TOKEN  — JWT signing secret (>= 16 chars)
#   RESEND_API_KEY      — for email delivery

ADMIN_TOKEN_TTL_SECONDS = 10 * 60  # 10 minutes
ADMIN_OTP_PURPOSE = "admin_2fa"


def _constant_time_eq(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks.

    Uses hmac.compare_digest (which is constant-time for equal-length strings).
    Pre-hashes both inputs with SHA-256 so the comparison time does not leak
    the length of the secret.
    """
    import hmac, hashlib
    if not isinstance(a, str) or not isinstance(b, str):
        return False
    a_hash = hashlib.sha256(a.encode('utf-8')).digest()
    b_hash = hashlib.sha256(b.encode('utf-8')).digest()
    return hmac.compare_digest(a_hash, b_hash)


def _verify_admin_credentials(email: str, password: str) -> bool:
    """Verify admin email + password against env vars (constant-time).

    Returns True only if BOTH email and password match. If ADMIN_EMAIL or
    ADMIN_PASSWORD env vars are unset, returns False (refuse all admin logins).
    """
    expected_email = os.environ.get("ADMIN_EMAIL", "").strip()
    expected_password = os.environ.get("ADMIN_PASSWORD", "")
    if not expected_email or not expected_password:
        logger.error("[ADMIN-AUTH] ADMIN_EMAIL or ADMIN_PASSWORD env var not set — refusing admin login.")
        return False
    # Constant-time comparison on both fields (independent of each other's
    # length, so an attacker can't infer whether the email or password was
    # wrong based on response timing).
    return _constant_time_eq(email, expected_email) and _constant_time_eq(password, expected_password)


def _create_admin_token(admin_email: str) -> str:
    """Sign a short-lived admin token (JWT HS256) using ADMIN_SECRET_TOKEN.

    The middleware verifies this signature with crypto.subtle in the edge
    runtime. The token encodes {sub, email, exp, iat, purpose: 'admin'}.
    """
    import jwt as pyjwt
    secret = os.environ.get("ADMIN_SECRET_TOKEN", "")
    if not secret or len(secret) < 16:
        raise HTTPException(status_code=500, detail="ADMIN_SECRET_TOKEN not configured (must be >= 16 chars)")
    now = datetime.now(timezone.utc)
    payload = {
        "sub": "admin",
        "email": admin_email,
        "purpose": "admin",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ADMIN_TOKEN_TTL_SECONDS)).timestamp()),
    }
    return pyjwt.encode(payload, secret, algorithm="HS256")


@app.post("/api/admin/login/initiate")
async def admin_login_initiate(request: Request):
    """Step 1 of admin 2FA: verify admin email + password, send 6-digit OTP.

    Body: {email, password}

    On success (credentials match ADMIN_EMAIL + ADMIN_PASSWORD env vars),
    generates an OTP with purpose='admin_2fa', stores it in
    password_reset_otps (15-min TTL), emails it via Resend.
    """
    check_rate_limit(request, max_requests=5, window_seconds=60)  # 5/min — strict for admin login

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")

    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password are required")

    if not _verify_admin_credentials(email, password):
        # Log the attempt (without revealing which field was wrong) and return
        # a generic error. Add a small delay to slow down brute-force attempts.
        logger.warning(f"[ADMIN-AUTH] Failed initiate for email={email[:3]}*** (bad credentials)")
        await asyncio.sleep(0.5)
        raise HTTPException(status_code=401, detail="Invalid admin credentials")

    # Credentials are valid — generate + email the OTP.
    async with AsyncSessionLocal() as session:
        # Delete any previous unused admin_2fa OTPs for this email
        await session.execute(
            __import__('sqlalchemy').text(
                "DELETE FROM password_reset_otps WHERE email = :email AND purpose = :purpose"
            ),
            {"email": email, "purpose": ADMIN_OTP_PURPOSE}
        )
        otp_code = str(secrets.randbelow(900000) + 100000)
        new_otp = PasswordResetOTP(
            id=str(uuid.uuid4()),
            email=email,
            otp_code=otp_code,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
            created_at=datetime.now(timezone.utc),
            purpose=ADMIN_OTP_PURPOSE,
        )
        session.add(new_otp)
        await session.commit()

    email_sent = await send_otp_email(email, otp_code, purpose="admin_2fa")
    if not email_sent:
        logger.error(f"[ADMIN-2FA] OTP email delivery FAILED for {email[:3]}*** — Resend misconfigured. OTP NOT logged.")
        raise HTTPException(
            status_code=503,
            detail="Could not send 2FA email. Please verify RESEND_API_KEY is set on the backend."
        )

    logger.info(f"[ADMIN-2FA] OTP sent to {email[:3]}*** for admin login")
    return {"status": "otp_sent", "message": "A 6-digit verification code has been sent to your email."}


@app.post("/api/admin/login/verify")
async def admin_login_verify(request: Request):
    """Step 2 of admin 2FA: re-verify credentials + verify OTP, issue admin token.

    Body: {email, password, otp_code}

    Re-verifies email + password (defense in depth — prevents a stolen OTP
    from being used without the password), validates the OTP, then issues a
    short-lived signed admin token (10-min TTL) that the frontend will store
    as the httpOnly admin_token cookie via the /api/admin-login Next.js route
    handler.
    """
    check_rate_limit(request, max_requests=10, window_seconds=60)  # 10/min

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")

    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    otp_code = str(data.get("otp_code", "")).strip()

    if not email or not password:
        raise HTTPException(status_code=400, detail="Email and password are required")
    if not otp_code or not otp_code.isdigit() or len(otp_code) != 6:
        raise HTTPException(status_code=400, detail="A 6-digit OTP code is required")

    # Re-verify credentials (defense in depth)
    if not _verify_admin_credentials(email, password):
        logger.warning(f"[ADMIN-AUTH] Failed verify (bad credentials) for email={email[:3]}***")
        await asyncio.sleep(0.5)
        raise HTTPException(status_code=401, detail="Invalid admin credentials")

    # Brute-force protection on the OTP
    check_otp_bruteforce(email)

    async with AsyncSessionLocal() as session:
        # Fetch the most recent unused admin_2fa OTP for this email.
        # NOTE: password_reset_otps has no `used` column — we delete rows
        # on successful verification instead, so any existing row is unused.
        result = await session.execute(
            select(PasswordResetOTP).where(
                PasswordResetOTP.email == email,
                PasswordResetOTP.purpose == ADMIN_OTP_PURPOSE,
            ).order_by(PasswordResetOTP.created_at.desc()).limit(1)
        )
        otp_row = result.scalar_one_or_none()

        is_valid = (
            otp_row is not None
            and otp_row.otp_code == otp_code
            and otp_row.expires_at > datetime.now(timezone.utc)
        )

        if not is_valid:
            record_otp_attempt(email, success=False)
            logger.warning(f"[ADMIN-2FA] Failed OTP verify for {email[:3]}***")
            raise HTTPException(status_code=401, detail="Invalid or expired verification code")

        # Delete the OTP row (matches the existing password_reset_otps usage pattern —
        # the table has no `used` column, so we delete on successful verification).
        await session.execute(
            __import__('sqlalchemy').text(
                "DELETE FROM password_reset_otps WHERE id = :otp_id"
            ),
            {"otp_id": otp_row.id}
        )
        await session.commit()

    record_otp_attempt(email, success=True)
    admin_token = _create_admin_token(email)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=ADMIN_TOKEN_TTL_SECONDS)
    logger.info(f"[ADMIN-2FA] Admin token issued for {email[:3]}*** (ttl={ADMIN_TOKEN_TTL_SECONDS}s)")

    return {
        "status": "success",
        "admin_token": admin_token,
        "expires_at": expires_at.isoformat(),
        "ttl_seconds": ADMIN_TOKEN_TTL_SECONDS,
    }



@app.post("/api/auth/refresh")
async def refresh_access_token(request: Request):
    """Exchange a valid refresh token for a new access token + refresh token pair.
    Implements token rotation: the old refresh token is revoked upon use."""
    check_rate_limit(request, max_requests=30, window_seconds=60)  # 30/min for refresh
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")

    refresh_token_str = data.get("refresh_token")
    if not refresh_token_str:
        raise HTTPException(status_code=400, detail="Refresh token required")

    # Decode and validate the refresh token
    try:
        payload = decode_refresh_token(refresh_token_str)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # Check if refresh token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Refresh token has been revoked")

    # Check if the refresh token exists in our DB and is not soft-revoked
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid refresh token payload")

    async with AsyncSessionLocal() as session:
        # Verify the refresh token is in our database and not revoked
        rt_result = await session.execute(
            select(RefreshToken).where(
                RefreshToken.token_jti == token_jti,
                RefreshToken.is_revoked == False
            )
        )
        rt_record = rt_result.scalar_one_or_none()
        if not rt_record:
            # Token was revoked or doesn't exist — possible theft, revoke ALL user tokens
            logger.warning(f"[Auth] Reuse of revoked refresh token detected for user {user_id[:8]}... — revoking all tokens")
            await revoke_all_user_tokens(user_id, reason="refresh_token_reuse")
            raise HTTPException(status_code=401, detail="Refresh token has been revoked. Please log in again.")

        # Verify user still exists (use safe fetch — column may be missing)
        user = await _safe_fetch_user(session, by_id=user_id)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")

        # Token rotation: revoke the old refresh token
        rt_record.is_revoked = True
        await session.flush()

        # Revoke the old refresh token's JTI in the blacklist
        if token_jti:
            await revoke_token(token_jti, "refresh", user_id, reason="token_rotation",
                             expires_at=datetime.now(timezone.utc) + timedelta(days=8))

        # Issue new token pair
        new_access_token = create_access_token({"sub": user.id, "email": user.email})
        new_refresh_token = create_refresh_token({"sub": user.id, "email": user.email})

        # Store new refresh token in DB
        await store_refresh_token(user.id, new_refresh_token, request)

        # Get subscription info
        sub_result = await session.execute(
            select(UserSubscription).where(UserSubscription.user_id == user.id)
        )
        subscription = sub_result.scalar_one_or_none()

        await session.commit()

        logger.info(f"[Auth] Token refreshed for user {user.email[:3]}***")

        return {
            "status": "success",
            "access_token": new_access_token,
            "refresh_token": new_refresh_token,
            "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.full_name,
                "is_admin": user.is_admin,
                "plan": subscription.plan_name if subscription else "Free",
                "auth_provider": getattr(user, 'auth_provider', 'email') or 'email',
                "avatar": getattr(user, 'avatar', None),
                "notification_sound": getattr(user, 'notification_sound', 'bell') or 'bell'
            }
        }


@app.post("/api/auth/logout")
async def logout(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Logout: revoke the current access token and its associated refresh token.
    Accepts both the access token (via Authorization header) and optionally a refresh_token in the body."""
    token = credentials.credentials
    payload = decode_access_token(token)

    token_jti = payload.get("jti")
    user_id = payload.get("sub")

    # Revoke the access token
    if token_jti:
        access_exp = datetime.fromtimestamp(payload.get("exp", 0), tz=timezone.utc)
        await revoke_token(token_jti, "access", user_id or "unknown",
                          reason="user_logout", expires_at=access_exp)

    # Revoke all refresh tokens for this user (full logout from all devices)
    if user_id:
        try:
            async with AsyncSessionLocal() as session:
                await session.execute(
                    __import__('sqlalchemy').text(
                        "UPDATE refresh_tokens SET is_revoked = TRUE WHERE user_id = :uid AND is_revoked = FALSE"
                    ),
                    {"uid": user_id}
                )
                await session.commit()
        except Exception as e:
            logger.error(f"[Auth] Failed to revoke refresh tokens on logout: {e}")

    logger.info(f"[Auth] User {user_id[:8] if user_id else 'unknown'}... logged out — tokens revoked")
    return {"status": "success", "message": "Logged out successfully"}


@app.get("/api/auth/me")
async def get_me(credentials: HTTPAuthorizationCredentials = Security(security)):
    token = credentials.credentials
    payload = decode_access_token(token)

    # Check if token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")

    async with AsyncSessionLocal() as session:
        # Use safe fetch — falls back to raw SQL if notification_sound column is missing
        user = await _safe_fetch_user(session, by_id=user_id)

        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        # Eagerly load subscription to avoid lazy-load issues
        # Use a fresh session in case the original was rolled back by _safe_fetch_user
        try:
            sub_result = await session.execute(
                select(UserSubscription).where(UserSubscription.user_id == user_id)
            )
            subscription = sub_result.scalar_one_or_none()
        except Exception:
            async with AsyncSessionLocal() as fresh_session:
                sub_result = await fresh_session.execute(
                    select(UserSubscription).where(UserSubscription.user_id == user_id)
                )
                subscription = sub_result.scalar_one_or_none()

        return {
            "id": user.id,
            "email": user.email,
            "name": user.full_name,
            "is_admin": user.is_admin,
            "plan": subscription.plan_name if subscription else "Free",
            "auth_provider": getattr(user, 'auth_provider', 'email') or 'email',
            "avatar": getattr(user, 'avatar', None),
            "notification_sound": getattr(user, 'notification_sound', 'bell') or 'bell'
        }


# ═══════════ TELEGRAM ACCOUNT LINKING ═══════════
# Flow: user generates a 6-digit code on the web app → emails it to themselves
# via Resend → user sends `/link <code>` to the bot → bot verifies the code,
# updates subscriptions.telegram_chat_id. Future /start calls detect the link
# via telegram_chat_id and fetch the plan correctly.

TELEGRAM_LINK_TTL_MINUTES = 10
TELEGRAM_LINK_PURPOSE = "telegram_link"


@app.post("/api/auth/telegram/link-code")
async def generate_telegram_link_code(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Generate a 6-digit one-time code to link the user's Telegram account.

    The code is stored in password_reset_otps with purpose='telegram_link'
    (10-min TTL, bound to the user's email) and emailed to the user via Resend.
    The user then sends `/link <code>` to the A2Sniper bot in Telegram to
    complete the linking.
    """
    token = credentials.credentials
    payload = decode_access_token(token)

    # Check if token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")
    user_email = payload.get("email")

    async with AsyncSessionLocal() as session:
        # Delete any previous unused telegram_link codes for this user
        await session.execute(
            __import__('sqlalchemy').text(
                "DELETE FROM password_reset_otps WHERE email = :email AND purpose = :purpose"
            ),
            {"email": user_email, "purpose": TELEGRAM_LINK_PURPOSE}
        )
        link_code = str(secrets.randbelow(900000) + 100000)
        new_otp = PasswordResetOTP(
            id=str(uuid.uuid4()),
            email=user_email,
            otp_code=link_code,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=TELEGRAM_LINK_TTL_MINUTES),
            created_at=datetime.now(timezone.utc),
            purpose=TELEGRAM_LINK_PURPOSE,
        )
        session.add(new_otp)
        await session.commit()

    email_sent = await send_otp_email(user_email, link_code, purpose="telegram_link")
    if not email_sent:
        logger.error(f"[TELEGRAM-LINK] Email delivery FAILED for {user_email[:3]}*** — code NOT logged.")
        raise HTTPException(
            status_code=503,
            detail="Could not send linking code email. Please verify RESEND_API_KEY is set on the backend."
        )

    logger.info(f"[TELEGRAM-LINK] Link code sent to {user_email[:3]}*** (user_id={user_id[:8]}...)")
    return {
        "status": "code_sent",
        "ttl_minutes": TELEGRAM_LINK_TTL_MINUTES,
        "message": f"A 6-digit linking code has been sent to {user_email}. Open Telegram and send `/link <code>` to the A2Sniper bot."
    }


@app.get("/api/auth/telegram/status")
async def get_telegram_link_status(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Check whether the user's Telegram account is linked (i.e. the
    subscriptions.telegram_chat_id column is set for this user).
    """
    token = credentials.credentials
    payload = decode_access_token(token)

    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(UserSubscription).where(UserSubscription.user_id == user_id)
        )
        sub = result.scalar_one_or_none()
        linked_chat_id = getattr(sub, 'telegram_chat_id', None) if sub else None

    return {
        "linked": bool(linked_chat_id),
        "telegram_chat_id": linked_chat_id,
    }


@app.delete("/api/auth/telegram/unlink")
async def unlink_telegram(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Clear the user's Telegram link (server-side). Useful if the user lost
    access to their Telegram account or wants to relink to a different one.
    """
    token = credentials.credentials
    payload = decode_access_token(token)

    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(UserSubscription).where(UserSubscription.user_id == user_id)
        )
        sub = result.scalar_one_or_none()
        if sub and getattr(sub, 'telegram_chat_id', None):
            sub.telegram_chat_id = None
            await session.commit()
            logger.info(f"[TELEGRAM-LINK] Unlinked Telegram for user_id={user_id[:8]}...")
        else:
            # Not linked — no-op, return success
            pass

    return {"status": "unlinked"}


@app.post("/api/auth/delete-account-send-otp")
async def delete_account_send_otp(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Step 1: Send OTP to user's email to confirm account deletion."""
    token = credentials.credentials
    payload = decode_access_token(token)

    # Check if token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        user_email = user.email

        # Generate 6-digit OTP
        otp_code = str(secrets.randbelow(900000) + 100000)

        # Delete any existing deletion OTPs for this email
        await session.execute(
            __import__('sqlalchemy').text(
                "DELETE FROM password_reset_otps WHERE email = :email AND purpose = 'account_deletion'"
            ),
            {"email": user_email}
        )

        # Store the OTP
        new_otp = PasswordResetOTP(
            id=str(uuid.uuid4()),
            email=user_email,
            otp_code=otp_code,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
            created_at=datetime.now(timezone.utc),
            purpose="account_deletion"
        )
        session.add(new_otp)
        await session.commit()

    # Send verification email
    email_sent = await send_otp_email(user_email, otp_code, purpose="account_deletion")

    if not email_sent:
        # SECURITY: do NOT log the OTP value (same rationale as register flow).
        logger.error(f"[Delete] Deletion OTP email delivery FAILED for {user_email[:3]}*** — Resend API misconfigured or down. OTP NOT logged.")
    else:
        logger.info(f"[Delete] Deletion OTP sent to {user_email[:3]}***")

    return {"status": "success", "message": "A confirmation code has been sent to your email."}


@app.post("/api/auth/delete-account-confirm")
async def delete_account_confirm(request: Request, credentials: HTTPAuthorizationCredentials = Security(security)):
    """Step 2: Verify OTP and permanently delete the account."""
    token = credentials.credentials
    payload = decode_access_token(token)

    # Check if token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")
    otp_code = data.get("otp_code")
    if not otp_code:
        raise HTTPException(status_code=400, detail="OTP code required")

    from sqlalchemy import text as sql_text

    try:
        async with AsyncSessionLocal() as session:
            # Check user exists
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if not user:
                raise HTTPException(status_code=404, detail="User not found")

            user_email = user.email
            user_name = user.full_name
            auth_provider = getattr(user, 'auth_provider', 'email') or 'email'

            # Verify OTP
            otp_result = await session.execute(
                select(PasswordResetOTP).where(
                    PasswordResetOTP.email == user_email,
                    PasswordResetOTP.otp_code == otp_code,
                    PasswordResetOTP.purpose == "account_deletion"
                )
            )
            otp_record = otp_result.scalar_one_or_none()

            if not otp_record:
                record_otp_attempt(user_email, success=False)
                raise HTTPException(status_code=400, detail="Invalid or expired confirmation code")

            if otp_record.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
                await session.delete(otp_record)
                await session.commit()
                record_otp_attempt(user_email, success=False)
                raise HTTPException(status_code=400, detail="Confirmation code has expired. Please request a new one.")

            # OTP is valid — delete it and record success
            await session.delete(otp_record)
            await session.flush()
            record_otp_attempt(user_email, success=True)

            # Get subscription info for audit trail
            sub_result = await session.execute(
                select(UserSubscription).where(UserSubscription.user_id == user_id)
            )
            subscription = sub_result.scalar_one_or_none()
            plan_name = subscription.plan_name if subscription else "Free"

            # Save deletion record for admin audit trail BEFORE deleting the user
            from db import DeletedAccount
            deletion_record = DeletedAccount(
                id=str(uuid.uuid4()),
                user_id=user_id,
                email=user_email,
                full_name=user_name,
                auth_provider=auth_provider,
                plan_name=plan_name,
                is_admin=user.is_admin,
                deleted_at=datetime.now(timezone.utc),
                deletion_reason="user_requested"
            )
            session.add(deletion_record)
            await session.flush()

            # Delete subscription
            await session.execute(
                sql_text("DELETE FROM subscriptions WHERE user_id = :uid"),
                {"uid": user_id}
            )
            # Delete any password reset OTPs
            await session.execute(
                sql_text("DELETE FROM password_reset_otps WHERE email = :email"),
                {"email": user_email}
            )
            # Delete all refresh tokens for this user
            await session.execute(
                sql_text("DELETE FROM refresh_tokens WHERE user_id = :uid"),
                {"uid": user_id}
            )
            # Delete the user record
            user_del = await session.execute(
                sql_text("DELETE FROM users WHERE id = :uid"),
                {"uid": user_id}
            )
            logger.info(f"[Auth] Deleted user record for: {user_email} (rows affected: {user_del.rowcount})")

            await session.commit()

            # Verify deletion
            verify = await session.execute(
                sql_text("SELECT id FROM users WHERE id = :uid"),
                {"uid": user_id}
            )
            if verify.fetchone():
                logger.error(f"[Auth] CRITICAL: User {user_email} still exists after DELETE! Force retry...")
                await session.execute(sql_text("DELETE FROM users WHERE id = :uid"), {"uid": user_id})
                await session.commit()

            logger.info(f"[Auth] Account fully deleted and verified for user: {user_email} ({user_id}). Audit record saved.")
            return {"detail": "Account permanently deleted"}

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"[Auth] Error deleting account for user {user_id}: {type(e).__name__}: {e}")
        logger.error(f"[Auth] Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Failed to delete account. Please contact support.")


@app.get("/api/auth/export-data")
async def export_user_data(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Export all data associated with the authenticated user."""
    token = credentials.credentials
    payload = decode_access_token(token)

    # Check if token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")

    try:
        async with AsyncSessionLocal() as session:
            # Get user data
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            if not user:
                raise HTTPException(status_code=404, detail="User not found")

            # Get subscription data
            sub_result = await session.execute(select(UserSubscription).where(UserSubscription.user_id == user_id))
            subscription = sub_result.scalar_one_or_none()

            # Get user's signal history
            signal_result = await session.execute(
                select(SignalRecord).order_by(SignalRecord.timestamp.desc()).limit(100)
            )
            signals = signal_result.scalars().all()

            export_data = {
                "exportDate": datetime.now(timezone.utc).isoformat(),
                "user": {
                    "id": user.id,
                    "email": user.email,
                    "name": user.full_name,
                    "created_at": user.created_at.isoformat() if user.created_at else None,
                },
                "subscription": {
                    "plan": subscription.plan_name if subscription else "Free",
                    "active_until": subscription.active_until.isoformat() if subscription and subscription.active_until else None,
                } if subscription else None,
                "recent_signals": [
                    {
                        "id": s.id,
                        "pair": s.pair,
                        "direction": s.direction,
                        "score": s.score,
                        "timestamp": s.timestamp.isoformat() if s.timestamp else None,
                    }
                    for s in signals[:20]
                ]
            }

            return export_data

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Auth] Error exporting data for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to export data. Please try again later.")


@app.get("/api/performance")
async def get_performance():
    return monitor.get_performance_dashboard()


@app.post("/api/risk/settings")
async def save_risk_settings(request: Request, credentials: HTTPAuthorizationCredentials = Security(security)):
    """Save user's risk manager settings."""
    token = credentials.credentials
    payload = decode_access_token(token)
    user_id = payload.get("sub")

    # Check if token is revoked
    token_jti = payload.get("jti")
    if token_jti and await is_token_revoked(token_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    try:
        data = await request.json()
        # For now, acknowledge the save — settings are stored client-side in localStorage
        # This endpoint can be extended later to persist settings in the database
        logger.info(f"[Risk] Settings saved for user {user_id}: capital={data.get('initial_capital')}, payout={data.get('payout')}")
        return {"detail": "Risk settings saved successfully"}
    except Exception as e:
        logger.error(f"[Risk] Error saving settings for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to save risk settings")


@app.get("/api/status")
async def get_status():
    # Calculate average latency from recent samples
    avg_latency = sum(_latency_samples) / len(_latency_samples) if _latency_samples else 0.0
    
    # Get LIVE forex pairs from PO (no hardcoded list)
    live_pairs = []
    if po_scanner.is_connected:
        live_pairs = list(po_scanner.find_pairs_above_payout(
            min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
        ).keys())

    return {
        "status": "active" if not monitor.is_suspended else "suspended",
        "circuit_breaker": monitor.check_circuit_breaker(),
        "risk": risk_mgr.check_can_trade(),
        "pairs": live_pairs,  # LIVE from PO, not hardcoded
        "total_signals": len(generated_signals),
        "server_start_time": SERVER_START_TIME.isoformat(),
        "uptime_seconds": (datetime.now(timezone.utc) - SERVER_START_TIME).total_seconds(),
        "avg_latency_ms": round(avg_latency, 2),
    }


@app.post("/api/admin/circuit-breaker")
async def toggle_circuit_breaker(request: Request, admin_payload = Depends(require_admin)):
    """Contrôle global du système (Shutdown d'urgence)."""
    data = await request.json()
    active = data.get("active", False)
    
    if active:
        monitor.force_suspend("Manual admin suspension")
    else:
        monitor.force_resume()
        
    logger.info(f"[ADMIN] Circuit Breaker {'ACTIVATED' if active else 'DEACTIVATED'}")
    return {"status": "success", "active": monitor.is_suspended}


# --- NEW ADMIN ENDPOINTS ---

@app.get("/api/admin/users")
async def admin_get_users(admin_payload = Depends(require_admin)):
    async with AsyncSessionLocal() as session:
        from db import UserSubscription
        # Get all users with their info
        user_result = await session.execute(select(User))
        all_users = user_result.scalars().all()
        safe_users = []
        for u in all_users:
            # Get subscription for each user
            sub_result = await session.execute(
                select(UserSubscription).where(UserSubscription.user_id == u.id)
            )
            sub = sub_result.scalar_one_or_none()
            safe_users.append({
                "user_id": u.id,
                "email": u.email,
                "name": u.full_name,
                "is_admin": u.is_admin,
                "is_active": u.is_active,
                "auth_provider": getattr(u, 'auth_provider', 'email') or 'email',
                "created_at": u.created_at.isoformat() if u.created_at else None,
                "plan_name": sub.plan_name if sub else None,
                "active_until": sub.active_until.isoformat() if sub and sub.active_until else None,
                "telegram_chat_id": sub.telegram_chat_id if sub else None,
            })
        return {"users": safe_users}


@app.post("/api/admin/users/{user_id}/plan")
async def admin_update_user_plan(user_id: str, request: Request, admin_payload = Depends(require_admin)):
    data = await request.json()
    plan = data.get("plan")
    from db import VALID_PLANS
    if plan not in VALID_PLANS:
        raise HTTPException(status_code=400, detail=f"Invalid plan. Must be one of: {VALID_PLANS}")
    async with AsyncSessionLocal() as session:
        from db import UserSubscription
        result = await session.execute(select(UserSubscription).where(UserSubscription.user_id == user_id))
        user = result.scalar_one_or_none()
        if user:
            user.plan_name = plan
            await session.commit()
        else:
            raise HTTPException(status_code=404, detail="User subscription not found")
    return {"status": "success"}


@app.delete("/api/admin/users/by-email")
async def admin_delete_user_by_email(request: Request, admin_payload = Depends(require_admin)):
    """Admin endpoint to force-delete a user account by email. Cleans up all related data."""
    data = await request.json()
    email = data.get("email")
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")

    from sqlalchemy import text as sql_text

    async with AsyncSessionLocal() as session:
        # Find the user by email
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail=f"No user found with email: {email}")

        user_id = user.id

        # Delete subscription
        await session.execute(
            sql_text("DELETE FROM subscriptions WHERE user_id = :uid"),
            {"uid": user_id}
        )
        # Delete OTPs
        await session.execute(
            sql_text("DELETE FROM password_reset_otps WHERE email = :email"),
            {"email": email}
        )
        # Delete user
        await session.execute(
            sql_text("DELETE FROM users WHERE id = :uid"),
            {"uid": user_id}
        )
        await session.commit()

        # Verify deletion
        verify = await session.execute(
            sql_text("SELECT id FROM users WHERE id = :uid"),
            {"uid": user_id}
        )
        if verify.fetchone():
            logger.error(f"[Admin] Failed to delete user {email}!")
            raise HTTPException(status_code=500, detail="Failed to delete user account")

        logger.info(f"[Admin] Force-deleted user account: {email} ({user_id})")
        return {"status": "success", "detail": f"Account {email} permanently deleted"}


@app.get("/api/admin/deleted-accounts")
async def admin_get_deleted_accounts(admin_payload = Depends(require_admin)):
    """View the audit trail of all deleted accounts."""
    async with AsyncSessionLocal() as session:
        from db import DeletedAccount
        result = await session.execute(
            select(DeletedAccount).order_by(DeletedAccount.deleted_at.desc())
        )
        records = result.scalars().all()
        deleted = []
        for r in records:
            deleted.append({
                "id": r.id,
                "user_id": r.user_id,
                "email": r.email,
                "full_name": r.full_name,
                "auth_provider": r.auth_provider,
                "plan_name": r.plan_name,
                "is_admin": r.is_admin,
                "deleted_at": r.deleted_at.isoformat() if r.deleted_at else None,
                "deletion_reason": r.deletion_reason,
            })
        return {"deleted_accounts": deleted, "total": len(deleted)}


# ═══════════ AI ENGINE ENDPOINTS (DISABLED — NEURAL_MODELS REMOVED) ═══════════
# The neural_models/ package (LSTM, Transformer, XGBoost, Voting, TrainingPipeline)
# was removed — it was 1,400+ lines of dead code (voting_model.predict() was never
# called, model weights were never trained, PyTorch was not in requirements).
# These endpoints remain as stubs so the admin dashboard doesn't crash on fetch,
# but they all report a "disabled" state. The frontend admin pages have been
# updated to show "AI voting disabled" cards instead of the fake UI.

@app.get("/api/admin/engine/weights")
async def admin_get_weights(admin_payload = Depends(require_admin)):
    """Returns disabled state — neural_models package was removed."""
    return {"disabled": True, "reason": "neural_models package removed"}

@app.post("/api/admin/engine/weights")
async def admin_update_weights(request: Request, admin_payload = Depends(require_admin)):
    """No-op — neural_models package was removed."""
    return {"disabled": True, "reason": "neural_models package removed"}

@app.post("/api/admin/retrain")
async def admin_trigger_retrain(request: Request, admin_payload = Depends(require_admin)):
    """No-op — neural_models package was removed."""
    return {
        "disabled": True,
        "reason": "neural_models package removed",
        "message": "AI model retraining is disabled. The LSTM/Transformer/XGBoost voting classifier was removed from the codebase.",
    }

@app.get("/api/admin/engine/status")
async def admin_engine_status(admin_payload = Depends(require_admin)):
    """Returns disabled state — neural_models package was removed."""
    return {
        "disabled": True,
        "reason": "neural_models package removed",
        "ai_gate_mode": "disabled",
        "models": {
            "xgboost": {"is_trained": False, "model_loaded": False},
            "lstm": {"is_trained": False},
            "transformer": {"is_trained": False},
        },
    }


# ═══════════ ACCUMULATOR STATUS (still useful — tracks live candle data) ═══════════

@app.get("/api/admin/accumulator/status")
async def admin_accumulator_status(admin_payload = Depends(require_admin)):
    """Check the status of live candle accumulation.

    Returns total rows, pairs seen, file size, date range, and whether
    enough data has accumulated to retrain on real market data.
    """
    try:
        from engine.candle_accumulator import get_accumulator
        accumulator = await get_accumulator()
        return accumulator.get_status()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get accumulator status: {e}")


# ═══════════ BACKTEST ENDPOINTS ═══════════

@app.post("/api/admin/backtest/run")
async def admin_run_backtest(request: Request, admin_payload = Depends(require_admin)):
    """Run a backtest on historical candle data and return actual win rate stats.

    Body: {
        pair: str (e.g. "EURUSD_otc") — defaults to "EURUSD_otc"
        engine: str ("ace" | "sniper") — defaults to "ace"
        strict_mode: bool (sniper only) — defaults to false
        payout: float (e.g. 80) — defaults to 80
        step: int (1 = check every candle, 5 = every 5th — faster) — defaults to 1
    }

    Returns:
        Summary stats: actual win rate vs claimed, P&L simulation,
        per-direction breakdown, per-score breakdown, verdict.

    This is the TRUTH layer — it compares the engines' hardcoded winrate
    claims against what actually happens when you follow the signals.
    """
    try:
        data = await request.json()
    except Exception:
        data = {}

    pair = data.get('pair', 'EURUSD_otc')
    engine = data.get('engine', 'ace')
    strict_mode = data.get('strict_mode', False)
    payout = float(data.get('payout', 80))
    step = int(data.get('step', 1))

    if engine not in ('ace', 'sniper'):
        raise HTTPException(status_code=400, detail="engine must be 'ace' or 'sniper'")
    if step < 1 or step > 100:
        raise HTTPException(status_code=400, detail="step must be between 1 and 100")

    from engine.backtest import Backtester
    bt = Backtester(pair=pair, payout=payout)

    # Load data (DB first, CSV fallback)
    df = await bt._load_data()
    if df is None or len(df) < 50:
        raise HTTPException(
            status_code=400,
            detail=f"Not enough candle data for {pair}. Need at least 50 candles. "
                   f"Connect to the market and let the scanner accumulate data, or use the synthetic CSV."
        )

    # Pre-calculate indicators
    df = bt._prepare_indicators(df)

    # Run backtest
    results = bt.run_backtest(df, engine=engine, strict_mode=strict_mode, step=step)
    summary = bt.summary(results)

    return {
        'status': 'success',
        'data_source': 'DB (real PO OTC candles)' if len(df) > 500 else 'CSV (synthetic fallback)',
        'candles_analyzed': len(df),
        'summary': summary,
    }


@app.post("/api/admin/backtest/diagnose-puts")
async def admin_diagnose_puts(request: Request, admin_payload = Depends(require_admin)):
    """Diagnostic — breaks down PUT signals by strategy type to find
    which PUT logic is failing.

    Returns:
      - per-strategy CALL vs PUT win rate comparison
      - ACE Trend Continuation PUT breakdown
      - ACE BB Reversal PUT breakdown
      - Sniper Option C PUT breakdown
      - Sniper Option D (strict) PUT breakdown

    This tells us whether PUTs are failing due to a specific strategy
    (e.g., ACE trend continuation) or across the board.
    """
    try:
        data = await request.json()
    except Exception:
        data = {}

    pair = data.get('pair', 'EURUSD_otc')
    payout = float(data.get('payout', 80))
    step = int(data.get('step', 1))

    from engine.backtest import Backtester
    bt = Backtester(pair=pair, payout=payout)
    df = await bt._load_data()
    if df is None or len(df) < 50:
        raise HTTPException(
            status_code=400,
            detail=f"Not enough candle data for {pair}. Need at least 50 candles."
        )

    df = bt._prepare_indicators(df)

    # Run all 3 engine configs
    ace_results = bt.run_backtest(df, engine='ace', strict_mode=False, step=step)
    sniper_c_results = bt.run_backtest(df, engine='sniper', strict_mode=False, step=step)
    sniper_d_results = bt.run_backtest(df, engine='sniper', strict_mode=True, step=step)

    def _bucket_stats(results):
        """Break down results by direction + strategy."""
        buckets = {}
        for r in results:
            if r['actual_win'] is None:
                continue  # skip ties
            key = f"{r['engine']}_{r['strategy']}"
            if key not in buckets:
                buckets[key] = {'calls': [], 'puts': []}
            if r['direction'] == 'CALL':
                buckets[key]['calls'].append(r)
            else:
                buckets[key]['puts'].append(r)
        return buckets

    def _wr(records):
        if not records:
            return 0, 0
        wins = sum(1 for r in records if r['actual_win'])
        return wins, len(records)

    all_results = ace_results + sniper_c_results + sniper_d_results
    buckets = _bucket_stats(all_results)

    # Build report
    report = {
        'pair': pair,
        'payout': payout,
        'candles_analyzed': len(df),
        'total_signals': len(all_results),
        'breakdown': {},
        'verdict': '',
    }

    for bucket_name, data in sorted(buckets.items()):
        call_wins, call_total = _wr(data['calls'])
        put_wins, put_total = _wr(data['puts'])
        call_wr = round(call_wins / call_total * 100, 1) if call_total > 0 else 0
        put_wr = round(put_wins / put_total * 100, 1) if put_total > 0 else 0
        gap = round(call_wr - put_wr, 1)

        report['breakdown'][bucket_name] = {
            'call_signals': call_total,
            'call_wins': call_wins,
            'call_winrate': call_wr,
            'put_signals': put_total,
            'put_wins': put_wins,
            'put_winrate': put_wr,
            'gap_call_minus_put': gap,
            'put_status': 'LOSING' if put_wr < 55.6 else 'PROFITABLE' if put_wr >= 55.6 else 'BREAK-EVEN',
        }

    # Overall verdict
    all_puts = [r for r in all_results if r['direction'] == 'PUT' and r['actual_win'] is not None]
    all_calls = [r for r in all_results if r['direction'] == 'CALL' and r['actual_win'] is not None]
    if all_puts:
        put_wr = sum(1 for r in all_puts if r['actual_win']) / len(all_puts) * 100
        call_wr = sum(1 for r in all_calls if r['actual_win']) / len(all_calls) * 100 if all_calls else 0
        report['verdict'] = (
            f"PUTs: {put_wr:.1f}% WR ({len(all_puts)} signals) | "
            f"CALLs: {call_wr:.1f}% WR ({len(all_calls)} signals) | "
            f"Gap: {call_wr - put_wr:+.1f}pp"
        )

    return {'status': 'success', 'report': report}


# ═══════════ MARKET CONNECTION ENDPOINTS ═══════════

import re as _re

def _deep_clean_ssid(raw: str) -> str:
    """
    Nettoyage robuste du SSID — supprime TOUS les caractères invisibles
    et corrections de format courants lors du copier-coller depuis DevTools.
    """
    cleaned = raw

    # 1. Remove BOM (Byte Order Mark) — très commun avec Chrome DevTools
    cleaned = cleaned.replace('\ufeff', '')

    # 2. Remove ALL zero-width and invisible Unicode characters
    cleaned = _re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u00ad]', '', cleaned)

    # 3. Replace smart/curly quotes with straight quotes (copié depuis chat/email)
    cleaned = cleaned.replace('\u201c', '"').replace('\u201d', '"')  # " " → "
    cleaned = cleaned.replace('\u2018', "'").replace('\u2019', "'")  # ' ' → '

    # 4. Replace non-breaking spaces with regular spaces
    cleaned = cleaned.replace('\u00a0', ' ')

    # 5. Remove all newlines, carriage returns, and tabs inside the frame
    # DevTools wraps long frames across multiple lines
    cleaned = _re.sub(r'[\r\n\t]+', '', cleaned)

    # 6. Trim whitespace
    cleaned = cleaned.strip()

    # 7. Fix doubled prefix: 42["auth",42["auth",{...}]  →  42["auth",{...}]
    if '42["auth",42["auth",' in cleaned:
        cleaned = cleaned.replace('42["auth",42["auth",', '42["auth",')
    if '42["auth", 42["auth",' in cleaned:
        cleaned = cleaned.replace('42["auth", 42["auth",', '42["auth",')

    # 8. Handle DevTools frame number prefix (e.g., "4:42["auth"..." or "42:42["auth"...")
    m = _re.match(r'^\d+:(42\["auth")', cleaned)
    if m:
        cleaned = _re.sub(r'^\d+:', '', cleaned)

    # 9. If there's extra text before the actual frame, find the start
    auth_idx = cleaned.find('42["auth"')
    if auth_idx > 0:
        cleaned = cleaned[auth_idx:]

    return cleaned


@app.post("/api/market/connect")
async def connect_market(request: Request, credentials: HTTPAuthorizationCredentials = Security(security)):
    # Validate token type and check revocation
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")

    # Two modes:
    #   {ssid: "42[\"auth\",...]"}     — user pasted a fresh SSID (one-time transit)
    #   {use_saved: true}              — reconnect using the server-side saved SSID
    #                                    (no SSID transits the browser)
    use_saved = data.get("use_saved", False)
    ssid = data.get("ssid")

    # Extract user_id from the JWT (used to scope the saved SSID)
    user_id = _payload.get("sub")

    if use_saved:
        # Reconnect mode — read the encrypted SSID from the market_sessions table
        encrypted_ssid = await get_market_session(user_id) if user_id else None
        ssid_clean = _decrypt_ssid(encrypted_ssid) if encrypted_ssid else None
        if not ssid_clean:
            raise HTTPException(
                status_code=400,
                detail="No saved SSID for your account on the server. Paste a fresh SSID from Pocket Option to connect."
            )
        logger.info(f"[MARKET] Reconnect request — using saved (encrypted) SSID for user_id={user_id[:8] if user_id else 'unknown'}...")
    else:
        if not ssid:
            raise HTTPException(status_code=400, detail="SSID required. Paste the Pocket Option authentication frame, or send {use_saved: true} to reconnect with the saved SSID.")

        # Deep clean the SSID — strip invisible chars, fix encoding issues
        ssid_clean = _deep_clean_ssid(ssid)

    if not ssid_clean.startswith('42["auth"'):
        # Provide specific guidance based on what was detected
        if ssid_clean.startswith('40') or ssid_clean.startswith('40['):
            raise HTTPException(
                status_code=400,
                detail="This is a connection frame (40), not an authentication frame. Look for a frame starting with 42[\"auth\",...] in the WS tab."
            )
        if 'session' in ssid_clean or 'uid' in ssid_clean:
            raise HTTPException(
                status_code=400,
                detail="Auth data detected but the frame does not start with 42[\"auth\". Copy the full message from the beginning."
            )
        raise HTTPException(
            status_code=400,
            detail="Invalid format. The message must start with 42[\"auth\",{...}]. Open F12 → Network → WS and copy the \"auth\" frame."
        )

    try:
        json_start = ssid_clean.find("{")
        json_end = ssid_clean.rfind("}") + 1
        if json_start != -1 and json_end > json_start:
            payload = json.loads(ssid_clean[json_start:json_end])
            # Accept BOTH 'session' (main app socket) AND 'sessionToken'
            # (chart socket). PO maintains two simultaneous WS connections
            # in the browser: the main socket handles account state + asset
            # metadata + chart config; the chart socket handles candle data.
            if "session" not in payload and "sessionToken" not in payload:
                raise HTTPException(
                    status_code=400,
                    detail="Unsupported format. The \"session\" or \"sessionToken\" key is missing. Copy the full authentication frame."
                )
            # Log which socket type we're connecting to
            is_chart = payload.get("isChart") in (1, True)
            if is_chart:
                logger.info("[MARKET] Chart socket SSID detected — connecting for candle data")
        else:
            raise HTTPException(status_code=400, detail="Invalid frame JSON format. Missing braces.")
    except HTTPException:
        raise
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Erreur de parsing JSON: {str(e)}. Vérifiez que vous avez copié le message exact depuis DevTools."
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Erreur de lecture de la trame: {str(e)}")

    # Attempt connection
    logger.info(f"[MARKET] Tentative de connexion (SSID: {ssid_clean[:15]}...)")
    try:
        success = await po_scanner.connect(ssid_clean)
    except Exception as e:
        logger.error(f"[MARKET] Erreur interne de connexion: {e}")
        raise HTTPException(
            status_code=500,
            detail="Internal error connecting to Pocket Option server. Please try again in a few seconds."
        )

    if success:
        is_demo = po_scanner.is_demo
        mode = "DÉMO" if is_demo else "RÉEL"
        logger.info(f"[MARKET] Connecté avec succès — Mode: {mode}")

        # Persist SSID (encrypted) to the market_sessions table for auto-reconnect
        # after Railway redeploy. Only write if this was a fresh SSID paste —
        # skip if we just used the saved one (no need to re-encrypt the same value).
        logger.info(f"[MARKET-DEBUG] use_saved={use_saved}, user_id={user_id[:8] if user_id else 'None'}..., ssid_clean_starts_with_auth={ssid_clean[:8]}")
        if not use_saved and user_id:
            logger.info(f"[MARKET-DEBUG] Entering save block for user_id={user_id[:8]}...")
            try:
                encrypted = _encrypt_ssid(ssid_clean)
                logger.info(f"[MARKET-DEBUG] SSID encrypted (length={len(encrypted)})")
                await save_market_session(user_id, encrypted)
                logger.info(f"[MARKET] SSID saved (encrypted) to DB for user_id={user_id[:8]}... — survives redeploys")
            except Exception as save_err:
                logger.error(f"[MARKET] Could not save SSID for auto-reconnect: {type(save_err).__name__}: {save_err}", exc_info=True)
        else:
            logger.info(f"[MARKET-DEBUG] Save block SKIPPED (use_saved={use_saved}, user_id={'set' if user_id else 'None'})")

        # Kick off an immediate analysis pass in the background so signals
        # start appearing in the UI within 5-10 seconds (not waiting for the
        # next trading_loop cycle or for 3+ minutes of candle building).
        # Fire-and-forget.
        #
        # ═══ GATE-RESPECTING VERSION ═══════════════════════════════════
        # Previously this called force_analyze_pair(pair) for EVERY live pair,
        # which bypassed the 30s emission gate and flooded the page with
        # 9+ signals at once. Now it uses return_candidate=True (like the
        # trading_loop) and emits ONLY the best candidate via _emit_candidate.
        # The gate's last_emission_ts starts at 0, so the first emission
        # after connecting is allowed immediately.
        async def _initial_analysis_kick():
            try:
                # Wait 5 seconds for:
                # 1. PO to push updateAssets (payouts) — ~2s
                # 2. REST API to prefetch 100 historical candles per pair — ~3s
                # After this, full CDC analysis (RSI, EMA, MACD, Bollinger) can run
                await asyncio.sleep(5)
                logger.info("[KICK] Starting INSTANT analysis pass after connection")
                # Use LIVE forex pairs from PO (no hardcoded list)
                live_pairs = list(po_scanner.find_pairs_above_payout(
                    min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
                ).keys())
                if not live_pairs:
                    logger.info("[KICK] No live FOREX pairs meet criteria yet — skipping initial kick")
                    return

                # ═══ COLLECT CANDIDATES + EMIT BEST (gate-respecting) ══════
                # Scan all pairs in candidate mode (no emission), then emit
                # ONLY the highest-scoring one. The 30s gate in _emit_candidate
                # ensures we don't flood the page.
                kick_candidates = []
                for pair in live_pairs:
                    payout = po_scanner.get_payout(pair)
                    if payout and payout >= 70:
                        try:
                            candidate = await analyze_pair(pair, return_candidate=True, strict_mode=True)
                            if candidate:
                                kick_candidates.append(candidate)
                                logger.info(f"[KICK-CANDIDATE] ✅ {pair} {candidate['direction']} score={candidate['score']}/7 ({candidate['winrate']}%) [strict/Option D]")
                        except Exception:
                            pass
                    # Yield to event loop so HTTP requests can be processed
                    await asyncio.sleep(0)

                # Emit the best candidate from the kick (gate is open on first run)
                if kick_candidates:
                    best = max(kick_candidates, key=lambda c: c.get('score', 0))
                    logger.info(f"[KICK-EMIT] Emitting best candidate: {best['pair']} score={best['score']}/7 ({len(kick_candidates)} candidates were available)")
                    await _emit_candidate(best, force=False)
                else:
                    logger.info(f"[KICK] No candidates qualified from {len(live_pairs)} pairs — waiting for main loop")
            except Exception as e:
                logger.warning(f"[KICK] Initial analysis failed: {e}")

        asyncio.create_task(_initial_analysis_kick())

        return {
            "status": "success",
            "message": f"Connecté au marché Pocket Option — Mode {mode}",
            "is_demo": is_demo,
            "uid": payload.get("uid"),
        }
    else:
        logger.warning(f"[MARKET] Échec de connexion — SSID refusé par le serveur")
        raise HTTPException(
            status_code=401,
            detail="Connection failed. Possible causes: (1) Your Pocket Option session was disconnected — log back in to pocketoption.com and copy a new SSID. (2) The SSID still contains invisible characters — try copying it again cleanly. (3) Temporary network issue — try again in a few seconds. Note: the SSID does NOT change until you disconnect your Pocket Option account."
        )

@app.post("/api/market/disconnect")
async def disconnect_market(credentials: HTTPAuthorizationCredentials = Security(security)):
    # Validate token type and check revocation
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = _payload.get("sub")

    await po_scanner.disconnect()

    # Delete the user's saved SSID from the DB so nothing can auto-reconnect
    # with it. (The scanner is shared, so we only delete the calling user's
    # row — other users' saved SSIDs are preserved.)
    if user_id:
        await delete_market_session(user_id)
        logger.info(f"[MARKET] SSID deleted from DB for user_id={user_id[:8]}...")

    return {"status": "success", "message": "Déconnecté du marché"}

@app.get("/api/market/status")
async def get_market_status(credentials: HTTPAuthorizationCredentials = Security(security)):
    # Validate token type and check revocation
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    try:
        # ONLY fetch eligible pairs: active AND payout >= +70%.
        # All other pairs (inactive OR payout < 70%) are EXCLUDED entirely —
        # not displayed, not used for signals. The asset refresh loop polls PO
        # every 5s so this list reflects what PO currently offers as tradable,
        # within ~5 seconds of any change on PO's side.
        all_otc_pairs = po_scanner.find_pairs_above_payout(
            min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
        ) if po_scanner.is_connected else {}

        # Build per-pair status from LIVE data (no hardcoded list).
        # Only includes pairs that meet the criteria (active + payout >= 70% + forex).
        # Inactive or below-threshold pairs are NOT included — they simply don't appear.
        default_pair_status = {}
        if po_scanner.is_connected:
            for pair in all_otc_pairs.keys():
                status = po_scanner.get_pair_status(pair)
                if status and status["is_active"] and status["payout"] is not None and status["payout"] >= 70.0:
                    default_pair_status[pair] = {
                        "payout": status["payout"],
                        "is_active": True,
                        "display": po_scanner.format_payout(status["payout"]),
                    }
                # else: pair is inactive OR payout < 70% → exclude entirely

        # Default payouts dict — only includes pairs that meet the threshold
        default_payouts = {
            pair: info["payout"]
            for pair, info in default_pair_status.items()
        }

        return {
            "is_connected": po_scanner.is_connected,
            # NOTE: ssid_preview was removed — it leaked the first 5 chars of the
            # SSID to the frontend. The SSID is now server-side only. Use
            # GET /api/market/ssid-status to check whether a saved SSID exists
            # (returns a boolean, never the value).
            "is_demo": po_scanner.is_demo,
            "uid": po_scanner._uid,
            # Account balance — extracted from PO's balance events with is_demo filtering.
            # If null, no balance event has been received yet (or all were rejected
            # by the is_demo filter — see /api/market/balance-debug for details).
            "account_balance": po_scanner._balance,
            "balance_source": po_scanner._balance_source,
            "balance_last_updated": po_scanner._balance_last_updated,
            "balance_event_is_demo": po_scanner._balance_event_is_demo,
            # Only includes pairs that are active AND payout ≥ 70%
            "payouts": default_payouts,
            "pair_status": default_pair_status,
            "all_otc_pairs": all_otc_pairs,
            "total_active_pairs_70_plus": len(all_otc_pairs),
            # Freshness report — exposes last_assets_update timestamp + age
            "freshness": po_scanner.get_freshness_report() if po_scanner.is_connected else None,
        }
    except Exception as e:
        logger.error(f"[MARKET STATUS] Error: {e}")
        return {
            "is_connected": False,
            "is_demo": True,
            "uid": None,
            "account_balance": None,
            "balance_source": None,
            "balance_last_updated": None,
            "balance_event_is_demo": None,
            "payouts": {},
            "pair_status": {},
            "all_otc_pairs": {},
            "total_active_pairs_70_plus": 0,
            "freshness": None,
            "error": "Connection error. Please try again."
        }


@app.get("/api/market/ssid-status")
async def get_ssid_status(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Check whether a saved SSID exists on the server (for the reconnect button).

    Returns {connected, has_saved_ssid} — NEVER returns the SSID value itself.
    The frontend uses this to decide whether to show the "Reconnect" button.
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = _payload.get("sub")
    has_saved = await has_market_session(user_id) if user_id else False

    return {
        "connected": bool(po_scanner.is_connected),
        "has_saved_ssid": has_saved,
    }


@app.get("/api/market/ssid-debug")
async def debug_ssid_status(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Diagnostic endpoint — checks whether the market_sessions table exists
    and whether the current user has a saved SSID. Does NOT return the SSID.

    Useful for diagnosing why the 'Reconnect with saved SSID' button isn't
    appearing after a Railway redeploy.
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = _payload.get("sub")
    user_email = _payload.get("email")

    diagnostics = {
        "user_id": user_id[:8] + "..." if user_id else None,
        "user_email": user_email[:3] + "***" if user_email else None,
        "scanner_connected": bool(po_scanner.is_connected),
        "table_exists": False,
        "total_rows": 0,
        "current_user_has_row": False,
        "latest_row": None,
        "errors": [],
    }

    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            # Check if the table exists
            result = await session.execute(
                sql_text(
                    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'market_sessions')"
                )
            )
            diagnostics["table_exists"] = result.scalar()

            if diagnostics["table_exists"]:
                # Count total rows
                result = await session.execute(sql_text("SELECT COUNT(*) FROM market_sessions"))
                diagnostics["total_rows"] = result.scalar() or 0

                # Check if current user has a row
                if user_id:
                    result = await session.execute(
                        sql_text("SELECT COUNT(*) FROM market_sessions WHERE user_id = :uid"),
                        {"uid": user_id}
                    )
                    diagnostics["current_user_has_row"] = (result.scalar() or 0) > 0

                # Get the latest row (without the encrypted_ssid value)
                result = await session.execute(
                    sql_text(
                        "SELECT user_id, created_at, updated_at FROM market_sessions "
                        "ORDER BY updated_at DESC LIMIT 1"
                    )
                )
                row = result.fetchone()
                if row:
                    diagnostics["latest_row"] = {
                        "user_id": row[0][:8] + "..." if row[0] else None,
                        "created_at": row[1].isoformat() if row[1] else None,
                        "updated_at": row[2].isoformat() if row[2] else None,
                    }
    except Exception as e:
        diagnostics["errors"].append(f"{type(e).__name__}: {str(e)[:200]}")

    return diagnostics


@app.post("/api/market/ssid-test-save")
async def test_save_ssid(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Diagnostic endpoint — tries to insert a TEST row into market_sessions
    and returns the full result/error. Does NOT save a real SSID.

    Useful for diagnosing why save_market_session() is failing silently.
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = _payload.get("sub")
    result = {
        "user_id": user_id[:8] + "..." if user_id else None,
        "steps": [],
        "success": False,
        "error": None,
    }

    # Step 1: Check if user exists in users table (FK constraint check)
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            r = await session.execute(
                sql_text("SELECT id, email FROM users WHERE id = :uid"),
                {"uid": user_id}
            )
            row = r.fetchone()
            if row:
                result["steps"].append({"step": "check_user_exists", "ok": True, "detail": f"Found user: {row[1][:3]}***"})
            else:
                result["steps"].append({"step": "check_user_exists", "ok": False, "detail": "User NOT found in users table — FK constraint will reject the insert"})
                result["error"] = "Foreign key violation: user_id does not exist in users table"
                return result
    except Exception as e:
        result["steps"].append({"step": "check_user_exists", "ok": False, "detail": f"{type(e).__name__}: {str(e)[:200]}"})
        result["error"] = f"User check failed: {type(e).__name__}: {str(e)[:200]}"
        return result

    # Step 2: Try a raw SQL INSERT (bypass ORM) to see if the issue is ORM-related
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            await session.execute(
                sql_text(
                    "INSERT INTO market_sessions (user_id, encrypted_ssid) "
                    "VALUES (:uid, :ssid) "
                    "ON CONFLICT (user_id) DO UPDATE SET encrypted_ssid = :ssid"
                ),
                {"uid": user_id, "ssid": "TEST_VALUE_NOT_A_REAL_SSID"}
            )
            await session.commit()
            result["steps"].append({"step": "raw_sql_insert", "ok": True, "detail": "Raw SQL insert succeeded"})
    except Exception as e:
        result["steps"].append({"step": "raw_sql_insert", "ok": False, "detail": f"{type(e).__name__}: {str(e)[:200]}"})
        result["error"] = f"Raw SQL insert failed: {type(e).__name__}: {str(e)[:200]}"
        return result

    # Step 3: Verify the row was saved
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            r = await session.execute(
                sql_text("SELECT COUNT(*) FROM market_sessions WHERE user_id = :uid"),
                {"uid": user_id}
            )
            count = r.scalar()
            result["steps"].append({"step": "verify_row", "ok": count > 0, "detail": f"Row count for this user: {count}"})
    except Exception as e:
        result["steps"].append({"step": "verify_row", "ok": False, "detail": f"{type(e).__name__}: {str(e)[:200]}"})

    # Step 4: Clean up the test row
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text as sql_text
            await session.execute(
                sql_text("DELETE FROM market_sessions WHERE user_id = :uid AND encrypted_ssid = 'TEST_VALUE_NOT_A_REAL_SSID'"),
                {"uid": user_id}
            )
            await session.commit()
            result["steps"].append({"step": "cleanup", "ok": True, "detail": "Test row deleted"})
    except Exception as e:
        result["steps"].append({"step": "cleanup", "ok": False, "detail": f"{type(e).__name__}: {str(e)[:200]}"})

    result["success"] = all(s["ok"] for s in result["steps"][:3])  # cleanup is non-critical
    return result


@app.get("/api/market/balance-debug")
async def debug_balance_data(credentials: HTTPAuthorizationCredentials = Security(security)):
    """
    Balance diagnostic endpoint — exposes the full balance tracking state
    so we can debug why the displayed balance might not match the user's
    actual PO account balance.

    Returns:
      • current_balance: what we're currently storing as the balance
      • balance_source: which event last updated it (auth/balance_event/...)
      • balance_last_updated: ISO timestamp of last accepted update
      • connection_is_demo: whether the user is connected to demo (True) or real (False)
      • last_event_is_demo: is_demo flag from the last balance event received
      • balance_history: last 20 balance updates (with old_balance, source, key_used)
      • raw_events: last 10 raw balance events (including REJECTED ones)

    Common issues this endpoint helps diagnose:
      1. User connected to demo but expects real balance (or vice versa)
         → connection_is_demo will reveal which type they're on
      2. PO sending balance events for wrong account type
         → raw_events[].event_is_demo vs connection_is_demo will mismatch
      3. Balance event arriving but with unrecognized keys
         → raw_events[].accepted=False, raw_events[].raw shows the actual dict
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    if not po_scanner.is_connected:
        return {
            "connected": False,
            "message": "Scanner not connected. Connect via /api/market/connect first.",
            "tip": (
                "Once connected, this endpoint will show every balance event PO sends, "
                "including which ones were accepted vs rejected by the is_demo filter. "
                "If your displayed balance doesn't match your PO UI, check "
                "'connection_is_demo' vs the account type you're viewing in PO."
            ),
        }

    return po_scanner.get_balance_debug_info()


@app.get("/api/market/debug")
async def debug_market_data(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Transparency endpoint — shows ONLY eligible pairs (active AND payout >= +70%).

    Use this to verify that the data shown in the UI matches what PO currently
    offers as TRADABLE pairs. Inactive pairs and below-threshold pairs are
    excluded entirely from the system (matching user requirement: "only fetch,
    display, and use pairs that are active AND have payout >= +70%").

    For diagnostic purposes only, we also include aggregate counts:
      - `freshness`: how stale our data is (should be <10s with the 5s refresh loop)
      - `active_otc_count_70_plus`: eligible pairs (active + payout >= +70%)
      - `active_otc_count_below_70`: active but below threshold (excluded)
      - `inactive_otc_count`: pairs PO has greyed-out right now (excluded)
    Individual inactive pairs are NEVER exposed by name — only aggregate counts.
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    if not po_scanner.is_connected:
        return {
            "connected": False,
            "message": "Scanner not connected. Connect via /api/market/connect first."
        }

    # Get detailed payouts (including is_active flag)
    detailed = po_scanner.get_all_payouts_detailed()

    # Split into OTC vs non-OTC, and active vs inactive.
    # ONLY active OTC pairs with payout ≥ 70% are returned as "tradable".
    # Inactive pairs are counted for transparency but NOT exposed individually.
    active_otc_70_plus = {}   # symbol -> payout  (these are what the system uses)
    active_otc_below_70 = {}  # symbol -> payout  (active but below threshold — excluded)
    active_non_otc = {}
    inactive_otc_count = 0
    inactive_non_otc_count = 0

    for symbol, info in detailed.items():
        payout = info.get("payout", 0)
        is_active = info.get("is_active", True)
        is_otc = "_otc" in symbol.lower()
        if is_active:
            if is_otc:
                if payout >= 70.0:
                    active_otc_70_plus[symbol] = payout
                else:
                    active_otc_below_70[symbol] = payout
            else:
                active_non_otc[symbol] = payout
        else:
            if is_otc:
                inactive_otc_count += 1
            else:
                inactive_non_otc_count += 1

    # Try to fetch a live price for EUR/USD OTC as a final proof of real data
    live_price_eurusd = None
    try:
        live_price_eurusd = await po_scanner.get_current_price("EUR/USD OTC")
    except Exception as e:
        logger.warning(f"[DEBUG] Could not fetch live EUR/USD price: {e}")

    # Show status of major pairs — but ONLY active ones with payout ≥ 70%
    # (inactive or below-threshold pairs are excluded entirely, matching user requirement)
    major_pairs_status = {}
    for pair in ["EUR/USD OTC", "GBP/USD OTC", "USD/JPY OTC", "USD/CHF OTC",
                  "AUD/USD OTC", "USD/CAD OTC", "NZD/USD OTC", "EUR/GBP OTC",
                  "EUR/JPY OTC", "GBP/JPY OTC"]:
        status = po_scanner.get_pair_status(pair)
        if status and status["is_active"] and status["payout"] is not None and status["payout"] >= 70.0:
            major_pairs_status[pair] = {
                "symbol": status["symbol"],
                "payout": status["payout"],
                "display": po_scanner.format_payout(status["payout"]),
                "updated_at": status.get("updated_at"),
            }
        # else: pair is inactive OR payout < 70% → NOT included

    return {
        "connected": True,
        "is_demo": po_scanner.is_demo,
        "uid": po_scanner._uid,
        "total_assets_received": len(detailed),
        # ─── Counts for transparency ────────────────────────────────────
        "active_otc_count_70_plus": len(active_otc_70_plus),
        "active_otc_count_below_70": len(active_otc_below_70),
        "inactive_otc_count": inactive_otc_count,
        "inactive_non_otc_count": inactive_non_otc_count,
        # ─── FRESHNESS DIAGNOSTICS ─────────────────────────────────────
        # If `last_assets_update_age_seconds` is >10s, our payouts may not
        # match PO's UI. The asset refresh loop nudges PO every 5s to push a
        # fresh snapshot, so under normal conditions this age stays <10s.
        "freshness": po_scanner.get_freshness_report(),
        # ─── TRADABLE pairs (active + payout ≥ +70%) ────────────────────
        # These are the ONLY pairs the system actually uses for signal generation.
        "tradable_otc_pairs": active_otc_70_plus,
        # Active OTC pairs with payout < 70% — shown for diagnostic only.
        # System does NOT use these for signal generation (below threshold).
        # They are not displayed to end users in Telegram bot / web UI.
        "active_otc_below_70": active_otc_below_70,
        # Sample of non-OTC active pairs (stocks, crypto, etc.) — diagnostic only
        "active_non_otc_sample": dict(list(active_non_otc.items())[:10]),
        # Major forex pairs — easy to verify against PO UI (only eligible ones)
        "major_pairs_status": major_pairs_status,
        "live_price_eurusd_otc": live_price_eurusd,
        "verification_note": (
            "1. 'tradable_otc_pairs' = pairs the system considers (active + payout >= +70%). "
            "Compare these payouts with what PO shows for the same active pairs "
            "(should match exactly: '+92%', '+78%', etc.). "
            "2. Inactive pairs are EXCLUDED entirely (not fetched, not displayed, not used). "
            "They are counted in 'inactive_otc_count' for transparency only — never by name. "
            "3. Payout update timing is UNPREDICTABLE (PO's internal logic decides). "
            "The refresh loop nudges PO every 5s so our view stays within ~5s of PO's UI. "
            "4. Check 'freshness.last_assets_update_age_seconds' — should always be <10s. "
            "5. 'freshness.refresh_interval_seconds' = 5 (the nudge interval)."
        )
    }


@app.get("/api/market/debug/search")
async def debug_search_symbols(
    q: str = "",
    credentials: HTTPAuthorizationCredentials = Security(security)
):
    """DIAGNOSTIC: Search ALL raw symbols in PO's asset list by substring.

    This endpoint exposes the RAW underlying data PO sent us — every symbol
    whose name contains the query substring (case-insensitive), with its full
    payout + is_active + display name.

    Use this to diagnose payout mismatches. Example:
      GET /api/market/debug/search?q=GBPJPY
    Returns every symbol PO sent containing "GBPJPY" — shows whether PO is
    sending multiple OTC variants, what payouts each has, and which one our
    code picks.

    NO filtering — shows inactive pairs too (for diagnosis only).
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    if not po_scanner.is_connected:
        return {"connected": False, "message": "Scanner not connected."}

    if not q:
        return {"error": "Add ?q=SEARCH_TERM to search (e.g. ?q=GBPJPY)"}

    q_upper = q.upper()
    detailed = po_scanner.get_all_payouts_detailed()

    matches = []
    for symbol, info in detailed.items():
        if q_upper in symbol.upper():
            display = po_scanner._symbol_to_display(symbol)
            matches.append({
                "symbol": symbol,
                "display_name": display,
                "po_display_name": info.get("po_display_name"),  # PO's own label from index 2
                "payout": info.get("payout"),
                "is_active": info.get("is_active"),
                "updated_at": info.get("updated_at"),
            })

    # Sort by payout descending so the highest is at the top
    matches.sort(key=lambda x: x.get("payout", 0), reverse=True)

    # Test what our code returns for BOTH OTC and non-OTC display names
    # (the bot list uses find_pairs_above_payout, signals use get_payout)
    test_results = {}
    if matches:
        # Find the OTC variant and non-OTC variant
        otc_match = next((m for m in matches if "_otc" in m["symbol"].lower()), None)
        non_otc_match = next((m for m in matches if "_otc" not in m["symbol"].lower()), None)

        if otc_match:
            otc_display = otc_match["display_name"]
            test_results["get_payout_for_otc"] = {
                "display_name": otc_display,
                "returns": po_scanner.get_payout(otc_display),
            }
        if non_otc_match:
            non_otc_display = non_otc_match["display_name"]
            test_results["get_payout_for_non_otc"] = {
                "display_name": non_otc_display,
                "returns": po_scanner.get_payout(non_otc_display),
            }

    # Also show what find_pairs_above_payout returns (this is what the bot list uses)
    eligible_pairs = po_scanner.find_pairs_above_payout(
        min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
    )
    # Filter to only pairs matching the query
    eligible_matches = {
        k: v for k, v in eligible_pairs.items()
        if q_upper in k.upper().replace('/', '').replace(' ', '')
    }

    return {
        "connected": True,
        "query": q,
        "total_matches": len(matches),
        "all_matching_symbols": matches,
        "our_code_returns": test_results,
        "find_pairs_above_payout_returns": eligible_matches,
        "freshness": po_scanner.get_freshness_report(),
        "diagnostic_note": (
            "1. 'all_matching_symbols' = EVERY symbol PO sent us containing the query. "
            "If you see a symbol with a payout matching PO's UI, our code should use it. "
            "2. 'our_code_returns.get_payout_for_otc.returns' = what get_payout() returns "
            "for the OTC display name. This should match the HIGHEST OTC payout. "
            "3. 'find_pairs_above_payout_returns' = what the bot pair list actually displays. "
            "4. If NONE of the symbols shown here match what PO's UI displays, then PO is "
            "sending us different data via WebSocket than what they show in their UI — "
            "this is a PO-side discrepancy we cannot fix from our end. "
            "5. Payouts fluctuate — PO changes them frequently based on market conditions. "
            "A 92% payout can become 85% within seconds."
        )
    }


@app.get("/api/market/debug/raw-frame")
async def debug_raw_frame(
    credentials: HTTPAuthorizationCredentials = Security(security)
):
    """DIAGNOSTIC: Show the RAW data PO sent us in the latest bare frame.

    This exposes the EXACT raw fields PO sent for each forex OTC pair,
    so we can compare with PO's UI to determine if:
    - Our parser is reading the wrong field
    - PO is sending us different data than what they display
    - There's a field layout mismatch

    Returns:
    - Last frame timestamp + age
    - For each forex OTC pair: all 19 raw fields + our parsed payout
    - Field layout reference for comparison
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    if not po_scanner.is_connected:
        return {"connected": False, "message": "Scanner not connected."}

    raw_sample = getattr(po_scanner, '_last_forex_raw_sample', [])
    raw_frame_count = len(getattr(po_scanner, '_last_raw_frame', []))

    return {
        "connected": True,
        "freshness": po_scanner.get_freshness_report(),
        "total_assets_in_last_frame": raw_frame_count,
        "forex_otc_sample": raw_sample,
        "field_layout_reference": {
            "0": "type_marker (always 5)",
            "1": "symbol (e.g. EURUSD_otc)",
            "2": "display_label (e.g. EUR/USD OTC)",
            "3": "type (currency/stock/crypto)",
            "4": "precision",
            "5": "PAYOUT % (0-92)",
            "6": "min_duration",
            "7": "max_duration",
            "8": "step_duration",
            "9": "volatility_index",
            "10": "spread",
            "11": "leverage",
            "12": "extra_data",
            "13": "expire_time",
            "14": "is_active (true/false)",
            "15": "timeframes",
            "16": "start_time",
            "17": "default_timeframe",
            "18": "status_code",
        },
        "note": (
            "Compare 'parsed_payout' with what PO's UI shows for each pair. "
            "If they match, our parser is correct. If they don't, check the "
            "'raw_fields' array to see if the payout is at a different index. "
            "The raw_fields show ALL 19 fields PO sent, so you can identify "
            "which index contains the correct payout value."
        )
    }


@app.get("/api/market/debug/payout-changes")
async def debug_payout_changes(
    credentials: HTTPAuthorizationCredentials = Security(security)
):
    """DIAGNOSTIC: Show recent payout changes in real-time.

    Returns:
    - List of recent payout changes (last 50)
    - Current freshness of payout data
    - Event statistics (which PO events we've received)
    - Sample of current payouts for major pairs
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    if not po_scanner.is_connected:
        return {"connected": False, "message": "Scanner not connected."}

    # Get event statistics
    event_counts = getattr(po_scanner, '_event_counts', {})
    seen_events = getattr(po_scanner, '_seen_events', set())
    payout_event_count = getattr(po_scanner, '_payout_event_count', 0)
    bare_frame_count = getattr(po_scanner, '_bare_frame_count', 0)

    # Get current payouts for major pairs
    major_pairs = ["EUR/USD OTC", "GBP/USD OTC", "USD/JPY OTC", "GBP/JPY OTC",
                   "AUD/JPY OTC", "USD/CHF OTC", "EUR/GBP OTC", "EUR/TRY OTC",
                   "USD/PKR OTC", "USD/RUB OTC", "NGN/USD OTC", "TND/USD OTC"]
    current_payouts = {}
    for pair in major_pairs:
        payout = po_scanner.get_payout(pair)
        if payout is not None:
            current_payouts[pair] = payout

    return {
        "connected": True,
        "freshness": po_scanner.get_freshness_report(),
        "event_statistics": {
            "total_event_types": len(event_counts),
            "event_counts": dict(sorted(event_counts.items(), key=lambda x: x[1], reverse=True)[:15]),
            "seen_events": sorted(list(seen_events)) if seen_events else [],
            "payout_events_received": payout_event_count,
            "bare_payout_frames_received": bare_frame_count,
        },
        "current_major_payouts": current_payouts,
        "note": (
            "1. 'event_counts' shows which events PO is sending us. "
            "Look for 'updateAssets', 'payout', 'payoutChange' — these carry payout data. "
            "2. 'bare_payout_frames_received' > 0 means the REAL-TIME payout parser is working! "
            "PO sends bare [[5,...]] frames with fresh payouts — these are now caught and parsed. "
            "3. 'payout_events_received' tracks Socket.IO payout events (may be 0 — that's OK now). "
            "4. 'freshness.last_assets_update_age_seconds' should be <60s (PO pushes every 30-60s). "
            "5. 'current_major_payouts' shows what we currently have — compare with PO's UI right now."
        )
    }


@app.get("/api/market/debug/verify-payouts")
async def debug_verify_payouts(
    pairs: str = "",
    credentials: HTTPAuthorizationCredentials = Security(security)
):
    """DIAGNOSTIC: Batch-verify payouts for multiple pairs at once.

    Pass pairs as a comma-separated list of "DISPLAY_NAME=EXPECTED_PAYOUT" pairs.
    Example: /api/market/debug/verify-payouts?pairs=GBP/JPY OTC=84,USD/CHF OTC=84,AUD/JPY OTC=90

    Returns a verification report showing:
    - What PO UI claims (expected)
    - What our system has (actual)
    - Match status (MATCH / MISMATCH / NOT FOUND)
    - All raw symbols PO sent us for each pair
    """
    _payload = decode_access_token(credentials.credentials)
    _jti = _payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    if not po_scanner.is_connected:
        return {"connected": False, "message": "Scanner not connected."}

    if not pairs:
        return {"error": "Add ?pairs=LIST where LIST is comma-separated 'NAME=PAYOUT' entries"}

    detailed = po_scanner.get_all_payouts_detailed()

    # Parse the input: "GBP/JPY OTC=84,USD/CHF OTC=84" → list of (name, expected)
    entries = []
    for raw in pairs.split(','):
        raw = raw.strip()
        if not raw or '=' not in raw:
            continue
        name, expected_str = raw.rsplit('=', 1)
        name = name.strip()
        try:
            expected = float(expected_str.strip())
        except ValueError:
            continue
        entries.append((name, expected))

    results = []
    for display_name, expected in entries:
        # Determine if the request is for OTC or non-OTC
        request_is_otc = "otc" in display_name.lower()

        # Find ALL raw symbols that match this display name
        # Normalize: remove slashes, spaces, AND the OTC suffix (so "USD/PKR OTC" → "USDPKR")
        # Then compare against symbols normalized the same way ("USDPKR_otc" → "USDPKR")
        base_no_otc = display_name.replace('/', '').replace(' ', '').upper()
        # Remove OTC suffix from display name (handle "OTC" and "_OTC")
        for suffix in ['_OTC', '_otc', 'OTC']:
            if base_no_otc.endswith(suffix):
                base_no_otc = base_no_otc[:-len(suffix)]
        base_no_otc = base_no_otc.lstrip('#')

        matches = []
        for symbol, info in detailed.items():
            # Normalize symbol the same way: "USDPKR_otc" → "USDPKR"
            sym_normalized = symbol.upper().replace('_', '').lstrip('#')
            # Remove OTC suffix from symbol too
            for suffix in ['OTC']:
                if sym_normalized.endswith(suffix):
                    sym_normalized = sym_normalized[:-len(suffix)]
            if sym_normalized == base_no_otc:
                sym_is_otc = "_otc" in symbol.lower()
                # Include if OTC-ness matches the request
                if sym_is_otc == request_is_otc:
                    matches.append({
                        "symbol": symbol,
                        "payout": info.get("payout"),
                        "is_active": info.get("is_active"),
                        "po_display_name": info.get("po_display_name"),
                    })

        # Sort by payout descending
        matches.sort(key=lambda x: x.get("payout", 0), reverse=True)

        # What our code returns
        our_payout = po_scanner.get_payout(display_name)

        # Match status (within 1% tolerance for rounding)
        if our_payout is None:
            status = "NOT_FOUND"
        elif abs(our_payout - expected) <= 1.0:
            status = "MATCH"
        else:
            status = "MISMATCH"

        results.append({
            "display_name": display_name,
            "po_ui_payout": expected,
            "our_payout": our_payout,
            "status": status,
            "all_raw_symbols": matches,
        })

    # Summary
    matched = sum(1 for r in results if r["status"] == "MATCH")
    mismatched = sum(1 for r in results if r["status"] == "MISMATCH")
    not_found = sum(1 for r in results if r["status"] == "NOT_FOUND")

    return {
        "connected": True,
        "freshness": po_scanner.get_freshness_report(),
        "summary": {
            "total_checked": len(results),
            "matched": matched,
            "mismatched": mismatched,
            "not_found": not_found,
        },
        "results": results,
    }


@app.middleware("http")
async def rate_limit_middleware(request, call_next):
    # CDC Section 8: Measure request latency
    start_time = time()
    
    client_ip = request.client.host if request.client else "unknown"
    now = datetime.now(timezone.utc).timestamp()
    
    # Skip rate limiting for health check endpoints
    if request.url.path in ["/", "/health", "/api/status", "/api/market/status", "/api/market/debug", "/api/market/balance-debug", "/api/debug/schema"]:
        response = await call_next(request)
        latency_ms = (time() - start_time) * 1000
        _latency_samples.append(latency_ms)
        return response
    
    if client_ip not in rate_limit_data:
        rate_limit_data[client_ip] = []
    
    # Clean old entries
    rate_limit_data[client_ip] = [t for t in rate_limit_data[client_ip] if now - t < RATE_LIMIT_WINDOW]
    
    if len(rate_limit_data[client_ip]) >= RATE_LIMIT_REQUESTS:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Please try again later.")
    
    rate_limit_data[client_ip].append(now)
    response = await call_next(request)
    
    # Record latency
    latency_ms = (time() - start_time) * 1000
    _latency_samples.append(latency_ms)
    
    return response


# ═══════════ DIAGNOSTIC ENDPOINT (admin-only) ═══════════
# Was previously public (no auth) — exposed DB schema (table names + column
# types for password_reset_otps and the full public table list) to anyone.
# Now requires admin auth. Safe to keep for debugging schema-migration issues.
@app.get("/api/debug/schema")
async def debug_schema(admin_payload = Depends(require_admin)):
    """Admin-only diagnostic — returns the actual columns of password_reset_otps
    and the list of all public tables. Used for diagnosing schema-migration
    issues (e.g. missing `purpose` column on Supabase PgBouncer).
    """
    try:
        async with AsyncSessionLocal() as session:
            from sqlalchemy import text
            result = await session.execute(text(
                "SELECT column_name, data_type, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_name = 'password_reset_otps' "
                "ORDER BY ordinal_position"
            ))
            rows = result.fetchall()
            columns = [
                {
                    "name": r[0],
                    "type": r[1],
                    "nullable": r[2],
                    "default": r[3]
                }
                for r in rows
            ]

            # Also list all tables
            tables_result = await session.execute(text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' ORDER BY table_name"
            ))
            tables = [r[0] for r in tables_result.fetchall()]

            return {
                "password_reset_otps_columns": columns,
                "all_tables": tables,
                "purpose_column_exists": any(c["name"] == "purpose" for c in columns)
            }
    except Exception as e:
        return {"error": str(e), "type": type(e).__name__}
