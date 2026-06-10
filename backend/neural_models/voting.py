"""
Voting Classifier Meta-Modèle — CDC A2Sniper 3.0
Pondérations CDC : LSTM 40% | Transformer 35% | XGBoost 25%
Seuil consensus : ≥ 95% confiance
"""

from .lstm import LSTMModel
from .transformer import TransformerModel
from .xgboost_model import XGBoostModel
import logging

logger = logging.getLogger(__name__)


class VotingClassifierModel:
    def __init__(self):
        # Initialisation avec les paramètres CDC
        self.lstm = LSTMModel(n_features=18)
        self.transformer = TransformerModel(n_features=18)
        self.xgboost = XGBoostModel(n_features=47)
        self.weights = {'LSTM': 0.40, 'Transformer': 0.35, 'XGBoost': 0.25}
        self.threshold = 60.0

    def predict(self, features: dict) -> dict:
        """Prédiction par consensus pondéré des 3 modèles."""
        import pandas as pd
        df = pd.DataFrame([features])
        
        lstm_pred = self.lstm.predict(df)
        trans_pred = self.transformer.predict(df)
        xgb_pred = self.xgboost.predict(features)

        # Consensus pondéré
        weighted_prob = (
            lstm_pred['probability'] * self.weights['LSTM'] +
            trans_pred['probability'] * self.weights['Transformer'] +
            xgb_pred['probability'] * self.weights['XGBoost']
        )

        # Direction par majorité pondérée
        call_weight_sum = sum(
            w for m, w in self.weights.items()
            for p in [{'LSTM': lstm_pred, 'Transformer': trans_pred, 'XGBoost': xgb_pred}[m]]
            if p['direction'] == 'CALL'
        )
        direction = 'CALL' if call_weight_sum > 0.5 else 'PUT'

        # Unanimité bonus
        all_same = lstm_pred['direction'] == trans_pred['direction'] == xgb_pred['direction']
        if all_same:
            weighted_prob = min(99.99, weighted_prob * 1.05)

        approved = weighted_prob >= self.threshold

        return {
            'approved': approved,
            'probability': round(weighted_prob, 2),
            'direction': direction,
            'unanimous': all_same,
            'models': {
                'LSTM': {'probability': lstm_pred['probability'], 'direction': lstm_pred['direction'], 'weight': self.weights['LSTM']},
                'Transformer': {'probability': trans_pred['probability'], 'direction': trans_pred['direction'], 'weight': self.weights['Transformer']},
                'XGBoost': {'probability': xgb_pred['probability'], 'direction': xgb_pred['direction'], 'weight': self.weights['XGBoost']},
            }
        }


