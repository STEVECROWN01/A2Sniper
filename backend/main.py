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
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from time import time
from fastapi import FastAPI, HTTPException, Request, Security, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../.env.local'))

from engine.smc import SMCEngine
from engine.indicators import TechnicalIndicators, DivergenceDetector
from engine.patterns import CandlestickPatterns
import uuid
from auth import get_password_hash, verify_password, create_access_token, decode_token, security
from fastapi.security import HTTPAuthorizationCredentials
from engine.pocket_option_scanner import PocketOptionScanner
from engine.monitoring_engine import MonitoringEngine
from engine.risk_manager import RiskManager
from engine.scoring import SniperEntrySystem
from neural_models.voting import VotingClassifierModel
from engine.chartist import ChartistPatterns
from engine.filters import AntiManipulationFilters
from engine.compliance import ComplianceManager
from bot.telegram_bot import TelegramSignalBot
from db import init_db, SignalRecord, AsyncSessionLocal, User, UserSubscription, PasswordResetOTP

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')
logger = logging.getLogger('A2Sniper')

# ═══════════ INSTANCES GLOBALES ═══════════
# 8 paires OTC obligatoires CDC
OTC_PAIRS = [
    'EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC', 'AUD/USD OTC',
    'USD/CHF OTC', 'EUR/GBP OTC', 'USD/CAD OTC', 'NZD/USD OTC'
]

smc_engine = SMCEngine()
indicators = TechnicalIndicators()
patterns = CandlestickPatterns()
chartist = ChartistPatterns()
ses = SniperEntrySystem()
filters = AntiManipulationFilters()
compliance = ComplianceManager()
risk_mgr = RiskManager()
monitor = MonitoringEngine()
voting_model = VotingClassifierModel()
po_scanner = PocketOptionScanner()
telegram_bot = TelegramSignalBot(scanner=po_scanner)

# Rate limiting config
RATE_LIMIT_REQUESTS = 2000 # Augmenté pour permettre le polling du dashboard
RATE_LIMIT_WINDOW = 3600 # 1 hour
rate_limit_data = {}


def check_rate_limit(request: Request, max_requests: int = 100, window_seconds: int = 60):
    """Simple in-memory rate limiting per IP."""
    client_ip = request.client.host if request.client else "unknown"
    now = time()
    if client_ip not in rate_limit_data:
        rate_limit_data[client_ip] = []
    # Remove old entries
    rate_limit_data[client_ip] = [t for t in rate_limit_data[client_ip] if now - t < window_seconds]
    if len(rate_limit_data[client_ip]) >= max_requests:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Please try again later.")
    rate_limit_data[client_ip].append(now)


# Admin authentication dependency
async def require_admin(credentials: HTTPAuthorizationCredentials = Security(security)):
    """Verify the user is an admin. Must be used on all admin endpoints."""
    token = credentials.credentials
    payload = decode_token(token)
    user_id = payload.get("sub")
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user or not user.is_admin:
            raise HTTPException(status_code=403, detail="Admin access required")
    return payload


# Stockage des signaux émis
generated_signals = deque(maxlen=1000)  # Bounded to prevent memory leak
signal_counter_lock = asyncio.Lock()
signal_counter = 0

# Limites par plan
PLAN_LIMITS = {'Standard': 20, 'Premium': 35, 'Pro': 999}


def get_signal_limit(plan: str = 'Premium') -> int:
    return PLAN_LIMITS.get(plan, 20)


async def analyze_pair(pair: str) -> dict:
    """Pipeline d'analyse complet pour une paire."""
    return await analyze_pair_internal(pair, force=False)


async def force_analyze_pair(pair: str) -> dict:
    """Génère ou force un signal basé sur des données réelles du marché."""
    return await analyze_pair_internal(pair, force=True)


async def analyze_pair_internal(pair: str, force: bool = False) -> dict:
    """Pipeline d'analyse complet pour une paire. Si force=True, on contourne les filtres bloquants."""
    # 1. Récupérer les données (Réel uniquement)
    if not po_scanner.is_connected:
        logger.warning(f"[{pair}] Scanner non connecté, analyse impossible.")
        return None

    payout = po_scanner.get_payout(pair)
    if payout is None:
        logger.warning(f"[{pair}] Cannot determine payout from scanner — skipping signal generation")
        return None

    # Si pas de force, on exige un payout >= 70%
    if not force and payout < 70:
        logger.info(f"[{pair}] Analyse ignorée : payout ({payout}%) insuffisant.")
        return None

    df_m1 = await po_scanner.get_candles(pair, timeframe="1m", count=100)
    if df_m1.empty or len(df_m1) < 52:
        logger.warning(f"[{pair}] Pas assez de données réelles ({len(df_m1)} bougies)")
        return None

    # Calcul des indicateurs
    df_m1 = indicators.calculate_all(df_m1)
    
    # Calcul des timeframes supérieurs
    df_m5 = df_m1.resample('5Min').agg({
        'open': 'first', 'high': 'max', 'low': 'min',
        'close': 'last', 'volume': 'sum'
    }).dropna()
    df_m15 = df_m1.resample('15Min').agg({
        'open': 'first', 'high': 'max', 'low': 'min',
        'close': 'last', 'volume': 'sum'
    }).dropna()
    if df_m5 is not None and len(df_m5) >= 52:
        df_m5 = indicators.calculate_all(df_m5)
    if df_m15 is not None and len(df_m15) >= 52:
        df_m15 = indicators.calculate_all(df_m15)

    # SMC & Breaks
    smc_result = smc_engine.analyze(df_m1)
    trend = smc_result.get('trend', 'RANGE')

    # MTF
    mtf_trends = {'M1': trend}
    if df_m5 is not None and len(df_m5) >= 20:
        mtf_trends['M5'] = smc_engine.identify_trend(df_m5)
    if df_m15 is not None and len(df_m15) >= 20:
        mtf_trends['M15'] = smc_engine.identify_trend(df_m15)
    mtf = SMCEngine.check_mtf_alignment(mtf_trends)

    active_patterns = patterns.detect_all_patterns(df_m1)
    active_patterns = patterns.get_active_patterns(df_m1)
    chart_result = chartist.detect_all(df_m1)
    fibo = indicators.auto_fibonacci(df_m1)
    divs = DivergenceDetector.detect_divergences(df_m1)

    # Déterminer la direction avec le système multicritère
    call_score = 0
    put_score = 0

    if 'UPTREND' in trend:
        call_score += 3
    elif 'DOWNTREND' in trend:
        put_score += 3

    if mtf['aligned']:
        if mtf['direction'] == 'CALL':
            call_score += 2
        elif mtf['direction'] == 'PUT':
            put_score += 2

    if active_patterns['has_bullish']:
        call_score += 2
    if active_patterns['has_bearish']:
        put_score += 2

    liquidity_zones = smc_result.get('liquidity_zones', {})
    stop_hunt = filters.detect_stop_hunt(df_m1, liquidity_zones)
    stop_hunt_detected = stop_hunt.get('detected', False)
    stop_hunt_signal = stop_hunt.get('signal') if stop_hunt_detected else None
    if stop_hunt_detected:
        if stop_hunt_signal == 'CALL':
            call_score += 4
        elif stop_hunt_signal == 'PUT':
            put_score += 4

    wyckoff = smc_result.get('wyckoff', 'UNKNOWN')
    if wyckoff == 'ACCUMULATION':
        call_score += 2
    elif wyckoff == 'DISTRIBUTION':
        put_score += 2

    last_row = df_m1.iloc[-1]
    ema9 = float(last_row.get('EMA_9', 0))
    ema21 = float(last_row.get('EMA_21', 0))
    ema_cross = 'CALL' if ema9 > ema21 else 'PUT'
    if ema_cross == 'CALL':
        call_score += 1.5
    else:
        put_score += 1.5

    for d in divs.get('divergences', []):
        if d['direction'] == 'CALL':
            call_score += 2.5
        elif d['direction'] == 'PUT':
            put_score += 2.5

    if call_score > put_score:
        direction = 'CALL'
    elif put_score > call_score:
        direction = 'PUT'
    else:
        direction = 'CALL' if ema_cross == 'CALL' else 'PUT'

    # Anti-manipulation filters
    atr = df_m1['ATRr_14'].iloc[-1] if 'ATRr_14' in df_m1.columns else 0
    atr_avg = df_m1['ATR_AVG_20'].iloc[-1] if 'ATR_AVG_20' in df_m1.columns else 0
    filter_result = filters.check_all_filters(df_m1, atr, atr_avg, signal_direction=direction)
    
    # Si non forcé et bloqué par filtre, on rejette
    if not force and filter_result['is_blocked']:
        logger.info(f"[{pair}] Bloqué par filtres: {filter_result['reasons']}")
        return None

    # Scoring SES
    candle = None
    if direction == 'CALL' and active_patterns['bullish']:
        candle = active_patterns['bullish'][0].lower().replace(' ', '_')
        candle = f"pattern_{candle}"
    elif direction == 'PUT' and active_patterns['bearish']:
        candle = active_patterns['bearish'][0].lower().replace(' ', '_')
        candle = f"pattern_{candle}"

    obs = smc_result.get('order_blocks', [])
    fvgs = smc_result.get('fvgs', [])
    current_ob_type = None
    fvg_confluence = False
    for ob in obs:
        if ob.get('type') in ['BULLISH_OB'] and direction == 'CALL':
            current_ob_type = 'BULLISH_OB'
        elif ob.get('type') in ['BEARISH_OB'] and direction == 'PUT':
            current_ob_type = 'BEARISH_OB'
    for fvg in fvgs:
        if (fvg.get('type') == 'BULLISH_FVG' and direction == 'CALL') or \
           (fvg.get('type') == 'BEARISH_FVG' and direction == 'PUT'):
            fvg_confluence = True

    chart_pattern_name = None
    chart_pattern_detected = False
    if chart_result['patterns']:
        for cp in chart_result['patterns']:
            if cp.get('signal') == direction:
                chart_pattern_name = cp['name']
                chart_pattern_detected = True
                break

    scoring_context = {
        'direction': direction,
        'smc_trend': trend,
        'mtf_alignment': mtf['details'],
        'current_ob_type': current_ob_type,
        'fvg_confluence': fvg_confluence,
        'stop_hunt_detected': stop_hunt_detected,
        'stop_hunt_signal': stop_hunt_signal,
        'wyckoff': wyckoff,
        'ema_cross': ema_cross,
        'chart_pattern': chart_pattern_detected,
        'chart_pattern_name': chart_pattern_name,
        'candle_pattern': candle,
        'fibonacci_level': fibo.get('closest_level'),
        'rsi': float(df_m1['RSI_14'].iloc[-1]) if 'RSI_14' in df_m1.columns else 50,
        'macd_histogram': float(df_m1['MACDh_12_26_9'].iloc[-1]) if 'MACDh_12_26_9' in df_m1.columns else 0,
        'volume_spike': float(df_m1['volume'].iloc[-1]) > float(df_m1['volume'].rolling(20).mean().iloc[-1]) * 1.5 if len(df_m1) >= 20 else False,
        'divergence_bonus': divs.get('score_bonus', 0),
        'pattern_score_modifier': active_patterns.get('score_modifier', 0),
        'payout': payout,
    }

    score_result = ses.evaluate_signal(scoring_context)
    
    # Si non forcé et winrate trop bas, on rejette. Si forcé, on utilise le vrai winrate
    winrate = score_result['winrate']
    # Force mode: use the real calculated winrate (no fabrication)
    if force and winrate < 70.0:
        logger.warning(f"[{pair}] Force mode: winrate {winrate}% is low but using real value (no fabrication)")

    if not force and winrate < ses.WINRATE_THRESHOLD:
        logger.info(f"[{pair}] Winrate {winrate}% < seuil")
        return None

    # Risk Check (sauf si forcé)
    if not force:
        risk_check = risk_mgr.check_can_trade()
        if not risk_check['can_trade']:
            logger.warning(f"[{pair}] Bloqué par risk manager")
            return None

        cb = monitor.check_circuit_breaker()
        if cb['is_active']:
            logger.warning(f"[{pair}] Circuit Breaker actif")
            return None

    # AI Voting Classifier (sauf si forcé)
    if not force:
        features = _build_ai_features(df_m1, smc_result, fibo, active_patterns, divs)
        ai_result = voting_model.predict(features)
        if not ai_result.get('approved', False):
            logger.info(f"[{pair}] Rejeté par Voting Classifier")
            return None

    # Construire le signal
    global signal_counter
    async with signal_counter_lock:
        signal_counter += 1
        sig_count = signal_counter
    now = datetime.now(timezone.utc)
    current_price = float(df_m1['close'].iloc[-1])

    # CDC: 1min or 5min based on structure (ATR-based)
    if atr > 0:
        atr_ratio = atr / current_price if current_price > 0 else 0
        if atr_ratio > 0.001:  # High volatility → 5 min
            expiration = 5
        else:  # Low volatility → 1 min
            expiration = 1
    else:
        expiration = 5  # Default to 5min (safer)

    signal = {
        'id': f'SIG-{now.strftime("%Y%m%d")}-{uuid.uuid4().hex[:6].upper()}',
        'pair': pair,
        'direction': direction,
        'time': now.strftime('%H:%M:%S'),
        'timestamp': now.isoformat(),
        'entry_price': current_price,
        'expiration': expiration,
        'winrate': score_result['winrate'],
        'payout': payout,
        'classification': score_result['classification'],
        'smc_structure': score_result['details'].get('smc_structure', trend),
        'smc_zone': score_result['details'].get('smc_zone', 'N/A'),
        'chart_pattern': score_result['details'].get('chart_pattern', chart_pattern_name or 'N/A'),
        'fibonacci': score_result['details'].get('fibonacci', f"Zone {fibo.get('closest_level', 'N/A')}%"),
        'rsi_status': 'Survendu' if (direction == 'CALL' and last_row.get('RSI_14', 50) < 40) else 'Suracheté' if (direction == 'PUT' and last_row.get('RSI_14', 50) > 60) else 'Neutre',
        'recommended_stake': score_result['recommended_stake'],
        'mtf_aligned': mtf['aligned'],
        'wyckoff': wyckoff,
        'divergences': [d['type'] for d in divs.get('divergences', [])],
    }

    signal['hash_signature'] = compliance.generate_immutable_log(signal)

    async with AsyncSessionLocal() as session:
        db_signal = SignalRecord(
            id=signal['id'],
            pair=signal['pair'],
            direction=signal['direction'],
            entry_price=signal['entry_price'],
            expiration=signal['expiration'],
            winrate=signal['winrate'],
            payout=signal['payout'],
            classification=signal['classification'],
            timestamp=now,
            analysis_details=scoring_context,
            hash_signature=signal['hash_signature']
        )
        session.add(db_signal)
        await session.commit()

    generated_signals.append(signal)
    monitor.record_signal(signal['id'], pair, direction, score_result['winrate'])

    # Envoi Telegram
    signal_msg = f"""🎯 <b>A2SNIPER SIGNAL {"LIVE" if not force else "SUR DEMANDE"}</b>
━━━━━━━━━━━━━━━━━━━━━
📊 Paire : <b>{signal['pair']}</b>
🟢 Direction : <b>{signal['direction']}</b>
⌛ Expiration : <b>{signal['expiration']}m</b>
💰 Payout : <b>{signal['payout']}%</b>
🎯 Winrate IA : <b>{signal['winrate']}%</b>

🏗️ Structure : <i>{signal['smc_structure']}</i>
⚡ Confluence : <i>{signal['fibonacci']}</i>

Zéro Simulation. 100% Real-Market."""

    await telegram_bot.send_signal(signal_msg)
    return signal




def _build_ai_features(df, smc, fibo, patterns_result, divs):
    """Construit le vecteur de features pour le Voting Classifier."""
    last = df.iloc[-1]
    features = {
        'rsi': float(last.get('RSI_14', 50)),
        'macd': float(last.get('MACD_12_26_9', 0)),
        'macd_signal': float(last.get('MACDs_12_26_9', 0)),
        'macd_histogram': float(last.get('MACDh_12_26_9', 0)),
        'bb_upper': float(last.get('BBU_20_2.0', 0)),
        'bb_lower': float(last.get('BBL_20_2.0', 0)),
        'bb_middle': float(last.get('BBM_20_2.0', 0)),
        'ema_9': float(last.get('EMA_9', 0)),
        'ema_21': float(last.get('EMA_21', 0)),
        'adx': float(last.get('ADX_14', 25)),
        'atr': float(last.get('ATRr_14', 0)),
        'stoch_k': float(last.get('STOCH_K', 50)),
        'stoch_d': float(last.get('STOCH_D', 50)),
        'cci': float(last.get('CCI_20', 0)),
        'obv': float(last.get('OBV', 0)),
        'close': float(last['close']),
        'volume': float(last['volume']),
        'trend': smc.get('trend', 'RANGE'),
        'has_ob': len(smc.get('order_blocks', [])) > 0,
        'has_fvg': len(smc.get('fvgs', [])) > 0,
        'has_confluence': len(smc.get('confluence_zones', [])) > 0,
        'fibo_level': fibo.get('closest_level', 'N/A'),
        'in_golden_zone': fibo.get('in_golden_zone', False),
        'has_divergence': len(divs.get('divergences', [])) > 0,
        'has_bull_pattern': patterns_result.get('has_bullish', False),
        'has_bear_pattern': patterns_result.get('has_bearish', False),
    }
    return features


# ═══════════ BOUCLE PRINCIPALE ═══════════
async def trading_loop():
    """Boucle d'analyse réelle sur les 8 paires OTC."""
    logger.info("═══════════ A2Sniper 3.0 — DÉMARRAGE ═══════════")
    logger.info(f"Paires surveillées: {', '.join(OTC_PAIRS)}")

    while True:
        try:
            if not po_scanner.is_connected:
                await asyncio.sleep(0.5)
                continue

            # Circuit Breaker check
            cb = monitor.check_circuit_breaker()
            if cb['is_active']:
                logger.warning(f"⚠️ Circuit Breaker actif: {cb['reason']}")
                await asyncio.sleep(60)
                continue

            # Analyse séquentielle des paires
            for pair in OTC_PAIRS:
                if not po_scanner.is_connected: break
                
                payout = po_scanner.get_payout(pair)
                if payout is None or payout < 70:
                    logger.info(f"[{pair}] Analyse sautée : payout ({payout}%) insuffisant ou inactif.")
                    continue

                await analyze_pair(pair)
                await asyncio.sleep(1) # Délai pour éviter de saturer le processeur
            
            await asyncio.sleep(10) # Pause entre les cycles d'analyse complète

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
                    # Next candle boundary of s.expiration minutes
                    minutes_to_add = s.expiration - (s_timestamp.minute % s.expiration)
                    expiry_time = s_timestamp.replace(second=0, microsecond=0) + timedelta(minutes=minutes_to_add)
                    
                    if now >= expiry_time:
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
                            
                            logger.info(f"🏁 SIGNAL RÉSOLU RÉEL: {s.id} ({s.pair}) -> {'GAGNÉ' if is_win else 'PERDU'} (Entry: {s.entry_price}, Exit: {current_price})")
                        else:
                            logger.warning(f"Impossible de résoudre {s.id}: Pas de prix pour {s.pair}")
                
                await session.commit()
            
            await asyncio.sleep(10)
        except Exception as e:
            logger.error(f"Erreur boucle résolution: {e}")
            await asyncio.sleep(10)


# ═══════════ LIFESPAN (replaces deprecated on_event) ═══════════

@asynccontextmanager
async def lifespan(app):
    # Startup
    await init_db()
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(SignalRecord).order_by(SignalRecord.timestamp.asc()))
        historical_signals = result.scalars().all()
        for s in historical_signals:
            monitor.record_signal(s.id, s.pair, s.direction, s.winrate, is_win=s.is_win)
            monitor.signal_history[-1]['timestamp'] = s.timestamp.replace(tzinfo=timezone.utc) if s.timestamp.tzinfo is None else s.timestamp

    logger.info(f"Database initialized. Loaded {len(historical_signals)} signals into monitoring history.")
    logger.info("Waiting for real market connection to start analysis.")
    
    asyncio.create_task(trading_loop())
    asyncio.create_task(resolution_loop())
    asyncio.create_task(telegram_bot.start_polling())
    
    yield  # Application runs here
    
    # Shutdown cleanup could go here


app = FastAPI(title="A2Sniper 3.0", version="3.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        os.getenv("FRONTEND_URL", "http://localhost:3000"),
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/signals/request")
async def request_live_signal(request: Request, credentials: HTTPAuthorizationCredentials = Security(security), rate_limit: None = Depends(lambda req: check_rate_limit(req))):
    """Génère un signal en direct à la demande pour une paire. Requires authentication."""
    # Verify auth
    payload = decode_token(credentials.credentials)
    
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Corps de requête invalide")
    
    pair = data.get("pair")
    if not pair:
        raise HTTPException(status_code=400, detail="Paire requise")
    
    # Validate pair is in OTC_PAIRS
    if pair not in OTC_PAIRS:
        raise HTTPException(status_code=400, detail=f"Paire invalide. Paires supportées: {', '.join(OTC_PAIRS)}")
        
    if not po_scanner.is_connected:
        raise HTTPException(status_code=400, detail="Le scanner A2Sniper n'est pas connecté au marché réel.")

    signal = await analyze_pair(pair)
    if signal:
        return {"status": "success", "signal": signal}
    else:
        raise HTTPException(status_code=500, detail="Impossible de générer le signal. Le marché ne remplit pas les critères de sécurité ou la connexion est inactive.")


@app.get("/api/signals")
async def get_signals(pair: str = None, limit: int = 100):
    async with AsyncSessionLocal() as session:
        # On récupère les signaux (triés par plus récent)
        # On garde une limite raisonnable pour les filtres d'historique
        query = select(SignalRecord).order_by(SignalRecord.timestamp.desc()).limit(limit)
        if pair:
            query = query.where(SignalRecord.pair == pair)
        
        result = await session.execute(query)
        signals = result.scalars().all()
        
        # Sérialisation explicite pour éviter les erreurs de type (datetime, etc.)
        output = []
        for s in signals:
            d = {
                "id": s.id,
                "pair": s.pair,
                "direction": s.direction,
                "entry_price": s.entry_price,
                "expiration": s.expiration,
                "winrate": s.winrate,
                "payout": s.payout,
                "classification": s.classification,
                "timestamp": s.timestamp.isoformat() if s.timestamp else None,
                "is_win": s.is_win,
                "hash_signature": s.hash_signature
            }
            # Don't merge full analysis_details to avoid leaking proprietary strategy logic
            output.append(d)
            
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
# ═══════════ AUTH ENDPOINTS ═══════════

@app.post("/api/auth/register")
async def register(request: Request, rate_limit: None = Depends(lambda req: check_rate_limit(req))):
    data = await request.json()
    email = data.get("email")
    password = data.get("password")
    full_name = data.get("name")
    
    if not email or not password:
        raise HTTPException(status_code=400, detail="Email et mot de passe requis")
        
    from auth import validate_password_strength, MIN_PASSWORD_LENGTH
    if not validate_password_strength(password):
        raise HTTPException(status_code=400, detail=f"Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères, dont 1 majuscule, 1 chiffre et 1 caractère spécial")
        
    async with AsyncSessionLocal() as session:
        # Vérifier si l'utilisateur existe déjà
        result = await session.execute(select(User).where(User.email == email))
        if result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Email déjà utilisé")
            
        user_id = str(uuid.uuid4())
        new_user = User(
            id=user_id,
            email=email,
            hashed_password=get_password_hash(password),
            full_name=full_name,
            created_at=datetime.now(timezone.utc)
        )
        session.add(new_user)
        
        # Créer une souscription par défaut
        sub = UserSubscription(
            user_id=user_id,
            plan_name="Standard",
            active_until=datetime.now(timezone.utc) + timedelta(days=7) # 7 jours d'essai
        )
        session.add(sub)
        
        await session.commit()
        
    return {"status": "success", "message": "Compte créé avec succès"}

@app.post("/api/auth/login")
async def login(request: Request, rate_limit: None = Depends(lambda req: check_rate_limit(req))):
    data = await request.json()
    email = data.get("email")
    password = data.get("password")
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        
        if not user or not verify_password(password, user.hashed_password):
            raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect")
            
        token = create_access_token({"sub": user.id, "email": user.email})
        
        return {
            "status": "success",
            "token": token,
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.full_name
            }
        }

@app.post("/api/auth/google")
async def auth_google(request: Request):
    data = await request.json()
    access_token = data.get("access_token")
    
    if not access_token:
        raise HTTPException(status_code=400, detail="Access token requis")
    
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
        raise HTTPException(status_code=400, detail="Token Google invalide ou expiré")
        
    email = user_info.get("email")
    full_name = user_info.get("name", "Google Sniper")
    
    if not email:
        raise HTTPException(status_code=400, detail="Email non fourni par Google")
        
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        
        if not user:
            # Auto-register Google user
            user_id = str(uuid.uuid4())
            user = User(
                id=user_id,
                email=email,
                hashed_password=get_password_hash(str(uuid.uuid4())), # random password
                full_name=full_name,
                created_at=datetime.now(timezone.utc)
            )
            session.add(user)
            
            sub = UserSubscription(
                user_id=user_id,
                plan_name="Standard",
                active_until=datetime.now(timezone.utc) + timedelta(days=7)
            )
            session.add(sub)
            await session.commit()
            
            result = await session.execute(select(User).where(User.id == user_id))
            user = result.scalar_one_or_none()
            
        token = create_access_token({"sub": user.id, "email": user.email})
        
        return {
            "status": "success",
            "token": token,
            "user": {
                "id": user.id,
                "email": user.email,
                "name": user.full_name
            }
        }


async def send_otp_email(recipient_email: str, otp_code: str):
    resend_api_key = os.getenv("RESEND_API_KEY")
    resend_from_email = os.getenv("RESEND_FROM_EMAIL", "noreply@a2sniper.ai")
    
    if not resend_api_key:
        logger.warning("RESEND_API_KEY non configurée. Impossible d'envoyer l'email.")
        return False
    
    import httpx
    try:
        html_content = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #4f46e5; margin: 0;">A2Sniper</h2>
                <p style="color: #6b7280; font-size: 14px; margin: 5px 0 0 0;">Réinitialisation de mot de passe</p>
            </div>
            <div style="padding: 20px; background-color: #f9fafb; border-radius: 6px; text-align: center;">
                <p style="font-size: 16px; color: #374151; margin-top: 0;">Bonjour,</p>
                <p style="font-size: 16px; color: #374151;">Vous avez demandé la réinitialisation de votre mot de passe sur A2Sniper. Voici votre code de sécurité OTP :</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #4f46e5; margin: 20px 0; padding: 10px; background-color: #e0e7ff; border-radius: 6px; display: inline-block;">
                    {otp_code}
                </div>
                <p style="font-size: 14px; color: #6b7280; margin-bottom: 0;">Ce code est valable pendant 15 minutes. Si vous n'avez pas demandé cette réinitialisation, veuillez ignorer cet email.</p>
            </div>
        </div>
        """
        
        payload = {
            "from": f"A2Sniper <{resend_from_email}>",
            "to": [recipient_email],
            "subject": "Code de réinitialisation A2Sniper",
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
async def forgot_password(request: Request, rate_limit: None = Depends(lambda req: check_rate_limit(req))):
    data = await request.json()
    email = data.get("email")
    
    if not email:
        raise HTTPException(status_code=400, detail="Email requis")
        
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        
        if not user:
            # Don't reveal whether email exists (security best practice)
            return {"status": "success", "message": "Si l'email existe, un code OTP y a été envoyé."}
            
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
async def verify_otp(request: Request, rate_limit: None = Depends(lambda req: check_rate_limit(req))):
    data = await request.json()
    email = data.get("email")
    otp_code = data.get("otp_code")
    
    if not email or not otp_code:
        raise HTTPException(status_code=400, detail="Email et code OTP requis")
    
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
            raise HTTPException(status_code=400, detail="Code OTP invalide")
            
        # Reset tracker on successful verification
        if email in otp_attempt_tracker:
            del otp_attempt_tracker[email]
            
        now_utc = datetime.now(timezone.utc)
        expires_at = otp_record.expires_at.replace(tzinfo=timezone.utc) if otp_record.expires_at.tzinfo is None else otp_record.expires_at
        
        if now_utc > expires_at:
            raise HTTPException(status_code=400, detail="Ce code OTP a expiré")
            
        return {"status": "success", "message": "Code OTP vérifié avec succès"}

@app.post("/api/auth/reset-password")
async def reset_password(request: Request):
    data = await request.json()
    email = data.get("email")
    otp_code = data.get("otp_code")
    new_password = data.get("new_password")
    
    if not email or not otp_code or not new_password:
        raise HTTPException(status_code=400, detail="Toutes les informations sont requises")
        
    async with AsyncSessionLocal() as session:
        # Re-vérifier l'OTP
        result = await session.execute(
            select(PasswordResetOTP)
            .where(PasswordResetOTP.email == email)
            .where(PasswordResetOTP.otp_code == otp_code)
        )
        otp_record = result.scalar_one_or_none()
        
        if not otp_record:
            raise HTTPException(status_code=400, detail="Code OTP invalide")
            
        now = datetime.now(timezone.utc)
        expires_at = otp_record.expires_at.replace(tzinfo=timezone.utc) if otp_record.expires_at.tzinfo is None else otp_record.expires_at
        
        if now > expires_at:
            raise HTTPException(status_code=400, detail="Ce code OTP a expiré")
        
        # Validate new password strength
        from auth import validate_password_strength, MIN_PASSWORD_LENGTH
        if not validate_password_strength(new_password):
            raise HTTPException(status_code=400, detail=f"Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères, dont 1 majuscule, 1 chiffre et 1 caractère spécial")
            
        # Mettre à jour le mot de passe
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail="Utilisateur non trouvé")
            
        user.hashed_password = get_password_hash(new_password)
        
        # Supprimer l'OTP
        from sqlalchemy import delete
        await session.execute(delete(PasswordResetOTP).where(PasswordResetOTP.email == email))
        
        await session.commit()
        
    return {"status": "success", "message": "Mot de passe réinitialisé avec succès"}

@app.get("/api/auth/me")
async def get_me(credentials: HTTPAuthorizationCredentials = Security(security)):
    token = credentials.credentials
    payload = decode_token(token)
    user_id = payload.get("sub")
    
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=404, detail="Utilisateur non trouvé")
            
        return {
            "id": user.id,
            "email": user.email,
            "name": user.full_name,
            "is_admin": user.is_admin
        }



@app.get("/api/performance")
async def get_performance():
    return monitor.get_performance_dashboard()


@app.get("/api/status")
async def get_status():
    return {
        "status": "active" if not monitor.is_suspended else "suspended",
        "circuit_breaker": monitor.check_circuit_breaker(),
        "risk": risk_mgr.check_can_trade(),
        "pairs": OTC_PAIRS,
        "total_signals": len(generated_signals),
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
        result = await session.execute(select(UserSubscription))
        users = result.scalars().all()
        safe_users = []
        for u in users:
            safe_users.append({
                "user_id": u.user_id,
                "plan_name": u.plan_name,
                "active_until": u.active_until.isoformat() if u.active_until else None,
                "telegram_chat_id": u.telegram_chat_id,
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
    threshold = data.get('threshold', 0.6)
    
    weight_sum = lstm_w + transformer_w + xgboost_w
    if abs(weight_sum - 1.0) > 0.05:
        raise HTTPException(status_code=400, detail=f"Weights must sum to ~1.0 (current sum: {weight_sum:.2f})")
    if threshold < 0 or threshold > 1:
        raise HTTPException(status_code=400, detail="Threshold must be between 0 and 1")
    
    voting_model.weights['LSTM'] = lstm_w
    voting_model.weights['Transformer'] = transformer_w
    voting_model.weights['XGBoost'] = xgboost_w
    voting_model.threshold = threshold
    return {"status": "success"}


# ═══════════ MARKET CONNECTION ENDPOINTS ═══════════

@app.post("/api/market/connect")
async def connect_market(request: Request):
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Corps de requête invalide")
    
    ssid = data.get("ssid")
    if not ssid:
        raise HTTPException(status_code=400, detail="SSID requis")
    
    ssid_strip = ssid.strip()
    if not ssid_strip.startswith('42["auth"'):
        raise HTTPException(status_code=400, detail="Format invalide. Le message doit commencer par 42[\"auth\",{...}].")
    
    try:
        json_start = ssid_strip.find("{")
        json_end = ssid_strip.rfind("}") + 1
        if json_start != -1 and json_end > json_start:
            payload = json.loads(ssid_strip[json_start:json_end])
            if "session" not in payload:
                raise HTTPException(status_code=400, detail="Format non supporté. Veuillez copier la trame contenant \"session\".")
        else:
            raise HTTPException(status_code=400, detail="Format JSON de la trame invalide.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Erreur de lecture de la trame: {str(e)}")

    success = await po_scanner.connect(ssid_strip)
    logger.info(f"[MARKET] Connexion effectuée (SSID: {ssid[:15]}...)")
        
    if success:
        return {"status": "success", "message": "Connecté au marché"}
    else:
        raise HTTPException(status_code=401, detail="Échec de la connexion. Vérifiez que votre SSID est frais et valide.")

@app.post("/api/market/disconnect")
async def disconnect_market():
    await po_scanner.disconnect()
    return {"status": "success", "message": "Déconnecté du marché"}

@app.get("/api/market/status")
async def get_market_status():
    return {
        "is_connected": po_scanner.is_connected,
        "ssid_preview": po_scanner.ssid[:5] + "..." if po_scanner.ssid else None,
        "payouts": {pair: po_scanner.get_payout(pair) for pair in OTC_PAIRS}
    }


@app.middleware("http")
async def rate_limit_middleware(request, call_next):
    client_ip = request.client.host if request.client else "unknown"
    now = datetime.now(timezone.utc).timestamp()
    
    # Skip rate limiting for health check endpoints
    if request.url.path in ["/api/status", "/api/market/status"]:
        return await call_next(request)
    
    if client_ip not in rate_limit_data:
        rate_limit_data[client_ip] = []
    
    # Clean old entries
    rate_limit_data[client_ip] = [t for t in rate_limit_data[client_ip] if now - t < RATE_LIMIT_WINDOW]
    
    if len(rate_limit_data[client_ip]) >= RATE_LIMIT_REQUESTS:
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Please try again later.")
    
    rate_limit_data[client_ip].append(now)
    return await call_next(request)
