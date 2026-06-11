try:
    pass
except ImportError:
    pass

import pandas as pd
import numpy as np
import os
import json
import logging
import copy
from sklearn.preprocessing import StandardScaler

# Importation des modèles réels
from .lstm import LSTMModel
from .transformer import TransformerModel
from .xgboost_model import XGBoostModel

logger = logging.getLogger(__name__)

# Directory for model weights
WEIGHTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'weights')

# Minimum accuracy threshold for deployment (CDC Section 9.2)
MIN_DEPLOYMENT_ACCURACY = 0.80


class TrainingPipeline:
    def __init__(self, data_path='backend/data/eurusd_otc_30d.csv'):
        self.data_path = data_path
        self.scaler = StandardScaler()
        self.weights_dir = WEIGHTS_DIR

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
        """Charge et prépare les données pour l'entraînement.
        Uses time-series split: 80% train / 10% validation / 10% test.
        """
        if not os.path.exists(self.data_path):
            logger.error(f"Fichier de données {self.data_path} introuvable.")
            return None

        df = pd.read_csv(self.data_path)

        # Feature Engineering basique pour l'entraînement
        df['returns'] = df['close'].pct_change()
        df['target'] = (df['close'].shift(-5) > df['close']).astype(int)  # Direction à 5min

        # Extended features for LSTM/Transformer (18 features)
        if 'high' in df.columns and 'low' in df.columns:
            df['hl_spread'] = df['high'] - df['low']
            df['oc_spread'] = df['close'] - df['open']
            df['hl_ratio'] = df['high'] / (df['low'] + 1e-10)

        # Rolling statistics
        for col in ['close', 'volume']:
            if col in df.columns:
                df[f'{col}_rolling_mean_10'] = df[col].rolling(10, min_periods=1).mean()
                df[f'{col}_rolling_std_10'] = df[col].rolling(10, min_periods=1).std().fillna(0)

        # Momentum features
        if 'close' in df.columns:
            for period in [5, 10, 20]:
                df[f'momentum_{period}'] = df['close'] - df['close'].shift(period)

        # RSI-like feature
        if 'close' in df.columns:
            delta = df['close'].diff()
            gain = delta.where(delta > 0, 0).rolling(14, min_periods=1).mean()
            loss = (-delta.where(delta < 0, 0)).rolling(14, min_periods=1).mean()
            rs = gain / (loss + 1e-10)
            df['rsi'] = 100 - (100 / (1 + rs))

        # Volatility
        if 'returns' in df.columns:
            df['volatility_10'] = df['returns'].rolling(10, min_periods=1).std().fillna(0)
            df['volatility_20'] = df['returns'].rolling(20, min_periods=1).std().fillna(0)

        df.dropna(inplace=True)

        # XGBoost features (47 features) — use all available columns
        xgb_features = [c for c in df.columns if c not in ['target']]
        # LSTM/Transformer features (18 features)
        lstm_features = [
            'open', 'high', 'low', 'close', 'volume', 'returns',
            'hl_spread', 'oc_spread', 'hl_ratio',
            'close_rolling_mean_10', 'close_rolling_std_10',
            'momentum_5', 'momentum_10', 'momentum_20',
            'rsi', 'volatility_10', 'volatility_20',
            'volume_rolling_mean_10'
        ]
        # Only use features that exist in the dataframe
        lstm_features = [c for c in lstm_features if c in df.columns]

        # Prepare XGBoost data
        X_xgb = df[xgb_features]
        # Prepare LSTM/Transformer data
        X_lstm = df[lstm_features]
        y = df['target']

        # Pad XGBoost features to exactly 47 columns if needed
        if X_xgb.shape[1] < 47:
            for i in range(47 - X_xgb.shape[1]):
                X_xgb[f'_pad_{i}'] = 0.0
        elif X_xgb.shape[1] > 47:
            X_xgb = X_xgb.iloc[:, :47]

        # Pad LSTM features to exactly 18 columns if needed
        if X_lstm.shape[1] < 18:
            for i in range(18 - X_lstm.shape[1]):
                X_lstm[f'_pad_{i}'] = 0.0
        elif X_lstm.shape[1] > 18:
            X_lstm = X_lstm.iloc[:, :18]

        # Scale
        X_xgb_scaled = self.scaler.fit_transform(X_xgb)
        lstm_scaler = StandardScaler()
        X_lstm_scaled = lstm_scaler.fit_transform(X_lstm)

        # Time-series split: 80% train / 10% validation / 10% test (no shuffle)
        n = len(y)
        train_end = int(n * 0.8)
        val_end = int(n * 0.9)

        X_xgb_train = X_xgb_scaled[:train_end]
        X_xgb_val = X_xgb_scaled[train_end:val_end]
        X_xgb_test = X_xgb_scaled[val_end:]

        X_lstm_train = X_lstm_scaled[:train_end]
        X_lstm_val = X_lstm_scaled[train_end:val_end]
        X_lstm_test = X_lstm_scaled[val_end:]

        y_train = y.iloc[:train_end]
        y_val = y.iloc[train_end:val_end]
        y_test = y.iloc[val_end:]

        return {
            'X_xgb_train': X_xgb_train, 'X_xgb_val': X_xgb_val, 'X_xgb_test': X_xgb_test,
            'X_lstm_train': X_lstm_train, 'X_lstm_val': X_lstm_val, 'X_lstm_test': X_lstm_test,
            'y_train': y_train, 'y_val': y_val, 'y_test': y_test,
            'xgb_features': xgb_features[:47],
            'lstm_features': lstm_features[:18],
        }

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
                y_test_seq = y_test.values[:n_samples:seq_len][:len(X_test_reshaped)]

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
                y_test_seq = y_test.values[:n_samples:seq_len][:len(X_test_reshaped)]

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
            y_lstm_batch = y_train.values[:n_samples:seq_len][:len(X_lstm_reshaped)]

            # Validation data for early stopping
            n_val_samples = (len(X_lstm_val) // seq_len) * seq_len
            best_val_loss = float('inf')
            patience = 5
            patience_counter = 0
            max_epochs = 50

            try:
                import torch
                X_val_reshaped = X_lstm_val[:n_val_samples].reshape(-1, seq_len, n_lstm_features)
                y_val_batch = y_val.values[:n_val_samples:seq_len][:len(X_val_reshaped)]

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
