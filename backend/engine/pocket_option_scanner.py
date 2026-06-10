import json
import logging
import pandas as pd
from typing import Optional
from pocketoptionapi_async.client import AsyncPocketOptionClient

logger = logging.getLogger(__name__)

class PocketOptionScanner:
    """
    Scanner temps réel pour Pocket Option via la bibliothèque pocketoptionapi_async.
    """
    def __init__(self):
        self.client: Optional[AsyncPocketOptionClient] = None
        self.is_demo = True
        self.ssid = None
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
    def _prepare_ssid(ssid: str) -> tuple[str, bool]:
        """
        Pré-traite le SSID pour extraire isDemo.
        Retourne le SSID brut non modifié pour préserver l'authenticité de la trame.
        """
        ssid = ssid.strip()
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
        return self.client.get_payout(asset)
