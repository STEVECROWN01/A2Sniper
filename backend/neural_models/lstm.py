"""
LSTM (Long Short-Term Memory) — Modèle Séquentiel Temporel
Poids dans le Voting Classifier : 40%
"""

import numpy as np
import logging

logger = logging.getLogger(__name__)

# Activation PyTorch pour Phase 6
try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    PYTORCH_AVAILABLE = True
except ImportError:
    PYTORCH_AVAILABLE = False
    logger.warning("PyTorch non disponible. Le modèle LSTM fonctionnera en mode simulation.")


if PYTORCH_AVAILABLE:
    class LSTMNetwork(nn.Module):
        def __init__(self, n_features, hidden_size, num_layers=3):
            super().__init__()
            self.lstm = nn.LSTM(
                input_size=n_features,
                hidden_size=hidden_size,
                num_layers=num_layers,
                batch_first=True,
                bidirectional=True,
                dropout=0.3
            )
            self.fc1 = nn.Linear(hidden_size * 2, 64)
            self.relu = nn.ReLU()
            self.dropout = nn.Dropout(0.2)
            self.fc2 = nn.Linear(64, 3) # CALL, PUT, NO_TRADE
            self.softmax = nn.Softmax(dim=1)
        
        def forward(self, x):
            lstm_out, _ = self.lstm(x)
            last_hidden = lstm_out[:, -1, :]
            x = self.relu(self.fc1(last_hidden))
            x = self.dropout(x)
            x = self.softmax(self.fc2(x))
            return x
else:
    class LSTMNetwork:
        pass


class LSTMModel:
    def __init__(self, sequence_length: int = 60, n_features: int = 18, hidden_size: int = 128):
        self.sequence_length = sequence_length
        self.n_features = n_features
        self.hidden_size = hidden_size
        self.is_trained = False
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu") if PYTORCH_AVAILABLE else None
        
        if PYTORCH_AVAILABLE:
            self.model = LSTMNetwork(n_features, hidden_size).to(self.device)
            self.optimizer = optim.Adam(self.model.parameters(), lr=0.001)
            self.criterion = nn.CrossEntropyLoss()
        else:
            self.model = None

        logger.info(f"LSTMModel initialisé (seq={sequence_length}, features={n_features}) | Device: {self.device}")

    def train_on_batch(self, X_batch, y_batch):
        """Entraîne le modèle sur un batch de données."""
        if not PYTORCH_AVAILABLE: return
        
        self.model.train()
        X_tensor = torch.FloatTensor(X_batch).to(self.device)
        y_tensor = torch.LongTensor(y_batch).to(self.device)
        
        self.optimizer.zero_grad()
        outputs = self.model(X_tensor)
        loss = self.criterion(outputs, y_tensor)
        loss.backward()
        self.optimizer.step()
        
        self.is_trained = True
        return loss.item()

    def prepare_features(self, df) -> np.ndarray:
        """Prépare les séquences temporelles pour l'entrée du LSTM."""
        # Sélection des colonnes CDC
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
        """Prédiction avec le modèle PyTorch (si disponible) ou simulation."""
        features = self.prepare_features(df)
        
        if PYTORCH_AVAILABLE and self.is_trained:
            self.model.eval()
            with torch.no_grad():
                tensor = torch.FloatTensor(features).to(self.device)
                outputs = self.model(tensor)
                probs = outputs.cpu().numpy()[0]
                
            labels = ["CALL", "PUT", "NO_TRADE"]
            idx = np.argmax(probs)
            return {
                "direction": labels[idx],
                "probability": round(float(probs[idx]) * 100, 2),
                "probabilities": {labels[i]: round(float(probs[i]), 4) for i in range(3)}
            }
            
        # Fallback simulation intelligente si non entraîné
        return self._simulate_predict(df)

    def _simulate_predict(self, df) -> dict:
        """Simulation basée sur le momentum et le RSI."""
        last_close = df['close'].iloc[-1]
        prev_close = df['close'].iloc[-5] if len(df) >= 5 else df['close'].iloc[0]
        rsi = df['RSI_14'].iloc[-1] if 'RSI_14' in df.columns else 50
        
        momentum = (last_close - prev_close) / prev_close
        
        call_prob = 0.33 + momentum * 10 + (0.01 * (50 - rsi))
        put_prob = 0.33 - momentum * 10 - (0.01 * (50 - rsi))
        
        total = call_prob + put_prob + 0.34
        probs = {
            "CALL": round(max(0.05, call_prob / total), 4),
            "PUT": round(max(0.05, put_prob / total), 4),
            "NO_TRADE": 0
        }
        probs["NO_TRADE"] = round(1.0 - probs["CALL"] - probs["PUT"], 4)
        
        direction = max(probs, key=probs.get)
        return {
            "direction": direction,
            "probability": round(probs[direction] * 100, 2),
            "probabilities": probs
        }
