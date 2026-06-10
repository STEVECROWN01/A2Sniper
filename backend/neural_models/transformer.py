"""
Transformer Temporel — Modèle à Attention Multi-Têtes
Poids dans le Voting Classifier : 35%
"""

import logging
import math
import numpy as np

logger = logging.getLogger(__name__)

try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    PYTORCH_AVAILABLE = True
except ImportError:
    PYTORCH_AVAILABLE = False
    logger.warning("PyTorch non disponible. Le modèle Transformer fonctionnera en mode simulation.")


if PYTORCH_AVAILABLE:
    class PositionalEncoding(nn.Module):
        def __init__(self, d_model, max_len=5000):
            super().__init__()
            pe = torch.zeros(max_len, d_model)
            position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
            div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
            pe[:, 0::2] = torch.sin(position * div_term)
            pe[:, 1::2] = torch.cos(position * div_term)
            pe = pe.unsqueeze(0)
            self.register_buffer('pe', pe)

        def forward(self, x):
            return x + self.pe[:, :x.size(1), :]
else:
    class PositionalEncoding:
        pass


if PYTORCH_AVAILABLE:
    class TransformerNetwork(nn.Module):
        def __init__(self, n_features, d_model=64, nhead=8, num_layers=4, dim_feedforward=256):
            super().__init__()
            self.embedding = nn.Linear(n_features, d_model)
            self.pos_encoder = PositionalEncoding(d_model)
            encoder_layers = nn.TransformerEncoderLayer(d_model, nhead, dim_feedforward, dropout=0.2, batch_first=True)
            self.transformer_encoder = nn.TransformerEncoder(encoder_layers, num_layers)
            self.fc = nn.Linear(d_model, 3)
            self.softmax = nn.Softmax(dim=1)
            self.d_model = d_model

        def forward(self, x):
            x = self.embedding(x) * math.sqrt(self.d_model)
            x = self.pos_encoder(x)
            output = self.transformer_encoder(x)
            # On prend la moyenne des sorties temporelles pour la classification
            output = output.mean(dim=1)
            return self.softmax(self.fc(output))
else:
    class TransformerNetwork:
        pass


class TransformerModel:
    def __init__(self, n_features: int = 18):
        self.n_features = n_features
        self.sequence_length = 60
        self.is_trained = False
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu") if PYTORCH_AVAILABLE else None
        
        if PYTORCH_AVAILABLE:
            self.model = TransformerNetwork(n_features).to(self.device)
            self.optimizer = optim.Adam(self.model.parameters(), lr=0.0005)
            self.criterion = nn.CrossEntropyLoss()
        else:
            self.model = None

        logger.info(f"TransformerModel initialisé | Device: {self.device}")

    def prepare_features(self, df) -> np.ndarray:
        """Prépare les séquences temporelles pour l'entrée du Transformer."""
        feature_cols = [
            'open', 'high', 'low', 'close', 'volume',
            'RSI_14', 'MACD_12_26_9', 'MACDh_12_26_9', 'MACDs_12_26_9',
            'ATRr_14', 'BBL_20_2.0', 'BBM_20_2.0', 'BBU_20_2.0',
            'EMA_50', 'EMA_200'
        ]
        
        # S'assurer que les colonnes existent
        cols = [c for c in feature_cols if c in df.columns]
        data = df[cols].fillna(0).values
        
        # Normalisation locale (Z-score)
        mean = data.mean(axis=0)
        std = data.std(axis=0) + 1e-8
        data_norm = (data - mean) / std
        
        if len(data_norm) < self.sequence_length:
            pad = np.zeros((self.sequence_length - len(data_norm), data_norm.shape[1]))
            data_norm = np.vstack([pad, data_norm])
            
        seq = data_norm[-self.sequence_length:]
        return seq.reshape(1, self.sequence_length, -1).astype(np.float32)

    def predict(self, df) -> dict:
        """Prédiction avec le modèle PyTorch (si disponible et entraîné) ou simulation."""
        if PYTORCH_AVAILABLE and self.is_trained:
            try:
                features = self.prepare_features(df)
                self.model.eval()
                with torch.no_grad():
                    tensor = torch.FloatTensor(features).to(self.device)
                    outputs = self.model(tensor)
                    probs = outputs.cpu().numpy()[0]
                    
                labels = ["CALL", "PUT", "NO_TRADE"]
                idx = int(np.argmax(probs))
                return {
                    "direction": labels[idx],
                    "probability": round(float(probs[idx]) * 100, 2),
                    "probabilities": {labels[i]: round(float(probs[i]), 4) for i in range(3)}
                }
            except Exception as e:
                logger.warning(f"Transformer prediction failed, falling back to simulation: {e}")
        
        # Fallback: simulation mode (NOT trained or PyTorch unavailable)
        return self._simulate_predict(df)
    
    def _simulate_predict(self, df) -> dict:
        """Simulation basée sur ADX et Stochastique. MODE SIMULATION — modèle non entraîné."""
        adx = df['ADX_14'].iloc[-1] if 'ADX_14' in df.columns else 25
        stoch_k = df['STOCH_K'].iloc[-1] if 'STOCH_K' in df.columns else 50
        
        # Heuristic-based simulation
        if stoch_k < 30 and adx > 20:
            direction = "CALL"
            call_prob = 0.40 + (adx / 500)
            put_prob = 0.30
        elif stoch_k > 70 and adx > 20:
            direction = "PUT"
            call_prob = 0.30
            put_prob = 0.40 + (adx / 500)
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
