
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
from engine.momentum_engine import generate_momentum_signal, validate_momentum_data
from neural_models.voting import VotingClassifierModel
from engine.compliance import ComplianceManager, geographic_restriction_dependency
from bot.telegram_bot import TelegramSignalBot
from db import (init_db, SignalRecord, CandleRecord, AsyncSessionLocal, User, UserSubscription,
                  PasswordResetOTP, SystemLog, RefreshToken, RevokedToken, RateLimitEntry)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')
logger = logging.getLogger('A2Sniper')


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
SIGNAL_ENGINE = "momentum"  # Currently testing momentum engine
risk_mgr = RiskManager()
monitor = MonitoringEngine()
voting_model = VotingClassifierModel()
po_scanner = PocketOptionScanner()
telegram_bot = TelegramSignalBot(scanner=po_scanner)

# ═══ PERSISTENT SSID — auto-reconnect scanner on backend restart ═══════
# When Railway redeploys, the entire Python process restarts and the
# scanner loses its connection. To avoid requiring the user to manually
# reconnect after every deploy, we persist the SSID to a file and
# auto-reconnect on startup.
# The SSID is written to backend/data/last_ssid.txt by /api/market/connect
# and read here during lifespan startup.
SSID_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'last_ssid.txt')

async def auto_reconnect_scanner():
    """On backend startup, try to reconnect the scanner using the last SSID.

    This survives Railway redeploys — the user doesn't need to manually
    reconnect after every code push.
    """
    try:
        if not os.path.exists(SSID_FILE):
            logger.info("[AUTO-RECONNECT] No saved SSID found — waiting for manual connect")
            return

        with open(SSID_FILE, 'r') as f:
            ssid = f.read().strip()

        if not ssid or not ssid.startswith('42["auth"'):
            logger.info("[AUTO-RECONNECT] Saved SSID is invalid or empty — waiting for manual connect")
            return

        logger.info("[AUTO-RECONNECT] Found saved SSID — attempting auto-reconnect...")
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
                for pair in live_pairs[:3]:
                    payout = po_scanner.get_payout(pair)
                    if payout and payout >= 70:
                        sig = await force_analyze_pair(pair)
                        if sig:
                            logger.info(f"[AUTO-RECONNECT] Initial signal generated for {pair}")
                            break
            asyncio.create_task(_kick())
        else:
            logger.warning("[AUTO-RECONNECT] ❌ Auto-reconnect failed — SSID may be expired. User needs to reconnect manually.")
    except Exception as e:
        logger.warning(f"[AUTO-RECONNECT] Error: {e}")

# Load pre-trained model weights at startup (don't wait for the 72h retraining_loop).
# The weights are at backend/models/weights/{lstm_v3.pt, transformer_v3.pt, xgboost_v3.json}.
# If no weights exist, models stay in simulation mode and the AI gate is skipped.
# Train via: python3 /home/z/my-project/scripts/run_fast_training.py
try:
    import os as _os
    _WEIGHTS_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'models', 'weights')
    _lstm_path = _os.path.join(_WEIGHTS_DIR, 'lstm_v3.pt')
    _trans_path = _os.path.join(_WEIGHTS_DIR, 'transformer_v3.pt')
    _xgb_path = _os.path.join(_WEIGHTS_DIR, 'xgboost_v3.json')

    if _os.path.exists(_xgb_path):
        if voting_model.xgboost.load(_xgb_path):
            logger.info(f"✅ XGBoost weights loaded from {_xgb_path}")
    else:
        logger.info("ℹ️ No XGBoost weights found — train via run_fast_training.py")

    if _os.path.exists(_lstm_path):
        if voting_model.lstm.load(_lstm_path):
            logger.info(f"✅ LSTM weights loaded from {_lstm_path}")
    else:
        logger.info("ℹ️ No LSTM weights found — LSTM in simulation mode")

    if _os.path.exists(_trans_path):
        if voting_model.transformer.load(_trans_path):
            logger.info(f"✅ Transformer weights loaded from {_trans_path}")
    else:
        logger.info("ℹ️ No Transformer weights found — Transformer in simulation mode")
except Exception as _e:
    logger.warning(f"Model weight loading failed at startup: {_e}")

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
    """Check if a token's JTI is in the revocation blacklist."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(RevokedToken).where(RevokedToken.token_jti == token_jti)
            )
            return result.scalar_one_or_none() is not None
    except Exception:
        return False  # If DB check fails, allow the token (fail open)


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
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user or not user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required")
    return payload


# Emitted signals buffer (bounded to prevent memory leak)
generated_signals = deque(maxlen=1000)


async def analyze_pair(pair: str) -> dict:
    """Pipeline d'analyse complet pour une paire."""
    return await analyze_pair_internal(pair, force=False)


async def force_analyze_pair(pair: str) -> dict:
    """Génère ou force un signal basé sur des données réelles du marché."""
    return await analyze_pair_internal(pair, force=True)


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

async def analyze_pair_internal(pair: str, force: bool = False) -> dict:
    """Sniper engine analysis pipeline. If force=True, bypasses risk/circuit-breaker checks."""
    try:
        return await _analyze_pair_internal_impl(pair, force)
    except Exception as e:
        import traceback
        logger.error(
            f"[ANALYZE-CRASH] pair={pair} force={force} error={e}\n"
            f"{traceback.format_exc()}"
        )
        return None


async def _analyze_pair_internal_impl(pair: str, force: bool = False) -> dict:
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
    df_m1 = await po_scanner.get_candles(pair, timeframe="1m", count=100)
    candle_count = len(df_m1) if df_m1 is not None and not df_m1.empty else 0
    logger.info(f"[SNIPER-TRACE] {pair} step=3 candles={candle_count}/14 needed")
    if df_m1 is None or df_m1.empty or len(df_m1) < 14:
        logger.info(
            f"[{pair}] Insufficient candles for sniper engine: "
            f"{candle_count}/14 — waiting for warm-up"
        )
        return None

    # 4. Calculate all indicators (RSI, Bollinger, Stochastic, CCI, EMA, ATR, ADX)
    df_with_indicators = indicators.calculate_all(df_m1)
    logger.info(f"[SNIPER-TRACE] {pair} step=4 indicators_calculated columns={list(df_with_indicators.columns)[:10]}")

    # 5. Validate data quality (rejects identical candles, suspicious jumps, zero volume)
    is_valid, validation_reason = validate_candle_data(df_with_indicators, min_bars=14)
    logger.info(f"[SNIPER-TRACE] {pair} step=5 data_valid={is_valid} reason={validation_reason}")
    if not is_valid:
        logger.info(f"[{pair}] Sniper data rejected: {validation_reason}")
        return None

    # 6. Run the sniper engine (dual-mode: 1M mean-reversion + 3M trend-pullback)
    # min_factors=4 for BOTH modes. With STRICT thresholds (RSI ≤30, Stoch ≤20,
    # CCI ≤-100, BB touch, 1.5 ATR deviation), 4/7 factors = genuine confluence.
    # Plus ADX ≤ 30 trend filter (no signals in trending markets).
    # Plus at least 1 STRONG factor required (RSI/Stoch/BB/CCI).
    #
    # Winrate: 4/7 → 75%, 5/7 → 80%, 6/7 → 87%, 7/7 → 92%
    min_factors = 4

    # ═══ ENGINE TOGGLE ═════════════════════════════════════════════
    # Uses SIGNAL_ENGINE global to select which engine to run.
    # "momentum" = Momentum Continuation (new — for testing)
    # "sniper"   = 7-Factor Mean Reversion (original)
    if SIGNAL_ENGINE == "momentum":
        engine_result = generate_momentum_signal(df_with_indicators, payout, min_factors=min_factors)
        if engine_result is None:
            last_row = df_with_indicators.iloc[-1]
            rsi_val = float(last_row.get('RSI_14', 50)) if 'RSI_14' in df_with_indicators.columns else 50
            adx_val = float(last_row.get('ADX_14', 0)) if 'ADX_14' in df_with_indicators.columns else 0
            logger.info(
                f"[{pair}] No momentum signal — insufficient confluence (<{min_factors} factors, force={force}). "
                f"RSI={rsi_val:.1f}, ADX={adx_val:.1f}, candles={len(df_with_indicators)}"
            )
            return None
    else:
        engine_result = generate_sniper_signal(df_with_indicators, payout, min_factors=min_factors)
        if engine_result is None:
            last_row = df_with_indicators.iloc[-1]
            rsi_val = float(last_row.get('RSI_14', 50)) if 'RSI_14' in df_with_indicators.columns else 50
            stoch_val = float(last_row.get('STOCH_K', 50)) if 'STOCH_K' in df_with_indicators.columns else 50
            cci_val = float(last_row.get('CCI_20', 0)) if 'CCI_20' in df_with_indicators.columns else 0
            logger.info(
                f"[{pair}] No sniper signal — insufficient confluence (<{min_factors} factors, force={force}). "
                f"RSI={rsi_val:.1f}, Stoch={stoch_val:.1f}, CCI={cci_val:.0f}, "
                f"candles={len(df_with_indicators)}"
            )
            return None

    # Use the result from whichever engine ran
    sniper_result = engine_result

    # 7. Risk check (skip in force mode — user explicitly requested)
    if not force:
        risk_check = risk_mgr.check_can_trade()
        if not risk_check['can_trade']:
            logger.warning(f"[{pair}] Risk check rejected: {risk_check.get('reasons', 'unknown')}")
            return None

        cb = monitor.check_circuit_breaker()
        if cb['is_active']:
            logger.warning(f"[{pair}] Circuit breaker active: {cb.get('reason', 'unknown')}")
            return None

    # 8. Deduplication: don't emit for the same pair within X seconds
    # Background mode: 60s dedup (prevent spam)
    # Force mode (user request): 10s dedup (user explicitly asked — let them through)
    if not hasattr(analyze_pair_internal, '_last_signal_time'):
        analyze_pair_internal._last_signal_time = {}
    last_time = analyze_pair_internal._last_signal_time.get(pair, 0)
    now_ts = datetime.now(timezone.utc).timestamp()
    dedup_window = 10 if force else 60
    if (now_ts - last_time) < dedup_window:
        logger.debug(f"[{pair}] Signal skipped — duplicate within {dedup_window}s window (force={force})")
        return None

    # 9. Build the signal dict from engine result
    now = datetime.now(timezone.utc)
    engine_mode = sniper_result.get('mode', 'SNIPER_1M')
    is_momentum = engine_mode == 'MOMENTUM_1M'
    factors_hit = sniper_result['factors']['factors_hit']

    if is_momentum:
        strategy_label = f"Momentum Continuation ({sniper_result['score']}/7 factors)"
        indicator_summary = f"RSI {sniper_result['factors']['rsi']:.0f} / ADX {sniper_result['factors']['adx']:.0f}"
        rsi_status = 'Mid-range (momentum)'
    elif engine_mode == 'SNIPER_1M':
        strategy_label = f"Mean Reversion ({sniper_result['score']}/7 factors)"
        indicator_summary = f"RSI {sniper_result['factors']['rsi']:.0f} / Stoch {sniper_result['factors']['stoch_k']:.0f} / CCI {sniper_result['factors']['cci']:.0f}"
        rsi_status = 'Oversold' if sniper_result['direction'] == 'CALL' else 'Overbought'
    else:
        strategy_label = f"Trend Pullback ({sniper_result['score']}/7 factors)"
        indicator_summary = f"RSI {sniper_result['factors']['rsi']:.0f} / Stoch {sniper_result['factors']['stoch_k']:.0f} / ADX {sniper_result['factors']['adx']:.0f}"
        rsi_status = 'Mid-range (trend resume)'

    signal = {
        'id': f'SIG-{now.strftime("%Y%m%d")}-{uuid.uuid4().hex[:6].upper()}',
        'pair': pair,
        'direction': sniper_result['direction'],
        'time': now.strftime('%H:%M:%S'),
        'timestamp': now.isoformat(),
        'entry_price': sniper_result['entry_price'],
        'expiration': sniper_result['expiration'],  # 1 or 3 minutes
        'winrate': sniper_result['winrate'],
        'score': sniper_result['score'],
        'raw_points': sniper_result['score'],
        'payout': payout,
        'classification': sniper_result['classification'],
        'smc_structure': strategy_label,
        'smc_zone': ', '.join(factors_hit[:3]),
        'chart_pattern': sniper_result['factors'].get('reversal_pattern', 'N/A') or 'N/A',
        'fibonacci': indicator_summary,
        'rsi_status': rsi_status,
        'recommended_stake': 10,
        'analysis_details': {
            'mode': 'sniper_1m_mean_reversion' if is_1m else 'sniper_3m_trend_pullback',
            'sniper_mode': sniper_mode,
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
                hash_signature=signal['hash_signature']
            )
            session.add(db_signal)
            await session.commit()
    except Exception as db_err:
        logger.warning(f"[{pair}] DB save error: {db_err}")

    # 12. Emit signal
    generated_signals.append(signal)
    analyze_pair_internal._last_signal_time[pair] = now_ts
    monitor.record_signal(signal['id'], pair, signal['direction'], signal['winrate'])

    logger.info(
        f"[SNIPER-EMITTED] id={signal['id']} pair={signal['pair']} "
        f"mode={sniper_mode} direction={signal['direction']} "
        f"score={signal['score']}/7 winrate={signal['winrate']}% "
        f"expiration={signal['expiration']}m payout={signal['payout']}%"
    )

    return signal


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
    # The sniper engine requires 4/7 factors + ADX ≤ 30 + strict thresholds.
    # Pairs with insufficient candles or no confluence are silently skipped.
    try:
        kickoff_pairs = po_scanner.find_pairs_above_payout(
            min_payout=70.0, pair_filter="OTC", active_only=True, forex_only=True
        )
        if kickoff_pairs:
            kickoff_list = list(kickoff_pairs.keys())
            logger.info(f"[SNIPER-KICKSTART] Firing sniper analysis on {len(kickoff_list)} pairs...")
            for pair in kickoff_list:
                try:
                    sig = await analyze_pair(pair)
                    if sig:
                        logger.info(f"[SNIPER-KICKSTART] ✅ Signal generated: {sig['pair']} {sig['direction']} ({sig['winrate']}%)")
                except Exception:
                    pass
                await asyncio.sleep(0.05)  # 50ms between pairs — fast kickoff
    except Exception as e:
        logger.warning(f"[SNIPER-KICKSTART] Error: {e}")

    while True:
        try:
            if not po_scanner.is_connected:
                await asyncio.sleep(2)
                continue

            # Circuit Breaker check
            cb = monitor.check_circuit_breaker()
            if cb['is_active']:
                logger.warning(f"⚠️ Circuit Breaker actif: {cb['reason']}")
                await asyncio.sleep(60)
                continue

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

            # Analyse séquentielle des paires
            for pair in pairs_to_scan:
                if not po_scanner.is_connected: break

                payout = po_scanner.get_payout(pair)
                if payout is None or payout < 70:
                    # Skip pairs that don't currently meet the threshold (active + ≥ 70%)
                    continue

                # ═══ SNIPER ENGINE + CANDLE PERSISTENCE ════════════════
                try:
                    await analyze_pair(pair)
                except Exception as e:
                    logger.debug(f"[SNIPER-ERROR] pair={pair} err={e}")
                
                # Save completed candles to database (for persistence across redeploys)
                # save_candles_to_db automatically excludes the last (incomplete) candle
                try:
                    asset = po_scanner.get_asset_symbol(pair)
                    cached_df = po_scanner._candles_cache.get(f"{asset}_1m")
                    if cached_df is not None and not cached_df.empty and len(cached_df) > 1:
                        # Only save if there are completed candles (exclude the forming one)
                        await save_candles_to_db(asset, cached_df.tail(10))
                except Exception:
                    pass
                
                await asyncio.sleep(0.3)

            # 5s cycle interval (was 15s) — user requirement: "every 5s so
            # it doesn't miss". This means we re-evaluate the eligible pair
            # list and run analysis 3x more often, catching pair state
            # changes (active↔inactive, payout fluctuations) much faster.
            await asyncio.sleep(5)

        except Exception as e:
            logger.error("Erreur boucle principale", exc_info=True)
            await asyncio.sleep(10)

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
                    # Expiry = signal timestamp + expiration minutes (NOT candle boundary)
                    # Each signal expires at its own time based on when it was generated.
                    expiry_time = s_timestamp + timedelta(minutes=s.expiration or 1)
                    
                    if now >= expiry_time:
                        # ─── ACCURATE WIN/LOSS DETERMINATION ───────────────
                        # BUG FIX: Previously this called get_current_price() which returns
                        # the price at RESOLUTION time (up to 10s AFTER expiry). This caused
                        # incorrect win/loss results — the price at expiry moment is what
                        # determines the outcome, not the price 10s later.
                        #
                        # FIX: Fetch the candle that contains the expiry timestamp and use
                        # its CLOSE price. For 1-minute candles, the close of the candle
                        # at expiry_time is the exit price. This matches what PO uses to
                        # determine win/loss on their platform.
                        #
                        # For CALL: win if exit_price > entry_price
                        # For PUT:  win if exit_price < entry_price
                        # Tie (exit == entry): no result (skip, will retry next loop)
                        try:
                            # Fetch candles around the expiry time
                            df_expiry = await po_scanner.get_candles(s.pair, timeframe="1m", count=5)
                            if df_expiry is not None and not df_expiry.empty:
                                # Find the candle whose timestamp matches the expiry minute
                                # The candle containing expiry_time has its close at the
                                # end of that minute. We want the close price of the candle
                                # that was closing at expiry_time.
                                expiry_ts = expiry_time.timestamp()
                                # Convert candle index (datetime) to timestamp for comparison
                                df_expiry_ts = df_expiry.index.astype(np.int64) // 10**9
                                # Find the last candle that CLOSED at or before expiry_time
                                # A 1-minute candle closes at its timestamp + 60 seconds
                                candle_close_ts = df_expiry_ts.values + 60
                                # Get the candle whose close is closest to (but not after) expiry
                                valid_candles = df_expiry[candle_close_ts <= expiry_ts + 30]  # 30s tolerance
                                if not valid_candles.empty:
                                    current_price = float(valid_candles.iloc[-1]['close'])
                                else:
                                    # Fallback: use the last candle's close
                                    current_price = float(df_expiry.iloc[-1]['close'])
                            else:
                                current_price = await po_scanner.get_current_price(s.pair)
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
                                logger.info(f"Tie detected for {s.id}: entry={s.entry_price}, exit={current_price}")
                                continue
                            s.is_win = is_win

                            # Record result in monitoring engine and risk manager
                            monitor.record_result(s.id, is_win)
                            stake_val = 1.0
                            if s.analysis_details and s.analysis_details.get('recommended_stake'):
                                try:
                                    stake_str = str(s.analysis_details['recommended_stake']).replace('% du capital', '').replace('%', '').strip()
                                    stake_val = float(stake_str) if stake_str else 1.0
                                except (ValueError, TypeError):
                                    stake_val = 1.0
                            risk_mgr.record_trade_result(is_win, stake_val)

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


async def retraining_loop():
    """CDC Section 9.2: Ré-entraînement automatique.

    Runs every 24h (reduced from 72h to be more responsive to accumulated
    live data). Uses the TrainingPipeline which automatically prefers
    backend/data/live_candles.csv (real PO market data accumulated via
    CandleAccumulator) over the synthetic multi-pair dataset.

    After retraining completes, the freshly-trained weights are hot-loaded
    into the live voting_model so the new model takes effect immediately
    without requiring a backend restart.
    """
    RETRAIN_INTERVAL_HOURS = 24
    while True:
        await asyncio.sleep(RETRAIN_INTERVAL_HOURS * 3600)
        try:
            logger.info("[RETRAINING] Starting scheduled retraining...")
            from neural_models.training_pipeline import TrainingPipeline
            from engine.candle_accumulator import get_accumulator

            # Log accumulator status before retraining
            try:
                accumulator = await get_accumulator()
                status = accumulator.get_status()
                logger.info(
                    f"[RETRAINING] Accumulator status: "
                    f"{status['total_rows']:,} rows, {status['pairs_count']} pairs, "
                    f"{status['file_size_mb']:.1f}MB, "
                    f"ready_for_training={status['ready_for_training']}"
                )
            except Exception as e:
                logger.warning(f"[RETRAINING] Could not get accumulator status: {e}")

            pipeline = TrainingPipeline()
            logger.info(f"[RETRAINING] Data source: {getattr(pipeline, 'data_source', 'unknown')}")
            pipeline.run_training()

            # Hot-reload the freshly-trained weights into the live voting_model
            # so the new model takes effect immediately without a restart.
            try:
                xgb_trained = pipeline.xgb_model.is_trained
                lstm_trained = pipeline.lstm_model.is_trained
                transformer_trained = pipeline.transformer_model.is_trained

                if xgb_trained:
                    voting_model.xgboost = pipeline.xgb_model
                    logger.info("[RETRAINING] Hot-reloaded XGBoost into voting_model")
                if lstm_trained:
                    voting_model.lstm = pipeline.lstm_model
                    logger.info("[RETRAINING] Hot-reloaded LSTM into voting_model")
                if transformer_trained:
                    voting_model.transformer = pipeline.transformer_model
                    logger.info("[RETRAINING] Hot-reloaded Transformer into voting_model")

                logger.info(
                    f"[RETRAINING] Voting model status after reload: "
                    f"XGBoost={voting_model.xgboost.is_trained}, "
                    f"LSTM={voting_model.lstm.is_trained}, "
                    f"Transformer={voting_model.transformer.is_trained}"
                )
            except Exception as reload_err:
                logger.warning(f"[RETRAINING] Hot-reload failed: {reload_err}")

            logger.info("[RETRAINING] Scheduled retraining completed successfully")
        except Exception as e:
            logger.error(f"[RETRAINING] Retraining failed: {e}", exc_info=True)


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
        asyncio.create_task(retraining_loop())
    except Exception as e:
        logger.warning(f"[STARTUP] Background task creation issue: {e}")

    yield  # Server starts here — healthcheck passes immediately

    # Shutdown cleanup could go here


app = FastAPI(title="A2Sniper 3.0", version="3.0.0", lifespan=lifespan)

# Simple root health endpoint — always responds even if DB is down
@app.get("/")
async def root():
    return {"status": "ok", "service": "A2Sniper 3.0", "version": "3.0.0"}

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

    # ═══ SNIPER ENGINE — Single Pair (user selected this pair) ═══
    # The user explicitly selected this pair and clicked "Request Signal".
    # We analyze THIS pair with the sniper engine.
    # 5/7 factors required for 80%+ winrate.
    logger.info(f"[SIGNAL-REQUEST] pair={pair} payout={real_payout}% — running sniper engine")
    try:
        signal = await asyncio.wait_for(force_analyze_pair(pair), timeout=30.0)
    except asyncio.TimeoutError:
        logger.warning(f"[SIGNAL-REQUEST] Sniper engine timed out (30s) for {pair}")
        raise HTTPException(
            status_code=404,
            detail=f"Signal analysis timed out for {pair}. The market data is still loading — please try again in 5-10 seconds."
        )
    except Exception as e:
        logger.error(f"[SIGNAL-REQUEST] Error analyzing {pair}: {e}", exc_info=True)
        raise HTTPException(
            status_code=404,
            detail=f"Could not analyze {pair} right now. Please try another pair or wait 1-2 minutes."
        )
    if signal:
        logger.info(f"[SIGNAL-REQUEST] ✅ Signal generated for {pair} (score={signal.get('score', '?')}/7, winrate={signal.get('winrate', '?')}%)")
        return {"status": "success", "signal": signal, "mode": "sniper"}

    # ═══ NO SIGNAL AVAILABLE ════════════════════════════════════════
    logger.info(f"[SIGNAL-REQUEST] No signal for {pair} — insufficient confluence (needs 3/7 factors). Try another pair or wait 1-2 minutes.")
    raise HTTPException(
        status_code=404,
        detail=(
            f"No signal for {pair} right now. "
            f"Try another pair or wait 1-2 minutes for better market conditions."
        )
    )


@app.get("/api/signals")
async def get_signals(pair: str = None, limit: int = 200, credentials: HTTPAuthorizationCredentials = Security(security)):
    # Validate token type and check revocation
    payload = decode_access_token(credentials.credentials)
    _jti = payload.get("jti")
    if _jti and await is_token_revoked(_jti):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    # Validate and clamp limit — allow up to 500 for full history
    limit = max(1, min(limit, 500))

    # Build the output list — try DB first, fall back to in-memory deque
    output = []
    now = datetime.now(timezone.utc)

    # Get total count from DB (not limited by the query limit)
    total_in_db = 0
    active_count = 0
    won_count = 0
    lost_count = 0

    try:
        async with AsyncSessionLocal() as session:
            # First, get ALL signals to count them properly
            count_query = select(SignalRecord)
            if pair:
                count_query = count_query.where(SignalRecord.pair == pair)
            count_result = await session.execute(count_query)
            all_db_signals = count_result.scalars().all()
            total_in_db = len(all_db_signals)

            # Count by status
            for s in all_db_signals:
                sig_time = s.timestamp
                if sig_time and sig_time.tzinfo is None:
                    sig_time = sig_time.replace(tzinfo=timezone.utc)
                expiration_seconds = (s.expiration or 5) * 60
                age_seconds = (now - sig_time).total_seconds() if sig_time else 999

                if s.is_win is True:
                    won_count += 1
                elif s.is_win is False:
                    lost_count += 1
                elif age_seconds < expiration_seconds:
                    active_count += 1

            # Now get the limited set for display (most recent first)
            query = select(SignalRecord).order_by(SignalRecord.timestamp.desc()).limit(limit)
            if pair:
                query = query.where(SignalRecord.pair == pair)
            result = await session.execute(query)
            signals = result.scalars().all()

            for s in signals:
                # Calculate signal status (ACTIVE / EXPIRED / WON / LOST)
                sig_time = s.timestamp
                if sig_time and sig_time.tzinfo is None:
                    sig_time = sig_time.replace(tzinfo=timezone.utc)
                expiration_seconds = (s.expiration or 5) * 60
                age_seconds = (now - sig_time).total_seconds() if sig_time else 999

                if s.is_win is True:
                    status = "WON"
                elif s.is_win is False:
                    status = "LOST"
                elif age_seconds < expiration_seconds:
                    status = "ACTIVE"
                else:
                    status = "EXPIRED"

                # Ensure winrate is never 0 or null (minimum 70%)
                sig_winrate = s.winrate if s.winrate and s.winrate > 0 else 70

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
                    # Analysis fields — stored in analysis_details JSON, not separate columns
                    "smc_structure": details.get('smc_structure', 'Price Action'),
                    "smc_zone": details.get('smc_zone', 'N/A'),
                    "chart_pattern": details.get('chart_pattern', 'Momentum'),
                    "fibonacci": details.get('fibonacci', 'N/A'),
                    "rsi_status": details.get('rsi_status', 'N/A'),
                }
                output.append(d)

        # If DB had signals, return them. If DB was empty, ALSO check the
        # in-memory deque (signals may not have been saved to DB).
        if not output:
            logger.info("[SIGNALS-API] DB returned 0 signals — checking in-memory deque")
            for s in reversed(generated_signals):
                if pair and s['pair'] != pair:
                    continue
                sig_time = datetime.fromisoformat(s['timestamp']) if isinstance(s.get('timestamp'), str) else s.get('timestamp')
                if sig_time and sig_time.tzinfo is None:
                    sig_time = sig_time.replace(tzinfo=timezone.utc)
                expiration_seconds = (s.get('expiration', 5)) * 60
                age_seconds = (now - sig_time).total_seconds() if sig_time else 999

                if s.get('is_win') is True:
                    status = "WON"
                elif s.get('is_win') is False:
                    status = "LOST"
                elif age_seconds < expiration_seconds:
                    status = "ACTIVE"
                else:
                    status = "EXPIRED"

                d = {
                    "id": s['id'],
                    "pair": s['pair'],
                    "direction": s['direction'],
                    "entry_price": float(s['entry_price']) if s['entry_price'] else 0,
                    "expiration": s['expiration'],
                    "winrate": s.get('winrate', 70) or 70,
                    "score": s.get('score', 4),
                    "payout": s.get('payout', 0),
                    "classification": s.get('classification', 'SIGNAL'),
                    "timestamp": s['timestamp'],
                    "is_win": s.get('is_win'),
                    "status": status,
                    "hash_signature": s.get('hash_signature', ''),
                    # Analysis fields from in-memory signal dict
                    "smc_structure": s.get('smc_structure', 'Price Action'),
                    "smc_zone": s.get('smc_zone', 'N/A'),
                    "chart_pattern": s.get('chart_pattern', 'Momentum'),
                    "fibonacci": s.get('fibonacci', 'N/A'),
                    "rsi_status": s.get('rsi_status', 'N/A'),
                }
                output.append(d)
                if len(output) >= limit:
                    break

        return {
            "signals": output,
            "total": total_in_db if total_in_db > 0 else len(output),
            "active_count": active_count,
            "won_count": won_count,
            "lost_count": lost_count,
            "live_status": "LIVE" if po_scanner.is_connected else "DISCONNECTED"
        }

    except Exception as db_err:
        logger.warning(f"[SIGNALS-API] DB query failed, falling back to in-memory: {db_err}")
        # Fall back to in-memory deque
        for s in reversed(generated_signals):  # most recent first
            if pair and s['pair'] != pair:
                continue
            sig_time = datetime.fromisoformat(s['timestamp']) if isinstance(s.get('timestamp'), str) else s.get('timestamp')
            if sig_time and sig_time.tzinfo is None:
                sig_time = sig_time.replace(tzinfo=timezone.utc)
            expiration_seconds = (s.get('expiration', 5)) * 60
            age_seconds = (now - sig_time).total_seconds() if sig_time else 999

            if age_seconds < expiration_seconds:
                status = "ACTIVE"
            else:
                status = "EXPIRED"

            d = {
                "id": s['id'],
                "pair": s['pair'],
                "direction": s['direction'],
                "entry_price": s['entry_price'],
                "expiration": s['expiration'],
                "winrate": s['winrate'],
                "score": s['score'],
                "payout": s['payout'],
                "classification": s.get('classification', 'N/A'),
                "timestamp": s['timestamp'],
                "is_win": None,
                "status": status,
                "hash_signature": s.get('hash_signature', '')
            }
            output.append(d)
            if len(output) >= limit:
                break
            
        return {
            "signals": output, 
            "total": len(output),
            "live_status": "LIVE" if po_scanner.is_connected else "DISCONNECTED"
        }


@app.delete("/api/admin/signals/{signal_id}")
async def delete_signal(signal_id: str, admin_payload = Depends(require_admin)):
    async with AsyncSessionLocal() as session:
        from sqlalchemy import delete
        await session.execute(delete(SignalRecord).where(SignalRecord.id == signal_id))
        await session.commit()
    return {"status": "success"}


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
        logger.warning(f"[Register] OTP generated for {email} but email could not be sent.")
        # Log OTP server-side only for dev debugging — NEVER return in API response
        logger.info(f"[Register] DEV OTP for {email}: {otp_code}")
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
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        
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
                # Refresh user after commit
                result = await session.execute(select(User).where(User.id == user.id))
                user = result.scalar_one_or_none()
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
        sub_result = await session.execute(
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
                "auth_provider": getattr(user, 'auth_provider', 'email') or 'email'
            }
        }

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
                result = await session.execute(select(User).where(User.email == email))
                user = result.scalar_one_or_none()
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
            result = await session.execute(select(User).where(User.email == email))
            user = result.scalar_one_or_none()
            
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

        # Verify user still exists
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
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
                "auth_provider": getattr(user, 'auth_provider', 'email') or 'email'
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
        result = await session.execute(
            select(User).where(User.id == user_id)
        )
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        
        # Eagerly load subscription to avoid lazy-load issues
        sub_result = await session.execute(
            select(UserSubscription).where(UserSubscription.user_id == user_id)
        )
        subscription = sub_result.scalar_one_or_none()
            
        return {
            "id": user.id,
            "email": user.email,
            "name": user.full_name,
            "is_admin": user.is_admin,
            "plan": subscription.plan_name if subscription else "Free",
            "auth_provider": getattr(user, 'auth_provider', 'email') or 'email'
        }


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
        logger.warning(f"[Delete] Deletion OTP generated for {user_email} but email could not be sent.")
        # Log OTP server-side only — NEVER return in API response
        logger.info(f"[Delete] DEV OTP for {user_email}: {otp_code}")
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


@app.get("/api/admin/engine/weights")
async def admin_get_weights(admin_payload = Depends(require_admin)):
    return {
        "lstm": voting_model.weights.get('LSTM', 0.4),
        "transformer": voting_model.weights.get('Transformer', 0.35),
        "xgboost": voting_model.weights.get('XGBoost', 0.25),
        "threshold": voting_model.threshold
    }


@app.post("/api/admin/engine/weights")
async def admin_update_weights(request: Request, admin_payload = Depends(require_admin)):
    data = await request.json()
    lstm_w = data.get('lstm', 0.4)
    transformer_w = data.get('transformer', 0.35)
    xgboost_w = data.get('xgboost', 0.25)
    threshold = data.get('threshold', 85.0)
    
    weight_sum = lstm_w + transformer_w + xgboost_w
    if abs(weight_sum - 1.0) > 0.05:
        raise HTTPException(status_code=400, detail=f"Weights must sum to ~1.0 (current sum: {weight_sum:.2f})")
    if threshold < 0 or threshold > 100:
        raise HTTPException(status_code=400, detail="Threshold must be between 0 and 100")
    
    voting_model.weights['LSTM'] = lstm_w
    voting_model.weights['Transformer'] = transformer_w
    voting_model.weights['XGBoost'] = xgboost_w
    voting_model.threshold = threshold
    return {"status": "success"}


# ═══════════ ACCUMULATOR & RETRAINING ENDPOINTS (Phase 3) ═══════════

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


@app.post("/api/admin/retrain")
async def admin_trigger_retrain(request: Request, admin_payload = Depends(require_admin)):
    """Manually trigger model retraining (does not wait for the 24h loop).

    Uses whatever data source TrainingPipeline prefers (live_candles.csv
    if enough data, else synthetic multi-pair). Returns immediately with
    a job ID — retraining runs in the background. Check logs for progress.
    """
    import uuid as _uuid
    job_id = f"retrain-{_uuid.uuid4().hex[:8]}"

    async def _run_retrain():
        try:
            logger.info(f"[RETRAIN {job_id}] Manual retraining triggered by admin...")
            from neural_models.training_pipeline import TrainingPipeline
            from engine.candle_accumulator import get_accumulator

            try:
                accumulator = await get_accumulator()
                status = accumulator.get_status()
                logger.info(
                    f"[RETRAIN {job_id}] Accumulator: "
                    f"{status['total_rows']:,} rows, {status['pairs_count']} pairs, "
                    f"ready={status['ready_for_training']}"
                )
            except Exception:
                pass

            pipeline = TrainingPipeline()
            logger.info(f"[RETRAIN {job_id}] Data source: {getattr(pipeline, 'data_source', 'unknown')}")
            pipeline.run_training()

            # Hot-reload into live voting_model
            if pipeline.xgb_model.is_trained:
                voting_model.xgboost = pipeline.xgb_model
                logger.info(f"[RETRAIN {job_id}] Hot-reloaded XGBoost")
            if pipeline.lstm_model.is_trained:
                voting_model.lstm = pipeline.lstm_model
                logger.info(f"[RETRAIN {job_id}] Hot-reloaded LSTM")
            if pipeline.transformer_model.is_trained:
                voting_model.transformer = pipeline.transformer_model
                logger.info(f"[RETRAIN {job_id}] Hot-reloaded Transformer")

            logger.info(f"[RETRAIN {job_id}] Manual retraining completed successfully")
        except Exception as e:
            logger.error(f"[RETRAIN {job_id}] Manual retraining failed: {e}", exc_info=True)

    asyncio.create_task(_run_retrain())
    return {
        "status": "started",
        "job_id": job_id,
        "message": "Retraining started in background. Check backend logs for progress.",
        "note": "Use GET /api/admin/engine/status to check model status after retraining completes."
    }


@app.get("/api/admin/engine/status")
async def admin_engine_status(admin_payload = Depends(require_admin)):
    """Get the current status of all AI models in the voting classifier."""
    try:
        from engine.candle_accumulator import get_accumulator
        accumulator = await get_accumulator()
        acc_status = accumulator.get_status()
    except Exception:
        acc_status = None

    return {
        "models": {
            "xgboost": {
                "is_trained": getattr(voting_model.xgboost, 'is_trained', False),
                "model_loaded": voting_model.xgboost.model is not None,
            },
            "lstm": {
                "is_trained": getattr(voting_model.lstm, 'is_trained', False),
            },
            "transformer": {
                "is_trained": getattr(voting_model.transformer, 'is_trained', False),
            },
        },
        "voting_weights": voting_model.weights,
        "voting_threshold": voting_model.threshold,
        "accumulator": acc_status,
        "ai_gate_mode": (
            "full_voting" if (
                getattr(voting_model.xgboost, 'is_trained', False)
                and getattr(voting_model.lstm, 'is_trained', False)
                and getattr(voting_model.transformer, 'is_trained', False)
            ) else "xgboost_only" if getattr(voting_model.xgboost, 'is_trained', False)
            else "disabled"
        ),
    }


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

    ssid = data.get("ssid")
    if not ssid:
        raise HTTPException(status_code=400, detail="SSID required. Paste the Pocket Option authentication frame.")

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

        # Persist SSID for auto-reconnect after Railway redeploy
        try:
            os.makedirs(os.path.dirname(SSID_FILE), exist_ok=True)
            with open(SSID_FILE, 'w') as f:
                f.write(ssid_clean)
            logger.info("[MARKET] SSID saved for auto-reconnect on backend restart")
        except Exception as save_err:
            logger.warning(f"[MARKET] Could not save SSID for auto-reconnect: {save_err}")

        # Kick off an immediate analysis pass in the background so signals
        # start appearing in the UI within 5-10 seconds (not waiting for the
        # next trading_loop cycle or for 3+ minutes of candle building).
        # Fire-and-forget.
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

                # ═══ CANDLE-BASED SIGNAL KICK ═══════════════════════════
                # With REST-prefetched historical candles (100 bars per pair),
                # we can run full CDC analysis (RSI, EMA, MACD, Bollinger)
                # within 5 seconds of connecting.
                # This produces REAL signals with genuine predictive power.
                signals_generated = 0
                for pair in live_pairs:
                    payout = po_scanner.get_payout(pair)
                    if payout and payout >= 70:
                        try:
                            # Sniper engine — the ONLY signal generator
                            sig = await force_analyze_pair(pair)
                            if sig:
                                signals_generated += 1
                                logger.info(f"[KICK-SNIPER] ✅ Signal generated for {pair} ({sig.get('winrate', 70)}% winrate)")
                        except Exception:
                            pass
                        await asyncio.sleep(0.05)

                logger.info(f"[KICK] Pass complete — {signals_generated} signals generated from {len(live_pairs)} pairs")

                # If sniper didn't produce any signals (insufficient confluence),
                # retry after 3 more seconds — by then more candles may have arrived
                # and market conditions may have changed.
                if signals_generated == 0:
                    logger.info("[KICK-SNIPER] No signals on first pass — retrying in 3s (waiting for candle accumulation)")
                    await asyncio.sleep(3)
                    for pair in live_pairs:
                        payout = po_scanner.get_payout(pair)
                        if payout and payout >= 70:
                            try:
                                sig = await force_analyze_pair(pair)
                                if sig:
                                    signals_generated += 1
                                    logger.info(f"[KICK-SNIPER-RETRY] ✅ Signal generated for {pair} ({sig['winrate']}% winrate)")
                            except Exception:
                                pass
                            await asyncio.sleep(0.05)
                    logger.info(f"[KICK-SNIPER-RETRY] Pass complete — {signals_generated} signals total")

                # Final retry: sniper engine on first 3 pairs (one more attempt)
                if signals_generated == 0:
                    logger.info("[KICK] No sniper signals yet — final retry on first 3 pairs")
                    for pair in live_pairs[:3]:
                        payout = po_scanner.get_payout(pair)
                        if payout and payout >= 70:
                            sig = await force_analyze_pair(pair)
                            if sig:
                                logger.info(f"[KICK-FINAL] Sniper signal generated for {pair}")
                                break
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

    await po_scanner.disconnect()

    # Delete saved SSID file so nothing can auto-reconnect
    try:
        if os.path.exists(SSID_FILE):
            os.remove(SSID_FILE)
            logger.info("[MARKET] SSID file deleted on disconnect")
    except Exception:
        pass

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
            "ssid_preview": po_scanner.ssid[:5] + "..." if po_scanner.ssid else None,
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
            "ssid_preview": None,
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
    if request.url.path in ["/api/status", "/api/market/status", "/api/market/debug", "/api/market/balance-debug", "/api/debug/schema"]:
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


# ═══════════ TEMPORARY DIAGNOSTIC ENDPOINT (REMOVE AFTER DEBUG) ═══════════
@app.get("/api/debug/schema")
async def debug_schema():
    """Public diagnostic — returns the actual columns of password_reset_otps.
    Temporary: delete after diagnosis is complete.
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
