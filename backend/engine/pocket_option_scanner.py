"""
Pocket Option Scanner — Direct WebSocket Connection
====================================================
Connects directly to Pocket Option's Socket.IO v4 WebSocket
without relying on the fragile pocketoptionapi_async library.

The SSID (WebSocket auth frame) stays valid as long as the user
doesn't manually disconnect their Pocket Option account — even
across browser/device restarts.

Protocol: Socket.IO v4 (EIO=4&transport=websocket)
  1. TCP/TLS connect to wss://...
  2. Receive "0{sid...}" (Engine.IO open)
  3. Send "40" (Socket.IO CONNECT)
  4. Receive "40{sid...}" (connect ack)
  5. Send "42[\"auth\",{...}]" (SSID auth frame)
  6. Receive "43...[\"successauth\",...]" or "42[\"NotAuthorized\"]"
  7. Keep-alive: respond "3" to "2" pings, send "42[\"ps\"]" periodically
"""

import json
import logging
import re
import ssl
import asyncio
import pandas as pd
from typing import Optional
from datetime import datetime, timezone

try:
    import websockets
    _WS_AVAILABLE = True
except ImportError:
    _WS_AVAILABLE = False

# websockets v16+ uses ClientConnection with .state attribute (no .closed)
# We detect the open state value at runtime after first connection
_WS_OPEN_STATE = None  # Will be set after first successful connect

logger = logging.getLogger(__name__)

# ═══════════ POCKET OPTION SERVERS ═══════════
PO_SERVERS = {
    "demo": [
        "wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket",
        "wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket",
    ],
    "live": [
        "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
        "wss://api-sc.po.market/socket.io/?EIO=4&transport=websocket",
    ],
}

# Browser-like headers for the WebSocket connection
WS_HEADERS = {
    "Origin": "https://pocketoption.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}


class PocketOptionScanner:
    """
    Scanner temps réel pour Pocket Option via connexion WebSocket directe.
    
    Avantages par rapport à la bibliothèque pocketoptionapi_async:
    - Connexion directe Socket.IO v4 — pas de couches d'abstraction fragiles
    - Timeouts configurables et messages d'erreur clairs
    - Authentification vérifiée (pas seulement TCP connecté)
    - Keep-alive robuste avec ping/pong
    - Récupération des bougies et payouts directement via le protocole PO
    """

    def __init__(self):
        self.is_demo = True
        self.ssid = None
        self._ws = None  # websockets.WebSocketClientProtocol
        self._is_authenticated = False
        self._sid = None  # Socket.IO session ID
        self._uid = None
        # Payout store: maps symbol -> {"payout": float, "is_active": bool, "updated_at": iso}
        # PO sends the FULL asset list (including greyed-out / inactive pairs) on every
        # updateAssets event. We MUST track is_active separately so we can show "N/A"
        # for inactive pairs (matching PO's UI behaviour) instead of stale payouts.
        self._payouts = {}  # symbol -> {"payout": float, "is_active": bool, "updated_at": str}
        self._candles_cache = {}  # asset -> DataFrame
        self._receive_task = None
        self._ping_task = None
        self._health_check_task = None
        self._balance = None
        self._last_message_time = None
        self._message_buffer = []  # Buffer for incoming messages
        self._auth_event = asyncio.Event()

    # ═══════════ SSID CLEANING ═══════════

    @staticmethod
    def _deep_clean_ssid(raw: str) -> str:
        """
        Nettoyage robuste du SSID — supprime TOUS les caractères invisibles
        et corrections de format courants lors du copier-coller depuis DevTools.
        """
        cleaned = raw
        cleaned = cleaned.replace('\ufeff', '')
        cleaned = re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u00ad]', '', cleaned)
        cleaned = cleaned.replace('\u201c', '"').replace('\u201d', '"')
        cleaned = cleaned.replace('\u2018', "'").replace('\u2019', "'")
        cleaned = cleaned.replace('\u00a0', ' ')
        cleaned = re.sub(r'[\r\n\t]+', '', cleaned)
        cleaned = cleaned.strip()
        if '42["auth",42["auth",' in cleaned:
            cleaned = cleaned.replace('42["auth",42["auth",', '42["auth",')
        if '42["auth", 42["auth",' in cleaned:
            cleaned = cleaned.replace('42["auth", 42["auth",', '42["auth",')
        m = re.match(r'^\d+:(42\["auth")', cleaned)
        if m:
            cleaned = re.sub(r'^\d+:', '', cleaned)
        auth_idx = cleaned.find('42["auth"')
        if auth_idx > 0:
            cleaned = cleaned[auth_idx:]
        return cleaned

    @staticmethod
    def _prepare_ssid(ssid: str) -> tuple:
        """
        Pré-traite le SSID : nettoie et extrait les champs.
        Retourne (ssid_nettoyé, is_demo, uid, session).
        """
        ssid = PocketOptionScanner._deep_clean_ssid(ssid)
        is_demo = True
        uid = 0
        session = ""

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
                    uid = data.get("uid", 0)
                    session = data.get("session", "")
            except Exception as e:
                logger.warning(f"Erreur lors du parsing du SSID: {e}")

        return ssid, is_demo, uid, session

    # ═══════════ CONNECTION ═══════════

    def _ws_is_open(self) -> bool:
        """Check if WebSocket connection is open (compatible with websockets v16+)."""
        if self._ws is None:
            return False
        # websockets v16+ uses .state attribute
        if hasattr(self._ws, 'state'):
            global _WS_OPEN_STATE
            if _WS_OPEN_STATE is None:
                # Auto-detect the OPEN state value from the enum
                try:
                    from websockets.protocol import State
                    _WS_OPEN_STATE = State.OPEN
                except (ImportError, AttributeError):
                    _WS_OPEN_STATE = 1  # Fallback
            return self._ws.state == _WS_OPEN_STATE
        # websockets < v14 uses .closed attribute
        if hasattr(self._ws, 'closed'):
            return not self._ws.closed
        # Fallback: check if close_code is None (means still open)
        if hasattr(self._ws, 'close_code'):
            return self._ws.close_code is None
        return False

    @property
    def is_connected(self) -> bool:
        """True only if WebSocket is open AND authenticated."""
        return (
            self._ws is not None
            and self._ws_is_open()
            and self._is_authenticated
        )

    async def connect(self, ssid: str, is_demo: Optional[bool] = None) -> bool:
        """
        Connecte directement au WebSocket Pocket Option.
        Protocol: Socket.IO v4 handshake + auth.
        """
        if not _WS_AVAILABLE:
            logger.error("websockets library not installed. Run: pip install websockets")
            return False

        # Parse SSID
        prepared_ssid, detected_is_demo, uid, session = self._prepare_ssid(ssid)
        if is_demo is None:
            is_demo = detected_is_demo

        # Si déjà connecté avec le même SSID, on ne fait rien
        if self.is_connected and self.ssid == prepared_ssid and self.is_demo == is_demo:
            logger.info("[SCANNER] Déjà connecté avec le même SSID")
            return True

        # Déconnexion propre
        await self.disconnect()

        self.ssid = prepared_ssid
        self.is_demo = is_demo
        self._uid = uid
        mode_label = "DÉMO" if is_demo else "RÉEL"
        logger.info(f"[SCANNER] 🔍 TENTATIVE DE CONNEXION — Mode: {mode_label}, UID: {uid}")

        # Select servers to try
        servers = PO_SERVERS["demo"] if is_demo else PO_SERVERS["live"]

        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

        last_error = None
        for server_url in servers:
            try:
                logger.info(f"[SCANNER] Essai: {server_url[:50]}...")

                # Step 1: WebSocket connect
                self._ws = await asyncio.wait_for(
                    websockets.connect(
                        server_url,
                        ssl=ssl_context,
                        additional_headers=WS_HEADERS,
                        ping_interval=None,  # We handle pings ourselves
                        close_timeout=5,
                    ),
                    timeout=15
                )

                # Step 2: Receive Engine.IO open ("0{sid...}")
                open_msg = await asyncio.wait_for(self._ws.recv(), timeout=10)
                if isinstance(open_msg, bytes):
                    open_msg = open_msg.decode("utf-8")
                
                if open_msg.startswith("0"):
                    try:
                        open_data = json.loads(open_msg[1:])
                        self._sid = open_data.get("sid", "unknown")
                        logger.info(f"[SCANNER] Engine.IO open received — SID: {self._sid[:15]}...")
                    except json.JSONDecodeError:
                        logger.warning(f"[SCANNER] Engine.IO open parse error: {open_msg[:100]}")
                else:
                    logger.warning(f"[SCANNER] Unexpected first message: {open_msg[:100]}")

                # Step 3: Send Socket.IO CONNECT ("40")
                await self._ws.send("40")
                logger.debug("[SCANNER] Sent '40' (Socket.IO CONNECT)")

                # Step 4: Receive connect ack ("40{sid...}")
                connect_ack = await asyncio.wait_for(self._ws.recv(), timeout=10)
                if isinstance(connect_ack, bytes):
                    connect_ack = connect_ack.decode("utf-8")
                logger.debug(f"[SCANNER] Connect ack: {connect_ack[:80]}")

                # Step 5: Send SSID auth frame
                await self._ws.send(prepared_ssid)
                logger.info("[SCANNER] Auth frame sent — waiting for authentication...")

                # Step 6: Wait for authentication response
                self._auth_event.clear()
                self._is_authenticated = False

                # Start receive loop
                self._receive_task = asyncio.create_task(self._receive_loop())

                # Wait for auth result (up to 15 seconds)
                try:
                    await asyncio.wait_for(self._auth_event.wait(), timeout=15)
                except asyncio.TimeoutError:
                    logger.error("[SCANNER] ❌ Auth timeout — aucune réponse du serveur")
                    last_error = "Authentification timeout — le serveur ne répond pas"
                    await self._close_ws()
                    continue

                if self._is_authenticated:
                    logger.info(f"[SCANNER] ✅ CONNECTÉ AU MARCHÉ POCKET OPTION — Mode: {mode_label}")
                    
                    # Start keep-alive ping loop
                    self._ping_task = asyncio.create_task(self._ping_loop())
                    
                    # Start health check loop
                    if self._health_check_task is None or self._health_check_task.done():
                        self._health_check_task = asyncio.create_task(self._health_check_loop())

                    # Request initial data
                    await self._request_initial_data()
                    
                    return True
                else:
                    logger.error(f"[SCANNER] ❌ AUTHENTIFICATION REFUSÉE — Mode: {mode_label}")
                    last_error = "Authentification refusée par Pocket Option — le SSID est invalide ou votre session a été déconnectée"
                    await self._close_ws()
                    continue

            except asyncio.TimeoutError:
                logger.warning(f"[SCANNER] Timeout de connexion pour {server_url[:50]}...")
                last_error = "Timeout de connexion — le serveur met trop de temps à répondre"
                await self._close_ws()
                continue
            except Exception as e:
                logger.error(f"[SCANNER] Erreur de connexion: {e}")
                last_error = str(e)
                await self._close_ws()
                continue

        logger.error(f"[SCANNER] ❌ TOUTES LES TENTATIVES ONT ÉCHOUÉ — Dernière erreur: {last_error}")
        return False

    async def _close_ws(self):
        """Close WebSocket and cancel tasks."""
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            self._receive_task = None
        if self._ping_task and not self._ping_task.done():
            self._ping_task.cancel()
            self._ping_task = None
        if self._ws and self._ws_is_open():
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None
        self._is_authenticated = False

    # ═══════════ MESSAGE RECEIVING ═══════════

    async def _receive_loop(self):
        """Main loop for receiving WebSocket messages."""
        try:
            while self._ws and self._ws_is_open():
                try:
                    message = await asyncio.wait_for(self._ws.recv(), timeout=60)
                except asyncio.TimeoutError:
                    # No message for 60s — check if still connected
                    if self._ws and self._ws_is_open():
                        continue
                    break
                
                # Handle binary messages (Socket.IO binary attachments)
                # After a "451-" text frame, binary data arrives as bytes
                if isinstance(message, bytes):
                    try:
                        # Try to decode as UTF-8 (some binary frames are actually text)
                        decoded = message.decode('utf-8')
                        self._last_message_time = datetime.now(timezone.utc)
                        
                        # Binary attachment data — typically JSON array of assets
                        # This arrives after a "451-[\"updateAssets\",...]" frame
                        if decoded.startswith('[') or decoded.startswith('{'):
                            try:
                                parsed = json.loads(decoded)
                                if isinstance(parsed, list):
                                    await self._parse_assets_list(parsed)
                                elif isinstance(parsed, dict):
                                    await self._parse_assets_dict(parsed)
                            except (json.JSONDecodeError, ValueError):
                                pass
                        else:
                            try:
                                await self._handle_message(decoded)
                            except Exception as e:
                                logger.error(f"[SCANNER] Error handling decoded binary: {e}")
                    except UnicodeDecodeError:
                        # True binary data — parse as assets/payouts
                        self._last_message_time = datetime.now(timezone.utc)
                        await self._handle_binary_data(message)
                    continue
                
                self._last_message_time = datetime.now(timezone.utc)
                
                try:
                    await self._handle_message(message)
                except Exception as e:
                    logger.error(f"[SCANNER] Error handling message: {e}")
                    
        except websockets.exceptions.ConnectionClosed as e:
            code = getattr(e, 'code', 'unknown')
            reason = getattr(e, 'reason', '')
            logger.warning(f"[SCANNER] WebSocket closed: code={code}, reason={reason}")
            self._is_authenticated = False
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[SCANNER] Receive loop error: {e}")
            self._is_authenticated = False

    async def _handle_message(self, message: str):
        """Route incoming Socket.IO messages."""
        
        # Engine.IO PING ("2")
        if message == "2":
            await self._ws.send("3")  # PONG
            logger.debug("[SCANNER] PING/PONG")
            return

        # Engine.IO PONG ("3")
        if message == "3":
            return

        # Socket.IO CONNECT ack ("40{...}")
        if message.startswith("40"):
            logger.debug("[SCANNER] Socket.IO CONNECT ack")
            return

        # Socket.IO DISCONNECT ("41") — server is closing the connection
        if message == "41" or message.startswith("41"):
            logger.warning("[SCANNER] Socket.IO DISCONNECT received — server closed the connection")
            self._is_authenticated = False
            return

        # Socket.IO EVENT ("42[...]") — main data channel
        if message.startswith("42"):
            try:
                json_start = message.index("[")
                data = json.loads(message[json_start:])
                event_name = data[0] if data else ""
                event_data = data[1:] if len(data) > 1 else []
                
                await self._handle_event(event_name, event_data)
            except (json.JSONDecodeError, ValueError) as e:
                logger.warning(f"[SCANNER] Failed to parse event: {message[:100]}")
            return

        # Socket.IO ACK ("43...") — auth response comes here
        if message.startswith("43"):
            try:
                # Ack format: "43<ack_id>[data]"
                ack_data_start = message.index("[")
                data = json.loads(message[ack_data_start:])
                logger.debug(f"[SCANNER] ACK data: {data}")
                
                # Check for auth success
                if any("successauth" in str(item).lower() for item in data):
                    self._is_authenticated = True
                    self._auth_event.set()
                    logger.info("[SCANNER] ✅ Authentification réussie (via ACK)")
                elif any("notauthorized" in str(item).lower() for item in data):
                    self._is_authenticated = False
                    self._auth_event.set()
                    logger.error("[SCANNER] ❌ Authentification refusée (via ACK)")
            except (json.JSONDecodeError, ValueError):
                logger.warning(f"[SCANNER] Failed to parse ACK: {message[:100]}")
            return

        # Socket.IO BINARY EVENT ("451-..." or "45<id>-..." )
        # Pocket Option uses this format for auth response (updateAssets, etc.)
        # Format: "451-[\"eventName\",{...}]" followed by binary payload
        if message.startswith("45"):
            try:
                # Strip the "45<id>-" prefix to get the JSON event
                dash_idx = message.index("-")
                json_part = message[dash_idx + 1:]
                # This may contain _placeholder references, but the event name is parseable
                data = json.loads(json_part)
                event_name = data[0] if isinstance(data, list) and data else ""
                logger.debug(f"[SCANNER] Binary event: {event_name}")
                
                # updateAssets after auth = auth succeeded!
                if event_name in ("updateAssets", "successauth"):
                    if not self._is_authenticated:
                        self._is_authenticated = True
                        self._auth_event.set()
                        logger.info(f"[SCANNER] ✅ Authentification réussie (via binary event: {event_name})")
                    
                    # Try to parse payout data from the next binary message
                    # (will arrive as bytes in the next recv)
                elif event_name == "NotAuthorized":
                    self._is_authenticated = False
                    self._auth_event.set()
                    logger.error("[SCANNER] ❌ Authentification refusée (via binary event)")
                else:
                    event_data = data[1:] if len(data) > 1 else []
                    await self._handle_event(event_name, event_data)
            except (json.JSONDecodeError, ValueError, IndexError) as e:
                logger.debug(f"[SCANNER] Failed to parse binary event: {message[:100]}")
            return

        # Engine.IO open ("0{...}")
        if message.startswith("0"):
            logger.debug("[SCANNER] Engine.IO open message (unexpected during receive)")
            return

        # Unknown
        logger.debug(f"[SCANNER] Unhandled message type: {message[:50]}")

    async def _handle_binary_data(self, data: bytes):
        """
        Handle binary data from Socket.IO binary attachments.
        Pocket Option sends asset/payout data as binary after a "451-["updateAssets",...]" frame.
        The binary data is typically a msgpack or JSON-encoded array of asset info.
        """
        try:
            # Try to decode as UTF-8 JSON first
            text = data.decode('utf-8', errors='replace')
            
            # Pocket Option binary asset data format:
            # Array of arrays: [id, symbol, name, type, ... , payout, ...]
            parsed = json.loads(text)
            if isinstance(parsed, list):
                await self._parse_assets_list(parsed)
            elif isinstance(parsed, dict):
                await self._parse_assets_dict(parsed)
                
            logger.debug(f"[SCANNER] Binary data parsed: {len(text)} bytes")
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            logger.debug(f"[SCANNER] Binary data not JSON: {len(data)} bytes, error: {e}")
        except Exception as e:
            logger.debug(f"[SCANNER] Binary data parse error: {e}")

    async def _parse_assets_list(self, assets: list):
        """Parse assets from Pocket Option's `updateAssets` payload.

        Verified field layout (from real 183-asset snapshot — source:
        ChipaDevTeam/PocketOptionAPI example_payouts.json + lordralinc/pocket_option):
        Each asset entry is a positional array with 19 fields:
          Index → Field
            0   → id (int)
            1   → symbol (str, e.g. "EURUSD_otc", "#AAPL")
            2   → label/display name (str, e.g. "EUR/USD OTC")
            3   → type (str, e.g. "currency", "stock", "crypto")
            4   → precision (int, decimal places)
            5   → payout (int, 0..92 — percentage; PO caps at 92%)
            6   → min_duration (int, seconds)
            7   → max_duration (int, seconds)
            8   → step_duration (int, seconds)
            9   → volatility_index (int; 0=real market, 1=OTC/synthetic)
           10   → linked_id (int, ID of OTC counterpart)
           11   → leverage (int)
           12   → extra_data (list)
           13   → expire_time (int, unix timestamp — session expiry)
           14   → is_active (bool) ← FALSE = greyed out / "N/A" in PO UI
           15   → timeframes (list of dicts)
           16   → start_time (int, unix timestamp; -1 = N/A)
           17   → default_timeframe (int, seconds)
           18   → status_code (int, unix timestamp)

        CRITICAL: PO keeps stale payout values in the payload for greyed-out
        (inactive) pairs. We MUST read is_active at index [14] and only treat
        a payout as "live" when is_active=True. Otherwise our payouts won't
        match what PO shows in the UI (PO hides inactive pairs / shows "N/A").
        """
        count = 0
        active_count = 0
        inactive_count = 0
        try:
            # Log a sample so we can verify the format matches our parser
            if assets and isinstance(assets[0], list):
                sample = assets[0]
                logger.info(f"[SCANNER] updateAssets sample (len={len(sample)}): {sample[:19]}")

            now_iso = datetime.now(timezone.utc).isoformat()

            for asset_info in assets:
                if not isinstance(asset_info, list) or len(asset_info) < 15:
                    # Need at least 15 fields to read is_active at index 14
                    continue

                # Symbol is at index 1 — must be a non-empty string
                symbol = asset_info[1] if len(asset_info) > 1 else None
                if not isinstance(symbol, str) or not symbol:
                    continue

                # Payout is at index 5 (verified against real PO data)
                payout_raw = asset_info[5] if len(asset_info) > 5 else None
                if not isinstance(payout_raw, (int, float)) or payout_raw < 0:
                    continue

                payout = float(payout_raw)
                # If payout looks like a fraction (0..1), convert to percent
                if 0 < payout <= 1.0:
                    payout = payout * 100.0

                # Sanity: PO caps payouts at 92% (verified). Anything > 92
                # suggests we're reading the wrong field — skip it.
                if not (0 <= payout <= 92):
                    continue

                # is_active is at index 14 (verified) — FALSE = greyed out / N/A
                is_active_raw = asset_info[14] if len(asset_info) > 14 else True
                # Be defensive: PO uses bool, but some servers may send 0/1 or strings
                if isinstance(is_active_raw, bool):
                    is_active = is_active_raw
                elif isinstance(is_active_raw, (int, float)):
                    is_active = bool(is_active_raw)
                elif isinstance(is_active_raw, str):
                    is_active = is_active_raw.lower() in ("true", "1", "yes", "active")
                else:
                    is_active = True  # Default to active if we can't tell

                # Store EVERYTHING (including inactive payouts) so we can distinguish
                # "this pair is inactive right now" from "we never received this pair".
                # Callers (get_payout, get_all_payouts, etc.) will filter on is_active.
                self._payouts[symbol] = {
                    "payout": payout,
                    "is_active": is_active,
                    "updated_at": now_iso,
                }
                count += 1
                if is_active:
                    active_count += 1
                else:
                    inactive_count += 1

            if count > 0:
                # Log OTC forex samples split by active/inactive so user can verify
                # against PO's UI (active pairs show payout, inactive show N/A).
                active_otc_items = [
                    (k, v["payout"]) for k, v in self._payouts.items()
                    if "_otc" in k.lower() and v["is_active"]
                ][:8]
                inactive_otc_items = [
                    (k, v["payout"]) for k, v in self._payouts.items()
                    if "_otc" in k.lower() and not v["is_active"]
                ][:8]
                logger.info(
                    f"[SCANNER] updateAssets parsed: {count} total "
                    f"({active_count} active, {inactive_count} inactive). "
                    f"Active OTC samples: {dict(active_otc_items)}. "
                    f"Inactive OTC samples (N/A on PO): {dict(inactive_otc_items)}"
                )
        except Exception as e:
            logger.error(f"[SCANNER] Asset list parse error: {e}", exc_info=True)

    async def _parse_assets_dict(self, data: dict):
        """Parse assets from Pocket Option's dict format (legacy fallback)."""
        try:
            assets = data.get("assets", data.get("data", []))
            now_iso = datetime.now(timezone.utc).isoformat()
            if isinstance(assets, list):
                for asset in assets:
                    if isinstance(asset, dict):
                        symbol = asset.get("asset", asset.get("symbol", ""))
                        payout = asset.get("payout", None)
                        if symbol and payout is not None:
                            p = float(payout)
                            if 0 < p <= 1.0:
                                p = p * 100.0
                            # Cap at 92% (PO's verified max)
                            if 0 <= p <= 92:
                                is_active = asset.get("is_active", asset.get("active", True))
                                self._payouts[symbol] = {
                                    "payout": p,
                                    "is_active": bool(is_active),
                                    "updated_at": now_iso,
                                }
            if self._payouts:
                logger.info(f"[SCANNER] Parsed {len(self._payouts)} asset payouts from dict data")
        except Exception as e:
            logger.debug(f"[SCANNER] Asset dict parse error: {e}")

    async def _handle_event(self, event_name: str, event_data: list):
        """Handle Socket.IO named events."""

        # Auth success event
        if event_name == "successauth":
            self._is_authenticated = True
            self._auth_event.set()
            logger.info("[SCANNER] ✅ Authentification réussie (via event)")
            return

        # Auth failure event
        if event_name == "NotAuthorized":
            self._is_authenticated = False
            self._auth_event.set()
            logger.error("[SCANNER] ❌ Authentification refusée (via event)")
            return

        # updateAssets — Pocket Option sends the full asset list (with payouts)
        # via this event after auth. Format: [[id, symbol, name, type, ..., payout, ...], ...]
        if event_name in ("updateAssets", "assets"):
            try:
                if event_data:
                    assets = event_data[0]
                    if isinstance(assets, list):
                        await self._parse_assets_list(assets)
                    elif isinstance(assets, dict):
                        await self._parse_assets_dict(assets)
            except Exception as e:
                logger.error(f"[SCANNER] updateAssets parse error: {e}")
            return

        # Payout update (incremental — PO may send these between full updateAssets snapshots)
        if event_name == "payout" or event_name == "payoutChange":
            try:
                if event_data:
                    payout_data = event_data[0] if isinstance(event_data[0], list) else event_data
                    now_iso = datetime.now(timezone.utc).isoformat()
                    if isinstance(payout_data, list):
                        for item in payout_data:
                            if isinstance(item, dict) and "asset" in item and "payout" in item:
                                p = float(item["payout"])
                                if 0 < p <= 1.0:
                                    p = p * 100.0
                                if 0 <= p <= 92:
                                    # Preserve existing is_active, default True
                                    existing = self._payouts.get(item["asset"], {})
                                    self._payouts[item["asset"]] = {
                                        "payout": p,
                                        "is_active": existing.get("is_active", item.get("is_active", True)),
                                        "updated_at": now_iso,
                                    }
                    elif isinstance(payout_data, dict):
                        if "asset" in payout_data and "payout" in payout_data:
                            p = float(payout_data["payout"])
                            if 0 < p <= 1.0:
                                p = p * 100.0
                            if 0 <= p <= 92:
                                existing = self._payouts.get(payout_data["asset"], {})
                                self._payouts[payout_data["asset"]] = {
                                    "payout": p,
                                    "is_active": existing.get("is_active", payout_data.get("is_active", True)),
                                    "updated_at": now_iso,
                                }
            except Exception as e:
                logger.debug(f"[SCANNER] Payout parse error: {e}")
            return

        # Balance update
        if event_name == "balance":
            try:
                if event_data and isinstance(event_data[0], dict):
                    self._balance = event_data[0]
                    logger.info(f"[SCANNER] Balance: {event_data[0]}")
            except Exception:
                pass
            return

        # Candles data
        if event_name in ("candles", "candlesData", "quote"):
            try:
                await self._parse_candles(event_name, event_data)
            except Exception as e:
                logger.debug(f"[SCANNER] Candles parse error: {e}")
            return

        # Other events — log at debug level
        logger.debug(f"[SCANNER] Event '{event_name}': {str(event_data)[:200]}")

    async def _parse_candles(self, event_name: str, event_data: list):
        """Parse candle data from WebSocket events."""
        # The exact format depends on Pocket Option's API
        # This is a placeholder that handles common formats
        pass

    # ═══════════ KEEP-ALIVE & HEALTH ═══════════

    async def _ping_loop(self):
        """Send periodic keep-alive messages."""
        try:
            while self._ws and self._ws_is_open():
                await asyncio.sleep(20)  # Every 20 seconds
                if self._ws and self._ws_is_open() and self._is_authenticated:
                    try:
                        await self._ws.send('42["ps"]')  # PO keep-alive
                        logger.debug("[SCANNER] Keep-alive sent")
                    except Exception:
                        logger.warning("[SCANNER] Keep-alive failed — connection may be lost")
                        self._is_authenticated = False
                        break
        except asyncio.CancelledError:
            pass

    async def _health_check_loop(self):
        """Periodic health check to verify the connection is still alive."""
        while True:
            try:
                await asyncio.sleep(30)
                if not self._is_authenticated:
                    logger.warning("[SCANNER] Health check: not authenticated")
                elif self._ws and not self._ws_is_open():
                    logger.warning("[SCANNER] Health check: WebSocket closed")
                    self._is_authenticated = False
                else:
                    logger.debug("[SCANNER] Health check: OK")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[SCANNER] Health check error: {e}")

    async def _request_initial_data(self):
        """Request initial market data after authentication.

        Pocket Option typically pushes the full asset list via updateAssets right
        after a successful auth — but we also nudge it explicitly. The exact event
        names vary slightly between PO server versions, so we send a few known
        variants to maximize the chance of receiving the payout table.
        """
        if not self._is_authenticated or not self._ws:
            return

        nudges = [
            '42["ps"]',                    # Standard keep-alive / state request
            '42["getPayout"]',             # Direct payout table request
            '42["updateAssets"]',          # Some PO versions respond to this
        ]
        for nudge in nudges:
            try:
                await self._ws.send(nudge)
            except Exception as e:
                logger.warning(f"[SCANNER] Failed to send initial nudge {nudge[:20]}: {e}")
                break
        logger.info("[SCANNER] Sent initial data requests (getPayout + updateAssets nudge)")

    # ═══════════ MARKET DATA ═══════════

    def get_asset_symbol(self, pair: str) -> str:
        """Convert pair name to Pocket Option asset symbol."""
        symbol = pair.replace('/', '')
        if ' OTC' in symbol:
            symbol = symbol.replace(' OTC', '_otc')
        return symbol

    async def get_candles(self, pair: str, timeframe: str = "1m", count: int = 100) -> pd.DataFrame:
        """
        Récupère les bougies OHLCV du marché.
        Tente via WebSocket, fallback sur l'API REST de Pocket Option.
        """
        if not self._is_authenticated or not self._ws:
            return pd.DataFrame()

        asset = self.get_asset_symbol(pair)
        
        # Map timeframe to seconds
        tf_seconds = {
            "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
            "1h": 3600, "4h": 14400, "1d": 86400,
        }
        tf_sec = tf_seconds.get(timeframe, 60)

        try:
            # Request candles via WebSocket
            request_id = id(asset) % 10000
            msg = f'42["getCandles","{asset}",{tf_sec},{count}]'
            await self._ws.send(msg)
            
            # Wait for candles response (up to 10 seconds)
            # We'll listen for the next candles event for this asset
            start_time = asyncio.get_event_loop().time()
            while (asyncio.get_event_loop().time() - start_time) < 10:
                # Check if we got candles in the cache
                cache_key = f"{asset}_{timeframe}"
                if cache_key in self._candles_cache:
                    df = self._candles_cache.pop(cache_key)
                    return df
                await asyncio.sleep(0.2)
            
            # If no candles received via WebSocket, try HTTP API
            return await self._fetch_candles_http(asset, tf_sec, count)
            
        except Exception as e:
            logger.error(f"[SCANNER] Erreur récupération bougies ({pair}): {e}")
            return await self._fetch_candles_http(asset, tf_sec, count)

    async def _fetch_candles_http(self, asset: str, tf_sec: int, count: int) -> pd.DataFrame:
        """Fallback: fetch candles via Pocket Option's HTTP API."""
        try:
            import httpx
            # PO has an HTTP API for historical data
            # This is a simplified version — may need adjustment based on actual PO API
            logger.debug(f"[SCANNER] Trying HTTP candles for {asset}")
            return pd.DataFrame()  # Placeholder
        except Exception:
            return pd.DataFrame()

    async def get_current_price(self, pair: str) -> Optional[float]:
        """Récupère le dernier prix de clôture."""
        df = await self.get_candles(pair, count=1)
        if not df.empty:
            return float(df['close'].iloc[-1])
        return None

    def get_payout(self, pair: str, active_only: bool = True) -> Optional[float]:
        """Get the current payout for a pair — STRICT lookup, no fuzzy matching.

        PO uses symbol formats like:
          "EURUSD_otc" for OTC forex
          "#AAPL" for stocks
          "#AAPL_otc" for OTC stocks
        We convert "EUR/USD OTC" → "EURUSD_otc" and do an EXACT lookup.
        No partial match — partial matching was returning wrong payouts.

        Args:
            pair: Display name like "EUR/USD OTC" or PO symbol like "EURUSD_otc"
            active_only: If True, return None for inactive (greyed-out / N/A) pairs.
                         Set False to get the last known payout even if inactive.
        """
        if not self._is_authenticated:
            return None

        # Build candidate list — all the formats PO might use
        candidates = []

        # "EUR/USD OTC" → "EURUSD_otc" (PO's main OTC forex format)
        base = pair.replace('/', '').replace(' ', '_')  # "EUR/USD OTC" → "EURUSD_OTC"
        base_lower = base.replace('_OTC', '_otc')
        candidates.extend([
            base_lower,                    # "EURUSD_otc"
            base_lower.lower(),            # "eurusd_otc"
            base,                          # "EURUSD_OTC"
            base.replace('_OTC', ''),      # "EURUSD" (non-OTC variant)
            base_lower.replace('_otc', ''), # "eurusd"
            f"#{base_lower}",              # "#EURUSD_otc" (stock-style)
            pair,                          # "EUR/USD OTC" (display name)
        ])

        # Exact-match lookup across all candidates
        match_symbol = None
        for candidate in candidates:
            if candidate and candidate in self._payouts:
                match_symbol = candidate
                break

        # Case-insensitive exact-match fallback
        if not match_symbol:
            pair_lower = pair.lower()
            for symbol in self._payouts.keys():
                if symbol.lower() == base_lower.lower():
                    match_symbol = symbol
                    break

        if not match_symbol:
            logger.debug(
                f"[SCANNER] No exact payout match for '{pair}'. "
                f"Available symbols sample: {list(self._payouts.keys())[:10]}"
            )
            return None

        entry = self._payouts[match_symbol]
        if active_only and not entry.get("is_active", True):
            # Pair is currently greyed out / N/A on PO — return None to signal that
            logger.info(f"[SCANNER] '{pair}' (symbol='{match_symbol}') is INACTIVE on PO — returning None (N/A)")
            return None
        return entry.get("payout")

    def get_pair_status(self, pair: str) -> Optional[dict]:
        """Get full status info for a pair: payout + is_active + updated_at.
        Returns None if pair not found in PO's asset list.
        """
        if not self._is_authenticated:
            return None

        candidates = []
        base = pair.replace('/', '').replace(' ', '_')
        base_lower = base.replace('_OTC', '_otc')
        candidates.extend([
            base_lower, base_lower.lower(), base,
            base.replace('_OTC', ''), base_lower.replace('_otc', ''),
            f"#{base_lower}", pair,
        ])

        for candidate in candidates:
            if candidate and candidate in self._payouts:
                return {"symbol": candidate, **self._payouts[candidate]}

        # Case-insensitive fallback
        for symbol, entry in self._payouts.items():
            if symbol.lower() == base_lower.lower():
                return {"symbol": symbol, **entry}
        return None

    def get_all_payouts(self, active_only: bool = False) -> dict:
        """Return ALL parsed payouts directly from PO.

        Args:
            active_only: If True, only return payouts for pairs where is_active=True
                         (i.e. pairs that are NOT greyed-out on PO UI). Default False
                         for transparency/debug.
        Returns:
            dict mapping symbol -> payout (float)  [backward-compatible with old API]
        """
        if active_only:
            return {k: v["payout"] for k, v in self._payouts.items() if v.get("is_active", True)}
        return {k: v["payout"] for k, v in self._payouts.items()}

    def get_all_payouts_detailed(self) -> dict:
        """Return full payout info including is_active flag.
        Returns:
            dict mapping symbol -> {"payout": float, "is_active": bool, "updated_at": str}
        """
        return {k: dict(v) for k, v in self._payouts.items()}

    def find_pairs_above_payout(self, min_payout: float = 70.0, pair_filter: str = "OTC",
                                 active_only: bool = True) -> dict:
        """Find all pairs with payout >= min_payout.

        Args:
            min_payout: Minimum payout threshold (e.g. 70.0)
            pair_filter: Filter symbols by this substring (e.g. "OTC")
            active_only: If True (default), exclude inactive/greyed-out pairs.
                         This matches PO's UI behaviour where N/A pairs aren't tradable.
        """
        result = {}
        for symbol, entry in self._payouts.items():
            payout = entry.get("payout", 0)
            is_active = entry.get("is_active", True)
            if active_only and not is_active:
                continue  # Skip greyed-out pairs (matches PO UI)
            if payout >= min_payout:
                if pair_filter and pair_filter.upper() in symbol.upper():
                    display = self._symbol_to_display(symbol)
                    result[display] = payout
        return result

    @staticmethod
    def format_payout(payout: Optional[float]) -> str:
        """Format a payout value for display — matches PO's UI format.
        PO shows payouts as '+92%' (with the plus sign).
        Returns 'N/A' if payout is None (pair is inactive/greyed-out).
        """
        if payout is None:
            return "N/A"
        if not isinstance(payout, (int, float)):
            return "N/A"
        return f"+{payout:.0f}%"

    @staticmethod
    def _symbol_to_display(symbol: str) -> str:
        """Convert PO symbol like 'EURUSD_otc' to display name 'EUR/USD OTC'."""
        s = symbol
        is_otc = "_otc" in s.lower()
        s = s.replace("_otc", "").replace("_OTC", "")
        s = s.lstrip("#")
        # Split into two 3-letter halves (e.g. "EURUSD" → "EUR/USD")
        if len(s) == 6 and s.isalpha():
            s = f"{s[:3]}/{s[3:]}"
        if is_otc:
            s = f"{s} OTC"
        return s

    # ═══════════ DISCONNECT ═══════════

    async def disconnect(self):
        """Déconnecte proprement."""
        if self._health_check_task and not self._health_check_task.done():
            self._health_check_task.cancel()
            self._health_check_task = None
        if self._ping_task and not self._ping_task.done():
            self._ping_task.cancel()
            self._ping_task = None
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            self._receive_task = None

        self._is_authenticated = False
        self._payouts = {}
        self._candles_cache = {}
        self._balance = None

        await self._close_ws()
        logger.info("[SCANNER] 🔌 DÉCONNECTÉ")
