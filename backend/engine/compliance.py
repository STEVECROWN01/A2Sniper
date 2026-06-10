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

    def verify_hash_chain(self, signal_chain: list) -> bool:
        """
        Verify the integrity of a hash chain by recomputing each signal's hash
        and comparing it against the stored hash.
        
        Args:
            signal_chain: List of signal dicts, each containing at minimum:
                - id, pair, direction, entry_price (or price), timestamp,
                  winrate, classification, hash_signature, prev_hash
        
        Returns:
            True only if the entire chain is valid (all hashes match).
            False if any hash doesn't match or chain is empty.
        """
        if not signal_chain:
            logger.warning("[COMPLIANCE] verify_hash_chain called with empty chain")
            return False
        
        expected_prev_hash = "0000000000000000000000000000000000000000000000000000000000000000"
        
        for i, signal in enumerate(signal_chain):
            stored_hash = signal.get('hash_signature')
            if not stored_hash:
                logger.warning(f"[COMPLIANCE] Signal {signal.get('id', i)} missing hash_signature — chain invalid")
                return False
            
            # Recompute the hash from the signal data
            payload = {
                'id': signal.get('id'),
                'pair': signal.get('pair'),
                'direction': signal.get('direction'),
                'price': signal.get('entry_price') or signal.get('price'),
                'timestamp': signal.get('timestamp'),
                'winrate': signal.get('winrate'),
                'classification': signal.get('classification'),
                'prev_hash': signal.get('prev_hash', expected_prev_hash)
            }
            
            payload_str = json.dumps(payload, sort_keys=True)
            computed_hash = hashlib.sha256(payload_str.encode('utf-8')).hexdigest()
            
            if computed_hash != stored_hash:
                logger.warning(
                    f"[COMPLIANCE] Hash mismatch at signal {signal.get('id', i)}: "
                    f"computed={computed_hash}, stored={stored_hash} — chain INVALID"
                )
                return False
            
            # Verify prev_hash linkage
            signal_prev_hash = signal.get('prev_hash')
            if signal_prev_hash and signal_prev_hash != expected_prev_hash:
                logger.warning(
                    f"[COMPLIANCE] prev_hash mismatch at signal {signal.get('id', i)}: "
                    f"expected={expected_prev_hash}, got={signal_prev_hash} — chain INVALID"
                )
                return False
            
            # Next signal's expected prev_hash should be this signal's hash
            expected_prev_hash = stored_hash
        
        logger.info(f"[COMPLIANCE] Hash chain verified: {len(signal_chain)} signals — all valid")
        return True

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
            
            # Delete password reset OTPs — using proper sqlalchemy select import
            from sqlalchemy import select as sa_select
            user_email_subquery = sa_select(User.email).where(User.id == user_id)
            await session.execute(delete(PasswordResetOTP).where(PasswordResetOTP.email.in_(
                user_email_subquery
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


# ---------------------------------------------------------------------------
# FastAPI Dependency for Geographic Restriction Enforcement
# ---------------------------------------------------------------------------
# Usage in main.py:
#   from engine.compliance import geographic_restriction_dependency
#
#   @app.get("/api/signals/request")
#   async def request_signal(
#       ...,
#       geo_check: dict = Depends(geographic_restriction_dependency)
#   ):
#       # geo_check contains {'allowed': True/False, 'reason': '...'}
#       if not geo_check['allowed']:
#           raise HTTPException(status_code=403, detail=geo_check['reason'])
# ---------------------------------------------------------------------------

_compliance_instance = ComplianceManager()


async def _get_country_from_ip(ip_address: str) -> str:
    """
    Resolve an IP address to a country code using an external GeoIP service.
    Returns empty string if lookup fails.
    """
    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Use a free GeoIP API (ip-api.com)
            resp = await client.get(f"http://ip-api.com/json/{ip_address}")
            if resp.status_code == 200:
                data = resp.json()
                return data.get('countryCode', '')
    except Exception as e:
        logger.warning(f"[COMPLIANCE] GeoIP lookup failed for {ip_address}: {e}")
    return ''


async def geographic_restriction_dependency(request) -> dict:
    """
    FastAPI dependency that checks geographic restrictions on the requesting IP.
    
    Usage:
        from fastapi import Depends
        from engine.compliance import geographic_restriction_dependency
        
        @app.get("/api/some-endpoint")
        async def some_endpoint(
            ...,
            geo: dict = Depends(geographic_restriction_dependency)
        ):
            if not geo['allowed']:
                raise HTTPException(status_code=403, detail=geo['reason'])
            ...
    """
    # Get client IP from request
    forwarded = request.headers.get('x-forwarded-for', '')
    if forwarded:
        ip_address = forwarded.split(',')[0].strip()
    else:
        ip_address = request.client.host if request.client else ''
    
    # Skip check for local/private IPs
    if not ip_address or ip_address in ('127.0.0.1', '::1', 'localhost'):
        return {'allowed': True, 'reason': 'Local request'}
    
    # Resolve country from IP
    country_code = await _get_country_from_ip(ip_address)
    
    # Check restriction
    return _compliance_instance.check_geographic_restriction(country_code)
