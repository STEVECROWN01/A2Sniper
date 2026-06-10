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

    def train(self, X_train, y_train):
        """Entraînement natif XGBoost."""
        if not XGB_AVAILABLE: return
        
        dtrain = xgb.DMatrix(X_train, label=y_train)
        self.model = xgb.train(self.params, dtrain, num_boost_round=500)
        self.is_trained = True
        logger.info("XGBoostModel entraîné avec succès.")

    def predict(self, features_dict: dict) -> dict:
        """Prédiction tabulaire basée sur 47 features."""
        # Use trained model if available
        if self.is_trained and self.model is not None and XGB_AVAILABLE:
            try:
                import numpy as np
                # Build feature vector from dict, filling missing with 0
                feature_vector = np.zeros(self.n_features)
                for i, key in enumerate(sorted(features_dict.keys())):
                    if i < self.n_features:
                        val = features_dict[key]
                        feature_vector[i] = float(val) if val is not None else 0.0
                
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
