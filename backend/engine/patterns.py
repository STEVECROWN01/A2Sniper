import pandas as pd
import numpy as np

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

        # Avoid division by zero
        body_safe = body.replace(0, np.nan)

        # ──────── EXISTING PATTERNS (5) ────────

        # Bullish Engulfing
        prev_bearish = df['close'].shift(1) < df['open'].shift(1)
        engulfing_bull = is_bullish & prev_bearish & (df['close'] > df['open'].shift(1)) & (df['open'] < df['close'].shift(1))
        df['pattern_bull_engulfing'] = engulfing_bull

        # Bearish Engulfing
        prev_bullish = df['close'].shift(1) > df['open'].shift(1)
        engulfing_bear = is_bearish & prev_bullish & (df['close'] < df['open'].shift(1)) & (df['open'] > df['close'].shift(1))
        df['pattern_bear_engulfing'] = engulfing_bear

        # Hammer / Bullish Pin Bar (basic — kept for backward compat)
        hammer = (lower_shadow >= 2 * body) & (upper_shadow <= 0.2 * body) & (body > 0)
        df['pattern_hammer'] = hammer

        # Shooting Star / Bearish Pin Bar (basic — kept for backward compat)
        shooting_star = (upper_shadow >= 2 * body) & (lower_shadow <= 0.2 * body) & (body > 0)
        df['pattern_shooting_star'] = shooting_star

        # Doji
        doji = (body <= 0.1 * total_range) & (total_range > 0)
        df['pattern_doji'] = doji

        # ──────── NEW PATTERNS (17) ────────

        # Shifted values for multi-candle patterns
        prev_close = df['close'].shift(1)
        prev_open = df['open'].shift(1)
        prev_high = df['high'].shift(1)
        prev_low = df['low'].shift(1)
        prev_body = abs(prev_close - prev_open)
        prev_is_bullish = prev_close > prev_open
        prev_is_bearish = prev_close < prev_open

        prev2_close = df['close'].shift(2)
        prev2_open = df['open'].shift(2)
        prev2_high = df['high'].shift(2)
        prev2_low = df['low'].shift(2)
        prev2_body = abs(prev2_close - prev2_open)
        prev2_is_bearish = prev2_close < prev2_open
        prev2_is_bullish = prev2_close > prev2_open

        # 1. Morning Star (3 candles: big red + small body + big green)
        small_body_cond = body < prev_body * 0.5
        morning_star = (
            prev2_is_bearish & (prev2_body > total_range.shift(2) * 0.4) &
            small_body_cond.shift(1) &
            is_bullish & (body > total_range * 0.4) &
            (df['close'] > (prev2_open + prev2_close) / 2)
        )
        df['pattern_morning_star'] = morning_star

        # 2. Evening Star (3 candles: big green + small body + big red)
        evening_star = (
            prev2_is_bullish & (prev2_body > total_range.shift(2) * 0.4) &
            small_body_cond.shift(1) &
            is_bearish & (body > total_range * 0.4) &
            (df['close'] < (prev2_open + prev2_close) / 2)
        )
        df['pattern_evening_star'] = evening_star

        # 3. Bullish Harami (big red followed by small green inside)
        bullish_harami = (
            prev_is_bearish & (prev_body > body * 2) &
            is_bullish &
            (df['close'] < prev_open) & (df['open'] > prev_close)
        )
        df['pattern_bullish_harami'] = bullish_harami

        # 4. Bearish Harami (big green followed by small red inside)
        bearish_harami = (
            prev_is_bullish & (prev_body > body * 2) &
            is_bearish &
            (df['close'] > prev_open) & (df['open'] < prev_close)
        )
        df['pattern_bearish_harami'] = bearish_harami

        # 5. Tweezer Bottom (two candles with same Low)
        low_tolerance = df['low'] * 0.001  # 0.1% tolerance
        tweezer_bottom = (
            (abs(df['low'] - prev_low) <= low_tolerance) &
            is_bullish & prev_is_bearish
        )
        df['pattern_tweezer_bottom'] = tweezer_bottom

        # 6. Tweezer Top (two candles with same High)
        tweezer_top = (
            (abs(df['high'] - prev_high) <= df['high'] * 0.001) &
            is_bearish & prev_is_bullish
        )
        df['pattern_tweezer_top'] = tweezer_top

        # 7. Piercing Line (green opens below prev low, closes above 50% of prev red body)
        prev_red_midpoint = (prev_open + prev_close) / 2
        piercing_line = (
            prev_is_bearish & is_bullish &
            (df['open'] < prev_low) &
            (df['close'] > prev_red_midpoint) &
            (df['close'] < prev_open)
        )
        df['pattern_piercing_line'] = piercing_line

        # 8. Dark Cloud Cover (red opens above prev high, closes below 50% of prev green body)
        prev_green_midpoint = (prev_open + prev_close) / 2
        dark_cloud_cover = (
            prev_is_bullish & is_bearish &
            (df['open'] > prev_high) &
            (df['close'] < prev_green_midpoint) &
            (df['close'] > prev_open)
        )
        df['pattern_dark_cloud_cover'] = dark_cloud_cover

        # 9. Three White Soldiers (3 consecutive large green candles)
        three_white_soldiers = (
            prev2_is_bullish & prev_is_bullish & is_bullish &
            (prev2_body > total_range.shift(2) * 0.3) &
            (prev_body > total_range.shift(1) * 0.3) &
            (body > total_range * 0.3) &
            (df['open'] > prev_open) & (df['open'] < prev_close) &
            (prev_open > prev2_open) & (prev_open < prev2_close)
        )
        df['pattern_three_white_soldiers'] = three_white_soldiers

        # 10. Three Black Crows (3 consecutive large red candles)
        three_black_crows = (
            prev2_is_bearish & prev_is_bearish & is_bearish &
            (prev2_body > total_range.shift(2) * 0.3) &
            (prev_body > total_range.shift(1) * 0.3) &
            (body > total_range * 0.3) &
            (df['open'] < prev_open) & (df['open'] > prev_close) &
            (prev_open < prev2_open) & (prev_open > prev2_close)
        )
        df['pattern_three_black_crows'] = three_black_crows

        # 11. Bullish Pin Bar (lower shadow >= 3x body, body in upper third)
        body_upper_third = df[['open', 'close']].min(axis=1) > (df['low'] + total_range * 0.6)
        bullish_pin_bar = (
            (lower_shadow >= 3 * body_safe) &
            body_upper_third &
            (upper_shadow < body_safe * 1.5) &
            (body > 0)
        )
        df['pattern_bullish_pin_bar'] = bullish_pin_bar.fillna(False)

        # 12. Bearish Pin Bar (upper shadow >= 3x body, body in lower third)
        body_lower_third = df[['open', 'close']].max(axis=1) < (df['high'] - total_range * 0.6)
        bearish_pin_bar = (
            (upper_shadow >= 3 * body_safe) &
            body_lower_third &
            (lower_shadow < body_safe * 1.5) &
            (body > 0)
        )
        df['pattern_bearish_pin_bar'] = bearish_pin_bar.fillna(False)

        # 13. Doji Dragonfly (doji with long lower shadow, no upper shadow)
        doji_dragonfly = (
            doji &
            (lower_shadow > total_range * 0.6) &
            (upper_shadow <= total_range * 0.05)
        )
        df['pattern_doji_dragonfly'] = doji_dragonfly

        # 14. Doji Gravestone (doji with long upper shadow, no lower shadow)
        doji_gravestone = (
            doji &
            (upper_shadow > total_range * 0.6) &
            (lower_shadow <= total_range * 0.05)
        )
        df['pattern_doji_gravestone'] = doji_gravestone

        # 15. Spinning Top (small body with shadows on both sides)
        spinning_top = (
            (body <= total_range * 0.2) &
            (upper_shadow >= body * 0.5) &
            (lower_shadow >= body * 0.5) &
            (total_range > 0) &
            ~doji  # Exclude doji — spinning top must have a visible body
        )
        df['pattern_spinning_top'] = spinning_top

        # 16. Marubozu Bullish (large green candle, no shadows)
        marubozu_bullish = (
            is_bullish &
            (body > total_range * 0.7) &
            (upper_shadow <= total_range * 0.05) &
            (lower_shadow <= total_range * 0.05) &
            (total_range > 0)
        )
        df['pattern_marubozu_bullish'] = marubozu_bullish

        # 17. Marubozu Bearish (large red candle, no shadows)
        marubozu_bearish = (
            is_bearish &
            (body > total_range * 0.7) &
            (upper_shadow <= total_range * 0.05) &
            (lower_shadow <= total_range * 0.05) &
            (total_range > 0)
        )
        df['pattern_marubozu_bearish'] = marubozu_bearish

        return df

    def get_active_patterns(self, df: pd.DataFrame) -> dict:
        """Extrait les patterns actifs sur la dernière bougie."""
        if df.empty:
            return {'bullish': [], 'bearish': [], 'indecision': [], 'has_bullish': False, 'has_bearish': False, 'score_modifier': 0}

        last = df.iloc[-1]
        bullish = []
        bearish = []
        indecision = []

        # Existing patterns
        if last.get('pattern_bull_engulfing'): bullish.append('Bullish Engulfing')
        if last.get('pattern_hammer'): bullish.append('Hammer')
        if last.get('pattern_bear_engulfing'): bearish.append('Bearish Engulfing')
        if last.get('pattern_shooting_star'): bearish.append('Shooting Star')

        # New bullish patterns
        if last.get('pattern_morning_star'): bullish.append('Morning Star')
        if last.get('pattern_bullish_harami'): bullish.append('Bullish Harami')
        if last.get('pattern_tweezer_bottom'): bullish.append('Tweezer Bottom')
        if last.get('pattern_piercing_line'): bullish.append('Piercing Line')
        if last.get('pattern_three_white_soldiers'): bullish.append('Three White Soldiers')
        if last.get('pattern_bullish_pin_bar'): bullish.append('Bullish Pin Bar')
        if last.get('pattern_marubozu_bullish'): bullish.append('Marubozu Bullish')

        # New bearish patterns
        if last.get('pattern_evening_star'): bearish.append('Evening Star')
        if last.get('pattern_bearish_harami'): bearish.append('Bearish Harami')
        if last.get('pattern_tweezer_top'): bearish.append('Tweezer Top')
        if last.get('pattern_dark_cloud_cover'): bearish.append('Dark Cloud Cover')
        if last.get('pattern_three_black_crows'): bearish.append('Three Black Crows')
        if last.get('pattern_bearish_pin_bar'): bearish.append('Bearish Pin Bar')
        if last.get('pattern_marubozu_bearish'): bearish.append('Marubozu Bearish')

        # Indecision patterns (H9: Doji included in output)
        if last.get('pattern_doji'): indecision.append('Doji')
        if last.get('pattern_doji_dragonfly'): indecision.append('Doji Dragonfly')
        if last.get('pattern_doji_gravestone'): indecision.append('Doji Gravestone')
        if last.get('pattern_spinning_top'): indecision.append('Spinning Top')

        return {
            'bullish': bullish,
            'bearish': bearish,
            'indecision': indecision,
            'has_bullish': len(bullish) > 0,
            'has_bearish': len(bearish) > 0,
            'score_modifier': (
                2 if 'Bullish Engulfing' in bullish or 'Bearish Engulfing' in bearish or
                     'Morning Star' in bullish or 'Evening Star' in bearish or
                     'Three White Soldiers' in bullish or 'Three Black Crows' in bearish
                else 1 if len(bullish) > 0 or len(bearish) > 0
                else 0
            )
        }
