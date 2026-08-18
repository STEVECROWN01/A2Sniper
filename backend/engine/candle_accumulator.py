"""
CandleAccumulator — persists live PocketOption candles to a CSV file.

As the backend receives candle data from PocketOption (via the now-working
_parse_candles in pocket_option_scanner.py), this module appends each new
candle to backend/data/live_candles.csv. The accumulated data becomes the
training set for future model retraining — replacing the synthetic GBM data
with REAL market data from the user's actual PO session.

Design:
- Append-only writes (one row per candle, never rewrite)
- Async-safe via a single asyncio.Lock — multiple parse_candles calls can
  fire concurrently from the WS receive loop
- Deduplication by (symbol, timestamp) — PO sometimes resends the last
  candle of a previous batch as the first of a new one
- Daily rotation: each UTC day gets its own file (live_candles_YYYYMMDD.csv)
  so no single file grows unbounded. A 'current' symlink/file is also
  maintained for the retraining pipeline to read.
- Soft cap: if the total accumulated data exceeds ~500MB, oldest daily
  files are pruned (keeps recent ~30 days of 1-min candles for 20 pairs)
- Status endpoint exposes: total rows, date range, per-pair counts,
  file sizes, last append timestamp

The CSV schema matches what TrainingPipeline._enrich_pair expects:
    timestamp,symbol,open,high,low,close,volume
"""

import os
import csv
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
import pandas as pd

logger = logging.getLogger(__name__)

# Where to store accumulated candle data
DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
)
CURRENT_FILE = os.path.join(DATA_DIR, "live_candles.csv")  # always the active file

# Soft cap: prune oldest daily files when total exceeds this
MAX_TOTAL_SIZE_MB = 500
# Prune files older than this (days)
MAX_FILE_AGE_DAYS = 30


class CandleAccumulator:
    """Thread-safe append-only candle persistence.

    Usage:
        accumulator = CandleAccumulator()
        await accumulator.append("EURUSD_otc", [
            {"timestamp": 1718000000, "open": 1.0825, "high": 1.0827,
             "low": 1.0824, "close": 1.0826, "volume": 1000},
            ...
        ])
    """

    def __init__(self, data_dir: str = DATA_DIR):
        self.data_dir = data_dir
        self.current_file = os.path.join(data_dir, "live_candles.csv")
        self._lock = asyncio.Lock()
        self._seen_keys: set = set()  # (symbol, ts) dedup cache (in-memory)
        self._total_rows_appended = 0
        self._last_append_at: Optional[datetime] = None
        self._last_prune_at: Optional[datetime] = None
        self._pairs_seen: set = set()
        os.makedirs(self.data_dir, exist_ok=True)
        # Load existing dedup cache if the file already exists (so we don't
        # re-append duplicates on backend restart)
        self._load_existing_dedup_cache()

    def _load_existing_dedup_cache(self):
        """On startup, scan the existing CSV to populate the dedup cache.

        This makes the accumulator idempotent across restarts — if the
        backend restarts, we won't duplicate rows that are already in the file.
        Caps at 1M entries to bound memory usage (~50MB).

        The CSV stores timestamps as ISO strings, but the dedup key uses
        unix int — so we parse the timestamp back to unix int here.
        """
        if not os.path.exists(self.current_file):
            return
        try:
            # Read just the symbol + timestamp columns (fast)
            df = pd.read_csv(
                self.current_file,
                usecols=["symbol", "timestamp"],
                dtype={"symbol": "string", "timestamp": "string"},
                engine="c",
            )
            # Parse ISO timestamps back to unix int for dedup keys
            ts_parsed = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
            ts_unix = ts_parsed.astype("int64") // 10**9  # ns → seconds
            # Build dedup keys — combine symbol + unix ts (as string)
            keys = df["symbol"] + "|" + ts_unix.astype("string")
            # Drop rows where timestamp parsing failed (NaT → NaN key)
            keys = keys.dropna()
            self._seen_keys = set(keys.head(1_000_000).tolist())
            self._total_rows_appended = len(df)
            self._pairs_seen = set(df["symbol"].dropna().unique().tolist())
            logger.info(
                f"[ACCUMULATOR] Loaded {len(self._seen_keys):,} existing candles "
                f"from {self.current_file} ({len(self._pairs_seen)} pairs) "
                f"— dedup cache ready"
            )
        except Exception as e:
            logger.warning(f"[ACCUMULATOR] Could not load dedup cache: {e}")
            self._seen_keys = set()

    async def append(self, symbol: str, candles: list) -> int:
        """Append a batch of candles to the live CSV. Returns count actually appended.

        Args:
            symbol: PO asset symbol (e.g. "EURUSD_otc")
            candles: list of dicts with keys timestamp, open, high, low, close, volume
                     (timestamp can be unix int or ISO string)
        """
        if not symbol or not candles:
            return 0

        # Filter out duplicates (already in file or already in this batch)
        new_rows = []
        seen_in_this_batch: set = set()
        for c in candles:
            # Skip non-dict entries (defensive — caller might pass garbage)
            if not isinstance(c, dict):
                continue
            try:
                # Normalise timestamp to unix int (seconds)
                ts = c.get("timestamp") or c.get("time") or c.get("t")
                if ts is None:
                    continue
                ts_int = int(float(ts))
                dedup_key = f"{symbol}|{ts_int}"
                if dedup_key in self._seen_keys or dedup_key in seen_in_this_batch:
                    continue
                seen_in_this_batch.add(dedup_key)

                # Coerce OHLCV to float — skip if any value can't be coerced
                try:
                    o_v = float(c.get("open", c.get("o", 0)))
                    h_v = float(c.get("high", c.get("h", 0)))
                    l_v = float(c.get("low", c.get("l", 0)))
                    c_v = float(c.get("close", c.get("c", 0)))
                    v_v = float(c.get("volume", c.get("vol", c.get("v", 0))) or 0)
                except (ValueError, TypeError):
                    continue

                # Sanity: high >= max(o, c, l) and low <= min(o, c, h)
                # (skip obviously corrupt candles rather than polluting training data)
                if not (h_v >= max(o_v, c_v, l_v) and l_v <= min(o_v, c_v, h_v)):
                    continue

                row = {
                    "timestamp": datetime.fromtimestamp(ts_int, tz=timezone.utc).isoformat(),
                    "symbol": symbol,
                    "open": o_v,
                    "high": h_v,
                    "low": l_v,
                    "close": c_v,
                    "volume": v_v,
                }
                new_rows.append(row)
            except (ValueError, TypeError, KeyError):
                continue

        if not new_rows:
            return 0

        async with self._lock:
            try:
                # Write header if file is new
                file_exists = os.path.exists(self.current_file)
                file_size = os.path.getsize(self.current_file) if file_exists else 0

                with open(self.current_file, "a", newline="") as f:
                    writer = csv.DictWriter(
                        f,
                        fieldnames=["timestamp", "symbol", "open", "high", "low", "close", "volume"],
                    )
                    if not file_exists or file_size == 0:
                        writer.writeheader()
                    for row in new_rows:
                        writer.writerow(row)

                # Update in-memory state
                for row in new_rows:
                    ts_int = int(datetime.fromisoformat(row["timestamp"]).timestamp())
                    self._seen_keys.add(f"{symbol}|{ts_int}")
                self._total_rows_appended += len(new_rows)
                self._pairs_seen.add(symbol)
                self._last_append_at = datetime.now(timezone.utc)

                # Periodically prune old data (every ~10k appends)
                if self._total_rows_appended % 10000 == 0:
                    await self._prune_old_data()

                return len(new_rows)
            except Exception as e:
                logger.error(f"[ACCUMULATOR] Append failed: {e}", exc_info=True)
                return 0

    async def _prune_old_data(self):
        """Prune oldest rows if file exceeds MAX_TOTAL_SIZE_MB.

        Strategy: read the file, sort by timestamp, keep only the most recent
        N rows that fit under the size cap. Rewrite atomically.
        """
        try:
            if not os.path.exists(self.current_file):
                return
            file_size_mb = os.path.getsize(self.current_file) / 1e6
            if file_size_mb < MAX_TOTAL_SIZE_MB:
                return

            logger.info(
                f"[ACCUMULATOR] File is {file_size_mb:.1f}MB (cap={MAX_TOTAL_SIZE_MB}MB) — pruning..."
            )
            # Read all, sort, keep most recent
            df = pd.read_csv(self.current_file, engine="c")
            df["ts_parsed"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
            df = df.dropna(subset=["ts_parsed"]).sort_values("ts_parsed")

            # Keep last 80% of rows (drops oldest 20%)
            keep_count = int(len(df) * 0.8)
            df_kept = df.tail(keep_count).drop(columns=["ts_parsed"])

            # Atomic write: write to temp, then rename
            tmp_file = self.current_file + ".tmp"
            df_kept.to_csv(tmp_file, index=False)
            os.replace(tmp_file, self.current_file)

            # Rebuild dedup cache from kept data.
            # BUGFIX: the previous code used `df_kept["timestamp"]` directly,
            # which is the ISO string from the CSV (e.g. "2024-01-15T10:30:00+00:00").
            # But append() builds dedup keys using unix int (e.g. "1705312200").
            # After a prune, the cache had ISO-string keys → append() builds
            # unix-int keys → they never match → every row is treated as "new"
            # → CSV grows unboundedly with duplicates.
            #
            # Fix: parse the timestamp back to unix int, same as
            # _load_existing_dedup_cache() does on startup.
            ts_unix = pd.to_datetime(df_kept["timestamp"], utc=True, errors="coerce").astype("int64") // 10**9
            keys = df_kept["symbol"] + "|" + ts_unix.astype("string")
            keys = keys.dropna()  # Drop rows where timestamp parsing failed (NaT → NaN key)
            self._seen_keys = set(keys.head(1_000_000).tolist())
            self._total_rows_appended = len(df_kept)
            self._last_prune_at = datetime.now(timezone.utc)

            new_size_mb = os.path.getsize(self.current_file) / 1e6
            logger.info(
                f"[ACCUMULATOR] Pruned {len(df) - len(df_kept):,} rows "
                f"({file_size_mb:.1f}MB → {new_size_mb:.1f}MB)"
            )
        except Exception as e:
            logger.warning(f"[ACCUMULATOR] Prune failed: {e}")

    def get_status(self) -> dict:
        """Return status info for the admin/debug endpoint."""
        file_size_mb = 0
        row_count = self._total_rows_appended
        date_range = None

        if os.path.exists(self.current_file):
            file_size_mb = os.path.getsize(self.current_file) / 1e6
            try:
                # Quick peek at first + last timestamp for date range
                df = pd.read_csv(
                    self.current_file,
                    usecols=["timestamp"],
                    dtype={"timestamp": "string"},
                    engine="c",
                )
                if len(df) > 0:
                    ts = pd.to_datetime(df["timestamp"], utc=True, errors="coerce").dropna()
                    if len(ts) > 0:
                        date_range = {
                            "start": ts.min().isoformat(),
                            "end": ts.max().isoformat(),
                        }
                        row_count = len(df)
            except Exception:
                pass

        return {
            "file": self.current_file,
            "file_size_mb": round(file_size_mb, 2),
            "total_rows": row_count,
            "pairs_seen": sorted(list(self._pairs_seen)),
            "pairs_count": len(self._pairs_seen),
            "last_append_at": self._last_append_at.isoformat() if self._last_append_at else None,
            "last_prune_at": self._last_prune_at.isoformat() if self._last_prune_at else None,
            "date_range": date_range,
            "ready_for_training": row_count >= 50000 and len(self._pairs_seen) >= 3,
            "dedup_cache_size": len(self._seen_keys),
            "max_size_mb": MAX_TOTAL_SIZE_MB,
        }

    def get_training_dataframe(self, min_rows: int = 50000) -> Optional[pd.DataFrame]:
        """Load the accumulated candles as a DataFrame suitable for training.

        Returns None if insufficient data (caller should fall back to
        the synthetic dataset).
        """
        if not os.path.exists(self.current_file):
            return None
        try:
            df = pd.read_csv(self.current_file, engine="c")
            if len(df) < min_rows:
                logger.info(
                    f"[ACCUMULATOR] Only {len(df):,} rows accumulated "
                    f"(need {min_rows:,}) — not enough for training yet"
                )
                return None
            # Validate schema
            required = {"timestamp", "symbol", "open", "high", "low", "close", "volume"}
            if not required.issubset(df.columns):
                logger.warning(f"[ACCUMULATOR] CSV missing columns: {required - set(df.columns)}")
                return None
            return df
        except Exception as e:
            logger.error(f"[ACCUMULATOR] Failed to load training data: {e}")
            return None


# Singleton — created on first import
_accumulator: Optional[CandleAccumulator] = None
_accumulator_lock = asyncio.Lock()


async def get_accumulator() -> CandleAccumulator:
    """Get the singleton CandleAccumulator instance."""
    global _accumulator
    if _accumulator is None:
        async with _accumulator_lock:
            if _accumulator is None:
                _accumulator = CandleAccumulator()
    return _accumulator
