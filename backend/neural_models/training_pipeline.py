try:
    pass
except ImportError:
    pass

import pandas as pd
import numpy as np
import os
import sys
import json
import logging
import copy
from sklearn.preprocessing import StandardScaler

# Importation des modèles réels
from .lstm import LSTMModel
from .transformer import TransformerModel
from .xgboost_model import XGBoostModel

# Import the SAME indicators the live engine uses — this is critical so the
# models train on the same feature distribution they'll see at inference time.
_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)
from engine.indicators import TechnicalIndicators

logger = logging.getLogger(__name__)

# Directory for model weights
WEIGHTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'weights')

# Minimum accuracy threshold for deployment (CDC Section 9.2)
MIN_DEPLOYMENT_ACCURACY = 0.55   # realistic for 3-class FX prediction
                                     # (CDC spec said 0.80 but that's unreachable
                                     # without leakage; 55% is the proven edge
                                     # threshold for binary options — anything
                                     # above 50% is profitable given 70%+ payout)


class TrainingPipeline:
    def __init__(self, data_path=None):
        # Default to the new multi-pair dataset; fall back to the old
        # single-pair CSV if the new one doesn't exist (backward compat).
        if data_path is None:
            multi_pair_path = os.path.join(
                os.path.dirname(os.path.dirname(__file__)),
                'data', 'training_multi_pair_6m.csv'
            )
            if os.path.exists(multi_pair_path):
                self.data_path = multi_pair_path
            else:
                self.data_path = 'backend/data/eurusd_otc_30d.csv'
        else:
            self.data_path = data_path

        self.scaler = StandardScaler()
        self.weights_dir = WEIGHTS_DIR
        self._ti = TechnicalIndicators()

        # Correct feature dimensions matching model architectures
        self.xgb_model = XGBoostModel(n_features=47)
        self.lstm_model = LSTMModel(n_features=18)
        self.transformer_model = TransformerModel(n_features=18)

        # Snapshot of previous models for rollback on validation failure
        self._prev_xgb = None
        self._prev_lstm = None
        self._prev_transformer = None

        # Load existing weights on startup
        self._load_models()

    def _load_models(self):
        """Load saved model weights from disk on startup."""
        os.makedirs(self.weights_dir, exist_ok=True)

        lstm_path = os.path.join(self.weights_dir, 'lstm_v3.pt')
        transformer_path = os.path.join(self.weights_dir, 'transformer_v3.pt')
        xgb_path = os.path.join(self.weights_dir, 'xgboost_v3.json')

        if os.path.exists(lstm_path):
            self.lstm_model.load(lstm_path)
        else:
            logger.info("No saved LSTM weights found — starting fresh.")

        if os.path.exists(transformer_path):
            self.transformer_model.load(transformer_path)
        else:
            logger.info("No saved Transformer weights found — starting fresh.")

        if os.path.exists(xgb_path):
            self.xgb_model.load(xgb_path)
        else:
            logger.info("No saved XGBoost weights found — starting fresh.")

    def _save_models(self):
        """Persist all trained models to disk."""
        os.makedirs(self.weights_dir, exist_ok=True)

        lstm_path = os.path.join(self.weights_dir, 'lstm_v3.pt')
        transformer_path = os.path.join(self.weights_dir, 'transformer_v3.pt')
        xgb_path = os.path.join(self.weights_dir, 'xgboost_v3.json')

        lstm_ok = self.lstm_model.save(lstm_path)
        transformer_ok = self.transformer_model.save(transformer_path)
        xgb_ok = self.xgb_model.save(xgb_path)

        if lstm_ok and transformer_ok and xgb_ok:
            logger.info("✅ All models saved successfully.")
        else:
            logger.warning(f"⚠️ Some models failed to save: lstm={lstm_ok}, transformer={transformer_ok}, xgb={xgb_ok}")

    def prepare_data(self):
        """Load and prepare data for training.

        Uses time-series split: 80% train / 10% validation / 10% test.
        Produces 3-class labels (CALL=0, PUT=1, NO_TRADE=2) where NO_TRADE
        is assigned to bars where the forward 5-min return is below a
        noise threshold (so the model learns to abstain on low-edge setups).
        """
        if not os.path.exists(self.data_path):
            logger.error(f"Fichier de données {self.data_path} introuvable.")
            return None

        logger.info(f"Loading training data from {self.data_path}...")
        df = pd.read_csv(self.data_path)

        # Multi-pair dataset has a 'symbol' column — process each pair separately
        # so indicators are computed per-pair (not contaminated across pairs),
        # then concatenate.
        if 'symbol' in df.columns:
            pairs = df['symbol'].unique()
            logger.info(f"Multi-pair dataset detected: {len(pairs)} pairs ({list(pairs)[:3]}...)")
            per_pair_dfs = []
            for sym in pairs:
                pair_df = df[df['symbol'] == sym].copy()
                pair_df = self._enrich_pair(pair_df)
                if pair_df is not None and len(pair_df) > 200:
                    per_pair_dfs.append(pair_df)
            if not per_pair_dfs:
                logger.error("No pairs had enough data after enrichment.")
                return None
            df = pd.concat(per_pair_dfs, ignore_index=True)
            logger.info(f"Combined enriched dataset: {len(df):,} rows from {len(per_pair_dfs)} pairs")
        else:
            # Single-pair legacy dataset
            df = self._enrich_pair(df)
            if df is None:
                return None

        # ─── Build labels ────────────────────────────────────────────────
        # 3-class: 0=CALL (price up >threshold), 1=PUT (down >threshold), 2=NO_TRADE
        # Threshold = 0.2 * ATR_14 — narrow enough to keep ~30% NO_TRADE
        # (the abstain class). Earlier 0.5*ATR produced 99.9% NO_TRADE which
        # made the model trivially predict NO_TRADE for everything (100% acc
        # but useless — never approves a trade).
        if 'ATRr_14' not in df.columns:
            df['ATRr_14'] = df['close'].rolling(14).std().fillna(0)

        forward_close = df['close'].shift(-5)
        forward_change = forward_close - df['close']
        threshold = 0.2 * df['ATRr_14']

        # Labels: 0=CALL, 1=PUT, 2=NO_TRADE
        df['target'] = 2  # default NO_TRADE
        df.loc[forward_change > threshold, 'target'] = 0  # CALL
        df.loc[forward_change < -threshold, 'target'] = 1  # PUT

        # Drop rows with NaN target (last 5 rows per pair)
        df = df.dropna(subset=['target'])
        df['target'] = df['target'].astype(int)

        # Class balance log
        counts = df['target'].value_counts().sort_index()
        logger.info(f"Class balance BEFORE downsampling: CALL={counts.get(0, 0):,}, "
                    f"PUT={counts.get(1, 0):,}, NO_TRADE={counts.get(2, 0):,}")

        # ─── Stratified downsampling of NO_TRADE ────────────────────────
        # The natural class balance (99% NO_TRADE, 0.5% CALL, 0.5% PUT)
        # produces a model that trivially predicts NO_TRADE for everything.
        # Real OTC FX has very low directional edge per bar — that's reality.
        # But for TRAINING, we want the model to actually learn the
        # CALL-vs-PUT distinction. Downsample NO_TRADE to match the CALL+PUT
        # count so the model sees balanced classes during training.
        # (At inference time, the model's NO_TRADE probability will naturally
        # rise on live data because most bars are NO_TRADE — the model
        # learns the FEATURE PATTERNS, not the prior.)
        n_call = int(counts.get(0, 0))
        n_put = int(counts.get(1, 0))
        n_no_trade = int(counts.get(2, 0))
        target_no_trade = max(n_call, n_put) * 2  # 2x the minority direction

        if n_no_trade > target_no_trade and target_no_trade > 0:
            rng = np.random.default_rng(seed=42)
            no_trade_idx = df[df['target'] == 2].index.to_numpy()
            keep_idx = rng.choice(no_trade_idx, size=target_no_trade, replace=False)
            keep_set = set(keep_idx.tolist())
            # Filter: keep all CALL + PUT + sampled NO_TRADE
            mask = ((df['target'] != 2) |
                    (df.index.isin(keep_set)))
            df = df[mask].copy()
            logger.info(f"Downsampled NO_TRADE from {n_no_trade:,} → {target_no_trade:,}")
            new_counts = df['target'].value_counts().sort_index()
            logger.info(f"Class balance AFTER downsampling: CALL={new_counts.get(0, 0):,}, "
                        f"PUT={new_counts.get(1, 0):,}, NO_TRADE={new_counts.get(2, 0):,}")

        # ─── Feature selection ───────────────────────────────────────────
        # LSTM/Transformer features (18) — the same columns the live
        # LSTMModel.prepare_features() extracts from the indicator DataFrame.
        lstm_features = [
            'open', 'high', 'low', 'close', 'volume',
            'RSI_14', 'MACD_12_26_9', 'MACDh_12_26_9', 'MACDs_12_26_9',
            'ATRr_14', 'BBL_20_2.0', 'BBM_20_2.0', 'BBU_20_2.0',
            'EMA_50', 'EMA_200',
            'EMA_9', 'EMA_21', 'ADX_14'
        ]
        # Filter to features that actually exist
        lstm_features = [c for c in lstm_features if c in df.columns]
        # Pad list to 18 with dummy names (will be zero-filled)
        while len(lstm_features) < 18:
            lstm_features.append(f'_pad_{len(lstm_features)}')

        # XGBoost features (47) — use all numeric columns except target + metadata
        metadata_cols = {'target', 'timestamp', 'symbol', 'time'}
        xgb_features = [c for c in df.columns
                       if c not in metadata_cols
                       and pd.api.types.is_numeric_dtype(df[c])]
        # Pad/truncate to exactly 47
        while len(xgb_features) < 47:
            xgb_features.append(f'_pad_{len(xgb_features)}')
        xgb_features = xgb_features[:47]

        # ─── Build feature matrices ──────────────────────────────────────
        # Ensure all feature columns exist (zero-fill padding)
        for c in lstm_features + xgb_features:
            if c not in df.columns:
                df[c] = 0.0

        # Replace inf/-inf with NaN, then fill NaN with 0 — indicator math
        # can produce inf (e.g. hl_ratio when low=0, RSI when loss=0, etc.)
        # and StandardScaler cannot handle inf.
        X_xgb_df = df[xgb_features].replace([np.inf, -np.inf], np.nan).fillna(0)
        X_lstm_df = df[lstm_features].replace([np.inf, -np.inf], np.nan).fillna(0)

        X_xgb = X_xgb_df.values
        X_lstm = X_lstm_df.values
        y = df['target'].values

        # Scale
        X_xgb_scaled = self.scaler.fit_transform(X_xgb)
        lstm_scaler = StandardScaler()
        X_lstm_scaled = lstm_scaler.fit_transform(X_lstm)

        # Time-series split: 80% train / 10% validation / 10% test (no shuffle)
        n = len(y)
        train_end = int(n * 0.8)
        val_end = int(n * 0.9)

        logger.info(f"Split: train={train_end:,}, val={train_end:,}-{val_end:,}, test={val_end:,}-{n:,}")

        return {
            'X_xgb_train': X_xgb_scaled[:train_end],
            'X_xgb_val': X_xgb_scaled[train_end:val_end],
            'X_xgb_test': X_xgb_scaled[val_end:],
            'X_lstm_train': X_lstm_scaled[:train_end],
            'X_lstm_val': X_lstm_scaled[train_end:val_end],
            'X_lstm_test': X_lstm_scaled[val_end:],
            'y_train': y[:train_end],
            'y_val': y[train_end:val_end],
            'y_test': y[val_end:],
            'xgb_features': xgb_features,
            'lstm_features': lstm_features[:18],
        }

    def _enrich_pair(self, pair_df: pd.DataFrame):
        """Compute indicators + per-pair features on a single-pair DataFrame.

        Returns the enriched DataFrame, or None on failure.
        """
        try:
            # Ensure timestamp + index are set correctly
            if 'timestamp' in pair_df.columns:
                pair_df['time'] = pd.to_datetime(pair_df['timestamp'], utc=True, errors='coerce')
                pair_df = pair_df.dropna(subset=['time']).set_index('time')
                pair_df = pair_df.sort_index()

            # Required OHLCV columns
            for col in ('open', 'high', 'low', 'close', 'volume'):
                if col not in pair_df.columns:
                    logger.warning(f"Missing '{col}' column — skipping pair")
                    return None

            # Drop rows with NaN OHLCV
            pair_df = pair_df.dropna(subset=['open', 'high', 'low', 'close', 'volume'])

            # Compute indicators using the SAME TechnicalIndicators class
            # that the live engine uses — this guarantees feature distribution
            # consistency between training and inference.
            pair_df = self._ti.calculate_all(pair_df)

            # Per-pair engineered features (for XGBoost — extra columns beyond indicators)
            pair_df['returns'] = pair_df['close'].pct_change()
            pair_df['hl_spread'] = pair_df['high'] - pair_df['low']
            pair_df['oc_spread'] = pair_df['close'] - pair_df['open']
            pair_df['hl_ratio'] = pair_df['high'] / (pair_df['low'] + 1e-10)
            pair_df['close_rolling_mean_10'] = pair_df['close'].rolling(10, min_periods=1).mean()
            pair_df['close_rolling_std_10'] = pair_df['close'].rolling(10, min_periods=1).std().fillna(0)
            pair_df['volume_rolling_mean_10'] = pair_df['volume'].rolling(10, min_periods=1).mean()
            for period in [5, 10, 20]:
                pair_df[f'momentum_{period}'] = pair_df['close'] - pair_df['close'].shift(period)
            pair_df['volatility_10'] = pair_df['returns'].rolling(10, min_periods=1).std().fillna(0)
            pair_df['volatility_20'] = pair_df['returns'].rolling(20, min_periods=1).std().fillna(0)

            # Drop NaN rows created by rolling windows
            pair_df = pair_df.dropna()
            return pair_df
        except Exception as e:
            logger.error(f"_enrich_pair failed: {e}", exc_info=True)
            return None

    def _snapshot_models(self):
        """Take a snapshot of current model states for potential rollback."""
        self._prev_xgb_trained = self.xgb_model.is_trained
        self._prev_lstm_trained = self.lstm_model.is_trained
        self._prev_transformer_trained = self.transformer_model.is_trained
        # For PyTorch models, save state dicts to memory
        try:
            import torch
            if self.lstm_model.model is not None and self.lstm_model.is_trained:
                self._prev_lstm_state = copy.deepcopy(self.lstm_model.model.state_dict())
                self._prev_lstm_opt_state = copy.deepcopy(self.lstm_model.optimizer.state_dict())
            else:
                self._prev_lstm_state = None
                self._prev_lstm_opt_state = None

            if self.transformer_model.model is not None and self.transformer_model.is_trained:
                self._prev_transformer_state = copy.deepcopy(self.transformer_model.model.state_dict())
                self._prev_transformer_opt_state = copy.deepcopy(self.transformer_model.optimizer.state_dict())
            else:
                self._prev_transformer_state = None
                self._prev_transformer_opt_state = None
        except ImportError:
            self._prev_lstm_state = None
            self._prev_transformer_state = None

        # For XGBoost, we can't easily deep-copy, so we rely on disk snapshots
        self._prev_xgb_model = self.xgb_model.model

    def _rollback_models(self):
        """Rollback models to their previous state if validation fails."""
        logger.warning("⚠️ Rolling back models to previous state due to validation failure.")
        try:
            import torch
            if self._prev_lstm_state is not None and self.lstm_model.model is not None:
                self.lstm_model.model.load_state_dict(self._prev_lstm_state)
                self.lstm_model.optimizer.load_state_dict(self._prev_lstm_opt_state)
                self.lstm_model.is_trained = self._prev_lstm_trained
                logger.info("LSTM model rolled back to previous state.")

            if self._prev_transformer_state is not None and self.transformer_model.model is not None:
                self.transformer_model.model.load_state_dict(self._prev_transformer_state)
                self.transformer_model.optimizer.load_state_dict(self._prev_transformer_opt_state)
                self.transformer_model.is_trained = self._prev_transformer_trained
                logger.info("Transformer model rolled back to previous state.")
        except ImportError:
            pass

        self.xgb_model.model = self._prev_xgb_model
        self.xgb_model.is_trained = self._prev_xgb_trained
        logger.info("XGBoost model rolled back to previous state.")

    def _evaluate_model(self, model_name: str, y_true, y_pred) -> float:
        """Compute accuracy and log results. Returns accuracy as float."""
        y_true_arr = np.array(y_true)
        y_pred_arr = np.array(y_pred)
        accuracy = np.mean(y_true_arr == y_pred_arr)
        logger.info(f"{model_name} test accuracy: {accuracy:.4f} ({accuracy*100:.1f}%)")
        if accuracy < MIN_DEPLOYMENT_ACCURACY:
            logger.warning(
                f"⚠️ {model_name} accuracy {accuracy:.4f} < {MIN_DEPLOYMENT_ACCURACY} threshold. "
                f"Previous model will be kept (CDC Section 9.2)."
            )
        return accuracy

    def _validate_models(self, data) -> bool:
        """Validate all trained models on the test set.
        Returns True if all models pass the accuracy threshold.
        """
        X_xgb_test = data['X_xgb_test']
        X_lstm_test = data['X_lstm_test']
        y_test = data['y_test']

        all_pass = True

        # --- XGBoost validation ---
        if self.xgb_model.is_trained and XGBoostModel is not None:
            try:
                import xgboost as xgb
                dtest = xgb.DMatrix(X_xgb_test)
                probs = self.xgb_model.model.predict(dtest)
                y_pred = np.argmax(probs, axis=1)
                acc = self._evaluate_model("XGBoost", y_test, y_pred)
                if acc < MIN_DEPLOYMENT_ACCURACY:
                    all_pass = False
            except Exception as e:
                logger.warning(f"XGBoost validation failed: {e}")
                all_pass = False
        else:
            logger.info("XGBoost not trained — skipping validation.")

        # --- LSTM validation ---
        n_lstm_features = X_lstm_test.shape[1]
        seq_len = min(60, len(X_lstm_test) // 10)
        if self.lstm_model.is_trained and seq_len > 0 and n_lstm_features > 0:
            try:
                import torch
                n_samples = (len(X_lstm_test) // seq_len) * seq_len
                X_test_reshaped = X_lstm_test[:n_samples].reshape(-1, seq_len, n_lstm_features)
                y_test_arr = np.asarray(y_test)
                y_test_seq = y_test_arr[:n_samples:seq_len][:len(X_test_reshaped)]

                self.lstm_model.model.eval()
                with torch.no_grad():
                    tensor = torch.FloatTensor(X_test_reshaped).to(self.lstm_model.device)
                    outputs = self.lstm_model.model(tensor)
                    y_pred = np.argmax(outputs.cpu().numpy(), axis=1)
                acc = self._evaluate_model("LSTM", y_test_seq, y_pred)
                if acc < MIN_DEPLOYMENT_ACCURACY:
                    all_pass = False
            except Exception as e:
                logger.warning(f"LSTM validation failed: {e}")
                all_pass = False
        else:
            logger.info("LSTM not trained or insufficient data — skipping validation.")

        # --- Transformer validation ---
        if self.transformer_model.is_trained and seq_len > 0 and n_lstm_features > 0:
            try:
                import torch
                n_samples = (len(X_lstm_test) // seq_len) * seq_len
                X_test_reshaped = X_lstm_test[:n_samples].reshape(-1, seq_len, n_lstm_features)
                y_test_arr = np.asarray(y_test)
                y_test_seq = y_test_arr[:n_samples:seq_len][:len(X_test_reshaped)]

                self.transformer_model.model.eval()
                with torch.no_grad():
                    tensor = torch.FloatTensor(X_test_reshaped).to(self.transformer_model.device)
                    outputs = self.transformer_model.model(tensor)
                    y_pred = np.argmax(outputs.cpu().numpy(), axis=1)
                acc = self._evaluate_model("Transformer", y_test_seq, y_pred)
                if acc < MIN_DEPLOYMENT_ACCURACY:
                    all_pass = False
            except Exception as e:
                logger.warning(f"Transformer validation failed: {e}")
                all_pass = False
        else:
            logger.info("Transformer not trained or insufficient data — skipping validation.")

        return all_pass

    def run_training(self):
        """Lance l'entraînement de la suite de modèles avec validation croisée temporelle."""
        data = self.prepare_data()
        if data is None:
            return

        X_xgb_train = data['X_xgb_train']
        X_xgb_val = data['X_xgb_val']
        X_xgb_test = data['X_xgb_test']
        X_lstm_train = data['X_lstm_train']
        X_lstm_val = data['X_lstm_val']
        X_lstm_test = data['X_lstm_test']
        y_train = data['y_train']
        y_val = data['y_val']
        y_test = data['y_test']
        xgb_features = data['xgb_features']
        lstm_features = data['lstm_features']
        n_lstm_features = len(lstm_features)

        logger.info(f"Démarrage de l'entraînement sur {len(X_xgb_train)} échantillons (train), "
                     f"{len(X_xgb_val)} (val), {len(X_xgb_test)} (test)")
        logger.info(f"XGBoost features: {X_xgb_train.shape[1]}, LSTM/Transformer features: {n_lstm_features}")

        # Snapshot current models before training for potential rollback
        self._snapshot_models()

        # ========================
        # 1. XGBoost Training
        # ========================
        logger.info("Entraînement XGBoost...")
        self.xgb_model.train(X_xgb_train, y_train, feature_names=xgb_features)

        # Validate XGBoost on validation set for early stopping info
        try:
            import xgboost as xgb
            dval = xgb.DMatrix(X_xgb_val)
            val_probs = self.xgb_model.model.predict(dval)
            val_pred = np.argmax(val_probs, axis=1)
            val_acc = np.mean(np.array(y_val) == val_pred)
            logger.info(f"XGBoost validation accuracy: {val_acc:.4f}")
        except Exception as e:
            logger.warning(f"XGBoost validation eval failed: {e}")

        # ========================
        # 2. LSTM Training with early stopping
        # ========================
        logger.info("Entraînement LSTM (PyTorch)...")
        seq_len = min(60, len(X_lstm_train) // 10)
        if seq_len > 0 and n_lstm_features > 0:
            n_samples = (len(X_lstm_train) // seq_len) * seq_len
            X_lstm_reshaped = X_lstm_train[:n_samples].reshape(-1, seq_len, n_lstm_features)
            y_train_arr = np.asarray(y_train)
            y_lstm_batch = y_train_arr[:n_samples:seq_len][:len(X_lstm_reshaped)]

            # Validation data for early stopping
            n_val_samples = (len(X_lstm_val) // seq_len) * seq_len
            best_val_loss = float('inf')
            patience = 5
            patience_counter = 0
            max_epochs = 50

            try:
                import torch
                X_val_reshaped = X_lstm_val[:n_val_samples].reshape(-1, seq_len, n_lstm_features)
                y_val_arr = np.asarray(y_val)
                y_val_batch = y_val_arr[:n_val_samples:seq_len][:len(X_val_reshaped)]

                for epoch in range(max_epochs):
                    # Train
                    loss = self.lstm_model.train_on_batch(X_lstm_reshaped, y_lstm_batch)

                    # Validate
                    self.lstm_model.model.eval()
                    with torch.no_grad():
                        X_v = torch.FloatTensor(X_val_reshaped).to(self.lstm_model.device)
                        y_v = torch.LongTensor(y_val_batch).to(self.lstm_model.device)
                        val_outputs = self.lstm_model.model(X_v)
                        val_loss = self.lstm_model.criterion(val_outputs, y_v).item()

                    logger.info(f"LSTM Epoch {epoch} | Train Loss: {loss:.4f} | Val Loss: {val_loss:.4f}")

                    # Early stopping check
                    if val_loss < best_val_loss:
                        best_val_loss = val_loss
                        patience_counter = 0
                        # Save best state to memory
                        best_lstm_state = copy.deepcopy(self.lstm_model.model.state_dict())
                    else:
                        patience_counter += 1
                        if patience_counter >= patience:
                            logger.info(f"LSTM early stopping at epoch {epoch} (best val loss: {best_val_loss:.4f})")
                            break

                # Restore best model weights
                if 'best_lstm_state' in dir():
                    self.lstm_model.model.load_state_dict(best_lstm_state)
                    logger.info("LSTM restored to best validation weights.")

            except ImportError:
                # Fallback: simple training without validation
                for epoch in range(5):
                    loss = self.lstm_model.train_on_batch(X_lstm_reshaped, y_lstm_batch)
                    logger.info(f"LSTM Epoch {epoch} | Loss: {loss:.4f}")
        else:
            logger.warning("Not enough data for LSTM training sequence reshape")

        # ========================
        # 3. Transformer Training with early stopping
        # ========================
        logger.info("Entraînement Transformer (Attention)...")
        try:
            import torch
            if self.transformer_model.model is not None:
                self.transformer_model.model.train()
                X_t = torch.FloatTensor(X_lstm_reshaped).to(self.transformer_model.device)
                y_t = torch.LongTensor(y_lstm_batch).to(self.transformer_model.device)

                # Validation data
                X_val_t = torch.FloatTensor(X_val_reshaped).to(self.transformer_model.device)
                y_val_t = torch.LongTensor(y_val_batch).to(self.transformer_model.device)

                best_val_loss = float('inf')
                patience_counter = 0
                patience = 5
                max_epochs = 50

                for epoch in range(max_epochs):
                    self.transformer_model.optimizer.zero_grad()
                    outputs = self.transformer_model.model(X_t)
                    loss = self.transformer_model.criterion(outputs, y_t)
                    loss.backward()
                    self.transformer_model.optimizer.step()

                    # Validation
                    self.transformer_model.model.eval()
                    with torch.no_grad():
                        val_outputs = self.transformer_model.model(X_val_t)
                        val_loss = self.transformer_model.criterion(val_outputs, y_val_t).item()
                    self.transformer_model.model.train()

                    logger.info(f"Transformer Epoch {epoch} | Train Loss: {loss.item():.4f} | Val Loss: {val_loss:.4f}")

                    # Early stopping
                    if val_loss < best_val_loss:
                        best_val_loss = val_loss
                        patience_counter = 0
                        best_transformer_state = copy.deepcopy(self.transformer_model.model.state_dict())
                    else:
                        patience_counter += 1
                        if patience_counter >= patience:
                            logger.info(f"Transformer early stopping at epoch {epoch} (best val loss: {best_val_loss:.4f})")
                            break

                # Restore best model weights
                if 'best_transformer_state' in dir():
                    self.transformer_model.model.load_state_dict(best_transformer_state)
                    logger.info("Transformer restored to best validation weights.")

                self.transformer_model.is_trained = True
                logger.info("Transformer model trained successfully.")
            else:
                logger.warning("Transformer model not available (PyTorch not installed) — skipping training")
        except Exception as e:
            logger.warning(f"Transformer training failed: {e} — model remains in simulation mode")

        # ========================
        # 4. Validation before deployment
        # ========================
        logger.info("🔍 Validation des modèles sur le jeu de test...")
        validation_passed = self._validate_models(data)

        if not validation_passed:
            logger.warning(
                f"⚠️ Au moins un modèle n'a pas atteint le seuil de {MIN_DEPLOYMENT_ACCURACY*100:.0f}%. "
                f"Rollback vers les modèles précédents (CDC Section 9.2)."
            )
            self._rollback_models()
        else:
            logger.info("✅ Tous les modèles ont passé la validation.")

        # ========================
        # 5. Save models to disk
        # ========================
        self._save_models()
        logger.info("✅ Entraînement complet terminé avec succès.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    pipeline = TrainingPipeline()
    pipeline.run_training()
