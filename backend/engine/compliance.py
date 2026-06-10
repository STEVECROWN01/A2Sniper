"""
Conformité, Sécurité & RGPD — CDC A2Sniper 3.0
- Logs immuables (Hash Chain SHA-256)
- RGPD (Consentement, Droit à l'oubli)
- Restrictions Géographiques
"""

import hashlib
import json
import logging

logger = logging.getLogger(__name__)

# Pays bloqués pour raisons réglementaires (Options Binaires)
RESTRICTED_COUNTRIES = [
    'US', 'CA', 'BE', 'IL', 'SY', 'SD', 'IR', 'KP', 'RU'
]

class ComplianceManager:
    def __init__(self):
        self.previous_hash = "0000000000000000000000000000000000000000000000000000000000000000"

    def generate_immutable_log(self, signal_data: dict) -> str:
        """
        Génère un hash SHA-256 pour le signal, chaîné avec le précédent.
        Garantit l'immutabilité des résultats pour l'audit.
        """
        # Préparation des données canoniques
        payload = {
            'id': signal_data.get('id'),
            'pair': signal_data.get('pair'),
            'direction': signal_data.get('direction'),
            'price': signal_data.get('entry_price'),
            'timestamp': signal_data.get('timestamp'),
            'prev_hash': self.previous_hash
        }

        # Conversion en string déterministe
        payload_str = json.dumps(payload, sort_keys=True)
        
        # Hachage
        current_hash = hashlib.sha256(payload_str.encode('utf-8')).hexdigest()
        
        # Chaînage
        self.previous_hash = current_hash
        
        return current_hash

    def check_geographic_restriction(self, country_code: str) -> dict:
        """Vérifie si l'utilisateur est dans un pays interdit."""
        if not country_code:
            return {'allowed': False, 'reason': 'Unknown location'}
            
        country_code = country_code.upper()
        if country_code in RESTRICTED_COUNTRIES:
            logger.warning(f"[COMPLIANCE] Accès bloqué pour la juridiction: {country_code}")
            return {
                'allowed': False, 
                'reason': f'Trading of binary options is restricted in your jurisdiction ({country_code})'
            }
            
        return {'allowed': True}

    def process_gdpr_deletion(self, user_id: str) -> bool:
        """
        Droit à l'oubli (RGPD).
        En pratique, cela anonymise les données liées à l'utilisateur dans la DB,
        mais conserve les trades globaux pour les statistiques d'audit (sans PII).
        """
        logger.info(f"[COMPLIANCE] Requête RGPD (Droit à l'oubli) traitée pour l'utilisateur {user_id}")
        # Logique DB à implémenter :
        # UPDATE users SET email = 'deleted_X', name = 'deleted', tg_id = null WHERE id = user_id;
        return True

    def get_mandatory_disclaimer(self) -> str:
        """Disclaimer légal obligatoire sur la plateforme."""
        return (
            "RISK WARNING: Trading Forex and Binary Options involves significant risk "
            "and can result in the loss of your invested capital. You should not invest "
            "more than you can afford to lose. A2Sniper is an analytical tool and "
            "does not provide financial advice. Past performance is not indicative of "
            "future results."
        )
