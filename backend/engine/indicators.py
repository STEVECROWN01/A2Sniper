"""
Module d'Indicateurs Techniques — CDC A2Sniper 3.0
12 indicateurs obligatoires + système de détection de divergences.

Indicateurs CDC :
1. RSI (14)                    2. MACD (12/26/9)
3. Bollinger Bands (20, 2σ)    4. EMA 9 / EMA 21
5. EMA 50 / EMA 200            6. ADX (14)
7. ATR (14)                    8. Stochastique (14/3/3)
9. CCI (20)                   10. OBV (On Balance Volume)
11. Ichimoku Kinko Hyo (9/26/52) 12. Fibonacci Auto
"""

import logging
import pandas as pd
import numpy as np

logger = logging.getLogger(__name__)


class TechnicalIndicators:
    def __init__(self):
        pass

    def calculate_all(self, df: pd.DataFrame) -> pd.DataFrame:
        """Calcule TOUS les 12 indicateurs CDC et les ajoute au DataFrame."""
        if df.empty or len(df) < 52:
            return df

        df = df.copy()

        # 1. RSI (14)
        df = self._calc_rsi(df, period=14)

        # 2. MACD (12/26/9)
        df = self._calc_macd(df, fast=12, slow=26, signal=9)

        # 3. Bollinger Bands (20, 2σ)
        df = self._calc_bollinger(df, period=20, std=2)

        # 4. EMA 9 / EMA 21 (directionnel court terme)
        df['EMA_9'] = df['close'].ewm(span=9, adjust=False).mean()
        df['EMA_21'] = df['close'].ewm(span=21, adjust=False).mean()

        # 5. EMA 50 / EMA 200 (biais directionnel macro)
        df['EMA_50'] = df['close'].ewm(span=50, adjust=False).mean()
        # H19 Fix: EMA 200 is unreliable with insufficient data
        MIN_EMA200_BARS = 50  # Minimum bars to calculate EMA 200 meaningfully
        if len(df) >= 200:
            df['EMA_200'] = df['close'].ewm(span=200, adjust=False).mean()
        elif len(df) >= MIN_EMA200_BARS:
            logger.warning(f"[INDICATORS] EMA 200 calculated with only {len(df)} bars (recommended: 200+). Result may be unreliable.")
            df['EMA_200'] = df['close'].ewm(span=len(df), adjust=False).mean()
        else:
            logger.warning(f"[INDICATORS] EMA 200 skipped: only {len(df)} bars available (minimum {MIN_EMA200_BARS} required). Setting to NaN.")
            df['EMA_200'] = np.nan

        # 6. ADX (14)
        df = self._calc_adx(df, period=14)

        # 7. ATR (14)
        df = self._calc_atr(df, period=14)

        # 8. Stochastique (14/3/3)
        df = self._calc_stochastic(df, k_period=14, d_period=3, smooth=3)

        # 9. CCI (20)
        df = self._calc_cci(df, period=20)

        # 10. OBV (On Balance Volume)
        df = self._calc_obv(df)

        # 11. Ichimoku Kinko Hyo (9/26/52)
        df = self._calc_ichimoku(df, tenkan=9, kijun=26, senkou_b=52)

        return df

    # ──────────────── 1. RSI ────────────────
    def _calc_rsi(self, df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
        delta = df['close'].diff()
        gain = delta.where(delta > 0, 0.0)
        loss = (-delta).where(delta < 0, 0.0)
        avg_gain = gain.ewm(alpha=1/period, min_periods=period).mean()
        avg_loss = loss.ewm(alpha=1/period, min_periods=period).mean()
        rs = avg_gain / avg_loss.replace(0, np.nan)
        df['RSI_14'] = 100 - (100 / (1 + rs))
        df['RSI_14'] = df['RSI_14'].fillna(50)
        return df

    # ──────────────── 2. MACD ────────────────
    def _calc_macd(self, df: pd.DataFrame, fast=12, slow=26, signal=9) -> pd.DataFrame:
        ema_fast = df['close'].ewm(span=fast, adjust=False).mean()
        ema_slow = df['close'].ewm(span=slow, adjust=False).mean()
        df['MACD_12_26_9'] = ema_fast - ema_slow
        df['MACDs_12_26_9'] = df['MACD_12_26_9'].ewm(span=signal, adjust=False).mean()
        df['MACDh_12_26_9'] = df['MACD_12_26_9'] - df['MACDs_12_26_9']
        return df

    # ──────────────── 3. Bollinger Bands ────────────────
    def _calc_bollinger(self, df: pd.DataFrame, period=20, std=2) -> pd.DataFrame:
        sma = df['close'].rolling(window=period).mean()
        rolling_std = df['close'].rolling(window=period).std()
        df['BBM_20_2.0'] = sma
        df['BBU_20_2.0'] = sma + (rolling_std * std)
        df['BBL_20_2.0'] = sma - (rolling_std * std)
        # Squeeze detection (volatilité compressée)
        df['BB_Width'] = (df['BBU_20_2.0'] - df['BBL_20_2.0']) / df['BBM_20_2.0']
        return df

    # ──────────────── 6. ADX ────────────────
    def _calc_adx(self, df: pd.DataFrame, period=14) -> pd.DataFrame:
        high, low, close = df['high'], df['low'], df['close']
        plus_dm = high.diff()
        minus_dm = -low.diff()
        plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
        minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

        tr1 = high - low
        tr2 = (high - close.shift(1)).abs()
        tr3 = (low - close.shift(1)).abs()
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

        atr = tr.ewm(alpha=1/period, min_periods=period).mean()
        plus_di = 100 * (plus_dm.ewm(alpha=1/period, min_periods=period).mean() / atr)
        minus_di = 100 * (minus_dm.ewm(alpha=1/period, min_periods=period).mean() / atr)

        dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
        df['ADX_14'] = dx.ewm(alpha=1/period, min_periods=period).mean()
        df['PLUS_DI'] = plus_di
        df['MINUS_DI'] = minus_di
        df['ADX_14'] = df['ADX_14'].fillna(25)
        return df

    # ──────────────── 7. ATR ────────────────
    def _calc_atr(self, df: pd.DataFrame, period=14) -> pd.DataFrame:
        high, low, close = df['high'], df['low'], df['close']
        tr1 = high - low
        tr2 = (high - close.shift(1)).abs()
        tr3 = (low - close.shift(1)).abs()
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        df['ATRr_14'] = tr.ewm(alpha=1/period, min_periods=period).mean()
        # Moyenne ATR sur 20 périodes pour le filtre de volatilité extrême
        df['ATR_AVG_20'] = df['ATRr_14'].rolling(window=20).mean()
        return df

    # ──────────────── 8. Stochastique ────────────────
    def _calc_stochastic(self, df: pd.DataFrame, k_period=14, d_period=3, smooth=3) -> pd.DataFrame:
        low_min = df['low'].rolling(window=k_period).min()
        high_max = df['high'].rolling(window=k_period).max()
        fast_k = 100 * (df['close'] - low_min) / (high_max - low_min).replace(0, np.nan)
        df['STOCH_K'] = fast_k.rolling(window=smooth).mean()
        df['STOCH_D'] = df['STOCH_K'].rolling(window=d_period).mean()
        df['STOCH_K'] = df['STOCH_K'].fillna(50)
        df['STOCH_D'] = df['STOCH_D'].fillna(50)
        return df

    # ──────────────── 9. CCI ────────────────
    def _calc_cci(self, df: pd.DataFrame, period=20) -> pd.DataFrame:
        tp = (df['high'] + df['low'] + df['close']) / 3
        sma_tp = tp.rolling(window=period).mean()
        mad = tp.rolling(window=period).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
        df['CCI_20'] = (tp - sma_tp) / (0.015 * mad).replace(0, np.nan)
        df['CCI_20'] = df['CCI_20'].fillna(0)
        return df

    # ──────────────── 10. OBV ────────────────
    def _calc_obv(self, df: pd.DataFrame) -> pd.DataFrame:
        # H18 Fix: Replaced O(n) Python loop with vectorized pandas operations
        direction = np.where(df['close'] > df['close'].shift(1), 1,
                            np.where(df['close'] < df['close'].shift(1), -1, 0))
        df['OBV'] = (direction * df['volume']).cumsum()
        # OBV SMA pour divergence
        df['OBV_SMA'] = df['OBV'].rolling(window=20).mean()
        return df

    # ──────────────── 11. Ichimoku ────────────────
    def _calc_ichimoku(self, df: pd.DataFrame, tenkan=9, kijun=26, senkou_b=52) -> pd.DataFrame:
        # Tenkan-sen (Conversion Line)
        tenkan_high = df['high'].rolling(window=tenkan).max()
        tenkan_low = df['low'].rolling(window=tenkan).min()
        df['ICHI_TENKAN'] = (tenkan_high + tenkan_low) / 2

        # Kijun-sen (Base Line)
        kijun_high = df['high'].rolling(window=kijun).max()
        kijun_low = df['low'].rolling(window=kijun).min()
        df['ICHI_KIJUN'] = (kijun_high + kijun_low) / 2

        # Senkou Span A (Leading Span A) — projeté 26 périodes en avant
        df['ICHI_SENKOU_A'] = ((df['ICHI_TENKAN'] + df['ICHI_KIJUN']) / 2).shift(kijun)

        # Senkou Span B (Leading Span B) — projeté 26 périodes en avant
        senkou_b_high = df['high'].rolling(window=senkou_b).max()
        senkou_b_low = df['low'].rolling(window=senkou_b).min()
        df['ICHI_SENKOU_B'] = ((senkou_b_high + senkou_b_low) / 2).shift(kijun)

        # Chikou Span (Lagging Span) — projeté 26 périodes en arrière
        df['ICHI_CHIKOU'] = df['close'].shift(-kijun)

        # Prix vs Kumo (au-dessus/en-dessous du nuage)
        df['ICHI_ABOVE_KUMO'] = (df['close'] > df['ICHI_SENKOU_A']) & (df['close'] > df['ICHI_SENKOU_B'])
        df['ICHI_BELOW_KUMO'] = (df['close'] < df['ICHI_SENKOU_A']) & (df['close'] < df['ICHI_SENKOU_B'])

        return df

    # ──────────────── 12. Fibonacci Auto ────────────────
    def get_fibonacci_levels(self, swing_high: float, swing_low: float, is_uptrend: bool) -> dict:
        """
        Calcule les niveaux de retracement et d'extension de Fibonacci.
        CDC: 23.6, 38.2, 50, 61.8 (Golden), 78.6 (Deep), 127.2, 161.8
        """
        diff = swing_high - swing_low
        if is_uptrend:
            return {
                '0.0': swing_high,
                '23.6': swing_high - 0.236 * diff,
                '38.2': swing_high - 0.382 * diff,
                '50.0': swing_high - 0.5 * diff,
                '61.8': swing_high - 0.618 * diff,
                '78.6': swing_high - 0.786 * diff,
                '100.0': swing_low,
                '127.2': swing_low - 0.272 * diff,
                '161.8': swing_low - 0.618 * diff,
            }
        else:
            return {
                '0.0': swing_low,
                '23.6': swing_low + 0.236 * diff,
                '38.2': swing_low + 0.382 * diff,
                '50.0': swing_low + 0.5 * diff,
                '61.8': swing_low + 0.618 * diff,
                '78.6': swing_low + 0.786 * diff,
                '100.0': swing_high,
                '127.2': swing_high + 0.272 * diff,
                '161.8': swing_high + 0.618 * diff,
            }

    def auto_fibonacci(self, df: pd.DataFrame, lookback: int = 50) -> dict:
        """Détecte automatiquement le swing high/low et calcule les niveaux Fibonacci."""
        recent = df.tail(lookback)
        swing_high = recent['high'].max()
        swing_low = recent['low'].min()
        high_idx = recent['high'].idxmax()
        low_idx = recent['low'].idxmin()
        is_uptrend = low_idx < high_idx
        levels = self.get_fibonacci_levels(swing_high, swing_low, is_uptrend)
        current_price = df['close'].iloc[-1]

        # Trouver le niveau Fibonacci le plus proche
        closest_level = None
        closest_dist = float('inf')
        for name, level in levels.items():
            dist = abs(current_price - level)
            if dist < closest_dist:
                closest_dist = dist
                closest_level = name

        return {
            'levels': levels,
            'swing_high': swing_high,
            'swing_low': swing_low,
            'is_uptrend': is_uptrend,
            'closest_level': closest_level,
            'in_golden_zone': self._is_in_golden_zone(current_price, levels, is_uptrend),
        }

    def _is_in_golden_zone(self, price, levels, is_uptrend):
        """Vérifie si le prix est dans la Golden Zone (50%-61.8%)."""
        z50 = levels['50.0']
        z618 = levels['61.8']
        lo, hi = min(z50, z618), max(z50, z618)
        return lo <= price <= hi


class DivergenceDetector:
    """
    Détection de divergences CDC :
    - Classique haussière/baissière (Score +2)
    - Cachée haussière/baissière (Score +1)
    - Triple (RSI + MACD + Stochastique) (Score +4)
    """

    @staticmethod
    def detect_divergences(df: pd.DataFrame, lookback: int = 30) -> dict:
        """Détecte toutes les divergences sur les dernières N bougies."""
        if len(df) < lookback or 'RSI_14' not in df.columns:
            return {'divergences': [], 'score_bonus': 0}

        recent = df.tail(lookback)
        divergences = []
        score_bonus = 0

        # Divergences RSI
        rsi_divs = DivergenceDetector._check_oscillator_divergence(
            recent['close'], recent['RSI_14'], 'RSI'
        )
        divergences.extend(rsi_divs)

        # Divergences MACD (histogramme)
        if 'MACDh_12_26_9' in df.columns:
            macd_divs = DivergenceDetector._check_oscillator_divergence(
                recent['close'], recent['MACDh_12_26_9'], 'MACD'
            )
            divergences.extend(macd_divs)

        # Divergences Stochastique
        if 'STOCH_K' in df.columns:
            stoch_divs = DivergenceDetector._check_oscillator_divergence(
                recent['close'], recent['STOCH_K'], 'Stochastique'
            )
            divergences.extend(stoch_divs)

        # Calcul du score bonus
        types_found = set()
        for d in divergences:
            if 'classique' in d['type'].lower():
                types_found.add(d['indicator'])
                score_bonus = max(score_bonus, 2)
            elif 'cachée' in d['type'].lower():
                score_bonus = max(score_bonus, 1)

        # Triple divergence (RSI + MACD + Stochastique simultanées)
        if len(types_found) >= 3:
            score_bonus = 4
            divergences.append({
                'type': 'DIVERGENCE TRIPLE',
                'indicator': 'RSI+MACD+Stochastique',
                'direction': divergences[0]['direction'],
                'score_bonus': 4
            })

        return {'divergences': divergences, 'score_bonus': score_bonus}

    @staticmethod
    def _check_oscillator_divergence(prices: pd.Series, oscillator: pd.Series, name: str) -> list:
        """Vérifie les divergences entre le prix et un oscillateur."""
        divs = []
        p = prices.values
        o = oscillator.values

        if len(p) < 10:
            return divs

        # Trouver les pivots locaux (simplifié : on compare 3 zones)
        third = len(p) // 3
        zone1_price = p[:third]
        zone2_price = p[third:2*third]
        zone3_price = p[2*third:]
        zone1_osc = o[:third]
        zone2_osc = o[third:2*third]
        zone3_osc = o[2*third:]

        p_low1, p_low3 = np.min(zone1_price), np.min(zone3_price)
        p_high1, p_high3 = np.max(zone1_price), np.max(zone3_price)
        o_low1, o_low3 = np.min(zone1_osc), np.min(zone3_osc)
        o_high1, o_high3 = np.max(zone1_osc), np.max(zone3_osc)

        # Divergence Classique Haussière : prix fait LL mais oscillateur fait HL
        if p_low3 < p_low1 and o_low3 > o_low1:
            divs.append({
                'type': 'Divergence Classique Haussière',
                'indicator': name,
                'direction': 'CALL',
                'score_bonus': 2
            })

        # Divergence Classique Baissière : prix fait HH mais oscillateur fait LH
        if p_high3 > p_high1 and o_high3 < o_high1:
            divs.append({
                'type': 'Divergence Classique Baissière',
                'indicator': name,
                'direction': 'PUT',
                'score_bonus': 2
            })

        # Divergence Cachée Haussière : prix fait HL mais oscillateur fait LL
        if p_low3 > p_low1 and o_low3 < o_low1:
            divs.append({
                'type': 'Divergence Cachée Haussière',
                'indicator': name,
                'direction': 'CALL',
                'score_bonus': 1
            })

        # Divergence Cachée Baissière : prix fait LH mais oscillateur fait HH
        if p_high3 < p_high1 and o_high3 > o_high1:
            divs.append({
                'type': 'Divergence Cachée Baissière',
                'indicator': name,
                'direction': 'PUT',
                'score_bonus': 1
            })

        return divs
