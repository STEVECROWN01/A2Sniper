"""
Bot Telegram — CDC A2Sniper 3.0
15 commandes obligatoires + ACL par plan + disclaimer.
"""

import os
import re
import json
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from collections import deque
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(__file__), '../../.env.local')
load_dotenv(env_path)

logger = logging.getLogger('TelegramBot')

TELEGRAM_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID', '@A2Sniper_BinaryTrader')


# SSID detection pattern: long base64/hex strings (typical Pocket Option session IDs)
_SSID_PATTERN = re.compile(r'["\']?session["\']?\s*[:=]\s*["\']?([A-Za-z0-9+/=_-]{40,})', re.IGNORECASE)
_SSID_RAW_PATTERN = re.compile(r'\b[A-Za-z0-9+/]{80,}={0,2}\b')  # Long base64 strings
_AUTH_MSG_PATTERN = re.compile(r'42\["auth"', re.IGNORECASE)

# File path for persisting bot state
BOT_STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bot_state.json')


class TelegramSignalBot:
    def __init__(self, scanner=None):
        self.scanner = scanner
        self.is_live = False
        self.user_settings = {}  # user_id -> settings
        self.user_plans = {}     # user_id -> plan name
        self.alerts = {}         # user_id -> [{pair, level}]
        self.subscribed_chats = set() # Liste des chat_ids abonnés
        # Load persisted state from file
        self._load_state()
        self.command_handlers = {
            '/start': self.cmd_start,
            '/signals': self.cmd_signals,
            '/live': self.cmd_live,
            '/performance': self.cmd_performance,
            '/analyse': self.cmd_analyse,
            '/structure': self.cmd_structure,
            '/timeframe': self.cmd_timeframe,
            '/paires': self.cmd_paires,
            '/session': self.cmd_session,
            '/backtesting': self.cmd_backtesting,
            '/alert': self.cmd_alert,
            '/settings': self.cmd_settings,
            '/plan': self.cmd_plan,
            '/help': self.cmd_help,
            '/disclaimer': self.cmd_disclaimer,
            '/risk': self.cmd_risk_manager,
            '/journal': self.cmd_trading_journal,
            '/unsubscribe': self.cmd_unsubscribe,
            '/link': self.cmd_link,
            '/unlink': self.cmd_unlink,
        }
        # H16 Fix: Bounded signal history to prevent unbounded memory growth
        self.signal_history = deque(maxlen=1000)

    def _load_state(self):
        """Load bot state from persistent JSON file."""
        try:
            if os.path.exists(BOT_STATE_FILE):
                with open(BOT_STATE_FILE, 'r') as f:
                    data = json.load(f)
                self.user_settings = data.get('user_settings', {})
                self.user_plans = data.get('user_plans', {})
                self.alerts = data.get('alerts', {})
                # Convert subscribed_chats from list back to set
                self.subscribed_chats = set(data.get('subscribed_chats', []))
                # Restore is_live flag
                self.is_live = data.get('is_live', False)
                logger.info("[TELEGRAM] Bot state loaded from file")
        except (json.JSONDecodeError, IOError, TypeError) as e:
            logger.warning(f"[TELEGRAM] Could not load bot state (using defaults): {e}")
            # Keep the empty defaults already set in __init__

    def _save_state(self):
        """Persist current bot state to JSON file."""
        try:
            data = {
                'user_settings': self.user_settings,
                'user_plans': self.user_plans,
                'alerts': self.alerts,
                'subscribed_chats': list(self.subscribed_chats),  # Convert set to list for JSON
                'is_live': self.is_live,
            }
            with open(BOT_STATE_FILE, 'w') as f:
                json.dump(data, f)
        except (IOError, TypeError) as e:
            logger.warning(f"[TELEGRAM] Could not save bot state: {e}")

    def get_default_keyboard(self):
        keyboard = [
            [{"text": "⚡ Pairs de devises"}],
            [{"text": "📊 Trading Journal"}, {"text": "🧮 Risk Manager"}],
            [{"text": "⚠️ DISCLAIMER"}, {"text": "📈 PERF"}, {"text": "ℹ️ HELP"}]
        ]
        webapp_url = os.getenv('TELEGRAM_WEBAPP_URL')
        if webapp_url:
            keyboard.insert(0, [{"text": "🖥️ Ouvrir WebApp", "web_app": {"url": webapp_url}}])
        return {
            "keyboard": keyboard,
            "resize_keyboard": True,
            "one_time_keyboard": False
        }

    # ═══════════ ACL ═══════════
    async def _check_access(self, user_id: str, required_plan: str = 'Standard') -> bool:
        """Check access level - syncs with database.

        Two-step check:
          1. User must have run /start (user_id in subscribed_chats).
          2. User's Telegram chat_id must be linked to a DB subscription
             (subscriptions.telegram_chat_id == user_id). The linked
             subscription's plan_name determines access.
        Unlinked users get 'Standard' (free tier) — they can use Standard
        commands but Premium/Pro commands return False.
        """
        # First check if user is subscribed (has run /start)
        if user_id not in self.subscribed_chats:
            return False
        await self._sync_user_plan(user_id)
        plan = self.user_plans.get(user_id, 'Standard')
        plan_hierarchy = {'Standard': 0, 'Premium': 1, 'Pro': 2}
        return plan_hierarchy.get(plan, 0) >= plan_hierarchy.get(required_plan, 0)

    async def _sync_user_plan(self, user_id: str):
        """Sync user plan from database via the telegram_chat_id link.

        Queries subscriptions.telegram_chat_id == user_id (the Telegram
        chat_id). If a subscription row is found, its plan_name is cached
        in self.user_plans. If not found (user hasn't linked their Telegram),
        defaults to 'Standard'.

        BUGFIX: the previous version queried UserSubscription.user_id == user_id,
        but user_id here is the Telegram chat_id (e.g. "123456789"), NOT the
        DB user UUID. The query never matched, so all users were always
        'Standard' — paid Premium/Pro subscribers got Standard access only.
        """
        try:
            from db import AsyncSessionLocal, UserSubscription
            from sqlalchemy import select
            async with AsyncSessionLocal() as session:
                # Look up the subscription row linked to this Telegram chat_id.
                # subscriptions.telegram_chat_id is set by the /link command
                # (see cmd_link below).
                result = await session.execute(
                    select(UserSubscription).where(UserSubscription.telegram_chat_id == str(user_id))
                )
                sub = result.scalar_one_or_none()
                if sub:
                    # Check if subscription is still active (not expired)
                    from datetime import datetime, timezone
                    if sub.active_until and sub.active_until < datetime.now(timezone.utc):
                        # Expired — downgrade to Standard
                        self.user_plans[user_id] = 'Standard'
                    else:
                        self.user_plans[user_id] = sub.plan_name
                    self._save_state()
                else:
                    # Not linked — default to Standard
                    self.user_plans[user_id] = 'Standard'
                    self._save_state()
        except Exception as e:
            logger.warning(f"[TELEGRAM] Could not sync plan for {user_id}: {e}")

    async def _get_plan(self, user_id: str) -> str:
        await self._sync_user_plan(user_id)
        return self.user_plans.get(user_id, 'Standard')

    # ═══════════ ENVOI DE SIGNAL ═══════════
    async def send_signal(self, message: str):
        """Envoie un signal formaté au canal Telegram (si activé)."""
        # On ne supprime JAMAIS l'historique
        self.signal_history.append({
            'message': message,
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
        
        # On n'envoie que si le scanner est connecté au marché réel
        if not (self.scanner and self.scanner.is_connected):
            logger.info("[TELEGRAM] Signal généré mais non envoyé (Scanner non connecté).")
            return

        chats_to_notify = set(self.subscribed_chats)
        if TELEGRAM_CHAT_ID and TELEGRAM_CHAT_ID != '[CHAT_ID]':
            chats_to_notify.add(TELEGRAM_CHAT_ID)

        if not chats_to_notify and not TELEGRAM_CHAT_ID:
            logger.info("[TELEGRAM] Signal émis mais aucun chat de destination.")
            return

        if TELEGRAM_TOKEN:
            import httpx
            async with httpx.AsyncClient() as client:
                for chat_id in chats_to_notify:
                    try:
                        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
                        await client.post(url, json={
                            'chat_id': chat_id,
                            'text': message,
                            'parse_mode': 'HTML'
                        })
                    except Exception as e:
                        logger.error(f"[TELEGRAM] Erreur d'envoi à {chat_id}: {e}")
        else:
            logger.info(f"[TELEGRAM] Signal émis (simulation):\n{message[:100]}...")

    # ═══════════ 15 COMMANDES CDC ═══════════

    async def cmd_start(self, user_id: str, args: list = None) -> str:
        """1. /start — Onboarding et authentification"""
        self.subscribed_chats.add(user_id)
        self.user_settings.setdefault(user_id, {
            'pairs': ['EUR/USD OTC'],
            'timeframe': 'M5',
            'min_winrate': 70,
            'session_filter': 'ALL',
            'live_signals': False,
            'enabled_sessions': {'LONDON': True, 'NY': True, 'ASIAN': True},
        })
        self._save_state()

        # Check if this Telegram chat is linked to a subscription
        plan = await self._get_plan(user_id)
        is_linked = plan != 'Standard'

        link_hint = ""
        if not is_linked:
            link_hint = (
                "\n\n🔗 <b>LINK YOUR ACCOUNT</b>\n"
                "You're currently on the <b>Standard (free)</b> plan.\n"
                "If you have a Premium or Pro subscription, link it to unlock /analyse, /structure, /backtesting.\n"
                "→ Go to <b>a2sniper.vercel.app/settings</b> → <b>Link Telegram Account</b> → generate a code → send <code>/link &lt;code&gt;</code> here."
            )

        return f"""🎯 Bienvenue sur A2Sniper 3.0

🏆 Système d'Analyse Marché Réel 100% Intègre.
📊 Winrate Dynamique | Sniper Entry System (SES)

Pour commencer :
1️⃣ /plan — Voir votre abonnement
2️⃣ /paires — Choisir vos paires
3️⃣ /live — Activer les signaux temps réel (Data Live)
4️⃣ /help — Guide complet{link_hint}

⚠️ SÉCURITÉ : Ne partagez JAMAIS votre SSID dans ce chat.
Utilisez la méthode de connexion sécurisée dans le dashboard web.

⚠️ Le trading comporte des risques. Zéro Simulation. 100% Real-Market."""

    async def cmd_signals(self, user_id: str, args: list = None) -> str:
        """2. /signals — 10 derniers signaux reçus"""
        # Query from database for real signal history
        try:
            from db import AsyncSessionLocal, SignalRecord
            from sqlalchemy import select
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(SignalRecord).order_by(SignalRecord.timestamp.desc()).limit(10)
                )
                db_signals = result.scalars().all()
        except Exception as e:
            logger.error(f"Error querying signals: {e}")
            db_signals = []
        
        if not db_signals and not self.signal_history:
            return "📭 Aucun signal récent. Activez /live pour recevoir des signaux."

        lines = ["📊 DERNIERS SIGNAUX\n━━━━━━━━━━━━━━━━━━━━━"]
        if db_signals:
            for i, s in enumerate(db_signals, 1):
                ts = s.timestamp.strftime('%Y-%m-%d %H:%M') if s.timestamp else 'N/A'
                result_icon = '✅' if s.is_win == True else '❌' if s.is_win == False else '⏳'
                lines.append(f"{i}. {result_icon} {s.pair} | {s.direction} | WR:{s.winrate}% | {ts}")
        else:
            for i, s in enumerate(reversed(self.signal_history[-10:]), 1):
                lines.append(f"{i}. {s['timestamp'][:19]}")
        lines.append("\nTapez /live pour recevoir les signaux en temps réel.")
        return "\n".join(lines)

    async def cmd_live(self, user_id: str, args: list = None) -> str:
        """3. /live — Activer/désactiver signaux temps réel"""
        if self.scanner and not self.scanner.is_connected:
            return "🔴 ERREUR : Le système est actuellement DÉCONNECTÉ du marché.\nLe bot ne peut pas envoyer de signaux tant que la connexion SSID n'est pas établie via le dashboard ou le bot."

        settings = self.user_settings.get(user_id, {})
        current = settings.get('live_signals', False)
        settings['live_signals'] = not current
        self.user_settings[user_id] = settings
        
        # Pour le canal principal
        self.is_live = settings['live_signals']
        self._save_state()

        if settings['live_signals']:
            return "✅ SIGNAUX LIVE ACTIVÉS\nVous recevrez désormais les signaux en temps réel dès qu'ils sont détectés par l'IA."
        return "⏸️ SIGNAUX LIVE DÉSACTIVÉS\nLe bot restera silencieux. Utilisez /live pour reprendre."

    async def cmd_performance(self, user_id: str, args: list = None) -> str:
        """4. /performance — Statistiques de succès réelles (from database)"""
        try:
            from db import AsyncSessionLocal, SignalRecord
            from sqlalchemy import select, func
            async with AsyncSessionLocal() as session:
                # Get total signals
                total_result = await session.execute(select(func.count(SignalRecord.id)))
                total_signals = total_result.scalar() or 0
                
                # Get resolved signals (where is_win is known)
                resolved_result = await session.execute(
                    select(SignalRecord).where(SignalRecord.is_win != None)  # noqa: E711
                )
                resolved = resolved_result.scalars().all()
                
                if not resolved:
                    return "📈 PERFORMANCE — A2SNIPER\n━━━━━━━━━━━━━━━━━━━━━\nNo performance data available yet.\n\nSignals will appear here once they are generated and resolved."
                
                wins = sum(1 for s in resolved if s.is_win)
                losses = len(resolved) - wins
                win_rate = round(wins / len(resolved) * 100, 1) if resolved else 0
                
                # Average payout
                payout_result = await session.execute(
                    select(func.avg(SignalRecord.payout)).where(SignalRecord.is_win != None)  # noqa: E711
                )
                avg_payout = round(payout_result.scalar() or 0, 1)
                
                # Best pair
                pair_stats = {}
                for s in resolved:
                    p = s.pair
                    if p not in pair_stats:
                        pair_stats[p] = {'wins': 0, 'total': 0}
                    pair_stats[p]['total'] += 1
                    if s.is_win:
                        pair_stats[p]['wins'] += 1
                
                best_pair = max(
                    pair_stats.items(), 
                    key=lambda x: x[1]['wins'] / max(x[1]['total'], 1), 
                    default=('N/A', {'wins': 0, 'total': 0})
                )
        except Exception as e:
            logger.error(f"Error querying performance: {e}")
            return "📈 PERFORMANCE — A2SNIPER\n━━━━━━━━━━━━━━━━━━━━━\nNo performance data available yet.\n\nCould not retrieve data from the database."
        
        return f"""📈 PERFORMANCE RÉELLE — A2SNIPER
━━━━━━━━━━━━━━━━━━━━━
🎯 Win Rate (Réel) : {win_rate}%
📊 Signaux Résolus : {wins}W / {losses}L ({wins+losses} total)
📊 Signaux Total   : {total_signals}
💰 Payout Moyen    : {avg_payout}%
🏆 Meilleure Paire : {best_pair[0]} ({best_pair[1]['wins']}/{best_pair[1]['total']})

🏦 Source : Pocket Option Real-Market Feed

Note: Toutes les données sont extraites de la base de données réelle."""

    async def cmd_analyse(self, user_id: str, args: list = None) -> str:
        """5. /analyse [PAIRE] — Analyse manuelle à la demande (Premium+)"""
        # Auth check: must be subscribed and have Premium+ plan
        if user_id not in self.subscribed_chats:
            return "🔒 Vous devez d'abord démarrer le bot avec /start pour accéder aux commandes premium."
        if not await self._check_access(user_id, 'Premium'):
            return "🔒 Commande réservée aux plans Premium et Pro.\nTapez /plan pour upgrader.\n\n⚠️ NOTE : L'authentification complète nécessite la liaison de votre ID Telegram à votre compte utilisateur."

        pair = args[0] if args else 'EUR/USD OTC'
        
        # C13 Fix: Check scanner availability before attempting analysis
        if not self.scanner:
            return "Market data not available. Please connect to Pocket Option first."
        if not self.scanner.is_connected:
            return f"Market data not available. Please connect to Pocket Option first.\n\n⚠️ Impossible d'analyser {pair}. Le bot n'est actuellement pas connecté au marché réel."

        payout = self.scanner.get_payout(pair) if self.scanner else None
        current_price = await self.scanner.get_current_price(pair) if self.scanner else None

        if payout is None or current_price is None:
            return f"⚠️ Impossible d'obtenir les données en temps réel pour {pair}. Vérifiez la connexion."

        # Format payout in PO's display format (+92%, not 92%)
        payout_display = self.scanner.format_payout(payout)

        return f"""🔍 ANALYSE EN DIRECT (RÉEL) — {pair}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Prix Actuel   : {current_price}
💰 Payout Actuel : {payout_display}

📊 Les données ci-dessus sont extraites en temps réel du marché.
Pour un signal complet avec scoring IA, utilisez le dashboard Web.

⚠️ Les signaux doivent être générés par le moteur d'analyse complet pour une évaluation de winrate fiable."""

    async def cmd_structure(self, user_id: str, args: list = None) -> str:
        """6. /structure [PAIRE] — Vue SMC complète (Premium+)"""
        # Auth check: must be subscribed and have Premium+ plan
        if user_id not in self.subscribed_chats:
            return "🔒 Vous devez d'abord démarrer le bot avec /start pour accéder aux commandes premium."
        if not await self._check_access(user_id, 'Premium'):
            return "🔒 Commande réservée aux plans Premium et Pro.\nTapez /plan pour upgrader.\n\n⚠️ NOTE : L'authentification complète nécessite la liaison de votre ID Telegram à votre compte utilisateur."

        pair = args[0] if args else 'EUR/USD OTC'
        
        # C13 Fix: Check scanner availability before attempting SMC analysis
        if not self.scanner:
            return "Market data not available. Please connect to Pocket Option first."
        if not self.scanner.is_connected:
            return f"Market data not available. Please connect to Pocket Option first.\n\n⚠️ Impossible de récupérer la structure pour {pair}. Le bot n'est pas connecté au marché réel."

        current_price = await self.scanner.get_current_price(pair) if self.scanner else None
        
        if current_price is None:
            return f"⚠️ Impossible d'obtenir le prix pour {pair}. Vérifiez la connexion."

        # Run real SMC analysis
        try:
            from engine.smc import SMCEngine
            from engine.indicators import TechnicalIndicators
            smc = SMCEngine()
            ind = TechnicalIndicators()
            
            df = await self.scanner.get_candles(pair, timeframe="1m", count=100)
            if df.empty or len(df) < 20:
                return f"⚠️ Pas assez de données pour analyser {pair}."
            
            df = ind.calculate_all(df)
            smc_result = smc.analyze(df)
            trend = smc_result.get('trend', 'N/A')
            obs = smc_result.get('order_blocks', [])
            fvgs = smc_result.get('fvgs', [])
            liq = smc_result.get('liquidity_zones', {})
            
            ob_lines = []
            for ob in obs[:3]:
                ob_lines.append(f"  └ {ob.get('type', 'OB')} @ zone active")
            
            fvg_lines = []
            for fvg in fvgs[:3]:
                fvg_lines.append(f"  └ {fvg.get('type', 'FVG')} @ zone active")
            
            bsl = liq.get('buy_side_liquidity', [])
            ssl = liq.get('sell_side_liquidity', [])
            bsl_str = f"@ {bsl[0]:.5f}" if bsl else "N/A"
            ssl_str = f"@ {ssl[0]:.5f}" if ssl else "N/A"
            
        except Exception as e:
            logger.error(f"Error in SMC analysis: {e}")
            trend = "N/A"
            ob_lines = ["  └ Erreur d'analyse"]
            fvg_lines = ["  └ Erreur d'analyse"]
            bsl_str = "N/A"
            ssl_str = "N/A"

        return f"""🏗️ STRUCTURE SMC EN DIRECT — {pair}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Prix Marché : {current_price}
📈 Tendance    : {trend}

📦 Order Blocks actifs :
{chr(10).join(ob_lines) if ob_lines else '  └ Aucun détecté'}

📐 FVG actifs :
{chr(10).join(fvg_lines) if fvg_lines else '  └ Aucun détecté'}

💧 Liquidité :
  └ BSL {bsl_str}
  └ SSL {ssl_str}"""

    async def cmd_timeframe(self, user_id: str, args: list = None) -> str:
        """7. /timeframe [M1|M5|M15] — Changer le timeframe"""
        valid_tfs = ['M1', 'M5', 'M15']
        tf = args[0].upper() if args else None

        if tf not in valid_tfs:
            return f"⚙️ Timeframes disponibles : {', '.join(valid_tfs)}\nUtilisation : /timeframe M5"

        settings = self.user_settings.get(user_id, {})
        settings['timeframe'] = tf
        self.user_settings[user_id] = settings
        self._save_state()
        return f"✅ Timeframe changé à {tf}\nLes signaux seront analysés sur {tf}."

    async def cmd_paires(self, user_id: str, args: list = None) -> dict:
        """8. /paires — Show ONLY eligible pairs (active AND payout >= 70%).

        Rules (matching PO's real behaviour and user requirement):
          - ONLY pairs that are currently ACTIVE on PO (is_active=True)
            AND have payout >= +70% are listed.
          - All other pairs (inactive OR payout < 70%) are EXCLUDED entirely —
            they are not fetched, not displayed, not used for signal generation.
            They reappear automatically when PO marks them active AND their
            payout rises to >= +70% (the refresh loop detects the change within ~5s).
          - Payouts are shown in PO's display format: "+92%", "+78%", etc.
          - Payout update timing is UNPREDICTABLE (PO's internal logic decides).
            Our refresh loop polls PO every 5s so values shown reflect PO's UI.
        """
        if not self.scanner or not self.scanner.is_connected:
            return {
                "text": "⚠️ Impossible de lister les paires actives. Aucune connexion au marché réel."
            }

        # Fetch ONLY eligible pairs: active AND payout >= 70%.
        # active_only=True excludes inactive pairs (we never want them).
        # min_payout=70 enforces the minimum +70% profitability threshold.
        real_pairs = self.scanner.find_pairs_above_payout(
            min_payout=70.0, pair_filter="OTC", active_only=True
        )

        # Sort by payout descending (highest payout first)
        sorted_pairs = sorted(real_pairs.items(), key=lambda x: -x[1])

        # Limit to top 20 to avoid Telegram inline keyboard overflow
        sorted_pairs = sorted_pairs[:20]

        if not sorted_pairs:
            return {
                "text": (
                    "🎯 <b>Paires éligibles du marché (Live PO)</b>\n"
                    "━━━━━━━━━━━━━━━━━━━━━\n"
                    "⏳ Aucune paire OTC éligible pour le moment (active ET payout ≥ +70%).\n\n"
                    "Les paires deviennent disponibles lorsque Pocket Option les active "
                    "ET leur payout atteint +70%. Revenez dans quelques minutes — "
                    "la liste s'actualise automatiquement toutes les 5 secondes."
                )
            }

        inline_keyboard = []
        # Build rows of 2 buttons each
        for i in range(0, len(sorted_pairs), 2):
            row = []
            for pair_name, payout in sorted_pairs[i:i+2]:
                # Eligible pair — show in PO format: "+92%"
                btn_text = f"{pair_name}  💰+{payout:.0f}%"
                row.append({
                    "text": btn_text,
                    "callback_data": f"signal_{pair_name}"
                })
            inline_keyboard.append(row)

        return {
            "text": (
                "🎯 <b>Paires éligibles du marché (Live PO)</b>\n"
                "━━━━━━━━━━━━━━━━━━━━━\n"
                "💰 Payouts extraits en direct de Pocket Option (≥ +70%).\n"
                "Seules les paires actives avec payout ≥ +70% sont affichées.\n"
                "Cliquez sur une paire pour générer un signal immédiat.\n\n"
                f"<i>{len(sorted_pairs)} paires éligibles détectées. "
                "Actualisation toutes les 5 secondes.</i>"
            ),
            "reply_markup": {
                "inline_keyboard": inline_keyboard
            }
        }

    async def cmd_session(self, user_id: str, args: list = None) -> str:
        """9. /session [SESSION] [on|off] — Enable/disable signals by session"""
        sessions = {
            'LONDON': {'hours': '08:00-10:00 UTC', 'description': 'London Open'},
            'NY': {'hours': '13:00-15:00 UTC', 'description': 'New York Open'},
            'ASIAN': {'hours': '00:00-08:00 UTC', 'description': 'Asian Session'},
            'OVERLAP': {'hours': '13:00-16:00 UTC', 'description': 'London/NY Overlap'},
        }
        
        settings = self.user_settings.get(user_id, {})
        enabled_sessions = settings.get('enabled_sessions', {'LONDON': True, 'NY': True, 'ASIAN': True})
        
        # If args provided, toggle a specific session
        if args:
            s = args[0].upper()
            if s == 'ALL':
                # Toggle all sessions
                if len(args) > 1 and args[1].lower() == 'off':
                    enabled_sessions = {k: False for k in sessions}
                    settings['session_filter'] = 'NONE'
                else:
                    enabled_sessions = {k: True for k in sessions}
                    settings['session_filter'] = 'ALL'
                settings['enabled_sessions'] = enabled_sessions
                self.user_settings[user_id] = settings
                self._save_state()
                status = '✅ All' if any(enabled_sessions.values()) else '⏸️ Aucune'
                return f"✅ Sessions : {status} sessions activées"
            
            if s in sessions:
                # Toggle on/off
                if len(args) > 1 and args[1].lower() in ('on', 'off'):
                    enabled_sessions[s] = args[1].lower() == 'on'
                else:
                    # Simple toggle
                    enabled_sessions[s] = not enabled_sessions.get(s, True)
                
                settings['enabled_sessions'] = enabled_sessions
                # Set session_filter to ALL if any session enabled, or to NONE
                active = [k for k, v in enabled_sessions.items() if v]
                settings['session_filter'] = active[0] if len(active) == 1 else ('ALL' if active else 'NONE')
                self.user_settings[user_id] = settings
                self._save_state()
                status = '✅ Activée' if enabled_sessions[s] else '⏸️ Désactivée'
                return f"✅ Session {s} ({sessions[s]['hours']}) : {status}"

        # Show current session status
        lines = ["⏰ SESSIONS DE TRADING\n━━━━━━━━━━━━━━━━━━━━━"]
        for s, info in sessions.items():
            is_enabled = enabled_sessions.get(s, True)
            status_icon = '✅' if is_enabled else '⏸️'
            lines.append(f"{status_icon} {s} : {info['hours']} ({info['description']})")
        lines.append("\n📋 Commandes :")
        lines.append("• /session LONDON — Toggle London on/off")
        lines.append("• /session NY on — Enable NY session")
        lines.append("• /session ASIAN off — Disable Asian session")
        lines.append("• /session ALL — Enable all sessions")
        return "\n".join(lines)

    async def cmd_backtesting(self, user_id: str, args: list = None) -> str:
        """10. /backtesting [PAIRE] — Backtest rapide 30 jours (Pro) — uses real database data"""
        # Auth check: must be subscribed and have Pro plan specifically
        if user_id not in self.subscribed_chats:
            return "🔒 Vous devez d'abord démarrer le bot avec /start pour accéder aux commandes premium."
        await self._sync_user_plan(user_id)
        plan = self.user_plans.get(user_id, 'Standard')
        if plan != 'Pro':
            return "🔒 Commande réservée au plan Pro uniquement.\nTapez /plan pour upgrader.\n\n⚠️ NOTE : L'authentification complète nécessite la liaison de votre ID Telegram à votre compte utilisateur."

        pair = args[0] if args else 'EUR/USD OTC'
        
        try:
            from db import AsyncSessionLocal, SignalRecord
            from sqlalchemy import select, func
            from datetime import timedelta
            async with AsyncSessionLocal() as session:
                cutoff = datetime.now(timezone.utc) - timedelta(days=30)
                # Total signals for pair
                total_result = await session.execute(
                    select(func.count(SignalRecord.id)).where(
                        SignalRecord.pair == pair,
                        SignalRecord.timestamp >= cutoff
                    )
                )
                total = total_result.scalar() or 0
                
                # Resolved signals
                resolved_result = await session.execute(
                    select(SignalRecord).where(
                        SignalRecord.pair == pair,
                        SignalRecord.is_win != None,  # noqa: E711
                        SignalRecord.timestamp >= cutoff
                    )
                )
                resolved = resolved_result.scalars().all()
                
                # If no data available, return honest message
                if not resolved and total == 0:
                    return f"📊 BACKTESTING — {pair}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nNo backtesting data available yet.\n\nBacktesting requires historical signal data as per CDC specification.\nSignals will appear here once the system generates and resolves them."
                
                if not resolved:
                    return f"📊 BACKTESTING — {pair} (30 derniers jours)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📈 Trades totaux : {total}\n⏳ Aucun trade résolu pour le moment.\n\nLes résultats apparaîtront une fois les signaux résolus."
                
                wins = sum(1 for s in resolved if s.is_win)
                losses = len(resolved) - wins
                win_rate = round(wins / len(resolved) * 100, 1) if resolved else 0
                
                # Profit calculation (assuming $10 stake)
                pnl = 0
                for s in resolved:
                    if s.is_win:
                        pnl += 10 * ((s.payout or 80) / 100)
                    else:
                        pnl -= 10
        except Exception as e:
            logger.error(f"Error in backtesting query: {e}")
            return f"📊 BACKTESTING — {pair}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nNo backtesting data available yet.\n\nCould not retrieve data from the database."
        
        return f"""📊 BACKTESTING — {pair} (30 derniers jours)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Trades totaux : {total}
✅ Gagnants      : {wins}
❌ Perdants      : {losses}
🎯 Win Rate      : {win_rate}%
💰 Profit Net    : {'+' if pnl >= 0 else ''}${pnl:.2f} (mise $10)

⚠️ Les performances passées ne garantissent pas les résultats futurs.
📊 Données extraites de la base de données réelle."""

    async def cmd_alert(self, user_id: str, args: list = None) -> str:
        """11. /alert [PAIRE] [NIVEAU] — Alerte de prix (Premium+)"""
        if not await self._check_access(user_id, 'Premium'):
            return "🔒 Commande réservée aux plans Premium et Pro."

        if not args or len(args) < 2:
            return "⚙️ Utilisation : /alert EUR/USD 1.0850\nPour supprimer : /alert clear"

        if args[0].lower() == 'clear':
            self.alerts[user_id] = []
            self._save_state()
            return "✅ Toutes les alertes supprimées."

        pair = args[0]
        # Sanitize level input - must be a valid number
        try:
            level = float(args[1])
        except (ValueError, TypeError):
            return "❌ Le niveau de prix doit être un nombre valide. Exemple : /alert EUR/USD 1.0850"
        
        self.alerts.setdefault(user_id, []).append({'pair': pair, 'level': level})
        self._save_state()
        return f"✅ Alerte créée : {pair} @ {level}\nVous serez notifié quand le prix atteindra ce niveau."

    async def cmd_settings(self, user_id: str, args: list = None) -> str:
        """12. /settings — Configuration préférences"""
        settings = self.user_settings.get(user_id, {})
        return f"""⚙️ VOS PARAMÈTRES SNIPER
━━━━━━━━━━━━━━━━━━━━━
📊 Paires       : {', '.join(settings.get('pairs', ['EUR/USD OTC']))}
⏰ Timeframe    : {settings.get('timeframe', 'M5')}
🎯 Winrate min  : {settings.get('min_winrate', 70)}%
📅 Session      : {settings.get('session_filter', 'ALL')}
📡 Live         : {'✅ Activé' if settings.get('live_signals') else '⏸️ Désactivé'}

Pour modifier : /timeframe M1 | /paires EUR/USD OTC | /session LONDON"""

    async def cmd_plan(self, user_id: str, args: list = None) -> str:
        """13. /plan — Afficher plan actuel et upgrade (reads from database)"""
        plan = await self._get_plan(user_id)

        # Try to get additional plan details from database (via telegram_chat_id link)
        plan_details = {}
        is_linked = False
        try:
            from db import AsyncSessionLocal, UserSubscription
            from sqlalchemy import select
            async with AsyncSessionLocal() as session:
                # Query by telegram_chat_id (not user_id — that was the old bug)
                result = await session.execute(
                    select(UserSubscription).where(UserSubscription.telegram_chat_id == str(user_id))
                )
                sub = result.scalar_one_or_none()
                if sub:
                    is_linked = True
                    plan_details = {
                        'expires_at': sub.active_until.strftime('%Y-%m-%d') if hasattr(sub, 'active_until') and sub.active_until else 'N/A',
                        'is_active': getattr(sub, 'is_active', True),
                    }
        except Exception as e:
            logger.warning(f"Could not fetch plan details: {e}")

        expiry_line = f"\n📅 Expiration    : {plan_details.get('expires_at', 'N/A')}" if plan_details else ''
        active_line = f"\n🟢 Statut       : {'Actif' if plan_details.get('is_active', True) else 'Expiré'}" if plan_details else ''

        link_status_line = (
            "\n✅ Telegram lié à votre compte A2Sniper"
            if is_linked else
            "\n⚠️ Telegram NON lié — utilisez /link pour débloquer Premium/Pro"
        )

        return f"""👤 VOTRE ABONNEMENT
━━━━━━━━━━━━━━━━━━━━━
📋 Plan actuel : {plan}{expiry_line}{active_line}{link_status_line}

📊 PLANS DISPONIBLES :
▶ Standard (198$/mois) — 20 signaux/jour
▶ Premium (298$/mois) — 35 signaux/jour + /analyse + /structure
▶ Pro (398$/mois) — Illimité + Backtesting + API + Coaching

Pour upgrader : Visitez https://a2sniper/pricing"""

    async def cmd_help(self, user_id: str, args: list = None) -> str:
        """14. /help — Complete usage guide with all available commands"""
        return """📖 <b>GUIDE COMPLET A2SNIPER 3.0</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔹 <b>Commandes de base</b> :
• <code>/start</code> — Démarrer le bot et voir l'onboarding
• <code>/signals</code> — Voir les 10 derniers signaux
• <code>/live</code> — Activer/Désactiver les signaux temps réel
• <code>/help</code> — Afficher ce guide complet
• <code>/disclaimer</code> — Avertissement sur les risques
• <code>/unsubscribe</code> — Se désabonner des notifications

🔹 <b>Analyse & Données</b> :
• <code>/analyse [Paire]</code> — Analyse technique détaillée (Premium+)
• <code>/structure [Paire]</code> — Vue de la structure SMC (Premium+)
• <code>/performance</code> — Statistiques de succès réelles
• <code>/backtesting [Paire]</code> — Backtest historique 30j (Pro)

🔹 <b>Configuration</b> :
• <code>/paires</code> — Sélectionner les paires à surveiller
• <code>/timeframe [M1|M5|M15]</code> — Changer le timeframe
• <code>/session [LONDON|NY|ASIAN] [on|off]</code> — Activer/désactiver sessions
• <code>/settings</code> — Voir vos paramètres actuels
• <code>/alert [Paire] [Niveau]</code> — Créer une alerte de prix (Premium+)

🔹 <b>Gestion & Plan</b> :
• <code>/plan</code> — Voir votre abonnement et options
• <code>/journal</code> — Trading Journal avec historique
• <code>/risk</code> — Règles de Money Management

🔹 <b>Boutons rapides</b> :
⚡ Pairs de devises — Paires actives
📊 Trading Journal — Statistiques réelles
🧮 Risk Manager — Money Management
⚠️ DISCLAIMER — Risques
📈 PERF — Performances
ℹ️ HELP — Ce guide

⚠️ <b>SÉCURITÉ</b> : Ne partagez JAMAIS votre SSID dans ce chat.
Utilisez le dashboard web pour la connexion sécurisée.

⚠️ Le trading comporte des risques de perte de capital."""

    async def cmd_connect_ssid(self, user_id: str, ssid: str) -> str:
        """Tentative de connexion au marché via le SSID fourni — with security warning"""
        # C3 Fix: Warn users about SSID security
        warning = "⚠️ SECURITY WARNING: Never share your SSID in chat. Use the secure connection method in the web dashboard instead.\n\n"
        
        if not self.scanner:
            return f"{warning}❌ Erreur : Le scanner n'est pas initialisé sur le serveur."
            
        success = await self.scanner.connect(ssid)
        if success:
            return f"""{warning}🎉 <b>Connexion au marché Pocket Option réussie !</b>

🤖 L'assistant de pointe pour votre trading binaire haute fréquence.
🟢 Vous êtes actuellement connecté avec succès au marché 💹

Pour commencer à recevoir vos signaux de trading binaire, veuillez cliquer sur le bouton <b>⚡ Pairs de devises</b> ci-dessous, puis sélectionnez la paire de votre choix pour recevoir votre signal.

⚠️ Pour les prochaines connexions, utilisez le dashboard web pour plus de sécurité.

Excellente session de trading à vous !"""
        else:
            return f"{warning}❌ <b>Échec de la connexion.</b> Le SSID ou message de session fourni est invalide ou expiré. Veuillez utiliser le dashboard web pour vous connecter."

    async def cmd_unsubscribe(self, user_id: str, args: list = None) -> str:
        """Unsubscribe from signal notifications."""
        self.subscribed_chats.discard(user_id)
        settings = self.user_settings.get(user_id, {})
        settings['live_signals'] = False
        self.user_settings[user_id] = settings
        self._save_state()
        return "✅ Vous êtes désabonné des notifications de signaux.\nUtilisez /live ou /start pour vous réabonner."

    async def cmd_trading_journal(self, user_id: str, args: list = None) -> str:
        """Affiche le Trading Journal à partir de la base de données"""
        from db import AsyncSessionLocal, SignalRecord
        from sqlalchemy import select
        
        try:
            async with AsyncSessionLocal() as session:
                query = select(SignalRecord).where(SignalRecord.is_win != None).order_by(SignalRecord.timestamp.desc()).limit(30)
                result = await session.execute(query)
                signals = result.scalars().all()
        except Exception as e:
            logger.error(f"Error querying signals for Trading Journal: {e}")
            signals = []
            
        if not signals:
            return """📊 <b>Trading Journal — A2Sniper</b>
━━━━━━━━━━━━━━━━━━━━━
Aucune session de trading active ou aucun signal résolu pour le moment.

Les signaux résolus apparaîtront ici automatiquement."""

        wins = sum(1 for s in signals if s.is_win)
        losses = sum(1 for s in signals if not s.is_win)
        total = wins + losses
        winrate = (wins / total * 100) if total > 0 else 0
        
        pnl = 0
        for s in signals:
            if s.is_win:
                pnl += 10 * ((s.payout or 80) / 100)
            else:
                pnl -= 10

        lines = [
            "📊 <b>TRADING JOURNAL — A2SNIPER</b>",
            "━━━━━━━━━━━━━━━━━━━━━",
            "💵 Mise Standard : $10.00",
            f"📈 Net PnL : <b>{'+' if pnl >= 0 else ''}${pnl:.2f}</b>",
            f"🎯 Win Rate : <b>{winrate:.1f}%</b> ({wins}W - {losses}L)",
            f"🔢 Total Trades : {total}",
            "━━━━━━━━━━━━━━━━━━━━━",
            "<b>Historique Récent :</b>"
        ]
        
        for i, s in enumerate(signals[:5], 1):
            status = "🟢 WIN" if s.is_win else "🔴 LOSS"
            pnl_val = (10 * ((s.payout or 80) / 100)) if s.is_win else -10
            lines.append(f"#{i} {s.pair} | {status} ({'+' if pnl_val >= 0 else ''}${pnl_val:.2f})")
            
        return "\n".join(lines)

    async def cmd_risk_manager(self, user_id: str, args: list = None) -> str:
        """Affiche le Risk Manager & Règles de Money Management"""
        return """🧮 <b>A2SNIPER RISK MANAGER</b>
━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>Règles Strictes de Money Management :</b>

1️⃣ <b>Mise par Trade :</b> 1% à 3% maximum de votre capital total.
   • Score 7/10 : 1% du capital
   • Score 8-9/10 : 2% du capital
   • Score 10/10 (Sniper Shot) : 3% du capital

2️⃣ <b>Limite de Session :</b> Ne jamais engager plus de 15% de votre capital total en même temps.

3️⃣ <b>Règle de Circuit Breaker :</b> Après 3 pertes consécutives, arrêtez immédiatement votre session de trading pendant au moins 30 minutes.

4️⃣ <b>Pas de Martingale :</b> Doubler sa mise après une perte est formellement interdit pour préserver votre capital.

📊 <i>Utilisez ces règles rigoureusement pour maintenir un profit à long terme.</i>"""

    async def cmd_disclaimer(self, user_id: str, args: list = None) -> str:
        """Avertissement sur les risques de trading"""
        return """⚠️ <b>RISQUE & CONFORMITÉ — A2SNIPER</b>
━━━━━━━━━━━━━━━━━━━━━
<b>Attention : Risque élevé</b>

Le trading sur options binaires et Forex comporte un niveau de risque très élevé et peut ne pas convenir à tous les investisseurs.

• L'effet de levier peut jouer aussi bien en votre faveur qu'en votre défaveur.
• Avant de trader, examinez attentivement vos objectifs, votre expérience et votre gestion du risque.
• <b>Ne tradez jamais</b> avec de l'argent que vous ne pouvez pas vous permettre de perdre.

<i>L'Assistant A2Sniper fournit des analyses de pointe basées sur des algorithmes HFT, mais ne garantit en aucun cas des profits futurs.</i>"""

    async def cmd_signal_on_demand(self, user_id: str, pair: str) -> str:
        """Generate a real signal on demand when user clicks a pair button.

        This bypasses the Premium+ ACL gate (because the user already has market
        access via the dashboard) and uses the force-mode analyzer so the strict
        filters don't reject the on-demand request.
        """
        if not self.scanner or not self.scanner.is_connected:
            return "🔴 Le système est actuellement DÉCONNECTÉ du marché. Impossible de générer un signal."

        # Validate pair format — must look like "XXX/XXX OTC" or similar
        if not pair or len(pair) < 3:
            return "❌ Paire invalide."

        # Get real payout. None means: pair is inactive OR not found on PO right now.
        # Inactive pairs are NEVER displayed by /paires — so reaching this branch
        # means either the user typed a pair manually, or the pair became inactive
        # in the ~5s since they tapped the button. In either case we don't expose
        # "inactive" state — we just tell them the pair isn't available.
        payout = self.scanner.get_payout(pair)
        if payout is None:
            return (
                f"⏳ <b>{pair} n'est plus disponible sur Pocket Option.</b>\n"
                f"━━━━━━━━━━━━━━━━━━━━━\n"
                f"Cette paire n'est actuellement pas tradable (inactive ou payout insuffisant).\n\n"
                f"👉 Relancez /paires pour voir la liste à jour des paires éligibles\n"
                f"    (actives avec payout ≥ +70%)."
            )

        # Enforce minimum +70% payout — system rule.
        # Pairs below this threshold are not eligible for signal generation.
        if payout < 70:
            return (
                f"⏳ <b>{pair} n'est plus éligible.</b>\n"
                f"━━━━━━━━━━━━━━━━━━━━━\n"
                f"Payout actuel : <b>+{payout:.0f}%</b> (inférieur au seuil de +70%).\n"
                f"Le système ne génère des signaux que pour les paires avec payout ≥ +70%.\n\n"
                f"👉 Relancez /paires pour voir les paires éligibles actuelles."
            )

        # Try to import the force_analyze_pair from main (the bot runs in same process)
        try:
            import sys
            # Find main module — the bot is imported by main.py
            main_mod = sys.modules.get('main')
            if main_mod and hasattr(main_mod, 'force_analyze_pair'):
                signal = await main_mod.force_analyze_pair(pair)
                if signal:
                    # Format payout in PO's display format (+92%, not 92%)
                    payout_display = self.scanner.format_payout(signal.get('payout', payout))
                    return (
                        f"🎯 <b>SIGNAL À LA DEMANDE — {pair}</b>\n"
                        f"━━━━━━━━━━━━━━━━━━━━━\n"
                        f"🟢 Direction : <b>{signal['direction']}</b>\n"
                        f"⌛ Expiration : <b>{signal['expiration']}m</b>\n"
                        f"💰 Payout : <b>{payout_display}</b>\n"
                        f"🎯 Score : <b>{signal['score']}/10</b> | Winrate : <b>{signal['winrate']}%</b>\n"
                        f"📈 Prix d'entrée : <code>{signal['entry_price']}</code>\n"
                        f"🏗️ Structure : <i>{signal.get('smc_structure', '—')}</i>\n\n"
                        f"<i>Données 100% live — vérifiables sur Pocket Option.</i>\n"
                        f"⏰ Valable jusqu'à l'expiration indiquée. Agissez vite."
                    )
                else:
                    return (
                        f"⏳ Aucun signal valide pour {pair} à cet instant.\n"
                        f"Le marché ne remplit pas les critères de confluence Sniper (score insuffisant).\n"
                        f"Payout actuel : {self.scanner.format_payout(payout)}.\n\n"
                        f"Réessayez dans 1-2 minutes — le scanner ré-analyse en continu."
                    )
            else:
                logger.error("[TELEGRAM] main module or force_analyze_pair not found")
                return "⚠️ Erreur interne : moteur d'analyse indisponible. Réessayez plus tard."
        except Exception as e:
            logger.error(f"[TELEGRAM] Error generating signal for {pair}: {e}")
            return f"⚠️ Erreur lors de la génération du signal pour {pair}: {e}"

    async def handle_command(self, user_id: str, text: str):
        """Routeur principal de commandes."""
        text = text.strip()
        
        # Map button texts to appropriate handlers
        if text in ["⚡ Pairs de devises", "Pairs de devises"]:
            return await self.cmd_paires(user_id)
        elif text in ["📊 Trading Journal", "Trading Journal"]:
            return await self.cmd_trading_journal(user_id)
        elif text in ["🧮 Risk Manager", "Risk Manager"]:
            return await self.cmd_risk_manager(user_id)
        elif text in ["⚠️ DISCLAIMER", "DISCLAIMER"]:
            return await self.cmd_disclaimer(user_id)
        elif text in ["📈 PERF", "PERF"]:
            return await self.cmd_performance(user_id)
        elif text in ["ℹ️ HELP", "HELP"]:
            return await self.cmd_help(user_id)
            
        # C3 Fix: Check if message looks like an SSID — warn and strip sensitive content
        if _AUTH_MSG_PATTERN.search(text) or _SSID_PATTERN.search(text) or _SSID_RAW_PATTERN.search(text):
            # Strip the SSID from being displayed — replace with [REDACTED]
            sanitized_text = _SSID_RAW_PATTERN.sub('[REDACTED_SSID]', text)
            sanitized_text = _SSID_PATTERN.sub('[REDACTED_SSID]', sanitized_text)
            logger.warning(f"[TELEGRAM] SSID detected in message from {user_id} — content stripped for security")
            # Still attempt connection with the original text, but warn the user
            result = await self.cmd_connect_ssid(user_id, text)
            return result
            
        parts = text.split()
        if not parts:
            return "❓ Commande invalide."
            
        cmd = parts[0].lower()
        args = parts[1:] if len(parts) > 1 else []
        
        # Ensure it has a slash if it's a known command name without slash
        if not cmd.startswith('/'):
            cmd_with_slash = f"/{cmd}"
            if cmd_with_slash in self.command_handlers:
                cmd = cmd_with_slash
                
        handler = self.command_handlers.get(cmd)
        if handler:
            return await handler(user_id, args)
            
        return "❓ Commande inconnue. Utilisez le menu ou tapez /help pour voir les commandes disponibles."

    async def handle_callback(self, user_id: str, data: str):
        """Gère les callback queries envoyées par les boutons inline."""
        if not data:
            return None

        # New: signal_{pair} — user clicked a pair button → generate a real signal on demand
        if data.startswith('signal_'):
            pair = data.split('signal_', 1)[1]
            logger.info(f"[TELEGRAM] Signal request for {pair} from {user_id}")
            return await self.cmd_signal_on_demand(user_id, pair)

        # Legacy: analyze_{pair} — used to call cmd_analyse (Premium-gated, no signal).
        # Route through signal_on_demand now so users actually get a signal.
        if data.startswith('analyze_'):
            pair = data.split('analyze_', 1)[1]
            logger.info(f"[TELEGRAM] Legacy analyze_ callback for {pair} — routing to signal_on_demand")
            return await self.cmd_signal_on_demand(user_id, pair)

        return None

    # ═══════════ TELEGRAM ACCOUNT LINKING ═══════════
    # /link <code> — verify the 6-digit code (emailed to the user by the web app)
    #                and link this Telegram chat_id to the user's subscription.
    # /unlink      — clear the telegram_chat_id on the user's subscription.

    async def cmd_link(self, user_id: str, args: list = None) -> str:
        """Link this Telegram chat to a user's A2Sniper subscription.

        Usage: /link <6-digit-code>

        The user generates the code on the web app (Settings → Link Telegram
        Account). The code is emailed to them via Resend with purpose=
        'telegram_link' (10-min TTL). When they send `/link <code>` here,
        we verify the code, fetch the user's email, find their subscription,
        and set subscriptions.telegram_chat_id = chat_id.

        After linking, _sync_user_plan queries by telegram_chat_id and
        correctly returns the user's paid plan (Premium/Pro).
        """
        if not args or len(args) < 1:
            return (
                "🔗 <b>LINK TELEGRAM ACCOUNT</b>\n"
                "━━━━━━━━━━━━━━━━━━━━━\n"
                "To link your Telegram to your A2Sniper subscription:\n\n"
                "1️⃣ Log in to your A2Sniper web dashboard\n"
                "2️⃣ Go to <b>Settings → Link Telegram Account</b>\n"
                "3️⃣ Click <b>Generate Linking Code</b> — a 6-digit code will be emailed to you\n"
                "4️⃣ Come back here and send: <code>/link 123456</code>\n\n"
                "Once linked, your Premium/Pro plan unlocks /analyse, /structure, /backtesting."
            )

        code = str(args[0]).strip()
        if not code.isdigit() or len(code) != 6:
            return "❌ Invalid code format. The linking code must be exactly 6 digits. Example: <code>/link 123456</code>"

        try:
            from db import AsyncSessionLocal, PasswordResetOTP, UserSubscription, User
            from sqlalchemy import select
            async with AsyncSessionLocal() as session:
                # Find the most recent unused telegram_link OTP matching this code.
                # Note: password_reset_otps has no `used` column — we delete on success.
                result = await session.execute(
                    select(PasswordResetOTP).where(
                        PasswordResetOTP.otp_code == code,
                        PasswordResetOTP.purpose == "telegram_link",
                    ).order_by(PasswordResetOTP.created_at.desc()).limit(1)
                )
                otp_row = result.scalar_one_or_none()

                is_valid = (
                    otp_row is not None
                    and otp_row.expires_at > datetime.now(timezone.utc)
                )

                if not is_valid:
                    return (
                        "❌ <b>Invalid or expired linking code</b>\n"
                        "━━━━━━━━━━━━━━━━━━━━━\n"
                        "The code you entered is incorrect or has expired (10-minute TTL).\n"
                        "Please generate a new code on the web app and try again."
                    )

                # Look up the user by email, then their subscription
                user_result = await session.execute(
                    select(User).where(User.email == otp_row.email)
                )
                user = user_result.scalar_one_or_none()
                if not user:
                    return "❌ No A2Sniper account found for that email. Please sign up at a2sniper.vercel.app first."

                sub_result = await session.execute(
                    select(UserSubscription).where(UserSubscription.user_id == user.id)
                )
                sub = sub_result.scalar_one_or_none()
                if not sub:
                    # Auto-create a Standard subscription so we can attach the chat_id
                    sub = UserSubscription(
                        user_id=user.id,
                        plan_name="Standard",
                        active_until=datetime.now(timezone.utc) + timedelta(days=3650),
                    )
                    session.add(sub)
                    await session.flush()

                # Check if this chat_id is already linked to a different user
                existing_result = await session.execute(
                    select(UserSubscription).where(
                        UserSubscription.telegram_chat_id == str(user_id),
                        UserSubscription.user_id != user.id,
                    )
                )
                existing = existing_result.scalar_one_or_none()
                if existing:
                    # Unlink the previous account (the user is relinking to a new account)
                    existing.telegram_chat_id = None

                # Link this chat_id to the user's subscription
                sub.telegram_chat_id = str(user_id)

                # Delete the used OTP
                await session.execute(
                    __import__('sqlalchemy').text(
                        "DELETE FROM password_reset_otps WHERE id = :otp_id"
                    ),
                    {"otp_id": otp_row.id}
                )
                await session.commit()

                # Update in-memory plan cache
                self.user_plans[user_id] = sub.plan_name
                self._save_state()

                logger.info(
                    f"[TELEGRAM-LINK] Linked chat_id={user_id} to user_id={user.id[:8]}... "
                    f"(email={user.email[:3]}***, plan={sub.plan_name})"
                )

                plan_emoji = "🏆" if sub.plan_name == "Pro" else "⚡" if sub.plan_name == "Premium" else "✅"
                return (
                    f"{plan_emoji} <b>TELEGRAM ACCOUNT LINKED</b>\n"
                    "━━━━━━━━━━━━━━━━━━━━━\n"
                    f"👤 Account: {user.email}\n"
                    f"📋 Plan: <b>{sub.plan_name}</b>\n\n"
                    "Your Premium/Pro commands are now unlocked:\n"
                    "• <code>/analyse</code> — On-demand signal analysis\n"
                    "• <code>/structure</code> — Smart Money Concepts structure\n"
                    "• <code>/timeframe</code> — Multi-timeframe analysis\n"
                    f"{'• <code>/backtesting</code> — Backtest engine (Pro only)' if sub.plan_name == 'Pro' else ''}\n\n"
                    "Welcome aboard, Sniper. 🎯"
                )
        except Exception as e:
            logger.error(f"[TELEGRAM-LINK] Error linking chat_id={user_id}: {e}", exc_info=True)
            return "❌ An error occurred while linking your account. Please try again or contact support."

    async def cmd_unlink(self, user_id: str, args: list = None) -> str:
        """Unlink this Telegram chat from any A2Sniper subscription."""
        try:
            from db import AsyncSessionLocal, UserSubscription
            from sqlalchemy import select
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(UserSubscription).where(UserSubscription.telegram_chat_id == str(user_id))
                )
                sub = result.scalar_one_or_none()
                if not sub:
                    return (
                        "ℹ️ <b>This Telegram account is not linked</b>\n"
                        "━━━━━━━━━━━━━━━━━━━━━\n"
                        "There's no A2Sniper subscription linked to this Telegram chat.\n"
                        "Use /link to link your account."
                    )
                sub.telegram_chat_id = None
                await session.commit()

                # Clear in-memory plan cache — user reverts to Standard
                self.user_plans[user_id] = 'Standard'
                self._save_state()

                logger.info(f"[TELEGRAM-LINK] Unlinked chat_id={user_id} from user_id={sub.user_id[:8]}...")
                return (
                    "✅ <b>TELEGRAM ACCOUNT UNLINKED</b>\n"
                    "━━━━━━━━━━━━━━━━━━━━━\n"
                    "Your Telegram is no longer linked to your A2Sniper subscription.\n"
                    "You now have Standard (free) access. Use /link to relink."
                )
        except Exception as e:
            logger.error(f"[TELEGRAM-LINK] Error unlinking chat_id={user_id}: {e}", exc_info=True)
            return "❌ An error occurred while unlinking your account. Please try again."

    # H17 Note: Custom polling is used instead of python-telegram-bot's built-in event loop
    # because it provides more control over reconnection behavior, timeout handling,
    # and allows integration with the existing async architecture without additional
    # framework dependencies. This design decision enables fine-grained control over
    # the polling loop, error recovery, and message routing.

    async def start_polling(self):
        """Boucle de long polling pour écouter les messages Telegram en direct."""
        if not TELEGRAM_TOKEN:
            logger.warning("[TELEGRAM] Polling désactivé : TELEGRAM_BOT_TOKEN non configuré.")
            return

        logger.info("[TELEGRAM] Démarrage du Long Polling Telegram Bot API...")
        offset = 0
        url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/getUpdates"
        
        import httpx
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Fermer toute session de polling existante avant de démarrer
            try:
                await client.get(
                    f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/deleteWebhook",
                    params={'drop_pending_updates': True}
                )
                logger.info("[TELEGRAM] Webhook supprimé, polling prêt.")
            except Exception as e:
                logger.warning(f"[TELEGRAM] deleteWebhook: {e}")

            while True:
                try:
                    response = await client.get(url, params={'offset': offset, 'timeout': 20})
                    if response.status_code == 200:
                        data = response.json()
                        if data.get('ok') and data.get('result'):
                            for item in data['result']:
                                offset = item['update_id'] + 1
                                
                                # Handle callback_query if present
                                callback_query = item.get('callback_query')
                                if callback_query:
                                    chat_id = str(callback_query['message']['chat']['id'])
                                    data_payload = callback_query.get('data')
                                    logger.info(f"[TELEGRAM] Callback query {data_payload} de {chat_id}")
                                    
                                    # Answer callback query to stop loading state in Telegram
                                    try:
                                        await client.post(
                                            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/answerCallbackQuery",
                                            json={'callback_query_id': callback_query['id']}
                                        )
                                    except Exception as e:
                                        logger.warning(f"Error answering callback query: {e}")

                                    # Send "typing" indicator so the user knows the bot is computing a signal
                                    try:
                                        await client.post(
                                            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendChatAction",
                                            json={'chat_id': chat_id, 'action': 'typing'}
                                        )
                                    except Exception:
                                        pass

                                    reply = await self.handle_callback(chat_id, data_payload)
                                    if reply:
                                        if isinstance(reply, dict):
                                            payload = {
                                                'chat_id': chat_id,
                                                'parse_mode': 'HTML',
                                                'reply_markup': self.get_default_keyboard(),
                                                **reply
                                            }
                                        else:
                                            payload = {
                                                'chat_id': chat_id,
                                                'text': reply,
                                                'parse_mode': 'HTML',
                                                'reply_markup': self.get_default_keyboard()
                                            }
                                        await client.post(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage", json=payload)
                                    continue
                                
                                message = item.get('message')
                                if message and message.get('text'):
                                    chat_id = str(message['chat']['id'])
                                    text = message['text']
                                    logger.info(f"[TELEGRAM] Commande {text} de {chat_id}")
                                    
                                    self.subscribed_chats.add(chat_id)
                                    self._save_state()
                                    reply = await self.handle_command(chat_id, text)
                                    if reply:
                                        if isinstance(reply, dict):
                                            payload = {
                                                'chat_id': chat_id,
                                                'parse_mode': 'HTML',
                                                'reply_markup': self.get_default_keyboard(),
                                                **reply
                                            }
                                        else:
                                            payload = {
                                                'chat_id': chat_id,
                                                'text': reply,
                                                'parse_mode': 'HTML',
                                                'reply_markup': self.get_default_keyboard()
                                            }
                                        await client.post(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage", json=payload)
                except Exception as e:
                    logger.error(f"[TELEGRAM] Erreur Polling: {e}")
                    await asyncio.sleep(5)
                
                await asyncio.sleep(1)
