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

# FOREX filter — imported ONCE at module level (not inside functions)
# to avoid crashing every 5 seconds if the module is missing
try:
    from .forex_filter import is_forex_pair as _is_forex_pair
    _FOREX_FILTER_AVAILABLE = True
except ImportError:
    _FOREX_FILTER_AVAILABLE = False
    logger.warning("forex_filter module not available — ALL assets will be processed")

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
        # updateAssets event. We track is_active so we can FILTER OUT inactive pairs
        # entirely — they are never displayed, never used for signals, never sent to
        # the user. The system only considers pairs where is_active=True AND payout>=70.
        self._payouts = {}  # symbol -> {"payout": float, "is_active": bool, "updated_at": str}
        self._candles_cache = {}  # asset -> DataFrame
        self._receive_task = None
        self._ping_task = None
        self._health_check_task = None
        self._asset_refresh_task = None  # Periodic asset refresh loop
        self._balance = None
        self._last_message_time = None
        self._message_buffer = []  # Buffer for incoming messages
        self._auth_event = asyncio.Event()
        # ─── Freshness tracking ───────────────────────────────────────────
        # PO pushes the full asset list (updateAssets) once at auth, then again
        # at unpredictable intervals — could be seconds, minutes, or longer.
        # The timing is NOT predictable; PO's internal logic decides based on
        # market sessions, liquidity, and trader volume.
        # We actively nudge PO every 5s with `42["ps"]` to trigger a fresh push,
        # so our view stays within 5s of what PO's UI shows.
        self._last_assets_update = None  # datetime of last updateAssets received
        self._assets_received_count = 0  # how many updateAssets snapshots we've parsed
        self._last_payout_change = None  # datetime of last individual payout change event
        # ─── DEBUG: raw message capture (first 100 messages after auth) ──
        # This is a temporary diagnostic to discover PO's actual WS protocol.
        # Once we fix the candle parser, this can be removed.
        self._debug_message_count = 0
        self._debug_max_messages = 100  # capture first 100 messages after auth
        self._debug_candle_requests_sent = set()  # track which assets we've requested candles for
        self._debug_candle_responses_received = []  # log of candle-related events
        # ─── Socket.IO v4 binary attachment reassembly ──────────────────
        self._pending_binary_events = []  # list of {"event_name", "data", "placeholders_needed", "binaries_received"}
        # ─── Live tick buffer for updateStream aggregation ─────────────
        # PO's modern API sends live price ticks via 'updateStream' events.
        # Each tick: [asset, timestamp_unix_float, price]
        # We aggregate these into 1-minute OHLC candles and store in
        # _candles_cache so the indicator engine can consume them.
        # This is the ONLY way to get candle data from PO's modern API —
        # historical candle requests (changeSymbol, getCandles, etc.) are
        # silently ignored on the main app socket.
        self._tick_buffer = {}  # asset -> list of (timestamp_float, price_float)
        self._tick_aggregation_task = None
        self._tick_status_task = None  # Periodic tick buffer status logger
        self._last_aggregation_time = 0

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
        is_chart = False

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
                    # PO main socket uses "session", chart socket uses "sessionToken".
                    # The SSID is sent to PO verbatim, so we just track which one
                    # for logging purposes.
                    session = data.get("session", "") or data.get("sessionToken", "")
                    is_chart = bool(data.get("isChart", 0))
                    if is_chart:
                        logger.info("[SCANNER] Chart socket SSID detected (isChart:1)")
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

                    # Start periodic asset refresh loop — nudges PO every 30s to push
                    # a fresh updateAssets snapshot so our payouts stay in sync with PO's UI.
                    # Without this, payouts become stale within minutes (PO changes payouts
                    # second-by-second but only pushes updateAssets when nudged or when
                    # significant changes occur).
                    if self._asset_refresh_task is None or self._asset_refresh_task.done():
                        self._asset_refresh_task = asyncio.create_task(self._asset_refresh_loop())

                    # Start tick status logger — logs tick buffer + candle count
                    # every 30s so we can see the system warming up
                    if self._tick_status_task is None or self._tick_status_task.done():
                        self._tick_status_task = asyncio.create_task(self._tick_status_logger_loop())

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
        if self._asset_refresh_task and not self._asset_refresh_task.done():
            self._asset_refresh_task.cancel()
            self._asset_refresh_task = None
        if self._tick_status_task and not self._tick_status_task.done():
            self._tick_status_task.cancel()
            self._tick_status_task = None
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
                    self._last_message_time = datetime.now(timezone.utc)
                    try:
                        # Use the new binary attachment reassembly path
                        await self._process_binary_frame(message)
                    except Exception as e:
                        logger.error(f"[SCANNER] Error handling binary frame: {e}")
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

    @staticmethod
    def _find_placeholders(obj):
        """Recursively find all Socket.IO v4 binary placeholders in a JSON structure.

        Placeholders look like: {"_placeholder": True, "num": N}
        Returns a list of (path, num) tuples where path is a list of indices/keys
        to reach the placeholder in the nested structure.
        """
        placeholders = []

        def search(o, path=None):
            if path is None:
                path = []
            if isinstance(o, dict):
                if o.get("_placeholder") is True and "num" in o:
                    placeholders.append({"path": path, "num": o["num"]})
                else:
                    for k, v in o.items():
                        search(v, path + [k])
            elif isinstance(o, list):
                for i, item in enumerate(o):
                    search(item, path + [i])

        search(obj)
        return placeholders

    @staticmethod
    def _substitute_placeholder(obj, path, value):
        """Replace the placeholder at the given path with value (in-place)."""
        target = obj
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    @staticmethod
    def _decode_binary_frame(data: bytes):
        """Decode a Socket.IO v4 binary attachment frame to a Python object.

        Binary frames are typically UTF-8-encoded JSON (PocketOption uses
        this for the asset list and candle arrays). Sometimes they're raw
        bytes (binary protobuf etc.) — we return None in that case.
        """
        try:
            text = data.decode('utf-8')
            return json.loads(text)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    async def _process_binary_frame(self, data: bytes):
        """Process an incoming binary frame.

        Socket.IO v4 binary attachment protocol:
          1. Server sends text frame: 451-["eventName", {"_placeholder": true, "num": 0}]
          2. Server sends N binary frames, one per placeholder
          3. Each binary frame replaces its corresponding placeholder by `num` index

        We buffer text frames with placeholders, then substitute binary frames
        as they arrive. Once all placeholders are filled, the event is dispatched.
        """
        if not self._pending_binary_events:
            # No pending events — fall back to legacy behavior (try as raw assets)
            try:
                text = data.decode('utf-8')
                if text.startswith('[') or text.startswith('{'):
                    try:
                        parsed = json.loads(text)
                        if isinstance(parsed, list):
                            await self._parse_assets_list(parsed)
                        elif isinstance(parsed, dict):
                            await self._parse_assets_dict(parsed)
                    except (json.JSONDecodeError, ValueError):
                        pass
                else:
                    await self._handle_message(text)
            except UnicodeDecodeError:
                await self._handle_binary_data(data)
            return

        # Take the oldest pending event
        pending = self._pending_binary_events[0]
        decoded = self._decode_binary_frame(data)

        if decoded is None:
            # Couldn't decode as JSON — store raw bytes (rare case)
            pending["binaries_received"].append({"num": len(pending["binaries_received"]), "raw": data})
        else:
            pending["binaries_received"].append({"num": len(pending["binaries_received"]), "data": decoded})

        # Check if we have all binaries
        if len(pending["binaries_received"]) >= pending["placeholders_needed"]:
            # Substitute binaries into the event_data
            event_data = pending["event_data"]
            placeholders = self._find_placeholders(event_data)
            binaries_sorted = sorted(pending["binaries_received"], key=lambda b: b["num"])

            for i, ph in enumerate(placeholders):
                if i < len(binaries_sorted):
                    binary = binaries_sorted[i]
                    if "data" in binary:
                        self._substitute_placeholder(event_data, ph["path"], binary["data"])

            # Dispatch the now-complete event
            event_name = pending["event_name"]
            self._pending_binary_events.pop(0)

            logger.info(
                f"[SCANNER] Binary event reassembled: '{event_name}' "
                f"({len(placeholders)} placeholder(s) filled)"
            )
            await self._handle_event(event_name, event_data)

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
                data = json.loads(json_part)
                event_name = data[0] if isinstance(data, list) and data else ""
                event_data = data[1:] if len(data) > 1 else []

                # ─── Socket.IO v4 binary attachment reassembly ────────
                # Count placeholders in event_data. If any element is a dict
                # with {"_placeholder": True, "num": N}, the actual data
                # arrives as binary frames AFTER this text frame.
                placeholders = self._find_placeholders(event_data)
                if placeholders:
                    # Buffer this event — wait for binary frames to arrive
                    self._pending_binary_events.append({
                        "event_name": event_name,
                        "event_data": event_data,
                        "placeholders_needed": len(placeholders),
                        "binaries_received": [],
                    })
                    logger.debug(
                        f"[SCANNER] Binary event buffered: '{event_name}' "
                        f"waiting for {len(placeholders)} binary frame(s)"
                    )
                    # Update auth state if applicable
                    if event_name in ("updateAssets", "successauth", "successAuth", "successUpdateBalance"):
                        if not self._is_authenticated:
                            self._is_authenticated = True
                            self._auth_event.set()
                            logger.info(f"[SCANNER] ✅ Authentification réussie (via binary event: {event_name})")
                    elif event_name in ("NotAuthorized", "notAuthorized"):
                        self._is_authenticated = False
                        self._auth_event.set()
                        logger.error("[SCANNER] ❌ Authentification refusée (via binary event)")
                    return  # Don't dispatch yet — wait for binaries

                # No placeholders — dispatch immediately
                logger.debug(f"[SCANNER] Binary event (no placeholders): {event_name}")

                # Auth success events
                if event_name in ("updateAssets", "successauth", "successAuth", "successUpdateBalance"):
                    if not self._is_authenticated:
                        self._is_authenticated = True
                        self._auth_event.set()
                        logger.info(f"[SCANNER] ✅ Authentification réussie (via binary event: {event_name})")
                elif event_name in ("NotAuthorized", "notAuthorized"):
                    self._is_authenticated = False
                    self._auth_event.set()
                    logger.error("[SCANNER] ❌ Authentification refusée (via binary event)")

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
           14   → is_active (bool) ← FALSE = greyed out / inactive in PO UI
           15   → timeframes (list of dicts)
           16   → start_time (int, unix timestamp; -1 = N/A)
           17   → default_timeframe (int, seconds)
           18   → status_code (int, unix timestamp)

        CRITICAL: PO keeps stale payout values in the payload for greyed-out
        (inactive) pairs. We MUST read is_active at index [14] and only treat
        a pair as ELIGIBLE when is_active=True AND payout >= 70. Inactive pairs
        are NEVER displayed — they are filtered out entirely from all outputs.

        FRESHNESS: PO pushes this payload once at auth, then again at
        unpredictable intervals (timing decided by PO's internal logic).
        We nudge PO every 5s via _asset_refresh_loop so our view stays within
        ~5s of what PO's UI shows. Each call updates self._payouts in-place.
        """
        count = 0
        active_count = 0
        inactive_count = 0
        try:
            # ─── Freshness bookkeeping ────────────────────────────────────
            # Mark this exact moment as the latest updateAssets snapshot. The
            # debug endpoint exposes this so users can verify our payouts aren't
            # stale (e.g., if user sees payouts don't match PO UI, they can check
            # `last_assets_update_age_seconds` — if it's >60s, data is stale).
            self._last_assets_update = datetime.now(timezone.utc)
            self._assets_received_count += 1
            snapshot_num = self._assets_received_count

            # Log a sample so we can verify the format matches our parser
            # (only for first 3 snapshots to avoid log spam)
            if assets and isinstance(assets[0], list) and snapshot_num <= 3:
                sample = assets[0]
                logger.info(f"[SCANNER] updateAssets #{snapshot_num} sample (len={len(sample)}): {sample[:19]}")

            now_iso = datetime.now(timezone.utc).isoformat()

            # Track payout changes for the first 5 snapshots (for debugging)
            changes_detected = 0
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

                # Detect payout changes (for logging only — helps verify real-time updates)
                existing = self._payouts.get(symbol)
                if existing is not None:
                    if existing.get("payout") != payout or existing.get("is_active") != is_active:
                        changes_detected += 1
                        if snapshot_num <= 5 and changes_detected <= 5:
                            logger.info(
                                f"[SCANNER] Payout change detected: {symbol} "
                                f"{existing.get('payout')}%/{existing.get('is_active')} → "
                                f"{payout}%/{is_active}"
                            )

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
                # Mark last change time if any payouts changed
                if changes_detected > 0:
                    self._last_payout_change = datetime.now(timezone.utc)

                # Log OTC forex samples so user can verify against PO's UI.
                # Only ACTIVE pairs are ever used by the system; inactive pairs
                # are tracked internally for refresh detection but never displayed.
                # For snapshot #1 (initial) we always log; for later snapshots we
                # only log if changes were detected (to avoid log spam).
                should_log = (snapshot_num <= 3) or (changes_detected > 0)
                if should_log:
                    active_otc_items = [
                        (k, v["payout"]) for k, v in self._payouts.items()
                        if "_otc" in k.lower() and v["is_active"]
                    ][:8]
                    logger.info(
                        f"[SCANNER] updateAssets #{snapshot_num} parsed: {count} total "
                        f"({active_count} active, {inactive_count} inactive, "
                        f"{changes_detected} changes since last). "
                        f"Active OTC samples: {dict(active_otc_items)}. "
                        f"({inactive_count} inactive pairs hidden — not displayed)"
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

        # updateStream — PO's LIVE TICK STREAM. This is how PO's modern API
        # delivers price data. Each event contains [asset, timestamp, price].
        # We aggregate ticks into 1-minute OHLC candles.
        # This is the BREAKTHROUGH — PO doesn't send historical candles on
        # the main socket; it sends live ticks that we must aggregate ourselves.
        if event_name.lower() == "updatestream":
            try:
                await self._process_tick_stream(event_data)
            except Exception as e:
                logger.debug(f"[SCANNER] updateStream parse error: {e}")
            return

        # Candles data — PO's modern API uses 'loadHistoryPeriod' for the
        # initial candle response and 'updateHistoryNew' for incremental
        # updates. (Discovered by reading the pocketoptionapi-async library
        # source code — PO's protocol changed; old 'candles' event name
        # no longer exists in the modern API.)
        if event_name.lower() in (
            "candles", "candlesdata", "quote", "quotes",
            "getcandles", "getcandlesdata", "history",
            "loadhistory", "loadcandles", "candleslist",
            "ohlc", "ohlcv", "chartdata", "chartdataupdate",
            "updatecharts",  # chart configuration event
            "loadhistoryperiod",  # ← PO's actual candle response event
            "updatehistorynew",  # ← PO's incremental candle update event
        ):
            try:
                logger.info(
                    f"[SCANNER] Candle event received: '{event_name}' "
                    f"data_preview={str(event_data)[:500]}"
                )
                await self._parse_candles(event_name, event_data)
            except Exception as e:
                logger.warning(f"[SCANNER] Candles parse error for '{event_name}': {e}")
            return

        # updateAsset (singular) — discovered in production 2026-06-18.
        # PO sends this for incremental asset updates. Same format as
        # updateAssets but with a single asset (or small list) instead of
        # the full 183-asset snapshot.
        if event_name.lower() in ("updateasset", "updateassets", "assets"):
            try:
                if event_data:
                    assets = event_data[0]
                    if isinstance(assets, list):
                        # Could be a single asset or list of assets
                        if assets and isinstance(assets[0], (list, tuple)):
                            await self._parse_assets_list(assets)
                        else:
                            # Single asset wrapped in a list
                            await self._parse_assets_list([assets])
                    elif isinstance(assets, dict):
                        await self._parse_assets_dict(assets)
            except Exception as e:
                logger.debug(f"[SCANNER] updateAsset parse error: {e}")
            return

        # Other events — log at DEBUG level only (not INFO) to avoid
        # flooding the logs and blocking the async event loop.
        # Hundreds of log lines per second (from updateStream ticks) was
        # blocking the event loop → PONG messages delayed → PO disconnects.
        logger.debug(f"[SCANNER] Event '{event_name}': {str(event_data)[:200]}")

    async def _process_tick_stream(self, event_data):
        """Process live price ticks from PO's 'updateStream' event.

        PO's modern API sends real-time price updates. The binary attachment
        reassembly produces a deeply-nested structure:
            event_data = [[[[asset, ts, price]]]]
                       or [[[[asset, ts, price], [asset, ts, price], ...]]]
        We recursively unwrap until we find the actual tick arrays.
        """
        if not event_data:
            return

        try:
            # Recursively extract all ticks from any nesting depth.
            # A "tick" is a list where index 0 is a string (asset name).
            ticks_to_process = []

            def extract_ticks(obj):
                """Recursively find all [asset, ts, price] ticks in nested lists."""
                if isinstance(obj, list):
                    if len(obj) >= 3 and isinstance(obj[0], str):
                        # This looks like a tick: [asset, ts, price, ...]
                        ticks_to_process.append(obj)
                    else:
                        # Recurse into each element
                        for item in obj:
                            extract_ticks(item)
                # Don't process dicts or scalars

            extract_ticks(event_data)

            if not ticks_to_process:
                # Log at INFO so we can see the structure when extraction fails
                logger.info(
                    f"[SCANNER-TICK-EXTRACT-FAIL] structure={str(event_data)[:500]}"
                )
                return

            for tick in ticks_to_process:
                try:
                    asset = str(tick[0])
                    ts = float(tick[1])
                    price = float(tick[2])

                    if not asset:
                        continue

                    # ═══ FOREX-ONLY FILTER ════════════════════════════
                    # A2Sniper is dedicated to FOREX currency pairs ONLY.
                    # Filter out stocks (AMD, AAPL, GME, MARA), crypto
                    # (BTC, ETH, AVAX, BITB), commodities, etc.
                    # This saves resources and ensures we only analyze
                    # the asset class the system was designed for.
                    if _FOREX_FILTER_AVAILABLE and not _is_forex_pair(asset):
                        continue  # silently skip non-forex assets

                    # Buffer the tick
                    if asset not in self._tick_buffer:
                        self._tick_buffer[asset] = []
                        logger.info(
                            f"[SCANNER-FIRST-TICK] asset={asset} price={price:.5f} "
                            f"ts={datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()}"
                        )
                    self._tick_buffer[asset].append((ts, price))
                except (ValueError, TypeError, IndexError) as e:
                    logger.warning(f"[SCANNER-TICK-PARSE-ERROR] err={e} tick={tick}")

            # Aggregate periodically (not on every tick — too expensive)
            # Only aggregate if last aggregation was >5 seconds ago
            now = datetime.now(timezone.utc).timestamp()
            if not hasattr(self, '_last_aggregation_time'):
                self._last_aggregation_time = 0
            if now - self._last_aggregation_time > 5.0:
                self._last_aggregation_time = now
                self._aggregate_ticks_into_candles()

        except Exception as e:
            # Log at WARNING level (not DEBUG) so it's visible in Railway
            logger.warning(f"[SCANNER-TICK-PROCESS-ERROR] err={e}", exc_info=True)

    def _aggregate_ticks_into_candles(self):
        """Aggregate buffered ticks into 1-minute OHLC candles.

        For each asset in _tick_buffer:
        1. Group ticks by 1-minute windows (floor to 60s)
        2. For each minute that is COMPLETE (i.e., the NEXT minute has started,
           meaning we've seen at least one tick from a later minute — this is
           a robust way to detect completeness without relying on server clock):
           open=first, high=max, low=min, close=last, volume=count
        3. Append new candles to _candles_cache[asset_1m]
        4. Keep only the last 200 candles (enough for EMA_200)
        5. Remove processed ticks from the buffer (keep only the latest minute)

        NOTE: We do NOT use server time (datetime.now) to determine which
        minute is "current" — PO's clock may differ from the server's clock,
        which would cause every minute to appear "current" and get skipped
        forever. Instead, we use the LATEST tick timestamp as the reference:
        any minute strictly older than the latest tick's minute is considered
        complete.
        """
        import numpy as np

        for asset, ticks in list(self._tick_buffer.items()):
            if not ticks:
                continue

            # Sort by timestamp
            ticks.sort(key=lambda t: t[0])

            # Group by 1-minute windows (floor timestamp to 60s)
            candles_by_minute = {}
            for ts, price in ticks:
                minute_key = int(ts // 60) * 60  # floor to minute boundary
                if minute_key not in candles_by_minute:
                    candles_by_minute[minute_key] = []
                candles_by_minute[minute_key].append(price)

            if not candles_by_minute:
                continue

            # Use the LATEST tick's minute as "current" — any minute strictly
            # older than this is complete (we've moved past it).
            # This is robust against server/PO clock drift.
            latest_minute = max(candles_by_minute.keys())

            cache_key = f"{asset}_1m"
            existing_df = self._candles_cache.get(cache_key)
            existing_times = set()
            if existing_df is not None and not existing_df.empty:
                existing_times = set(existing_df.index.floor('min').astype('int64') // 10**9)

            new_rows = []
            for minute_ts, prices in sorted(candles_by_minute.items()):
                # Skip the latest (still accumulating) minute
                if minute_ts >= latest_minute:
                    continue
                # Skip if we already have this candle
                if minute_ts in existing_times:
                    continue

                o = prices[0]
                h = max(prices)
                l = min(prices)
                c = prices[-1]
                v = float(len(prices))
                new_rows.append((minute_ts, o, h, l, c, v))

            if not new_rows:
                continue

            # Build new candle rows
            new_df = pd.DataFrame(
                new_rows, columns=["ts", "open", "high", "low", "close", "volume"]
            )
            new_df["time"] = pd.to_datetime(new_df["ts"], unit="s", utc=True)
            new_df = new_df.set_index("time").drop(columns=["ts"])

            # Merge with existing candles
            if existing_df is not None and not existing_df.empty:
                combined = pd.concat([existing_df, new_df])
                combined = combined[~combined.index.duplicated(keep='last')]
                combined = combined.sort_index()
                # Keep last 200 candles
                combined = combined.tail(200)
            else:
                combined = new_df.tail(200)

            self._candles_cache[cache_key] = combined

            # Log new candles — but only every 5th candle to reduce log volume
            # (was logging every candle → hundreds of lines/min with 50+ assets)
            for i, (_, row) in enumerate(new_df.iterrows()):
                if i % 5 == 0 or len(new_df) <= 5:  # Log first + every 5th
                    logger.info(
                        f"[SCANNER-CANDLE-BUILT] asset={asset} tf=1m "
                        f"O={row['open']:.5f} H={row['high']:.5f} L={row['low']:.5f} "
                        f"C={row['close']:.5f} ticks={int(row['volume'])} "
                        f"total_candles={len(combined)}"
                    )

            # Clean up processed ticks (keep only the latest minute's ticks)
            current_minute_ticks = [(ts, p) for ts, p in ticks if int(ts // 60) * 60 >= latest_minute]
            self._tick_buffer[asset] = current_minute_ticks

    async def _tick_status_logger_loop(self):
        """Periodically log tick buffer status so we can see the system warming up.

        Runs every 30 seconds, logs:
        - How many assets are receiving ticks
        - How many candles have been built per asset
        - How many ticks are in the current minute buffer
        """
        try:
            while self._ws and self._ws_is_open() and self._is_authenticated:
                await asyncio.sleep(60)  # every 60s (was 30s — reduce log volume)
                if not self._tick_buffer:
                    continue

                status_parts = []
                total_candles = 0
                for asset, ticks in sorted(self._tick_buffer.items()):
                    candle_count = len(self._candles_cache.get(f"{asset}_1m", pd.DataFrame()))
                    total_candles += candle_count
                    status_parts.append(f"{asset}: {candle_count} candles, {len(ticks)} ticks")

                logger.info(
                    f"[SCANNER-TICK-STATUS] assets={len(self._tick_buffer)} "
                    f"total_candles={total_candles} "
                    f"details=[{' | '.join(status_parts[:5])}]"
                    f"{' ...' if len(status_parts) > 5 else ''}"
                )

                # Also force aggregation in case the tick processor hasn't run it recently
                self._aggregate_ticks_into_candles()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"[SCANNER] Tick status logger error: {e}")

    async def _parse_candles(self, event_name: str, event_data: list):
        """Parse candle data from PocketOption WebSocket events.

        PocketOption responds to `42["getCandles","{asset}",{tf_sec},{count}]`
        with a Socket.IO event whose payload contains the asset symbol, the
        timeframe, and an array of OHLCV candles.

        Known PO response shapes (handled defensively — PO has shipped several
        variants over the years, all observed in production captures):

          Shape A (most common, post-2023):
            event_name = "candles"
            event_data = [{
              "asset": "EURUSD_otc",
              "timeframe": 60,                       # seconds
              "candles": [
                [ts, open, high, low, close, volume],  # positional
                ...
              ]
            }]

          Shape B (older, also still seen):
            event_name = "candles"
            event_data = ["EURUSD_otc", 60, [
                {"time": ts, "open": o, "high": h, "low": l, "close": c, "volume": v},
                ...
            ]]

          Shape C (candlesData — streamed incremental updates):
            event_name = "candlesData"
            event_data = [{
              "asset": "EURUSD_otc",
              "timeframe": 60,
              "data": [[ts, o, h, l, c, v], ...]
            }]

          Shape D (quote — single-tick / current price):
            event_name = "quote"
            event_data = [{
              "asset": "EURUSD_otc",
              "price": 1.0825,
              "time": ts
            }]

        This parser normalises all four shapes into a DataFrame with columns
        ['open','high','low','close','volume'] indexed by a UTC DatetimeIndex,
        then writes it to `self._candles_cache[f"{asset}_{tf_min}m"]` so that
        `get_candles()` (which polls that cache) can return it.

        The cache key MUST match what `get_candles()` reads at line ~957:
            cache_key = f"{asset}_{timeframe}"     # e.g. "EURUSD_otc_1m"
        so we normalise the timeframe to the string form ("1m","5m","15m",...)
        used by `get_candles()`.
        """
        import numpy as np
        from datetime import datetime as _dt

        try:
            if not event_data:
                return

            payload = event_data[0] if isinstance(event_data, list) and event_data else event_data

            # ─── Extract asset, timeframe, and raw candle list ────────────
            asset = None
            tf_sec = None
            raw_candles = None

            # Shape A / C / loadHistoryPeriod: dict with "asset" + "candles" or "data"
            # PO's modern API (loadHistoryPeriod event) sends:
            #   {"asset": "EURUSD_otc", "period": 60, "candles": [[ts,o,c,h,l,v], ...]}
            if isinstance(payload, dict):
                asset = payload.get("asset") or payload.get("symbol") or payload.get("pair")
                tf_sec = payload.get("timeframe") or payload.get("tf") or payload.get("period")
                raw_candles = (
                    payload.get("candles")
                    or payload.get("data")
                    or payload.get("candlesData")
                    or payload.get("quotes")
                    or payload.get("history")  # some PO versions use this
                )

            # Shape E (updateCharts): dict with nested "settings" containing
            # chart config. PO sends this on the main socket to push chart
            # configuration. Discovered in production 2026-06-18.
            # Sample: [{'chart_id': 'chart-1', 'settings': {'symbol': 'AUDUSD',
            #   'period': 4, 'candlesTimer': true, 'fastTimeframe': 60, ...}}]
            #
            # NOTE: 'updateCharts' alone contains only chart CONFIGURATION —
            # no candle data. The actual candles arrive via a separate event
            # (probably 'updateChartCandles' or 'chartCandles' — TBD via
            # debug logs). We still process this so we know which symbol
            # is currently active on the chart.
            if event_name.lower() == "updatecharts" and isinstance(payload, dict):
                settings = payload.get("settings", {})
                asset = settings.get("symbol") or settings.get("asset") or asset
                # PO uses 'period' (NOT 'chartPeriod' as I assumed earlier).
                # 'period' is an INDEX into the timeframe list
                # [60, 120, 180, 300, 600, 900, 1800, 2700, 3600, 7200, 10800, 14400]
                period_idx = settings.get("period", settings.get("chartPeriod"))
                if period_idx is not None:
                    tf_list = [60, 120, 180, 300, 600, 900, 1800, 2700, 3600, 7200, 10800, 14400]
                    try:
                        tf_sec = tf_list[int(period_idx)]
                    except (IndexError, ValueError, TypeError):
                        pass
                # 'fastTimeframe' may also be the actual candle timeframe in seconds
                if not tf_sec and settings.get("fastTimeframe"):
                    try:
                        tf_sec = int(settings["fastTimeframe"])
                    except (ValueError, TypeError):
                        pass
                # Look for candle data in various places — updateCharts
                # alone usually has no candles, but check just in case PO
                # bundles them on the initial push.
                raw_candles = (
                    settings.get("candles")
                    or settings.get("data")
                    or settings.get("history")
                    or settings.get("quotes")
                    or settings.get("candlesData")
                    or payload.get("candles")
                    or payload.get("data")
                    or payload.get("history")
                    or raw_candles
                )
                logger.info(
                    f"[SCANNER] updateCharts: asset={asset}, tf_sec={tf_sec}, "
                    f"period_idx={period_idx}, fastTimeframe={settings.get('fastTimeframe')}, "
                    f"candles_found={raw_candles is not None}"
                )

            # Shape B: list/tuple [asset, timeframe, candles]
            elif isinstance(payload, (list, tuple)) and len(payload) >= 3:
                asset = payload[0]
                tf_sec = payload[1]
                raw_candles = payload[2]

            # Shape D: single quote — synthesise a 1-candle DataFrame so
            # get_current_price() (which calls get_candles(count=1)) works.
            if event_name == "quote" and isinstance(payload, dict):
                price = payload.get("price") or payload.get("value") or payload.get("close")
                ts = payload.get("time") or payload.get("timestamp")
                if price is None:
                    return
                try:
                    price = float(price)
                    ts_int = int(ts) if ts else int(datetime.now(timezone.utc).timestamp())
                    # Use the asset from payload; if absent, skip (can't cache safely)
                    if not asset:
                        return
                    df = pd.DataFrame(
                        {"open": [price], "high": [price], "low": [price],
                         "close": [price], "volume": [0]},
                        index=pd.DatetimeIndex(
                            [pd.Timestamp(ts_int, unit="s", tz="UTC")], name="time"
                        ),
                    )
                    cache_key = f"{asset}_1m"  # quotes are typically 1-minute aligned
                    self._candles_cache[cache_key] = df
                    logger.debug(f"[SCANNER] Quote cached for {asset} → {price}")
                except (ValueError, TypeError) as e:
                    logger.debug(f"[SCANNER] Quote parse error: {e}")
                return

            # Validate
            if not asset or not isinstance(asset, str):
                logger.info(
                    f"[SCANNER] _parse_candles: no asset in payload ({event_name}). "
                    f"Payload keys: {list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__}, "
                    f"payload_preview={str(payload)[:500]}"
                )
                return
            if raw_candles is None or not isinstance(raw_candles, (list, tuple)) or len(raw_candles) == 0:
                logger.info(
                    f"[SCANNER] _parse_candles: no candle rows for {asset} ({event_name}). "
                    f"Payload keys: {list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__}, "
                    f"settings_keys: {list(payload.get('settings', {}).keys()) if isinstance(payload, dict) and isinstance(payload.get('settings'), dict) else 'N/A'}, "
                    f"payload_preview={str(payload)[:800]}"
                )
                return

            # Normalise asset symbol (PO uses "EURUSD_otc"; some events send "#EURUSD")
            asset_norm = asset.strip()
            # Strip a leading "#" if present (stock symbols use "#AAPL" form)
            if asset_norm.startswith("#"):
                asset_norm = asset_norm[1:]

            # Normalise timeframe to seconds, then to the "Nm"/"Nh" string form
            try:
                tf_sec_int = int(tf_sec) if tf_sec is not None else 60
            except (ValueError, TypeError):
                tf_sec_int = 60

            tf_str = self._tf_seconds_to_str(tf_sec_int)

            # ─── Build the DataFrame ─────────────────────────────────────
            # Accumulate rows in a Python list first (faster than growing a DataFrame),
            # then construct once. Each row is (timestamp, o, h, l, c, v).
            #
            # IMPORTANT: PO's loadHistoryPeriod event uses a DIFFERENT array
            # order than the old 'candles' event:
            #   Old format:    [ts, open, high, low, close, volume]  (close at idx 4)
            #   New format:    [ts, open, close, high, low, volume]  (close at idx 2!)
            # We detect which format by checking if h_v >= max(o, c, l) — if not,
            # the array is in the new format (close before high/low).
            rows = []
            for candle in raw_candles:
                try:
                    # Positional form
                    if isinstance(candle, (list, tuple)):
                        if len(candle) < 5:
                            continue
                        ts_v = candle[0]
                        v_v = candle[5] if len(candle) > 5 else 0.0

                        # Try OLD format first: [ts, open, HIGH, LOW, CLOSE, v]
                        o_try = float(candle[1])
                        h_try = float(candle[2])
                        l_try = float(candle[3])
                        c_try = float(candle[4])

                        if h_try >= max(o_try, c_try, l_try) and l_try <= min(o_try, c_try, h_try):
                            # Old format is consistent
                            o_v, h_v, l_v, c_v = o_try, h_try, l_try, c_try
                        else:
                            # NEW format (loadHistoryPeriod): [ts, open, CLOSE, HIGH, LOW, v]
                            # Per pocketoptionapi-async library source: candle_data[2] is close,
                            # candle_data[3] is high, candle_data[4] is low
                            o_v = float(candle[1])
                            c_v = float(candle[2])
                            h_v = float(candle[3])
                            l_v = float(candle[4])
                    # Dict form: {"time"/"timestamp", "open", "high", "low", "close", "volume"}
                    elif isinstance(candle, dict):
                        ts_v = candle.get("time") or candle.get("timestamp") or candle.get("t")
                        o_v = candle.get("open") or candle.get("o")
                        h_v = candle.get("high") or candle.get("h")
                        l_v = candle.get("low") or candle.get("l")
                        c_v = candle.get("close") or candle.get("c")
                        v_v = candle.get("volume") or candle.get("vol") or candle.get("v") or 0.0
                    else:
                        continue

                    # Type coercion — PO sends timestamps as unix seconds (int)
                    ts_int = int(float(ts_v)) if ts_v is not None else None
                    if ts_int is None:
                        continue
                    o_v = float(o_v); h_v = float(h_v); l_v = float(l_v)
                    c_v = float(c_v); v_v = float(v_v)

                    # Sanity: high must be >= max(open, close, low), low <= min(...)
                    if not (h_v >= max(o_v, c_v, l_v) and l_v <= min(o_v, c_v, h_v)):
                        # Repair: clamp to the obvious values
                        h_v = max(o_v, c_v, h_v, l_v)
                        l_v = min(o_v, c_v, h_v, l_v)

                    rows.append((ts_int, o_v, h_v, l_v, c_v, v_v))
                except (ValueError, TypeError, IndexError):
                    continue

            if not rows:
                logger.debug(f"[SCANNER] _parse_candles: 0 valid rows for {asset} ({event_name})")
                return

            # Construct the DataFrame — sort by timestamp, deduplicate, drop
            # duplicates on the index (PO occasionally re-sends the last
            # candle of the previous batch as the first of the new one).
            df = pd.DataFrame(
                rows, columns=["ts", "open", "high", "low", "close", "volume"]
            )
            df["time"] = pd.to_datetime(df["ts"], unit="s", utc=True)
            df = df.drop_duplicates(subset=["ts"]).sort_values("ts").set_index("time")
            df = df.drop(columns=["ts"])

            # If volume is all-zero, replace with NaN so indicators that use
            # volume (OBV, volume ratio) handle it gracefully.
            if (df["volume"] == 0).all():
                df["volume"] = np.nan

            cache_key = f"{asset_norm}_{tf_str}"
            self._candles_cache[cache_key] = df

            logger.info(
                f"[SCANNER] Candles cached: {asset_norm} {tf_str} "
                f"({len(df)} bars, last close={df['close'].iloc[-1]:.5f})"
            )

            # ─── Persist to CandleAccumulator for future retraining ────
            # The accumulator deduplicates by (symbol, timestamp) and appends
            # to backend/data/live_candles.csv. Once enough data accumulates
            # (~50k rows across 3+ pairs, typically 1-2 days of live trading),
            # the retraining_loop will use this REAL market data instead of
            # the synthetic GBM dataset the model was originally trained on.
            try:
                from .candle_accumulator import get_accumulator
                accumulator = await get_accumulator()
                # Convert DataFrame rows back to list of dicts for the accumulator
                candle_rows = []
                for ts, row in df.iterrows():
                    candle_rows.append({
                        "timestamp": int(ts.timestamp()),
                        "open": float(row["open"]),
                        "high": float(row["high"]),
                        "low": float(row["low"]),
                        "close": float(row["close"]),
                        "volume": float(row["volume"]) if not pd.isna(row["volume"]) else 0.0,
                    })
                appended = await accumulator.append(asset_norm, candle_rows)
                if appended > 0:
                    logger.debug(
                        f"[SCANNER] Accumulated {appended} new candles for {asset_norm} "
                        f"(total in file: {accumulator._total_rows_appended:,})"
                    )
            except Exception as accum_err:
                # Accumulator failure must NOT break signal generation
                logger.debug(f"[SCANNER] Accumulator skipped: {accum_err}")
        except Exception as e:
            logger.error(f"[SCANNER] _parse_candles error ({event_name}): {e}", exc_info=True)

    @staticmethod
    def _tf_seconds_to_str(tf_sec: int) -> str:
        """Map a timeframe in seconds to the string form used by get_candles().

        get_candles() accepts: "1m", "5m", "15m", "30m", "1h", "4h", "1d"
        (see `tf_seconds` dict at line ~940). We invert that mapping here so
        the cache key written by `_parse_candles` matches the key read by
        `get_candles`. Unknown values default to "1m" (PO's most common).
        """
        mapping = {
            60: "1m", 300: "5m", 900: "15m", 1800: "30m",
            3600: "1h", 14400: "4h", 86400: "1d",
        }
        return mapping.get(int(tf_sec), "1m")

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
                await asyncio.sleep(60)  # every 60s (was 15s — too noisy)
                if not self._is_authenticated:
                    logger.warning("[SCANNER] Health check: not authenticated")
                elif self._ws and not self._ws_is_open():
                    logger.warning("[SCANNER] Health check: WebSocket closed")
                    self._is_authenticated = False
                else:
                    # NOTE: PO pushes the full asset list (updateAssets) once at
                    # auth, then only sends incremental `payout` events as values
                    # change. The "stale" check below was a false alarm — data
                    # is NOT stale just because updateAssets hasn't been re-pushed.
                    # The real freshness signal is `last_payout_change` (incremental
                    # updates) or simply whether we have ANY payouts in store.
                    if self._payouts:
                        active_count = sum(1 for v in self._payouts.values() if v.get("is_active"))
                        last_change_age = (
                            (datetime.now(timezone.utc) - self._last_payout_change).total_seconds()
                            if self._last_payout_change else None
                        )
                        logger.debug(
                            f"[SCANNER] Health check: OK "
                            f"({len(self._payouts)} pairs total, {active_count} active, "
                            f"last payout change: "
                            f"{f'{last_change_age:.0f}s ago' if last_change_age else 'never'})"
                        )
                    else:
                        logger.warning(
                            "[SCANNER] Health check: no asset data received yet — "
                            "scanner may not be properly subscribed"
                        )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[SCANNER] Health check error: {e}")

    async def _asset_refresh_loop(self):
        """Periodically nudge PO to push a fresh `updateAssets` snapshot.

        PROBLEM: PO pushes the full asset list (with payouts) once at auth time.
        After that, PO only pushes new snapshots at unpredictable intervals —
        could be seconds, minutes, or longer. The timing is decided by PO's
        internal logic (market sessions, liquidity, trader volume) and is NOT
        predictable from our side.

        SOLUTION: Every 5 seconds, send `42["ps"]` (PO's keep-alive/state
        request). PO responds by pushing a fresh `[[5, ...], ...]` payload,
        which our receive loop picks up and routes to `_parse_assets_list`.

        This keeps our payouts within ~5s of what PO's UI shows. When a pair
        becomes inactive (or active) on PO, our system reflects that change
        within at most 5 seconds — so users never see stale pair lists.
        """
        try:
            # Wait 3s after auth before first nudge (let initial data arrive first)
            await asyncio.sleep(3)
            while self._ws and self._ws_is_open() and self._is_authenticated:
                try:
                    # Send a state request — PO typically responds with a fresh asset snapshot
                    await self._ws.send('42["ps"]')
                    logger.debug("[SCANNER] Asset refresh nudge sent: 42[\"ps\"]")
                except Exception as e:
                    logger.warning(f"[SCANNER] Asset refresh nudge failed: {e}")
                    break
                # Wait 5s before next nudge — keeps our view of PO's state
                # within ~5s of what PO's UI actually shows.
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[SCANNER] Asset refresh loop error: {e}")

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
                # Small delay between nudges to avoid flooding PO
                await asyncio.sleep(0.3)
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
            # Even without WS auth, the HTTP fallback is a public endpoint
            # and may still return data — try it before giving up.
            asset = self.get_asset_symbol(pair)
            tf_seconds = {
                "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
                "1h": 3600, "4h": 14400, "1d": 86400,
            }
            tf_sec = tf_seconds.get(timeframe, 60)
            df = await self._fetch_candles_http(asset, tf_sec, count)
            if not df.empty:
                return df
            return pd.DataFrame()

        asset = self.get_asset_symbol(pair)
        
        # Map timeframe to seconds
        tf_seconds = {
            "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
            "1h": 3600, "4h": 14400, "1d": 86400,
        }
        tf_sec = tf_seconds.get(timeframe, 60)

        try:
            cache_key = f"{asset}_{timeframe}"

            # ═══ CHECK TICK-AGGREGATED CANDLES FIRST ═══════════════════
            # PO's modern API sends live ticks via 'updateStream' events.
            # We aggregate them into 1-minute candles in real-time.
            # If we already have tick-aggregated candles, return them
            # immediately — no need to send WS requests that will timeout.
            if cache_key in self._candles_cache:
                df = self._candles_cache.get(cache_key)
                if df is not None and not df.empty:
                    logger.info(
                        f"[SCANNER-CANDLE-HIT] asset={asset} tf={timeframe} "
                        f"bars={len(df)} last_close={df['close'].iloc[-1]:.5f}"
                    )
                    return df.copy()

            # If we have ticks in the buffer but not enough candles yet,
            # log the warming-up status
            if asset in self._tick_buffer and len(self._tick_buffer[asset]) > 0:
                tick_count = len(self._tick_buffer[asset])
                existing_candles = len(self._candles_cache.get(cache_key, pd.DataFrame()))
                logger.info(
                    f"[SCANNER-WARMING-UP] asset={asset} candles={existing_candles} "
                    f"ticks={tick_count} min_remaining={max(0, 20 - existing_candles)}"
                )
                # Return what we have (even if < 52 bars) — the caller will
                # decide if it's enough for analysis
                if df is not None and not df.empty:
                    return df.copy()
                return pd.DataFrame()

            # No tick data yet — DON'T send WS candle requests!
            #
            # Previously we sent 11 different request formats per pair
            # (changeSymbol, getCandles, loadHistory, etc.). With 34 pairs
            # in the trading loop, that's 374 WS messages in a burst —
            # PO sees this as FLOODING and DISCONNECTS US.
            #
            # PO's modern API doesn't respond to these requests anyway —
            # candle data comes via the updateStream tick feed, which is
            # already flowing. We just need to WAIT for ticks to accumulate
            # into candles (takes ~60s for the first candle, ~20min for 20).
            #
            # Just log and return empty — the caller will skip analysis.
            logger.info(
                f"[SCANNER-WARMING-UP] asset={asset} — waiting for ticks "
                f"(no WS requests sent to avoid PO flooding/disconnect)"
            )
            return pd.DataFrame()

        except Exception as e:
            logger.error(f"[SCANNER] Erreur récupération bougies ({pair}): {e}")
            df = await self._fetch_candles_http(asset, tf_sec, count)
            if not df.empty:
                return df
            return pd.DataFrame()

    async def _fetch_candles_http(self, asset: str, tf_sec: int, count: int) -> pd.DataFrame:
        """Fallback: fetch candles via PocketOption's public REST API.

        PocketOption exposes historical candles at:
            https://api-eu.po.market/candles?asset={asset}&period={tf_sec}&size={count}
        (and the demo counterpart at https://demo-api-eu.po.market/...).

        This endpoint returns a JSON array of {time, open, high, low, close, volume}
        objects. It's used as a safety net when the WebSocket `getCandles`
        request times out (e.g., during the first 1–2 seconds after auth, before
        PO has finished streaming the asset list).

        Headers mimic the browser to avoid being blocked by PO's edge.
        """
        try:
            import httpx
            import numpy as np

            # Pick the right host based on whether we're on demo or live.
            # `self.is_demo` is set during connect() based on the SSID payload.
            host = "demo-api-eu.po.market" if self.is_demo else "api-eu.po.market"
            url = (
                f"https://{host}/candles"
                f"?asset={asset}&period={tf_sec}&size={count}"
            )

            headers = {
                "Origin": "https://pocketoption.com",
                "Referer": "https://pocketoption.com/",
                "User-Agent": WS_HEADERS["User-Agent"],
                "Accept": "application/json, text/plain, */*",
            }

            # Use the same httpx client with a tight timeout — this is a fallback
            # path, not the primary one. 5s connect, 8s total.
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=5.0)) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    logger.debug(
                        f"[SCANNER] HTTP candles {asset} {tf_sec}s → HTTP {resp.status_code}"
                    )
                    return pd.DataFrame()

                data = resp.json()
                # PO returns either a bare list [...] or {"data": [...], ...}
                if isinstance(data, dict):
                    candles_list = data.get("data") or data.get("candles") or []
                elif isinstance(data, list):
                    candles_list = data
                else:
                    return pd.DataFrame()

                if not candles_list:
                    return pd.DataFrame()

                rows = []
                for candle in candles_list:
                    try:
                        if isinstance(candle, dict):
                            ts_v = candle.get("time") or candle.get("timestamp") or candle.get("t")
                            o_v = candle.get("open") or candle.get("o")
                            h_v = candle.get("high") or candle.get("h")
                            l_v = candle.get("low") or candle.get("l")
                            c_v = candle.get("close") or candle.get("c")
                            v_v = candle.get("volume") or candle.get("vol") or 0.0
                        elif isinstance(candle, (list, tuple)) and len(candle) >= 5:
                            ts_v, o_v, h_v, l_v, c_v = candle[:5]
                            v_v = candle[5] if len(candle) > 5 else 0.0
                        else:
                            continue
                        ts_int = int(float(ts_v))
                        rows.append((
                            ts_int, float(o_v), float(h_v),
                            float(l_v), float(c_v), float(v_v),
                        ))
                    except (ValueError, TypeError, IndexError):
                        continue

                if not rows:
                    return pd.DataFrame()

                df = pd.DataFrame(
                    rows, columns=["ts", "open", "high", "low", "close", "volume"]
                )
                df["time"] = pd.to_datetime(df["ts"], unit="s", utc=True)
                df = df.drop_duplicates(subset=["ts"]).sort_values("ts").set_index("time")
                df = df.drop(columns=["ts"])

                if (df["volume"] == 0).all():
                    df["volume"] = np.nan

                tf_str = self._tf_seconds_to_str(tf_sec)
                cache_key = f"{asset}_{tf_str}"
                self._candles_cache[cache_key] = df

                logger.info(
                    f"[SCANNER] HTTP candles cached: {asset} {tf_str} "
                    f"({len(df)} bars, last close={df['close'].iloc[-1]:.5f})"
                )
                return df

        except Exception as e:
            logger.debug(f"[SCANNER] HTTP candles fetch error ({asset}): {e}")
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
            # Pair is currently inactive on PO — return None so callers can drop it.
            # Inactive pairs are NEVER displayed or used for signals; callers should
            # treat None as "this pair is not currently available on PO".
            logger.debug(f"[SCANNER] '{pair}' (symbol='{match_symbol}') is INACTIVE on PO — skipping")
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

    def get_all_payouts(self, active_only: bool = True) -> dict:
        """Return parsed payouts directly from PO.

        Args:
            active_only: If True (DEFAULT), only return payouts for pairs where
                         is_active=True. Inactive pairs are EXCLUDED entirely —
                         they are never displayed or used by the system.
                         Set False only for low-level debug inspection.
        Returns:
            dict mapping symbol -> payout (float)
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

    # ═══════════ FRESHNESS / DIAGNOSTICS ═══════════

    @property
    def last_assets_update(self) -> Optional[datetime]:
        """UTC datetime of the last `updateAssets` snapshot received from PO.
        None if we've never received one. Use this to verify data freshness —
        if it's more than ~60s old, our payouts are stale.
        """
        return self._last_assets_update

    @property
    def assets_received_count(self) -> int:
        """How many `updateAssets` snapshots we've received since connect."""
        return self._assets_received_count

    @property
    def last_payout_change(self) -> Optional[datetime]:
        """UTC datetime of the last detected payout change.
        None if no changes have been detected yet.
        """
        return self._last_payout_change

    def get_freshness_report(self) -> dict:
        """Return a freshness diagnostic dict for the debug endpoint.

        Use this to verify our payouts match PO's UI:
          - If `last_assets_update_age_seconds` is < 60s, our data is fresh.
          - If it's > 60s, data is stale — refresh loop may have stalled.
          - If `assets_received_count` is 0, we never received the payout table.
          - `payouts_seen_count` is how many pairs we currently know about.
        """
        now = datetime.now(timezone.utc)
        last_age = None
        last_change_age = None
        if self._last_assets_update:
            last_age = (now - self._last_assets_update).total_seconds()
        if self._last_payout_change:
            last_change_age = (now - self._last_payout_change).total_seconds()
        return {
            "last_assets_update": self._last_assets_update.isoformat() if self._last_assets_update else None,
            "last_assets_update_age_seconds": round(last_age, 1) if last_age is not None else None,
            "last_payout_change": self._last_payout_change.isoformat() if self._last_payout_change else None,
            "last_payout_change_age_seconds": round(last_change_age, 1) if last_change_age is not None else None,
            "assets_received_count": self._assets_received_count,
            "payouts_seen_count": len(self._payouts),
            "is_data_fresh": (last_age is not None and last_age < 15.0),
            "refresh_interval_seconds": 5,
        }

    def find_pairs_above_payout(self, min_payout: float = 70.0, pair_filter: str = "OTC",
                                 active_only: bool = True, forex_only: bool = True) -> dict:
        """Find all ELIGIBLE pairs — the only pairs the system should ever use.

        A pair is ELIGIBLE if and only if ALL conditions are met:
          1. is_active=True  (pair is currently tradable on PO — not greyed out)
          2. payout >= min_payout  (default 70.0 — minimum +70% profitability)
          3. (if forex_only=True) the symbol is a FOREX currency pair — NOT a
             stock, crypto, commodity, or other asset type. A2Sniper is
             dedicated to FOREX only.

        All other pairs (inactive, low payout, OR non-forex) are EXCLUDED entirely.
        They are never displayed, never used for signals, never sent to the user.
        When PO reactivates them (within ~5s, thanks to the refresh loop), they
        automatically reappear in this list IF they meet all criteria.

        Args:
            min_payout: Minimum payout threshold. Default 70.0 per system requirement.
            pair_filter: Filter symbols by this substring (e.g. "OTC"). Empty = all.
            active_only: If True (default), exclude inactive pairs.
            forex_only: If True (default), exclude non-FOREX assets (stocks, crypto, etc.)
        """
        result = {}
        for symbol, entry in self._payouts.items():
            payout = entry.get("payout", 0)
            is_active = entry.get("is_active", True)
            if active_only and not is_active:
                continue  # Inactive pair — DROP entirely, never display
            if payout < min_payout:
                continue  # Payout too low
            if pair_filter and pair_filter.upper() not in symbol.upper():
                continue  # Doesn't match the OTC/etc filter
            # FOREX-only filter — A2Sniper is dedicated to FOREX currency pairs
            if forex_only and _FOREX_FILTER_AVAILABLE and not _is_forex_pair(symbol):
                continue  # Stock, crypto, commodity — DROP
            display = self._symbol_to_display(symbol)
            result[display] = payout
        return result

    @staticmethod
    def format_payout(payout: Optional[float]) -> str:
        """Format a payout value for display — matches PO's UI format.

        PO shows payouts as '+92%' (with the plus sign, max ~92%).

        IMPORTANT: This function should only ever be called with a VALID payout
        for an ACTIVE pair. Inactive pairs are filtered out upstream and never
        reach this function. The None/invalid fallback is defensive only —
        callers should never rely on it for display logic.
        """
        if payout is None or not isinstance(payout, (int, float)):
            # Defensive fallback — should not happen in normal flow since
            # inactive pairs are filtered out before format_payout is called.
            return "—"
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
        if self._asset_refresh_task and not self._asset_refresh_task.done():
            self._asset_refresh_task.cancel()
            self._asset_refresh_task = None
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            self._receive_task = None

        self._is_authenticated = False
        self._payouts = {}
        self._candles_cache = {}
        self._balance = None
        self._last_assets_update = None
        self._assets_received_count = 0
        self._last_payout_change = None

        await self._close_ws()
        logger.info("[SCANNER] 🔌 DÉCONNECTÉ")
