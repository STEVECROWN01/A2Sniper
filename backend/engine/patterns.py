import pandas as pd

class CandlestickPatterns:
    def __init__(self):
        pass

    def detect_all_patterns(self, df: pd.DataFrame) -> pd.DataFrame:
        """Détecte les patterns principaux et ajoute les colonnes correspondantes au DataFrame."""
        if df.empty or len(df) < 3:
            return df

        # Calculs de base
        body = abs(df['close'] - df['open'])
        upper_shadow = df['high'] - df[['open', 'close']].max(axis=1)
        lower_shadow = df[['open', 'close']].min(axis=1) - df['low']
        total_range = df['high'] - df['low']
        is_bullish = df['close'] > df['open']
        is_bearish = df['close'] < df['open']
        
        # Bullish Engulfing
        prev_bearish = df['close'].shift(1) < df['open'].shift(1)
        engulfing_bull = is_bullish & prev_bearish & (df['close'] > df['open'].shift(1)) & (df['open'] < df['close'].shift(1))
        df['pattern_bull_engulfing'] = engulfing_bull

        # Bearish Engulfing
        prev_bullish = df['close'].shift(1) > df['open'].shift(1)
        engulfing_bear = is_bearish & prev_bullish & (df['close'] < df['open'].shift(1)) & (df['open'] > df['close'].shift(1))
        df['pattern_bear_engulfing'] = engulfing_bear

        # Hammer / Bullish Pin Bar
        # Petit corps, longue mèche basse (au moins 2x le corps), mèche haute inexistante ou très petite
        hammer = (lower_shadow >= 2 * body) & (upper_shadow <= 0.2 * body) & (body > 0)
        df['pattern_hammer'] = hammer

        # Shooting Star / Bearish Pin Bar
        # Petit corps, longue mèche haute (au moins 2x le corps), mèche basse inexistante ou très petite
        shooting_star = (upper_shadow >= 2 * body) & (lower_shadow <= 0.2 * body) & (body > 0)
        df['pattern_shooting_star'] = shooting_star

        # Doji
        # Corps quasi nul par rapport au range total
        doji = (body <= 0.1 * total_range) & (total_range > 0)
        df['pattern_doji'] = doji

        return df

    def get_active_patterns(self, df: pd.DataFrame) -> dict:
        """Extrait les patterns actifs sur la dernière bougie."""
        if df.empty:
            return {'bullish': [], 'bearish': [], 'has_bullish': False, 'has_bearish': False}
        
        last = df.iloc[-1]
        bullish = []
        bearish = []
        
        if last.get('pattern_bull_engulfing'): bullish.append('Bullish Engulfing')
        if last.get('pattern_hammer'): bullish.append('Hammer')
        
        if last.get('pattern_bear_engulfing'): bearish.append('Bearish Engulfing')
        if last.get('pattern_shooting_star'): bearish.append('Shooting Star')
        
        return {
            'bullish': bullish,
            'bearish': bearish,
            'has_bullish': len(bullish) > 0,
            'has_bearish': len(bearish) > 0,
            'score_modifier': (2 if 'Bullish Engulfing' in bullish or 'Bearish Engulfing' in bearish else 0)
        }
