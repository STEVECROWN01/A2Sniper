"""
XGBoost Ensemble Classifier — Modèle Tabulaire
Poids dans le Voting Classifier : 25%
"""

import logging

logger = logging.getLogger(__name__)

try:
    import xgboost as xgb
    XGB_AVAILABLE = True
except ImportError:
    XGB_AVAILABLE = False
    logger.warning("XGBoost non disponible. Le modèle fonctionnera en mode simulation.")


class XGBoostModel:
    def __init__(self, n_features: int = 47):
        self.n_features = n_features
        self.is_trained = False
        self.model = None
        self.feature_names = None  # Stored during training for consistent prediction
        
        if XGB_AVAILABLE:
            self.params = {
                'objective': 'multi:softprob',
                'num_class': 3,
                'max_depth': 6,
                'eta': 0.05,
                'subsample': 0.8,
                'colsample_bytree': 0.8,
                'eval_metric': 'mlogloss'
            }
        
        logger.info(f"XGBoostModel initialisé (47 features CDC)")

    def train(self, X_train, y_train, feature_names=None):
        """Entraînement natif XGBoost."""
        if not XGB_AVAILABLE: return
        
        self.feature_names = feature_names
        # Ensure training data has exactly n_features columns
        import numpy as np
        if X_train.shape[1] < self.n_features:
            pad_width = self.n_features - X_train.shape[1]
            X_train = np.hstack([X_train, np.zeros((X_train.shape[0], pad_width))])
        elif X_train.shape[1] > self.n_features:
            X_train = X_train[:, :self.n_features]
        
        dtrain = xgb.DMatrix(X_train, label=y_train)
        self.model = xgb.train(self.params, dtrain, num_boost_round=500)
        self.is_trained = True
        logger.info(f"XGBoostModel entraîné avec succès ({X_train.shape[1]} features).")

    def _build_feature_vector(self, features_dict: dict) -> 'np.ndarray':
        """Build a feature vector of exactly n_features from a dict.
        Uses stored feature_names for consistent mapping if available,
        otherwise falls back to sorted keys with zero-padding.
        """
        import numpy as np
        feature_vector = np.zeros(self.n_features)
        
        if self.feature_names is not None:
            # Use training feature order for consistent mapping
            for i, name in enumerate(self.feature_names):
                if i >= self.n_features:
                    break
                val = features_dict.get(name, 0)
                feature_vector[i] = float(val) if val is not None else 0.0
        else:
            # Fallback: sorted keys
            for i, key in enumerate(sorted(features_dict.keys())):
                if i >= self.n_features:
                    break
                val = features_dict[key]
                feature_vector[i] = float(val) if val is not None else 0.0
        
        return feature_vector

    def predict(self, features_dict: dict) -> dict:
        """Prédiction tabulaire basée sur 47 features.
        Always produces exactly n_features values, padding missing with zeros.
        """
        # Use trained model if available
        if self.is_trained and self.model is not None and XGB_AVAILABLE:
            try:
                import numpy as np
                feature_vector = self._build_feature_vector(features_dict)
                
                dmatrix = xgb.DMatrix(feature_vector.reshape(1, -1))
                probs = self.model.predict(dmatrix)[0]  # [CALL_prob, PUT_prob, NO_TRADE_prob]
                
                labels = ["CALL", "PUT", "NO_TRADE"]
                idx = int(np.argmax(probs))
                return {
                    "direction": labels[idx],
                    "probability": round(float(probs[idx]) * 100, 2),
                    "probabilities": {labels[i]: round(float(probs[i]), 4) for i in range(len(labels))}
                }
            except Exception as e:
                logger.warning(f"XGBoost prediction failed, falling back to simulation: {e}")
        
        # Fallback: simulation mode (NOT trained)
        return self._simulate_predict(features_dict)
    
    def save(self, path: str) -> bool:
        """Save XGBoost model to disk."""
        if not XGB_AVAILABLE or self.model is None:
            logger.warning("Cannot save XGBoost model: XGBoost unavailable or model not trained")
            return False
        try:
            import os
            import json
            os.makedirs(os.path.dirname(path), exist_ok=True)
            self.model.save_model(path)
            # Save feature names alongside model
            meta_path = path.replace('.json', '_meta.json') if path.endswith('.json') else path + '_meta.json'
            with open(meta_path, 'w') as f:
                json.dump({
                    'n_features': self.n_features,
                    'feature_names': self.feature_names,
                    'is_trained': self.is_trained,
                }, f)
            logger.info(f"XGBoost model saved to {path}")
            return True
        except Exception as e:
            logger.error(f"Failed to save XGBoost model: {e}")
            return False

    def load(self, path: str) -> bool:
        """Load XGBoost model from disk."""
        if not XGB_AVAILABLE:
            logger.warning("Cannot load XGBoost model: XGBoost unavailable")
            return False
        try:
            import os
            import json
            if not os.path.exists(path):
                logger.warning(f"XGBoost model file not found: {path}")
                return False
            self.model = xgb.Booster()
            self.model.load_model(path)
            # Load feature names
            meta_path = path.replace('.json', '_meta.json') if path.endswith('.json') else path + '_meta.json'
            if os.path.exists(meta_path):
                with open(meta_path, 'r') as f:
                    meta = json.load(f)
                self.feature_names = meta.get('feature_names')
                self.is_trained = meta.get('is_trained', True)
            else:
                self.is_trained = True
            logger.info(f"XGBoost model loaded from {path} (trained={self.is_trained})")
            return True
        except Exception as e:
            logger.error(f"Failed to load XGBoost model: {e}")
            return False

    def _simulate_predict(self, features_dict: dict) -> dict:
        """Simulation basée sur des heuristiques simples. MODE SIMULATION — modèle non entraîné."""
        rsi = features_dict.get('rsi', 50)
        momentum = features_dict.get('price_change_1m', 0)
        
        # Simple momentum-based heuristic
        if rsi < 35 and momentum > 0:
            direction = "CALL"
            call_prob = 0.45
            put_prob = 0.30
        elif rsi > 65 and momentum < 0:
            direction = "PUT"
            call_prob = 0.30
            put_prob = 0.45
        else:
            direction = "NO_TRADE"
            call_prob = 0.30
            put_prob = 0.30
        
        no_trade_prob = 1.0 - call_prob - put_prob
        
        return {
            "direction": direction,
            "probability": round(max(call_prob, put_prob, no_trade_prob) * 100, 2),
            "probabilities": {
                "CALL": round(call_prob, 4),
                "PUT": round(put_prob, 4),
                "NO_TRADE": round(no_trade_prob, 4)
            },
            "simulation_mode": True
        }
