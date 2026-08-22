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
        """Calculate all CDC indicators and add them to the DataFrame.
        
        Minimum bars: 14 (for RSI). Ichimoku (needs 52) is only calculated
        if enough data is available — otherwise it's skipped gracefully.
        """
        if df.empty or len(df) < 14:
            return df

        df = df.copy()

        # 1. RSI (14)
        df = self._calc_rsi(df, period=14)

        # 2. MACD (12/26/9) — needs 26 bars but calculates partial with fewer
        df = self._calc_macd(df, fast=12, slow=26, signal=9)

        # 3. Bollinger Bands (20, 2σ) — needs 20 bars
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

        # 11. Ichimoku Kinko Hyo (9/26/52) — only if 52+ bars available
        if len(df) >= 52:
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
        # H6 FIX: was fillna(25) — silently routed NaN-data signals into
        # trend continuation (ADX=25 > 22). Now fillna(0) so NaN data
        # falls through both ACE branches (ADX=0 < 18 → BB reversal, but
        # BB reversal also checks price/band relationship, so effectively
        # no signal is generated on broken data).
        df['ADX_14'] = df['ADX_14'].fillna(0)
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


