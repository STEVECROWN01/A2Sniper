"""
Risk Manager Backend — CDC A2Sniper 3.0
Money management intégré dans chaque signal.
"""

import json
import logging
import os
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# File path for persisting risk state
RISK_STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'risk_state.json')


class RiskManager:
    MAX_SESSION_RISK = 0.15       # 15% capital max en jeu
    MAX_DAILY_RISK = 0.10         # 10% risque journalier max
    CONSECUTIVE_LOSS_LIMIT = 3    # 3 pertes → avertissement
    SESSION_STOP_AUTO_RESET_HOURS = 1  # Auto-reset session_stopped after 1 hour

    def __init__(self):
        self.daily_trades = []
        self.consecutive_losses = 0
        self.daily_risk_used = 0.0
        self.session_risk = 0.0
        self.is_session_stopped = False
        self.session_stopped_at = None
        self.last_reset = datetime.now(timezone.utc).date()
        # Load persisted state
        self._load_state()

    def _load_state(self):
        """Load risk state from persistent file."""
        try:
            if os.path.exists(RISK_STATE_FILE):
                with open(RISK_STATE_FILE, 'r') as f:
                    data = json.load(f)
                    self.consecutive_losses = data.get('consecutive_losses', 0)
                    self.daily_risk_used = data.get('daily_risk_used', 0.0)
                    self.session_risk = data.get('session_risk', 0.0)
                    self.is_session_stopped = data.get('is_session_stopped', False)
                    if data.get('session_stopped_at'):
                        self.session_stopped_at = datetime.fromisoformat(data['session_stopped_at'])
                    if data.get('last_reset'):
                        self.last_reset = datetime.fromisoformat(data['last_reset']).date() if isinstance(data['last_reset'], str) else data['last_reset']
                    logger.info("[RISK] State loaded from file")
        except Exception as e:
            logger.warning(f"[RISK] Could not load state: {e}")

    def _save_state(self):
        """Persist current risk state to file."""
        try:
            data = {
                'consecutive_losses': self.consecutive_losses,
                'daily_risk_used': self.daily_risk_used,
                'session_risk': self.session_risk,
                'is_session_stopped': self.is_session_stopped,
                'session_stopped_at': self.session_stopped_at.isoformat() if self.session_stopped_at else None,
                'last_reset': self.last_reset.isoformat() if hasattr(self.last_reset, 'isoformat') else str(self.last_reset),
            }
            with open(RISK_STATE_FILE, 'w') as f:
                json.dump(data, f)
        except Exception as e:
            logger.warning(f"[RISK] Could not save state: {e}")

    def _reset_daily(self):
        today = datetime.now(timezone.utc).date()
        if today != self.last_reset:
            self.daily_trades = []
            self.daily_risk_used = 0.0
            self.is_session_stopped = False
            self.session_stopped_at = None
            self.last_reset = today
            self._save_state()
            logger.info("[RISK] Daily counters reset")

    def _auto_reset_session_stopped(self):
        """Auto-reset session_stopped after a cool-down period."""
        if self.is_session_stopped and self.session_stopped_at:
            elapsed = (datetime.now(timezone.utc) - self.session_stopped_at).total_seconds() / 3600
            if elapsed >= self.SESSION_STOP_AUTO_RESET_HOURS:
                self.is_session_stopped = False
                self.session_stopped_at = None
                self._save_state()
                logger.info("[RISK] Session stop auto-reset after cool-down period")

    def get_recommended_stake(self, winrate: float) -> dict:
        """CDC: 1% winrate 85-90%, 2% winrate 90-95%, 3% winrate 95%+."""
        if winrate >= 95:
            return {'percentage': 3.0, 'label': '3% du capital', 'reason': 'SNIPER SHOT — Winrate maximal'}
        elif winrate >= 90:
            return {'percentage': 2.0, 'label': '2% du capital', 'reason': 'Signal fort'}
        elif winrate >= 85:
            return {'percentage': 1.0, 'label': '1% du capital', 'reason': 'Signal acceptable'}
        return {'percentage': 0, 'label': 'Signal rejeté', 'reason': f'Winrate {winrate}% < seuil minimum'}

    def check_can_trade(self, capital: float = 10000) -> dict:
        """Vérifie toutes les règles de risque avant d'émettre un signal."""
        self._reset_daily()
        self._auto_reset_session_stopped()
        blocks = []

        # Règle 3 pertes consécutives
        if self.consecutive_losses >= self.CONSECUTIVE_LOSS_LIMIT:
            blocks.append(f"⚠️ {self.consecutive_losses} pertes consécutives — Arrêt recommandé")
            self.is_session_stopped = True
            self.session_stopped_at = datetime.now(timezone.utc)

        # Capital journalier max (10%)
        if self.daily_risk_used >= self.MAX_DAILY_RISK:
            blocks.append(f"🔴 Risque journalier max atteint ({self.daily_risk_used*100:.1f}% ≥ {self.MAX_DAILY_RISK*100}%)")

        # Capital session max (15%)
        if self.session_risk >= self.MAX_SESSION_RISK:
            blocks.append(f"🔴 Risque session max atteint ({self.session_risk*100:.1f}% ≥ {self.MAX_SESSION_RISK*100}%)")

        return {
            'can_trade': len(blocks) == 0 and not self.is_session_stopped,
            'blocks': blocks,
            'consecutive_losses': self.consecutive_losses,
            'daily_risk_used': round(self.daily_risk_used * 100, 1),
            'session_risk': round(self.session_risk * 100, 1),
            'is_session_stopped': self.is_session_stopped,
        }

    def record_trade_result(self, is_win: bool, risk_pct: float):
        """Enregistre le résultat d'un trade pour le suivi."""
        self._reset_daily()

        if is_win:
            self.consecutive_losses = 0
        else:
            self.consecutive_losses += 1
            self.daily_risk_used += risk_pct
            if self.consecutive_losses >= self.CONSECUTIVE_LOSS_LIMIT:
                logger.warning(f"[RISK] {self.CONSECUTIVE_LOSS_LIMIT} pertes consécutives — Arrêt de session recommandé")
                self.is_session_stopped = True
                self.session_stopped_at = datetime.now(timezone.utc)

        self.daily_trades.append({
            'time': datetime.now(timezone.utc).isoformat(),
            'is_win': is_win,
            'risk_pct': risk_pct,
        })
        
        # Persist state after each trade
        self._save_state()

    def check_martingale(self, current_stake: float, previous_stake: float) -> bool:
        """CDC: Interdiction FORMELLE de Martingale."""
        if previous_stake > 0 and current_stake > previous_stake * 1.5:
            logger.error("[RISK] MARTINGALE DÉTECTÉE — Opération bloquée")
            return True
        return False

    def get_daily_summary(self) -> dict:
        self._reset_daily()
        wins = sum(1 for t in self.daily_trades if t['is_win'])
        losses = len(self.daily_trades) - wins
        return {
            'total_trades': len(self.daily_trades),
            'wins': wins,
            'losses': losses,
            'win_rate': round(wins / len(self.daily_trades) * 100, 2) if self.daily_trades else 0,
            'daily_risk_used': round(self.daily_risk_used * 100, 1),
            'consecutive_losses': self.consecutive_losses,
        }
