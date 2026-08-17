"""
Conformité, Sécurité & RGPD — CDC A2Sniper 3.0
- Logs immuables (Hash Chain SHA-256)
- RGPD (Consentement, Droit à l'oubli)
- Restrictions Géographiques
"""

import asyncio
import hashlib
import json
import logging

from fastapi import Request

logger = logging.getLogger(__name__)

# Pays bloqués pour raisons réglementaires (Options Binaires)
RESTRICTED_COUNTRIES = [
    'US', 'CA', 'BE', 'IL', 'SY', 'SD', 'IR', 'KP', 'RU'
]

# app_state key for the hash chain head
HASH_CHAIN_STATE_KEY = 'compliance_hash_chain'


class ComplianceManager:
    def __init__(self):
        self.previous_hash = "0000000000000000000000000000000000000000000000000000000000000000"
        # _load_state is a no-op at __init__ time (no async loop available).
        # Hydration happens via hydrate_from_db() called from lifespan startup.

    def _load_state(self):
        """Legacy sync load — now a no-op. Use hydrate_from_db() instead.

        Kept for backward compat with any external callers, but the real
        hydration happens in hydrate_from_db() called from the lifespan.
        """
        pass

    async def hydrate_from_db(self):
        """Load previous_hash from the app_state table.

        Called from the lifespan startup. Replaces the old file-based
        _load_state (which read compliance_hash_chain.json — wiped on
        every Railway redeploy).
        """
        try:
            from db import get_app_state
            data = await get_app_state(HASH_CHAIN_STATE_KEY, default=None)
            if data and isinstance(data, dict):
                self.previous_hash = data.get('previous_hash', self.previous_hash)
                logger.info("[COMPLIANCE] Hash chain state hydrated from DB")
        except Exception as e:
            logger.warning(f"[COMPLIANCE] Could not hydrate hash chain state from DB: {e}")

    def _save_state(self):
        """Persist the current hash chain state to the app_state table.

        Sync wrapper — schedules an async DB write via asyncio.create_task
        (fire-and-forget). Safe to call from sync contexts. If no event loop
        is running (e.g., during __init__), the write is skipped — the next
        hydrate_from_db() will pick up the in-memory value.
        """
        try:
            asyncio.create_task(self._async_save_state())
        except RuntimeError:
            # No running event loop — skip (e.g., during __init__).
            # The value lives in memory and will be saved on the next
            # _save_state() call from a real async context.
            pass

    async def _async_save_state(self):
        """Async DB write — the actual persistence layer."""
        try:
            from db import set_app_state
            await set_app_state(HASH_CHAIN_STATE_KEY, {'previous_hash': self.previous_hash})
        except Exception as e:
            logger.warning(f"[COMPLIANCE] Could not save hash chain state to DB: {e}")

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

        # Persist the new state (fire-and-forget async DB write)
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


# ---------------------------------------------------------------------------
# FastAPI Dependency for Geographic Restriction Enforcement
# ---------------------------------------------------------------------------

_compliance_instance = ComplianceManager()


async def _get_country_from_ip(ip_address: str) -> str:
    """Resolve an IP address to a country code using a free GeoIP service."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"http://ip-api.com/json/{ip_address}")
            if resp.status_code == 200:
                data = resp.json()
                return data.get('countryCode', '')
    except Exception as e:
        logger.warning(f"[COMPLIANCE] GeoIP lookup failed for {ip_address}: {e}")
    return ''


async def geographic_restriction_dependency(request: Request) -> dict:
    """
    FastAPI dependency that checks geographic restrictions on the requesting IP.

    NOTE: Geographic restriction is DISABLED — always returns allowed=True.
    The function is kept for API compatibility (main.py imports it as a
    Depends() parameter on signal endpoints).
    """
    return {'allowed': True, 'reason': 'Geographic restriction disabled'}

