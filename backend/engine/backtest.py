"""
A2Sniper 3.0 — Backtest Engine
==============================

Runs the signal engines (ACE + Sniper) on historical candle data and
measures the ACTUAL win rate, comparing it to the engines' claimed
(hardcoded) win rates.

This is the truth-telling layer. The engines claim 62-78% win rate, but
those numbers are hardcoded lookup tables. This backtester tells you
what actually happens when you follow the signals.

Usage:
    from engine.backtest import Backtester
    bt = Backtester(pair='EURUSD_otc', payout=80)
    results = await bt.run(engine='ace', min_candles=50)
    print(bt.summary(results))

Data sources (in priority order):
    1. Real candles from the Supabase `candles` table (best — real PO OTC data)
    2. Synthetic CSV fallback (backend/data/eurusd_otc_30d.csv) for testing
"""

import logging
import os
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

import pandas as pd

logger = logging.getLogger(__name__)


class Backtester:
    """Run the signal engines on historical data and measure actual outcomes."""

    def __init__(self, pair: str = 'EURUSD_otc', payout: float = 80.0):
        self.pair = pair
        self.payout = payout

    async def _load_candles_from_db(self, limit: int = 5000) -> Optional[pd.DataFrame]:
        """Load real candles from the Supabase candles table."""
        try:
            from db import AsyncSessionLocal, CandleRecord
            from sqlalchemy import select
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(CandleRecord)
                    .where(CandleRecord.pair == self.pair)
                    .order_by(CandleRecord.timestamp.asc())
                    .limit(limit)
                )
                candles = result.scalars().all()
            if not candles or len(candles) < 50:
                logger.info(f"[BACKTEST] DB has only {len(candles)} candles for {self.pair} — need at least 50")
                return None

            df = pd.DataFrame([{
                'timestamp': c.timestamp,
                'open': float(c.open),
                'high': float(c.high),
                'low': float(c.low),
                'close': float(c.close),
                'volume': float(c.volume) if c.volume else 0,
            } for c in candles])
            # Convert unix timestamp to datetime for the engine
            df['datetime'] = pd.to_datetime(df['timestamp'], unit='s', utc=True)
            df = df.set_index('datetime').drop(columns=['timestamp'])
            logger.info(f"[BACKTEST] Loaded {len(df)} real candles for {self.pair} from DB")
            return df
        except Exception as e:
            logger.warning(f"[BACKTEST] Could not load candles from DB: {e}")
            return None

    def _load_candles_from_csv(self) -> Optional[pd.DataFrame]:
        """Load candles from the synthetic CSV fallback (for testing only)."""
        csv_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'eurusd_otc_30d.csv'
        )
        if not os.path.exists(csv_path):
            logger.warning(f"[BACKTEST] CSV not found: {csv_path}")
            return None
        try:
            df = pd.read_csv(csv_path)
            df['datetime'] = pd.to_datetime(df['timestamp'], utc=True, errors='coerce')
            df = df.dropna(subset=['datetime'])
            df = df.set_index('datetime').drop(columns=['timestamp'])
            # Rename to match engine expectations
            if 'vol' in df.columns:
                df = df.rename(columns={'vol': 'volume'})
            if 'volume' not in df.columns:
                df['volume'] = 0
            logger.info(f"[BACKTEST] Loaded {len(df)} candles from CSV (synthetic fallback)")
            return df
        except Exception as e:
            logger.warning(f"[BACKTEST] Could not load CSV: {e}")
            return None

    async def _load_data(self) -> Optional[pd.DataFrame]:
        """Load candle data — tries DB first, falls back to CSV."""
        df = await self._load_candles_from_db()
        if df is None or len(df) < 50:
            logger.info("[BACKTEST] DB data insufficient — falling back to CSV")
            df = self._load_candles_from_csv()
        return df

    def _prepare_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        """Pre-calculate all indicators on the full DataFrame.

        This is done once upfront so the backtest loop can just slice
        the pre-calculated DataFrame for each window — much faster than
        recalculating indicators on every iteration.
        """
        try:
            from engine.indicators import TechnicalIndicators
            ti = TechnicalIndicators()
            return ti.calculate_all(df)
        except Exception as e:
            logger.error(f"[BACKTEST] Indicator calculation failed: {e}")
            return df

    def run_backtest(
        self,
        df: pd.DataFrame,
        engine: str = 'ace',
        strict_mode: bool = False,
        step: int = 1,
    ) -> List[Dict[str, Any]]:
        """Run the signal engine on historical data and resolve outcomes.

        Args:
            df: DataFrame with OHLCV + indicators (pre-calculated)
            engine: 'ace' or 'sniper'
            strict_mode: For sniper engine — True = Option D (signals page),
                         False = Option C (bot). Ignored for ACE.
            step: Skip candles (step=1 = check every candle, step=5 = every 5th).
                  Use step > 1 for faster (but less thorough) backtests.

        Returns:
            List of signal records with actual outcomes resolved.
        """
        from engine.ace_engine import generate_ace_signal
        from engine.sniper_engine import generate_sniper_signal

        min_candles = 50  # Engines need at least 50 candles for indicators
        max_lookahead = 10  # Max expiration in candles (3min on 1min data = 3 candles)

        results: List[Dict[str, Any]] = []

        total_iterations = (len(df) - min_candles - max_lookahead) // step
        logger.info(
            f"[BACKTEST] Running {engine} engine on {self.pair} — "
            f"{total_iterations} iterations (df={len(df)}, step={step})"
        )

        for i in range(min_candles, len(df) - max_lookahead, step):
            window = df.iloc[:i + 1]

            # Run the signal engine on this window
            try:
                if engine == 'ace':
                    signal = generate_ace_signal(window, payout=self.payout, fast_mode=True)
                elif engine == 'sniper':
                    signal = generate_sniper_signal(
                        window, payout=self.payout, strict_mode=strict_mode
                    )
                else:
                    continue
            except Exception:
                # Engine errors are common on edge cases — skip silently
                continue

            if signal is None:
                continue

            # Record the signal
            entry_price = float(signal['entry_price'])
            entry_time = df.index[i]
            expiration = int(signal.get('expiration', 3))  # minutes (on 1m data = candles)
            direction = signal['direction']
            claimed_winrate = float(signal.get('winrate', 0))
            score = int(signal.get('score', 0))
            classification = signal.get('classification', '')

            # Look forward to find exit price
            exit_idx = i + expiration
            if exit_idx >= len(df):
                continue  # Not enough data to resolve

            exit_price = float(df.iloc[exit_idx]['close'])
            exit_time = df.index[exit_idx]

            # Determine outcome (binary option: strictly above/below entry)
            if direction == 'CALL':
                is_win = exit_price > entry_price
            elif direction == 'PUT':
                is_win = exit_price < entry_price
            else:
                continue

            # Tie (exact same price — rare but possible)
            is_tie = exit_price == entry_price

            results.append({
                'pair': self.pair,
                'engine': engine,
                'strict_mode': strict_mode,
                'timestamp': entry_time.isoformat(),
                'direction': direction,
                'entry_price': entry_price,
                'exit_price': exit_price,
                'expiration_minutes': expiration,
                'claimed_winrate': claimed_winrate,
                'actual_win': is_win if not is_tie else None,
                'is_tie': is_tie,
                'score': score,
                'classification': classification,
                'payout': self.payout,
            })

            if len(results) % 50 == 0:
                logger.info(f"[BACKTEST] {engine}: {len(results)} signals found so far...")

        logger.info(f"[BACKTEST] {engine} complete: {len(results)} signals from {total_iterations} iterations")
        return results

    def summary(self, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Calculate summary statistics from backtest results."""
        if not results:
            return {
                'total_signals': 0,
                'message': 'No signals generated. The engines found no qualifying setups in the data.',
            }

        # Filter out ties (unresolved)
        resolved = [r for r in results if r['actual_win'] is not None]
        wins = [r for r in resolved if r['actual_win'] is True]
        losses = [r for r in resolved if r['actual_win'] is False]
        ties = [r for r in results if r['is_tie']]

        total = len(resolved)
        win_count = len(wins)
        loss_count = len(losses)
        tie_count = len(ties)
        actual_winrate = round(win_count / total * 100, 1) if total > 0 else 0

        # Claimed win rate (average of the engines' hardcoded numbers)
        avg_claimed = round(sum(r['claimed_winrate'] for r in results) / len(results), 1) if results else 0

        # P&L simulation (assuming 1% stake per trade, payout = self.payout%)
        stake_pct = 1.0  # 1% of bankroll per trade
        pnl_per_win = stake_pct * (self.payout / 100)
        pnl_per_loss = -stake_pct
        total_pnl = sum(pnl_per_win if r['actual_win'] else pnl_per_loss for r in resolved)
        total_pnl = round(total_pnl, 2)

        # Break-even win rate
        break_even = round(100 / (100 + self.payout), 1)

        # Per-direction stats
        calls = [r for r in resolved if r['direction'] == 'CALL']
        puts = [r for r in resolved if r['direction'] == 'PUT']
        call_wr = round(sum(1 for r in calls if r['actual_win']) / len(calls) * 100, 1) if calls else 0
        put_wr = round(sum(1 for r in puts if r['actual_win']) / len(puts) * 100, 1) if puts else 0

        # Per-score stats (higher score = more confluence factors)
        score_stats = {}
        for score_val in sorted(set(r['score'] for r in resolved)):
            score_signals = [r for r in resolved if r['score'] == score_val]
            score_wins = sum(1 for r in score_signals if r['actual_win'])
            score_stats[score_val] = {
                'count': len(score_signals),
                'wins': score_wins,
                'winrate': round(score_wins / len(score_signals) * 100, 1) if score_signals else 0,
            }

        return {
            'pair': self.pair,
            'payout': self.payout,
            'total_signals': len(results),
            'resolved': total,
            'wins': win_count,
            'losses': loss_count,
            'ties': tie_count,
            'actual_winrate': actual_winrate,
            'avg_claimed_winrate': avg_claimed,
            'claim_vs_actual_gap': round(actual_winrate - avg_claimed, 1),
            'break_even_winrate': break_even,
            'profitable': actual_winrate > break_even,
            'pnl_simulation_pct': total_pnl,
            'call_signals': len(calls),
            'call_winrate': call_wr,
            'put_signals': len(puts),
            'put_winrate': put_wr,
            'score_breakdown': score_stats,
            'verdict': self._verdict(actual_winrate, break_even),
        }

    def _verdict(self, actual: float, break_even: float) -> str:
        """Human-readable verdict based on actual vs break-even win rate."""
        if actual >= 65:
            return f'EXCELLENT — {actual}% actual (break-even: {break_even}%). Profitable edge confirmed.'
        elif actual >= break_even + 2:
            return f'PROFITABLE — {actual}% actual (break-even: {break_even}%). Slim but positive edge.'
        elif actual >= break_even - 2:
            return f'BREAK-EVEN — {actual}% actual (break-even: {break_even}%). No real edge. Expect variance to determine P&L.'
        else:
            return f'LOSING — {actual}% actual (break-even: {break_even}%). Negative EV. Do NOT trade real money on these signals.'
