"""
Monitoring Engine — CDC A2Sniper 3.0
Win rate glissant, alertes dégradation, circuit breaker, rapport journalier.
"""

import logging
from datetime import datetime, timezone, timedelta
from collections import deque

logger = logging.getLogger(__name__)


class MonitoringEngine:
    DEGRADATION_THRESHOLD = 0.55   # 55% win rate minimum (realistic for binary options)
    DEGRADATION_WINDOW = 50        # Sur 50 signaux
    CIRCUIT_BREAKER_LOSSES = 3     # 3 pertes consécutives
    CIRCUIT_BREAKER_PAUSE = 30     # 30 minutes de pause

    def __init__(self, initial_signals: list = None):
        self.signal_history = deque(maxlen=10000)
        if initial_signals:
            for s in initial_signals:
                self.signal_history.append(s)
        self.consecutive_losses = 0
        self.circuit_breaker_until = None
        self.is_suspended = False
        self.suspension_reason = None

    def record_signal(self, signal_id: str, pair: str, direction: str,
                      winrate: float, is_win: bool = None):
        """Enregistre un signal émis."""
        self.signal_history.append({
            'id': signal_id,
            'pair': pair,
            'direction': direction,
            'winrate': winrate,
            'is_win': is_win,
            'timestamp': datetime.now(timezone.utc),
        })

    def record_result(self, signal_id: str, is_win: bool):
        """Met à jour le résultat d'un signal."""
        for s in reversed(self.signal_history):
            if s['id'] == signal_id:
                s['is_win'] = is_win
                break

        if is_win:
            self.consecutive_losses = 0
        else:
            self.consecutive_losses += 1

        # Circuit Breaker: 3 pertes consécutives → pause 30 min
        if self.consecutive_losses >= self.CIRCUIT_BREAKER_LOSSES:
            self.circuit_breaker_until = datetime.now(timezone.utc) + timedelta(minutes=self.CIRCUIT_BREAKER_PAUSE)
            self.is_suspended = True
            self.suspension_reason = f"Circuit Breaker: {self.consecutive_losses} pertes consécutives"
            logger.warning(f"[CIRCUIT BREAKER] Activé — Pause {self.CIRCUIT_BREAKER_PAUSE}min")

        # Vérifier dégradation
        self._check_degradation()

    def _check_degradation(self):
        """Alerte si win rate < 55% sur 50 signaux."""
        resolved = [s for s in self.signal_history if s['is_win'] is not None]
        if len(resolved) < self.DEGRADATION_WINDOW:
            return

        recent = resolved[-self.DEGRADATION_WINDOW:]
        wins = sum(1 for s in recent if s['is_win'])
        wr = wins / len(recent)

        if wr < self.DEGRADATION_THRESHOLD:
            self.is_suspended = True
            self.suspension_reason = f"Dégradation: Win rate {wr*100:.1f}% < {self.DEGRADATION_THRESHOLD*100}% sur {self.DEGRADATION_WINDOW} signaux"
            logger.warning(f"[DEGRADATION] {self.suspension_reason}")

    def check_circuit_breaker(self) -> dict:
        """Vérifie si le circuit breaker est actif."""
        if self.circuit_breaker_until:
            now = datetime.now(timezone.utc)
            if now >= self.circuit_breaker_until:
                self.circuit_breaker_until = None
                self.is_suspended = False
                self.suspension_reason = None
                self.consecutive_losses = 0
                logger.info("[CIRCUIT BREAKER] Levé — Reprise du système")

        return {
            'is_active': self.is_suspended,
            'reason': self.suspension_reason,
            'resume_at': self.circuit_breaker_until.isoformat() if self.circuit_breaker_until else None,
            'consecutive_losses': self.consecutive_losses,
        }

    def get_win_rate(self, pair: str = None, hours: int = None, count: int = None) -> dict:
        """Win rate glissant sur période, nombre de signaux ou paire spécifique."""
        resolved = [s for s in self.signal_history if s['is_win'] is not None]

        if pair:
            resolved = [s for s in resolved if s['pair'] == pair]

        if hours:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            resolved = [s for s in resolved if s['timestamp'] >= cutoff]

        if count:
            resolved = resolved[-count:]

        if not resolved:
            return {'win_rate': 0, 'total': 0, 'wins': 0, 'losses': 0}

        wins = sum(1 for s in resolved if s['is_win'])
        losses = len(resolved) - wins
        return {
            'win_rate': round(wins / len(resolved) * 100, 2),
            'total': len(resolved),
            'wins': wins,
            'losses': losses,
        }

    def get_performance_dashboard(self) -> dict:
        """Données pour le dashboard de monitoring CDC."""
        return {
            'win_rate_24h': self.get_win_rate(hours=24),
            'win_rate_7d': self.get_win_rate(hours=168),
            'win_rate_30d': self.get_win_rate(hours=720),
            'win_rate_all': self.get_win_rate(),
            'circuit_breaker': self.check_circuit_breaker(),
            'total_signals': len(self.signal_history),
            'signals_today': len([s for s in self.signal_history
                                  if s['timestamp'].date() == datetime.now(timezone.utc).date()]),
        }

    def generate_daily_report(self) -> str:
        """Rapport journalier automatique (23h59) pour Telegram."""
        today = datetime.now(timezone.utc).date()
        today_signals = [s for s in self.signal_history if s['timestamp'].date() == today]
        resolved = [s for s in today_signals if s['is_win'] is not None]

        wins = sum(1 for s in resolved if s['is_win'])
        losses = len(resolved) - wins
        wr = round(wins / len(resolved) * 100, 2) if resolved else 0

        # Winrate moyen (analysé)
        avg_winrate = round(sum(s['winrate'] for s in today_signals) / len(today_signals), 1) if today_signals else 0

        # Meilleure paire
        pair_stats = {}
        for s in resolved:
            p = s['pair']
            if p not in pair_stats:
                pair_stats[p] = {'wins': 0, 'total': 0}
            pair_stats[p]['total'] += 1
            if s['is_win']:
                pair_stats[p]['wins'] += 1

        best_pair = max(pair_stats.items(), key=lambda x: x[1]['wins']/max(x[1]['total'],1), default=('N/A', {}))

        return f"""📊 A2SNIPER — RAPPORT JOURNALIER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 Date : {today.strftime('%d/%m/%Y')}
📈 Signaux émis : {len(today_signals)}
✅ Gagnants : {wins}
❌ Perdants : {losses}
🎯 Win Rate (Réel) : {wr}%
⭐ Win Rate (Analysé) : {avg_winrate}%
🏆 Meilleure paire : {best_pair[0]}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ Ce rapport est généré automatiquement.
🏦 Plateforme : Pocket Option OTC"""

    def force_suspend(self, reason: str = "Manual suspension"):
        self.is_suspended = True
        self.suspension_reason = reason
        logger.warning(f"[MONITORING] Système suspendu: {reason}")

    def force_resume(self):
        self.is_suspended = False
        self.suspension_reason = None
        self.circuit_breaker_until = None
        self.consecutive_losses = 0
        logger.info("[MONITORING] Système relancé manuellement")
