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
        
        # Persist the new state
        self._save_state()
        
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

    async def process_gdpr_deletion(self, user_id: str, session=None) -> bool:
        """
        Droit à l'oubli (RGPD).
        Anonymizes user data in the database, preserving trade statistics for audit.
        """
        logger.info(f"[COMPLIANCE] Requête RGPD (Droit à l'oubli) traitée pour l'utilisateur {user_id}")
        
        if session is None:
            logger.warning("[COMPLIANCE] No DB session provided for GDPR deletion")
            return False
            
        try:
            from db import User, UserSubscription, PasswordResetOTP
            from sqlalchemy import delete, update
            
            # Delete password reset OTPs
            await session.execute(delete(PasswordResetOTP).where(PasswordResetOTP.email.in_(
                __import__('sqlalchemy').select(User.email).where(User.id == user_id)
            )))
            
            # Delete subscription
            await session.execute(delete(UserSubscription).where(UserSubscription.user_id == user_id))
            
            # Anonymize user record (preserve for audit but remove PII)
            await session.execute(
                update(User)
                .where(User.id == user_id)
                .values(
                    email=f"deleted_{user_id[:8]}@gdpr-deleted.a2sniper",
                    hashed_password="GDPR_DELETED",
                    full_name="Deleted User (GDPR)",
                    is_active=False
                )
            )
            
            await session.commit()
            logger.info(f"[COMPLIANCE] GDPR deletion completed for user {user_id}")
            return True
        except Exception as e:
            logger.error(f"[COMPLIANCE] GDPR deletion failed for user {user_id}: {e}")
            return False

    def get_mandatory_disclaimer(self) -> str:
        """Disclaimer légal obligatoire sur la plateforme."""
        return (
            "RISK WARNING: Trading Forex and Binary Options involves significant risk "
            "and can result in the loss of your invested capital. You should not invest "
            "more than you can afford to lose. A2Sniper is an analytical tool and "
            "does not provide financial advice. Past performance is not indicative of "
            "future results."
        )
