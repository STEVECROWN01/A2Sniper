"""
Voting Classifier Meta-Modèle — CDC A2Sniper 3.0
Pondérations CDC : LSTM 40% | Transformer 35% | XGBoost 25%
Seuil consensus : ≥ 85% confiance
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
        self.threshold = 85.0
        self.simulation_mode = True  # True if all sub-models are in simulation mode

    def predict(self, features: dict) -> dict:
        """Prédiction par consensus pondéré des 3 modèles."""
        import pandas as pd
        df = pd.DataFrame([features])

        lstm_pred = self.lstm.predict(df)
        trans_pred = self.transformer.predict(df)
        xgb_pred = self.xgboost.predict(features)

        # Check if all sub-models are in simulation mode
        all_simulation = all([
            lstm_pred.get('simulation_mode', not self.lstm.is_trained),
            trans_pred.get('simulation_mode', not self.transformer.is_trained),
            xgb_pred.get('simulation_mode', not self.xgboost.is_trained),
        ])
        self.simulation_mode = all_simulation

        # Consensus pondéré
        weighted_prob = (
            lstm_pred['probability'] * self.weights['LSTM'] +
            trans_pred['probability'] * self.weights['Transformer'] +
            xgb_pred['probability'] * self.weights['XGBoost']
        )

        # Direction par majorité pondérée — avec support NO_TRADE
        predictions_map = {
            'LSTM': lstm_pred,
            'Transformer': trans_pred,
            'XGBoost': xgb_pred,
        }

        # Calculer la somme des poids pour chaque direction
        direction_weights = {'CALL': 0.0, 'PUT': 0.0, 'NO_TRADE': 0.0}
        for model_name, weight in self.weights.items():
            d = predictions_map[model_name]['direction']
            if d in direction_weights:
                direction_weights[d] += weight

        call_w = direction_weights['CALL']
        put_w = direction_weights['PUT']
        no_trade_w = direction_weights['NO_TRADE']

        # Règle 1 : Si la majorité des poids est NO_TRADE → NO_TRADE
        if no_trade_w > 0.5:
            direction = 'NO_TRADE'
        # Règle 2 : Si aucun CALL ou PUT n'atteint la majorité (> 0.5) → NO_TRADE
        # (ex: CALL=0.40, PUT=0.35, NO_TRADE=0.25 → pas de majorité claire)
        elif call_w > 0.5:
            direction = 'CALL'
        elif put_w > 0.5:
            direction = 'PUT'
        else:
            # Pas de majorité claire pour CALL ou PUT → NO_TRADE
            direction = 'NO_TRADE'

        # Check unanimity (no artificial bonus — honesty matters)
        all_same = lstm_pred['direction'] == trans_pred['direction'] == xgb_pred['direction']

        # NO_TRADE signifie qu'il ne faut pas trader → jamais approuvé
        approved = (direction != 'NO_TRADE') and (weighted_prob >= self.threshold)

        result = {
            'approved': approved,
            'probability': round(weighted_prob, 2),
            'direction': direction,
            'unanimous': all_same,
            'simulation_mode': self.simulation_mode,
            'models': {
                'LSTM': {'probability': lstm_pred['probability'], 'direction': lstm_pred['direction'], 'weight': self.weights['LSTM']},
                'Transformer': {'probability': trans_pred['probability'], 'direction': trans_pred['direction'], 'weight': self.weights['Transformer']},
                'XGBoost': {'probability': xgb_pred['probability'], 'direction': xgb_pred['direction'], 'weight': self.weights['XGBoost']},
            }
        }

        if direction == 'NO_TRADE':
            logger.info(
                f"[VOTING] NO_TRADE emitted — direction_weights: "
                f"CALL={call_w:.2f}, PUT={put_w:.2f}, NO_TRADE={no_trade_w:.2f}"
            )

        if self.simulation_mode:
            logger.info("[VOTING] All models in simulation mode — predictions are heuristic-based, not ML-based")

        return result


