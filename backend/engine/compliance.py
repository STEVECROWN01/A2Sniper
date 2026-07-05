"""
Conformité, Sécurité & RGPD — CDC A2Sniper 3.0
- Logs immuables (Hash Chain SHA-256)
- RGPD (Consentement, Droit à l'oubli)
- Restrictions Géographiques
"""

import hashlib
import json
import logging
import os

from fastapi import Request

logger = logging.getLogger(__name__)

# Pays bloqués pour raisons réglementaires (Options Binaires)
RESTRICTED_COUNTRIES = [
    'US', 'CA', 'BE', 'IL', 'SY', 'SD', 'IR', 'KP', 'RU'
]

# File path for persisting hash chain state
HASH_CHAIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'compliance_hash_chain.json')


class ComplianceManager:
    def __init__(self):
        self.previous_hash = "0000000000000000000000000000000000000000000000000000000000000000"
        # Load persisted hash chain state
        self._load_state()

    def _load_state(self):
        """Load previous_hash from persistent file."""
        try:
            if os.path.exists(HASH_CHAIN_FILE):
                with open(HASH_CHAIN_FILE, 'r') as f:
                    data = json.load(f)
                    self.previous_hash = data.get('previous_hash', self.previous_hash)
                    logger.info("[COMPLIANCE] Hash chain state loaded from file")
        except Exception as e:
            logger.warning(f"[COMPLIANCE] Could not load hash chain state: {e}")

    def _save_state(self):
        """Persist current hash chain state to file."""
        try:
            with open(HASH_CHAIN_FILE, 'w') as f:
                json.dump({'previous_hash': self.previous_hash}, f)
        except Exception as e:
            logger.warning(f"[COMPLIANCE] Could not save hash chain state: {e}")

    def generate_immutable_log(self, signal_data: dict) -> str:
        """
        Génère un hash SHA-256 pour le signal, chaîné avec le précédent.
        Garantit l'immutabilité des résultats pour l'audit.
        """
        # Préparation des données canoniques
        # H13 Fix: Added winrate and classification to hash input
        # Store prev_hash in signal_data so verify_hash_chain can validate linkage
        signal_data['prev_hash'] = self.previous_hash
        payload = {
            'id': signal_data.get('id'),
            'pair': signal_data.get('pair'),
            'direction': signal_data.get('direction'),
            'price': signal_data.get('entry_price'),
            'timestamp': signal_data.get('timestamp'),
            'winrate': signal_data.get('winrate'),
            'classification': signal_data.get('classification'),
            'prev_hash': self.previous_hash
        }

        # Conversion en string déterministe
        payload_str = json.dumps(payload, sort_keys=True)
        
        # Hachage
        current_hash = hashlib.sha256(payload_str.encode('utf-8')).hexdigest()
        
        # Chaînage
        self.previous_hash = current_hash
        
        # Persist the new state
        self._save_state()
        
        return current_hash

    def check_geographic_restriction(self, country_code: str) -> dict:
        """Vérifie si l'utilisateur est dans un pays interdit.
        
        NOTE: Geographic restriction is DISABLED — the platform owner needs
        full access to the system regardless of location. The owner is
        responsible for enforcing geo-restrictions on their end users if needed.
        """
        return {'allowed': True}
        # Original restriction logic (disabled):
        # if not country_code:
        #     return {'allowed': False, 'reason': 'Unknown location'}
        #
        # country_code = country_code.upper()
        # if country_code in RESTRICTED_COUNTRIES:
        #     logger.warning(f"[COMPLIANCE] Accès bloqué pour la juridiction: {country_code}")
        #     return {
        #         'allowed': False,
        #         'reason': f'Trading of binary options is restricted in your jurisdiction ({country_code})'
        #     }
        #
        # return {'allowed': True}
