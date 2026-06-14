import json
import logging
import asyncio
import pandas as pd
from typing import Optional

try:
    from pocketoptionapi_async.client import AsyncPocketOptionClient
    _PO_LIB_AVAILABLE = True
except ImportError:
    _PO_LIB_AVAILABLE = False
    AsyncPocketOptionClient = None

logger = logging.getLogger(__name__)

class PocketOptionScanner:
    """
    Scanner temps réel pour Pocket Option via la bibliothèque pocketoptionapi_async.
    """
    def __init__(self):
        self.client: Optional[AsyncPocketOptionClient] = None
        self.is_demo = True
        self.ssid = None
        self._health_check_task = None

    def get_asset_symbol(self, pair: str) -> str:
        """
        Convertit un nom de paire lisible (ex: 'EUR/USD OTC' ou 'EUR/USD')
        en symbole utilisé par la bibliothèque (ex: 'EURUSD_otc' ou 'EURUSD').
        """
        symbol = pair.replace('/', '')
        if ' OTC' in symbol:
            symbol = symbol.replace(' OTC', '_otc')
        return symbol

    @property
    def is_connected(self) -> bool:
        return self.client.is_connected if self.client else False

    @staticmethod
    def _deep_clean_ssid(raw: str) -> str:
        """
        Nettoyage robuste du SSID — supprime TOUS les caractères invisibles
        et corrections de format courants lors du copier-coller depuis DevTools.
        """
        import re as _re
        cleaned = raw

        # Remove BOM
        cleaned = cleaned.replace('\ufeff', '')
        # Remove zero-width and invisible Unicode characters
        cleaned = _re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u00ad]', '', cleaned)
        # Replace smart/curly quotes with straight quotes
        cleaned = cleaned.replace('\u201c', '"').replace('\u201d', '"')
        cleaned = cleaned.replace('\u2018', "'").replace('\u2019', "'")
        # Replace non-breaking spaces
        cleaned = cleaned.replace('\u00a0', ' ')
        # Remove newlines/tabs inside the frame
        cleaned = _re.sub(r'[\r\n\t]+', '', cleaned)
        cleaned = cleaned.strip()
        # Fix doubled prefix
        if '42["auth",42["auth",' in cleaned:
            cleaned = cleaned.replace('42["auth",42["auth",', '42["auth",')
        if '42["auth", 42["auth",' in cleaned:
            cleaned = cleaned.replace('42["auth", 42["auth",', '42["auth",')
        # Handle DevTools frame number prefix
        m = _re.match(r'^\d+:(42\["auth")', cleaned)
        if m:
            cleaned = _re.sub(r'^\d+:', '', cleaned)
        # Find the actual start if there's extra text before
        auth_idx = cleaned.find('42["auth"')
        if auth_idx > 0:
            cleaned = cleaned[auth_idx:]

        return cleaned

    @staticmethod
    def _prepare_ssid(ssid: str) -> tuple[str, bool]:
        """
        Pré-traite le SSID : nettoie les caractères invisibles et extrait isDemo.
        Retourne le SSID nettoyé et le flag is_demo.
        """
        # Apply deep cleaning first
        ssid = PocketOptionScanner._deep_clean_ssid(ssid)
        is_demo = True

        if ssid.startswith('42["auth",'):
            try:
                json_start = ssid.find("{")
                json_end = ssid.rfind("}") + 1
                if json_start != -1 and json_end > json_start:
                    data = json.loads(ssid[json_start:json_end])
                    if "isDemo" in data:
                        is_demo = (data["isDemo"] == 1)
                    elif "currentUrl" in data:
                        is_demo = "demo-" in data["currentUrl"]
            except Exception as e:
                logger.warning(f"Erreur lors de la détection de is_demo: {e}")

        return ssid, is_demo

    async def connect(self, ssid: str, is_demo: Optional[bool] = None) -> bool:
        """
        Initialise et connecte le client Pocket Option.
        """
        if not _PO_LIB_AVAILABLE:
            logger.error("pocketoptionapi-async library not installed. Cannot connect to Pocket Option.")
            return False

        # Pré-traiter le SSID pour garantir isDemo/currentUrl corrects
        prepared_ssid, detected_is_demo = self._prepare_ssid(ssid)
        if is_demo is None:
            is_demo = detected_is_demo

        # Si déjà connecté avec le même SSID et mode, on ne fait rien
        if self.is_connected and self.ssid == ssid and self.is_demo == is_demo:
            return True

        # Déconnexion propre de l'ancien client si existant
        if self.client:
            await self.disconnect()

        self.ssid = ssid
        self.is_demo = is_demo
        mode_label = "DÉMO" if is_demo else "RÉEL"
        logger.info(f"🔍 TENTATIVE DE CONNEXION POCKET OPTION — Mode: {mode_label}")
        
        try:
            self.client = AsyncPocketOptionClient(
                ssid=prepared_ssid,
                is_demo=is_demo,
                persistent_connection=False,
                auto_reconnect=True
            )
            # Tentative de connexion (timeout géré par la lib)
            success = await self.client.connect()
            
            if success:
                logger.info(f"✅ CONNECTÉ AU MARCHÉ POCKET OPTION — Mode: {mode_label}")
                # Start health check loop
                if self._health_check_task is None or self._health_check_task.done():
                    self._health_check_task = asyncio.create_task(self._health_check_loop())
                return True
            else:
                logger.error(f"❌ ÉCHEC DE L'AUTHENTIFICATION POCKET OPTION — Mode: {mode_label} (SSID potentiellement expiré)")
                self.client = None
                return False
        except Exception as e:
            logger.error(f"❌ ERREUR LORS DE LA CONNEXION ({mode_label}): {e}")
            self.client = None
            return False

    async def disconnect(self):
        """
        Déconnecte proprement le client.
        """
        if self._health_check_task and not self._health_check_task.done():
            self._health_check_task.cancel()
            self._health_check_task = None
            
        if self.client:
            try:
                await self.client.disconnect()
            except Exception as e:
                logger.error(f"Erreur lors de la déconnexion: {e}")
            finally:
                self.client = None
                logger.info("🔌 SCANNER POCKET OPTION DÉCONNECTÉ")

    async def get_candles(self, pair: str, timeframe: str = "1m", count: int = 100) -> pd.DataFrame:
        """
        Récupère les bougies OHLCV réelles du marché.
        """
        if not self.is_connected:
            return pd.DataFrame()
            
        asset = self.get_asset_symbol(pair)
        try:
            # Utilisation de la méthode native de la lib qui retourne un DataFrame
            # On passe le nombre de bougies souhaitées
            df = await self.client.get_candles_dataframe(asset, timeframe, count)
            return df
        except Exception as e:
            logger.error(f"Erreur lors de la récupération des bougies ({pair}): {e}")
            return pd.DataFrame()

    async def get_current_price(self, pair: str) -> Optional[float]:
        """
        Récupère le dernier prix de clôture.
        """
        df = await self.get_candles(pair, count=1)
        if not df.empty:
            return float(df['close'].iloc[-1])
        return None

    def get_payout(self, pair: str) -> Optional[float]:
        """
        Récupère le payout actuel pour une paire.
        """
        if not self.is_connected:
            return None
        asset = self.get_asset_symbol(pair)
        try:
            return self.client.get_payout(asset)
        except Exception as e:
            logger.error(f"Erreur lors de la récupération du payout ({pair}): {e}")
            return None

    async def _health_check_loop(self):
        """Periodic health check to verify the connection is still alive."""
        while True:
            try:
                await asyncio.sleep(60)  # Check every 60 seconds
                if self.client:
                    is_still_connected = self.client.is_connected
                    if not is_still_connected:
                        logger.warning("[SCANNER] Health check: connection lost")
                    else:
                        logger.debug("[SCANNER] Health check: connection OK")
                else:
                    logger.warning("[SCANNER] Health check: client is None")
                    break
            except asyncio.CancelledError:
                logger.info("[SCANNER] Health check loop cancelled")
                break
            except Exception as e:
                logger.error(f"[SCANNER] Health check error: {e}")
