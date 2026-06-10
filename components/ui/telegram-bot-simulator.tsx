'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, Zap, TrendingUp, TrendingDown, ChevronRight, ChevronLeft, ShieldAlert, Info, BarChart4, Calculator, X, Play, RefreshCw, Trash2, Save, Download, Send } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { toast } from 'sonner';
import { tradingPairs, Signal } from '@/lib/mock-data';

interface Message {
  id: string;
  content: string;
  sender: 'user' | 'bot';
  timestamp: Date;
  type: 'text' | 'signal' | 'performance' | 'pairs_list' | 'ssid_input';
  pair_data?: any;
}

// Composant pour l'arrière-plan avec les bougies (ChartBackground)
const ChartBackground = () => {
  // Bougies réalistes – chaque objet définit couleur, hauteur du corps en px, hauteurs des mèches en px
  const candles = [
    { type: 'bear', body: 60, wickTop: 20, wickBottom: 35, dur: 1.8, delay: 0 },
    { type: 'bull', body: 95, wickTop: 40, wickBottom: 25, dur: 2.0, delay: 0.1 },
    { type: 'bear', body: 55, wickTop: 25, wickBottom: 50, dur: 1.4, delay: 0.2 },
    { type: 'bull', body: 45, wickTop: 30, wickBottom: 15, dur: 1.6, delay: 0.3 },
    { type: 'bull', body: 110, wickTop: 50, wickBottom: 30, dur: 1.8, delay: 0.4 },
    { type: 'bear', body: 40, wickTop: 20, wickBottom: 25, dur: 1.2, delay: 0.5 },
    { type: 'bull', body: 85, wickTop: 35, wickBottom: 20, dur: 2.0, delay: 0.6 },
    { type: 'bull', body: 130, wickTop: 55, wickBottom: 35, dur: 1.6, delay: 0.7 },
  ];

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none flex items-center justify-center opacity-55">
      {/* Poussé vers le haut avec translateY(-40px) */}
      <div className="flex items-center gap-4" style={{ height: '350px', transform: 'translateY(-40px)' }}>
        {candles.map((c, i) => {
          const color = c.type === 'bull' ? '#22c55e' : '#ef4444';
          // Direction alternée pour les bougies adjacentes (l'une monte, la suivante descend)
          const direction = i % 2 === 0 ? 1 : -1;
          const yRange = [-10 * direction, 10 * direction];

          return (
            <motion.div
              key={i}
              className="relative flex flex-col items-center"
              style={{ width: 22 }}
              animate={{ y: yRange }}
              transition={{
                duration: c.dur,
                repeat: Infinity,
                repeatType: "reverse",
                ease: "easeInOut",
                delay: c.delay
              }}
            >
              {/* Mèche haute */}
              <div style={{ width: 3, height: c.wickTop, backgroundColor: color }} />
              {/* Corps de la bougie (sans border-radius) – taille fixe, pas de zoom */}
              <div
                style={{ width: 22, height: c.body, backgroundColor: color, boxShadow: `0 0 20px ${color}60` }}
              />
              {/* Mèche basse */}
              <div style={{ width: 3, height: c.wickBottom, backgroundColor: color }} />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};

export function TelegramBotSimulator() {
  const { liveStatus, connectMarket, requestSignal, signals, userStats, marketInfo } = useAppStore();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [pairsScrollIndex, setPairsScrollIndex] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const prevLiveStatusRef = useRef(liveStatus);
  
  // Modals States
  const [showRiskManager, setShowRiskManager] = useState(false);
  const [showModal, setShowModal] = useState<'DISCLAIMER' | 'AIDE' | 'PERF' | null>(null);
  const [showClearModal, setShowClearModal] = useState(false);
  const [showTradingJournal, setShowTradingJournal] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearProgress, setClearProgress] = useState(0);

  // SSID Input State
  const [ssidInput, setSsidInput] = useState('');
  const [ssidError, setSsidError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Load persisted SSID on mount
  useEffect(() => {
    const saved = localStorage.getItem('a2sniper_last_ssid');
    if (saved) {
      setSsidInput(saved);
    }
  }, []);

  const handleSsidSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!ssidInput.trim()) {
      setSsidError("Erreur : Veuillez saisir ou coller votre message WS.");
      toast.error("Erreur : SSID ou message WS manquant", { duration: 3000 });
      return;
    }

    setIsConnecting(true);
    setSsidError(null);
    addMessage(`🔄 Tentative de connexion au marché avec le SSID ou message WS fourni...`, 'bot');

    const result = await connectMarket(ssidInput.trim());
    setIsConnecting(false);

    if (result.success) {
      localStorage.setItem('a2sniper_last_ssid', ssidInput.trim());
      toast.success("Connexion au marché Pocket Option réussie !", { duration: 3000 });
      
      // Start 5-second initial analysis automatically
      setIsAnalyzing(true);
      addMessage(`⚙️ Lancement de l'analyse initiale du marché en direct (5 secondes)... Le scanner commence à extraire les structures SMC réelles.`, 'bot');
      
      setTimeout(() => {
        setIsAnalyzing(false);
        addMessage(`✅ Analyse initiale terminée ! Le système commence à diffuser les signaux réels.`, 'bot');
        addMessage(`🎉Bienvenue sur A2Sniper 3.0 !\n\n🤖L'assistant de pointe pour votre trading binaire haute fréquence.\n\n🟢 Vous êtes actuellement connecté avec succès au marché 💹\n\nPour commencer à recevoir vos signaux de trading binaire, veuillez cliquer sur le bouton 'Pairs de devises' ci-dessous, puis dans la liste des pairs de devises actives qui s'affichera, cliquez sur la paire de devises de votre choix, pour recevoir votre signal.\n\n🎉Excellente session de trading à vous !\n@A2Sniper_BinaryTrader`, 'bot');
      }, 5000);
    } else {
      const errMsg = "Connexion expirée ou invalide. Le SSID fourni n'est pas actif.";
      setSsidError(errMsg);
      toast.error("Erreur de connexion : SSID invalide ou expiré", { duration: 3000 });
      addMessage(`❌ Échec de la connexion : Le message ou session fourni a expiré. Veuillez reprendre l'étape 3 sur pocketoption.com et coller un nouveau message WS.`, 'bot', 'ssid_input');
    }
  };

  const handleClearChat = () => {
    setIsClearing(true);
    let prog = 0;
    const interval = setInterval(() => {
      prog += 5;
      setClearProgress(prog);
      if (prog >= 100) {
        clearInterval(interval);
        
        // 1. Clear chat instantly, close modal and show success toast
        setMessages([]);
        localStorage.removeItem('a2sniper_v3_history_v3');
        setIsClearing(false);
        setShowClearModal(false);
        setClearProgress(0);
        toast.success("Chat vidé avec succès", { duration: 3000 });
        
        // 2. Start the exact 2-second delay where the chat is completely empty
        setTimeout(() => {
          const currentLiveStatus = useAppStore.getState().liveStatus;
          
          if (currentLiveStatus === 'LIVE') {
            addMessage(`🎉Bienvenue sur A2Sniper 3.0 !\n\n🤖L'assistant de pointe pour votre trading binaire haute fréquence.\n\n🟢 Vous êtes actuellement connecté avec succès au marché 💹\n\nPour commencer à recevoir vos signaux de trading binaire, veuillez cliquer sur le bouton 'Pairs de devises' ci-dessous, puis dans la liste des pairs de devises actives qui s'affichera, cliquez sur la paire de devises de votre choix, pour recevoir votre signal.\n\n🎉Excellente session de trading à vous !\n@A2Sniper_BinaryTrader`, 'bot');
          } else {
            addMessage(`🎉Bienvenue sur A2Sniper 3.0 !\n\n🤖L'assistant de pointe pour votre trading binaire haute fréquence.\n\n⛔ Vous n'êtes pas actuellement connecté au marché (ou votre SSID a expiré) ⚠️\n\nAfin de pouvoir recevoir des signaux sur les paires actives, veuillez vous connecter au marché en fournissant votre SSID actuel. Voici comment procéder :\n1. Ouvrez votre compte sur pocketoption.com\n2. Appuyez sur F12 (Inspecter) → onglet Network\n3. Filtrez par "socket.io" puis cliquez sur un websocket\n4. Dans l'onglet Messages, cherchez la trame d'authentification stable contenant la clé "session" (commençant par 42["auth",{"session":"..."). Faites un clic droit dessus et sélectionnez "Copy message"\n5. Collez‑la dans le champ « Chaîne SSID (Trame d’auth) » du bot (ci dessous 👇) puis envoyez.`, 'bot', 'ssid_input');
          }
        }, 5000);
      }
    }, 50);
  };

  const visiblePairsCount = 5;
  const filteredTradingPairs = useMemo(() => {
    if (!marketInfo || !marketInfo.isConnected || !marketInfo.payouts) {
      return [];
    }
    return Object.entries(marketInfo.payouts)
      .filter(([_, payout]) => payout !== null && payout >= 70)
      .map(([symbol]) => {
        const pairObj = tradingPairs.find(tp => tp.symbol === symbol);
        return {
          symbol,
          name: pairObj ? pairObj.name : symbol,
          payout: marketInfo.payouts[symbol] || 0
        };
      });
  }, [marketInfo]);

  const scrollToBottom = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  };

  const addMessage = (content: string, sender: 'user' | 'bot', type: 'text' | 'signal' | 'performance' | 'pairs_list' | 'ssid_input' = 'text', pair_data?: any) => {
    const newMessage: Message = {
      id: Date.now().toString(),
      content,
      sender,
      timestamp: new Date(),
      type
    };
    setMessages(prev => [...prev, newMessage]);
  };

  const simulateTyping = async (duration = 2000) => {
    setIsTyping(true);
    await new Promise(resolve => setTimeout(resolve, duration));
    setIsTyping(false);
  };

  const handlePairClick = async (pair: string) => {
    addMessage(pair, 'user');
    await simulateTyping(1000); // Délai de 1s pour rester sous les 3s max spécifiés
    
    if (liveStatus !== 'LIVE') {
      addMessage(`⚠️ Impossible d'analyser ${pair}. Le système n'est pas connecté au marché réel. Zéro simulation tolérée.`, 'bot');
      return;
    }
    
    const res = await requestSignal(pair);
    if (res.success && res.signal) {
      addMessage(`🎯 SIGNAL EN COURS : ${pair}`, 'bot', 'signal', res.signal);
    } else {
      addMessage(`⏳ Analyse en cours pour ${pair}... ${res.message || "Le système attend une opportunité Sniper."}`, 'bot');
    }
  };

  const handleBotResponse = async (userMessage: string) => {
    await simulateTyping();

    if (userMessage.startsWith('42["auth"') || userMessage.includes('"session":')) {
      addMessage(`🔄 Tentative de connexion au marché avec le SSID fourni...`, 'bot');
      const result = await connectMarket(userMessage);
      if (result.success) {
        // Start 5-second initial analysis automatically
        setIsAnalyzing(true);
        addMessage(`⚙️ Lancement de l'analyse initiale du marché en direct (5 secondes)... Le scanner commence à extraire les structures SMC réelles.`, 'bot');
        
        setTimeout(() => {
          setIsAnalyzing(false);
          addMessage(`✅ Analyse initiale terminée ! Le système commence à diffuser les signaux réels.`, 'bot');
          addMessage(`🎉Bienvenue sur A2Sniper 3.0 !\n\n🤖L'assistant de pointe pour votre trading binaire haute fréquence.\n\n🟢 Vous êtes actuellement connecté avec succès au marché 💹\n\nPour commencer à recevoir vos signaux de trading binaire, veuillez cliquer sur le bouton 'Pairs de devises' ci-dessous, puis dans la liste des pairs de devises actives qui s'affichera, cliquez sur la paire de devises de votre choix, pour recevoir votre signal.\n\n🎉Excellente session de trading à vous !\n@A2Sniper_BinaryTrader`, 'bot');
        }, 5000);
      } else {
        addMessage(`❌ Échec de la connexion. Le SSID fourni est expiré ou invalide. Veuillez réessayer les étapes de connexion.`, 'bot');
      }
      return;
    }

    if (userMessage.includes('/signals')) {
      if (liveStatus !== 'LIVE') {
        addMessage("⚠️ Impossible de lister les signaux. Le système est déconnecté du marché réel.", 'bot');
        return;
      }
      const latestSignal = signals[0];
      if (latestSignal) {
        addMessage(`🎯 DERNIER SIGNAL : ${latestSignal.pair}`, 'bot', 'signal', latestSignal);
      } else {
        addMessage("Aucun signal disponible. Le marché est sous surveillance. ⏳", 'bot');
      }
    } else if (userMessage.includes('/performance')) {
      addMessage(`📈 PERFORMANCE RÉELLE\n\n🎯 Win Rate: ${userStats.winRate.toFixed(2)}%\n📊 Signaux: ${userStats.todaySignals} aujourd'hui\n\nPure data. Zéro simulation.`, 'bot', 'performance');
    } else if (userMessage.includes('/pairs') || userMessage.includes('/paires')) {
      if (liveStatus !== 'LIVE') {
        addMessage("⚠️ Impossible de lister les paires actives. Aucune connexion au marché réel.", 'bot');
        return;
      }
      addMessage("Sélectionnez une paire active pour une analyse immédiate :", 'bot', 'pairs_list');
    } else {
      addMessage(`🤖 Assistant A2Sniper 3.0\n\nUtilisez les boutons de navigation pour interagir avec le système A2Sniper 3.0.`, 'bot');
    }
  };

  // Persistance des messages
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const saved = localStorage.getItem('a2sniper_v3_history_v3');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Normalise les anciens messages: si un message bot contient les instructions
        // SSID mais a le type 'text' (sauvegardé avant l'implémentation de ssid_input),
        // on lui restitue le bon type pour que le formulaire inline s'affiche correctement.
        const loaded = parsed.map((m: any) => {
          let type = m.type || 'text';
          if (
            type === 'text' &&
            m.sender === 'bot' &&
            typeof m.content === 'string' &&
            m.content.includes('42["auth"')
          ) {
            type = 'ssid_input';
          }
          return { ...m, type, timestamp: new Date(m.timestamp) };
        });
        setMessages(loaded);
      } catch (e) {
        console.error("Failed to load messages", e);
      }
    } else {
      if (liveStatus === 'LIVE') {
        addMessage(`🎉Bienvenue sur A2Sniper 3.0 !\n\n🤖L'assistant de pointe pour votre trading binaire haute fréquence.\n\n🟢 Vous êtes actuellement connecté avec succès au marché 💹\n\nPour commencer à recevoir vos signaux de trading binaire, veuillez cliquer sur le bouton 'Pairs de devises' ci-dessous, puis dans la liste des pairs de devises actives qui s'affichera, cliquez sur la paire de devises de votre choix, pour recevoir votre signal.\n\n🎉Excellente session de trading à vous !\n@A2Sniper_BinaryTrader`, 'bot');
      } else {
        addMessage(`🎉Bienvenue sur A2Sniper 3.0 !\n\n🤖L'assistant de pointe pour votre trading binaire haute fréquence.\n\n⛔ Vous n'êtes pas actuellement connecté au marché (ou votre SSID a expiré) ⚠️\n\nAfin de pouvoir recevoir des signaux sur les paires actives, veuillez vous connecter au marché en fournissant votre SSID actuel. Voici comment procéder :\n1. Ouvrez votre compte sur pocketoption.com\n2. Appuyez sur F12 (Inspecter) → onglet Network\n3. Filtrez par "socket.io" puis cliquez sur un websocket\n4. Dans l'onglet Messages, cherchez la trame d'authentification stable contenant la clé "session" (commençant par 42["auth",{"session":"..."). Faites un clic droit dessus et sélectionnez "Copy message"\n5. Collez‑la dans le champ « Chaîne SSID (Trame d’auth) » du bot (ci dessous 👇) puis envoyez.`, 'bot', 'ssid_input');
      }
    }
  }, [liveStatus]);

  useEffect(() => {
    if (liveStatus === 'LIVE' && prevLiveStatusRef.current !== 'LIVE') {
       addMessage(`✅ Connexion au marché réel établie. Données 100% en direct reçues.`, 'bot');
    } else if (liveStatus !== 'LIVE' && prevLiveStatusRef.current === 'LIVE') {
       addMessage(`⚠️ Déconnexion du marché réel. Le système bloque toutes les analyses pour éviter les fausses données.`, 'bot');
    }
    prevLiveStatusRef.current = liveStatus;
  }, [liveStatus]);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem('a2sniper_v3_history_v3', JSON.stringify(messages));
    }
    scrollToBottom();
  }, [messages]);

  return (
    <div className="bg-[#050507] rounded-3xl shadow-[0_0_50px_rgba(0,0,0,0.8)] border border-gray-800/50 overflow-hidden max-w-md mx-auto relative flex flex-col h-[640px] font-sans text-gray-200">
      
      {/* Dynamic Background */}
      <ChartBackground />

      {/* Header */}
      <div className="bg-[#0a0a0c]/90 backdrop-blur-2xl p-4 border-b border-gray-800/50 z-20 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="relative">
            <div className="w-10 h-10 bg-gradient-to-br from-[#D4AF37] to-[#C5A059] rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(212,175,55,0.5)] border border-[#D4AF37]/30 overflow-hidden p-[1px]">
              <img src="/A2Sniper-logo.jpeg" alt="Bot Logo" className="w-full h-full object-cover rounded-full" />
            </div>
            <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[#0a0a0c] animate-pulse ${liveStatus === 'LIVE' ? 'bg-green-500 shadow-[0_0_12px_#22c55e]' : 'bg-red-500 shadow-[0_0_12px_#ef4444]'}`} />
          </div>
          <div>
            <h3 className="text-white font-black text-sm tracking-tight">A2Sniper 3.0</h3>
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#D4AF37]/80">
              Binary Trader
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {liveStatus === 'LIVE' ? (
            <div className="bg-green-600/20 px-2.5 py-1 rounded-lg border border-green-500/30 flex items-center justify-center">
              <span className="text-[8px] font-black text-green-400 tracking-wider leading-none">CONNECTED</span>
            </div>
          ) : (
             <div className="bg-red-600/20 px-2.5 py-1 rounded-lg border border-red-500/30 flex items-center justify-center">
              <span className="text-[8px] font-black text-red-400 tracking-wider leading-none">DISCONNECTED</span>
            </div>
          )}
          <button title="Vider le chat" onClick={() => setShowClearModal(true)} className="p-1.5 hover:bg-red-500/10 rounded-lg text-gray-500 hover:text-red-400 transition-colors">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages Area */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 z-10 no-scrollbar scrollbar-hide relative">
        <AnimatePresence>
          {messages.map((message) => (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, x: message.sender === 'user' ? 20 : -20 }}
              animate={{ opacity: 1, x: 0 }}
              className={`flex flex-col ${message.sender === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div className={`max-w-[88%] relative group ${
                message.sender === 'user'
                  ? 'bg-[#D4AF37]/20 border border-[#D4AF37]/30 text-white rounded-2xl rounded-tr-none px-4 py-3'
                  : message.type === 'signal' 
                    ? '' // Signal handles its own styling
                    : 'bg-[#121216]/80 backdrop-blur-md border border-gray-800/80 text-gray-200 rounded-2xl rounded-tl-none px-4 py-3 shadow-xl shadow-black/20'
              }`}>
                
                {message.type === 'signal' && message.pair_data ? (
                  <motion.div 
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className={`min-w-[260px] rounded-2xl overflow-hidden border-2 shadow-2xl relative ${
                      message.pair_data.direction === 'CALL' 
                        ? 'border-green-500/50 bg-gradient-to-br from-green-600/20 via-green-900/40 to-black/80 shadow-green-500/20' 
                        : 'border-red-500/50 bg-gradient-to-br from-red-600/20 via-red-900/40 to-black/80 shadow-red-500/20'
                    }`}
                  >
                    {/* Glow effect */}
                    <div className={`absolute inset-0 opacity-20 pointer-events-none blur-3xl ${message.pair_data.direction === 'CALL' ? 'bg-green-500' : 'bg-red-500'}`} />
                    
                    <div className="p-4 relative z-10">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full animate-ping ${message.pair_data.direction === 'CALL' ? 'bg-green-400' : 'bg-red-400'}`} />
                          <span className="font-black text-sm tracking-tight text-white">{message.pair_data.pair}</span>
                        </div>
                        <span className="text-[10px] font-black text-gray-400/80 bg-black/40 px-2 py-0.5 rounded-full border border-gray-800">
                          {new Date(message.pair_data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      
                      <div className="flex flex-col items-center justify-center py-4 bg-black/30 rounded-xl border border-white/5 mb-4">
                        {message.pair_data.direction === 'CALL' ? (
                          <div className="text-center">
                            <motion.div animate={{ y: [-5, 5, -5] }} transition={{ repeat: Infinity, duration: 2 }}>
                              <TrendingUp className="w-16 h-16 text-green-400 drop-shadow-[0_0_15px_rgba(34,197,94,0.6)]" strokeWidth={3} />
                            </motion.div>
                            <span className="text-green-400 font-black text-2xl tracking-[0.3em] mt-2 block drop-shadow-[0_0_10px_rgba(34,197,94,0.4)]">CALL</span>
                          </div>
                        ) : (
                          <div className="text-center">
                            <motion.div animate={{ y: [5, -5, 5] }} transition={{ repeat: Infinity, duration: 2 }}>
                              <TrendingDown className="w-16 h-16 text-red-400 drop-shadow-[0_0_15px_rgba(239,68,68,0.6)]" strokeWidth={3} />
                            </motion.div>
                            <span className="text-red-400 font-black text-2xl tracking-[0.3em] mt-2 block drop-shadow-[0_0_10px_rgba(239,68,68,0.4)]">PUT</span>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="bg-white/5 p-2.5 rounded-xl border border-white/10 text-center backdrop-blur-sm">
                          <p className="text-[9px] text-gray-400 font-black uppercase tracking-wider mb-1">Winrate Assistant</p>
                          <p className={`text-lg font-black ${message.pair_data.direction === 'CALL' ? 'text-green-400' : 'text-red-400'}`}>{message.pair_data.winrate}%</p>
                        </div>
                        <div className="bg-white/5 p-2.5 rounded-xl border border-white/10 text-center backdrop-blur-sm">
                          <p className="text-[9px] text-gray-400 font-black uppercase tracking-wider mb-1">Expiration</p>
                          <p className="text-lg font-black text-[#D4AF37]">{message.pair_data.expiration}m</p>
                        </div>
                      </div>

                      <div className="bg-black/60 p-3 rounded-xl border border-gray-800/50">
                        <div className="flex items-center gap-2 mb-1.5">
                          <Zap className="w-3 h-3 text-yellow-500" />
                          <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest">SMC Analysis</span>
                        </div>
                        <p className="text-[10px] text-gray-200 font-bold italic line-clamp-1">
                          {message.pair_data.smc_structure}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ) : message.type === 'pairs_list' ? (
                  <div className="space-y-4 w-[280px]">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-black text-[#D4AF37] uppercase tracking-widest">Marché Forex Actif</p>
                      <div className="bg-[#D4AF37]/20 px-2 py-0.5 rounded-full">
                        <span className="text-[9px] text-[#D4AF37] font-black uppercase">Live</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {filteredTradingPairs.slice(pairsScrollIndex, pairsScrollIndex + visiblePairsCount).map((p, i) => (
                        <button
                          key={i}
                          onClick={() => handlePairClick(p.symbol)}
                          className="w-full flex items-center justify-between p-3.5 bg-black/60 hover:bg-[#D4AF37]/20 border border-gray-800 hover:border-[#D4AF37]/50 rounded-2xl transition-all group relative overflow-hidden"
                        >
                          <div className="absolute inset-0 bg-gradient-to-r from-[#D4AF37]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                          <div className="relative z-10 flex flex-col items-start">
                            <span className="text-xs font-black text-white group-hover:text-[#D4AF37] transition-colors">{p.symbol}</span>
                            <span className="text-[8px] text-gray-500 font-bold uppercase tracking-tighter">Forex OTC Sniper</span>
                          </div>
                          <div className="relative z-10 flex items-center gap-3">
                            <div className="text-right">
                              <p className="text-[10px] text-green-400 font-black">{p.payout}%</p>
                              <p className="text-[8px] text-gray-600 font-bold uppercase">Payout</p>
                            </div>
                            <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-[#D4AF37] transition-all group-hover:translate-x-1" />
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="flex justify-between items-center mt-4 pt-4 border-t border-gray-800/50">
                      <button 
                        disabled={pairsScrollIndex === 0}
                        onClick={() => setPairsScrollIndex(Math.max(0, pairsScrollIndex - 1))}
                        className="p-2 bg-gray-800/50 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-white disabled:opacity-30 transition-all shadow-lg"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="text-[10px] text-gray-500 font-black uppercase tracking-widest">Page {Math.floor(pairsScrollIndex/visiblePairsCount) + 1} / {Math.ceil(filteredTradingPairs.length / visiblePairsCount)}</span>
                      <button 
                        disabled={pairsScrollIndex + visiblePairsCount >= filteredTradingPairs.length}
                        onClick={() => setPairsScrollIndex(Math.min(filteredTradingPairs.length - visiblePairsCount, pairsScrollIndex + 1))}
                        className="p-2 bg-gray-800/50 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-white disabled:opacity-30 transition-all shadow-lg"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm whitespace-pre-line font-bold leading-relaxed tracking-tight">
                    {message.content.split(/(pocketoption\.com|42\["auth",\{"session":"\.\.\.)/gi).map((part, i) => {
                      if (part.toLowerCase() === 'pocketoption.com') {
                        return (
                          <a key={i} href="https://pocketoption.com" target="_blank" rel="noopener noreferrer" className="text-[#D4AF37] hover:text-[#C5A059] underline underline-offset-2 transition-colors">
                            {part}
                          </a>
                        );
                      } else if (part === '42["auth",{"session":"...') {
                        return (
                          <code key={i} className="bg-[#25262e] border border-gray-700/50 px-1.5 py-0.5 rounded text-gray-200 font-mono text-[11px] font-medium mx-0.5 select-all shadow-inner">
                            {part}
                          </code>
                        );
                      }
                      return <span key={i}>{part}</span>;
                    })}
                  </div>
                )}

                {message.type === 'ssid_input' && (
                  <div className="mt-3 pt-3 border-t border-gray-800/50">
                    <form onSubmit={handleSsidSubmit} className="flex flex-col gap-1.5 w-[280px]">

                      <div className={`flex items-center bg-black/60 rounded-xl border transition-all overflow-hidden ${ssidError ? 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.2)]' : 'border-gray-800 focus-within:border-[#D4AF37]/50'}`}>
                        <input 
                          type="text" 
                          value={ssidInput}
                          onChange={(e) => { 
                            setSsidInput(e.target.value); 
                            localStorage.setItem('a2sniper_last_ssid', e.target.value);
                            if (ssidError) setSsidError(null); 
                          }}
                          placeholder="Collez le message WS ici..." 
                          disabled={isConnecting}
                          className="flex-1 bg-transparent px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none border-none"
                        />
                        <button 
                          type="submit" 
                          disabled={isConnecting || !ssidInput.trim()}
                          className="bg-[#D4AF37] hover:bg-[#c5a059] disabled:bg-gray-800 disabled:text-gray-600 text-black px-3 py-2 text-xs font-black transition-all flex items-center justify-center cursor-pointer border-none"
                        >
                          {isConnecting ? (
                            <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                      {ssidError && (
                        <p className="text-[9px] text-red-400 font-bold px-1 flex items-center gap-1 animate-pulse">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                          {ssidError}
                        </p>
                      )}
                    </form>
                  </div>
                )}

                <div className={`text-[8px] mt-2 font-black tracking-[0.2em] uppercase ${message.sender === 'user' ? 'text-[#D4AF37]/60' : 'text-gray-600'}`}>
                  {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • SENT
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {isTyping && (
          <div className="flex space-x-1.5 p-3 bg-[#121216]/80 backdrop-blur-md rounded-2xl w-16 border border-gray-800/80 shadow-xl">
            <div className="w-2 h-2 bg-[#D4AF37] rounded-full animate-bounce shadow-[0_0_8px_rgba(212,175,55,0.6)]"></div>
            <div className="w-2 h-2 bg-[#D4AF37] rounded-full animate-bounce delay-150 shadow-[0_0_8px_rgba(212,175,55,0.6)]"></div>
            <div className="w-2 h-2 bg-[#D4AF37] rounded-full animate-bounce delay-300 shadow-[0_0_8px_rgba(212,175,55,0.6)]"></div>
          </div>
        )}
      </div>

      {/* Removed bottom SSID input form as it is now inline in the chat */}

      {/* Main Action Buttons */}
      <div className="p-4 bg-[#0a0a0c]/95 backdrop-blur-3xl border-t border-gray-800/50 z-20 space-y-3">
        <button 
          onClick={async () => {
            await simulateTyping(500);
            if (liveStatus !== 'LIVE') {
              addMessage("⚠️ Impossible de lister les paires actives. Aucune connexion au marché réel.", 'bot');
              return;
            }
            addMessage("Sélectionnez une paire active pour une analyse immédiate :", 'bot', 'pairs_list');
          }}
          className="w-full py-2 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-500 hover:to-green-600 rounded-2xl text-[10px] font-black text-white flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(34,197,94,0.2)] border border-green-400/30 group active:scale-95 whitespace-nowrap"
        >
          <Zap className="w-4 h-4 fill-white animate-pulse" />
          Pairs de devises
        </button>

        <div className="flex gap-2">
          <button 
            onClick={() => setShowTradingJournal(true)}
            className="flex-[1] py-2 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] border border-[#D4AF37]/30 rounded-2xl text-[10px] font-black text-black flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(212,175,55,0.4)] group active:scale-95 whitespace-nowrap"
          >
            <BarChart4 className="w-4 h-4" />
            Trading Journal
          </button>
          
          <button 
            onClick={() => setShowRiskManager(true)}
            className="flex-[1] py-2 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 border border-red-500/30 rounded-2xl text-[10px] font-black text-white flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(239,68,68,0.2)] group active:scale-95 whitespace-nowrap"
          >
            <Calculator className="w-4 h-4 group-hover:rotate-12 transition-transform" />
            Risk Manager
          </button>
        </div>
        
        {/* Secondary Command Buttons */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => setShowModal('DISCLAIMER')}
            className="flex items-center justify-center gap-2 py-1 bg-[#121216] hover:bg-red-950/20 border border-gray-800 hover:border-red-500/30 rounded-xl text-[8px] font-black text-gray-400 hover:text-red-400 transition-all group"
          >
            <ShieldAlert className="w-3.5 h-3.5 text-red-500/50 group-hover:text-red-500 transition-colors" />
            DISCLAIMER
          </button>
          <button
            onClick={() => setShowModal('PERF')}
            className="flex items-center justify-center gap-2 py-1 bg-[#121216] hover:bg-[#D4AF37]/10 border border-gray-800 hover:border-[#D4AF37]/30 rounded-xl text-[8px] font-black text-gray-400 hover:text-[#D4AF37] transition-all group"
          >
            <BarChart4 className="w-3.5 h-3.5 text-[#D4AF37]/50 group-hover:text-[#D4AF37] transition-colors" />
            PERF
          </button>
          <button
            onClick={() => setShowModal('AIDE')}
            className="flex items-center justify-center gap-2 py-1 bg-[#121216] hover:bg-indigo-950/20 border border-gray-800 hover:border-indigo-500/30 rounded-xl text-[8px] font-black text-gray-400 hover:text-indigo-400 transition-all group"
          >
            <Info className="w-3.5 h-3.5 text-indigo-500/50 group-hover:text-indigo-500 transition-colors" />
            HELP
          </button>
        </div>

        {isAnalyzing && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="flex flex-col items-center justify-center pt-2 gap-1.5 border-t border-gray-800/30 mt-2"
          >
            <div className="relative flex items-center justify-center">
              {/* Spinner Ring */}
              <div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
              {/* Pulsing inner dot */}
              <div className="absolute w-2 h-2 bg-indigo-500 rounded-full animate-ping"></div>
            </div>
            <p className="text-[8px] font-black text-indigo-400 uppercase tracking-[0.2em] animate-pulse">
              ANALYSE INITIALE DU MARCHÉ... (5s)
            </p>
          </motion.div>
        )}
      </div>

      {/* Modals & Panels */}
      <AnimatePresence>
        {showRiskManager && (
          <RiskManagerPanel onClose={() => setShowRiskManager(false)} />
        )}
        {showTradingJournal && (
          <TradingJournalPanel onClose={() => setShowTradingJournal(false)} />
        )}
        {showModal && (
          <InfoModal type={showModal} onClose={() => setShowModal(null)} stats={userStats} />
        )}
        {showClearModal && (
          <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#121216] border border-gray-800 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl p-6 text-center space-y-6"
            >
              <h3 className="text-lg font-black text-white">
                {isClearing ? "Suppression du Chat en cours..." : "Êtes-vous sûr de vouloir vraiment vider le chat ?"}
              </h3>
              
              {isClearing ? (
                <div className="space-y-2">
                  <div className="h-2 w-full bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 transition-all duration-75" style={{ width: `${clearProgress}%` }}></div>
                  </div>
                  <p className="text-xs text-gray-500 font-bold">{clearProgress}%</p>
                </div>
              ) : (
                <div className="flex gap-3">
                  <button 
                    onClick={() => setShowClearModal(false)}
                    className="flex-1 py-3 bg-green-500 hover:bg-green-400 text-black font-black rounded-xl transition-all shadow-[0_0_20px_rgba(34,197,94,0.6)] uppercase tracking-wider"
                  >
                    Annuler
                  </button>
                  <button 
                    onClick={handleClearChat}
                    className="flex-1 py-3 bg-red-900/40 hover:bg-red-900/60 border border-red-500/30 text-red-500 font-black rounded-xl transition-all uppercase tracking-wider"
                  >
                    Vider
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Composant Risk Manager
function RiskManagerPanel({ onClose }: { onClose: () => void }) {
  const [initialCapital, setInitialCapital] = useState(1000);
  const [payout, setPayout] = useState(92);
  const [trades, setTrades] = useState<any[]>(Array(10).fill({ result: '', amount: 0, return: 0 }));
  const [sessionCounter, setSessionCounter] = useState(0);

  const [isDirty, setIsDirty] = useState(false);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('a2sniper_risk_session');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setInitialCapital(parsed.initialCapital || 1000);
        setPayout(parsed.payout || 92);
        setTrades(parsed.trades || Array(10).fill({ result: '', amount: 0, return: 0 }));
        setSessionCounter(parsed.sessionCounter || 0);
      } catch (e) {
        console.error("Failed to load risk session", e);
      }
    }
  }, []);

  const calculateResults = () => {
    let currentBalance = initialCapital;
    let wins = 0;
    let losses = 0;
    let totalProfit = 0;

    const computedTrades = trades.map(trade => {
      if (!trade.result || trade.amount <= 0) return { ...trade, balance: '-' };
      
      let res = 0;
      if (trade.result === 'WIN') {
        res = trade.amount * (payout / 100);
        currentBalance += res;
        wins++;
        totalProfit += res;
      } else {
        res = -trade.amount;
        currentBalance += res;
        losses++;
        totalProfit += res;
      }
      return { ...trade, return: Math.abs(res), balance: currentBalance.toFixed(2) };
    });

    return { computedTrades, wins, losses, totalProfit, currentBalance };
  };

  const results = calculateResults();

  const handleUpdateTrade = (idx: number, field: string, val: any) => {
    const newTrades = [...trades];
    newTrades[idx] = { ...newTrades[idx], [field]: val };
    setTrades(newTrades);
    setIsDirty(true);
  };

  const handleSave = () => {
    const dataToSave = { initialCapital, payout, trades, sessionCounter };
    localStorage.setItem('a2sniper_risk_session', JSON.stringify(dataToSave));
    setIsDirty(false);
    toast.success("Session sauvegardée avec succès !", { duration: 3000 });
  };

  const handleReset = () => {
    setTrades(Array(10).fill({ result: '', amount: 0, return: 0 }));
    setSessionCounter(0);
    setIsDirty(false);
    localStorage.removeItem('a2sniper_risk_session');
    toast.success("Session réinitialisée.", { duration: 3000 });
  };

  const handleCloseAttempt = () => {
    if (isDirty) {
      setShowUnsavedModal(true);
    } else {
      onClose();
    }
  };

  return (
    <motion.div 
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className="absolute inset-0 z-50 bg-[#050507] flex flex-col"
    >
      <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-[#0a0a0c]">
        <div className="flex items-center gap-3">
          <Calculator className="w-5 h-5 text-[#D4AF37]" />
          <h3 className="text-white font-black text-sm uppercase tracking-widest">A2Sniper Risk Manager</h3>
        </div>
        <button onClick={handleCloseAttempt} className="p-2 hover:bg-gray-800 rounded-xl transition-colors">
          <X className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6 no-scrollbar scrollbar-hide">
        {/* Config Panel */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-[#121216] p-4 rounded-2xl border border-gray-800">
            <p className="text-[10px] font-black text-gray-500 uppercase mb-2">Capital Initial ($)</p>
            <input 
              type="number" 
              value={initialCapital} 
              onChange={(e) => { setInitialCapital(Number(e.target.value)); setIsDirty(true); }}
              className="w-full bg-black border border-gray-800 rounded-lg px-3 py-2 text-sm font-black text-white outline-none focus:border-[#D4AF37] transition-colors"
            />
          </div>
          <div className="bg-[#121216] p-4 rounded-2xl border border-gray-800">
            <p className="text-[10px] font-black text-gray-500 uppercase mb-2">Payout Moyen (%)</p>
            <input 
              type="number" 
              value={payout} 
              onChange={(e) => { setPayout(Number(e.target.value)); setIsDirty(true); }}
              className="w-full bg-black border border-gray-800 rounded-lg px-3 py-2 text-sm font-black text-white outline-none focus:border-[#D4AF37] transition-colors"
            />
          </div>
        </div>

        {/* Stats Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-[#121216] p-3 rounded-xl border border-gray-800 text-center">
            <p className="text-[8px] font-black text-gray-500 uppercase">Balance</p>
            <p className="text-sm font-black text-white">${results.currentBalance.toFixed(2)}</p>
          </div>
          <div className="bg-[#121216] p-3 rounded-xl border border-gray-800 text-center">
            <p className="text-[8px] font-black text-gray-500 uppercase">Profit</p>
            <p className={`text-sm font-black ${results.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {results.totalProfit >= 0 ? '+' : ''}${results.totalProfit.toFixed(2)}
            </p>
          </div>
          <div className="bg-[#121216] p-3 rounded-xl border border-gray-800 text-center">
            <p className="text-[8px] font-black text-gray-500 uppercase">Ratio</p>
            <p className="text-sm font-black text-[#D4AF37]">{results.wins}/{results.losses + results.wins}</p>
          </div>
        </div>

        {/* Trade Table */}
        <div className="space-y-2">
          <div className="flex px-3 text-[9px] font-black text-gray-600 uppercase tracking-widest">
            <div className="w-8">N°</div>
            <div className="flex-1">Résultat</div>
            <div className="w-24">Stake</div>
            <div className="w-24 text-right">Balance</div>
          </div>
          {results.computedTrades.map((trade, i) => (
            <div key={i} className="flex items-center gap-2 bg-[#121216]/50 p-2 rounded-xl border border-gray-800/50 hover:border-gray-700 transition-colors">
              <div className="w-8 text-[10px] font-black text-gray-600">{i + 1}</div>
              <div className="flex-1 flex gap-1">
                <button 
                  onClick={() => handleUpdateTrade(i, 'result', 'WIN')}
                  className={`flex-1 py-1 rounded-lg text-[9px] font-black transition-all ${trade.result === 'WIN' ? 'bg-green-500 text-white shadow-lg shadow-green-500/20' : 'bg-gray-800 text-gray-500'}`}
                >
                  WIN
                </button>
                <button 
                  onClick={() => handleUpdateTrade(i, 'result', 'LOSS')}
                  className={`flex-1 py-1 rounded-lg text-[9px] font-black transition-all ${trade.result === 'LOSS' ? 'bg-red-500 text-white shadow-lg shadow-red-500/20' : 'bg-gray-800 text-gray-500'}`}
                >
                  LOSS
                </button>
              </div>
              <div className="w-24">
                <input 
                  type="number" 
                  placeholder="Stake"
                  value={trade.amount || ''}
                  onChange={(e) => handleUpdateTrade(i, 'amount', Number(e.target.value))}
                  className="w-full bg-black/50 border border-gray-800 rounded-lg px-2 py-1 text-[10px] font-black text-white outline-none"
                />
              </div>
              <div className="w-24 text-right text-[10px] font-black text-[#D4AF37]">
                {trade.balance === '-' ? '-' : `$${trade.balance}`}
              </div>
            </div>
          ))}
        </div>

        {/* Session Controls */}
        <div className="bg-[#121216] p-6 rounded-2xl border border-gray-800 flex flex-col items-center gap-4">
          <p className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em]">Session Counter</p>
          <div className="flex items-center gap-8">
            <button onClick={() => { setSessionCounter(Math.max(0, sessionCounter - 1)); setIsDirty(true); }} className="p-3 bg-gray-800 rounded-full hover:bg-gray-700 transition-colors">
              <ChevronLeft className="w-6 h-6 text-white" />
            </button>
            <span className="text-5xl font-black text-white tabular-nums drop-shadow-[0_0_20px_rgba(255,255,255,0.2)]">{sessionCounter}</span>
            <button onClick={() => { setSessionCounter(sessionCounter + 1); setIsDirty(true); }} className="p-3 bg-gray-800 rounded-full hover:bg-gray-700 transition-colors">
              <ChevronRight className="w-6 h-6 text-white" />
            </button>
          </div>
          <button 
            onClick={handleReset}
            className="text-[10px] font-black text-gray-500 hover:text-white uppercase tracking-widest flex items-center gap-2 mt-2"
          >
            <RefreshCw className="w-3 h-3" /> RESET SESSION
          </button>
        </div>
      </div>

      <div className="p-4 bg-[#0a0a0c] border-t border-gray-800 grid grid-cols-2 gap-3">
        <button onClick={handleSave} className="py-3 bg-[#1a1a1e] border border-gray-800 rounded-2xl text-[10px] font-black text-white flex items-center justify-center gap-2 hover:bg-[#25252b] transition-all">
          <Save className={`w-4 h-4 ${isDirty ? 'text-yellow-500 animate-pulse' : 'text-[#D4AF37]'}`} /> SAUVEGARDER
        </button>
        <button className="py-2 bg-[#D4AF37] hover:bg-[#c5a059] rounded-2xl text-[10px] font-black text-black flex items-center justify-center gap-2 transition-all shadow-lg shadow-[#D4AF37]/20">
          <Download className="w-4 h-4 text-black" /> EXPORTER EN PDF
        </button>
      </div>

      {/* Unsaved Changes Confirmation Modal */}
      <AnimatePresence>
        {showUnsavedModal && (
          <div className="absolute inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#121216] border border-gray-800 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl p-6 text-center space-y-6"
            >
              <h3 className="text-base font-black text-white">Voulez-vous vraiment fermer le risk manager sans avoir sauvegardé vos trades ?</h3>
              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    handleSave();
                    setShowUnsavedModal(false);
                    onClose();
                  }}
                  className="flex-1 py-3 bg-[#D4AF37] hover:bg-[#c5a059] text-black font-black text-[11px] rounded-xl transition-all shadow-[0_0_20px_rgba(212,175,55,0.4)] uppercase tracking-wider leading-tight"
                >
                  Sauvegarder & Fermer
                </button>
                <button 
                  onClick={() => {
                    setShowUnsavedModal(false);
                    onClose();
                  }}
                  className="flex-1 py-3 bg-red-900/40 hover:bg-red-900/60 border border-red-500/30 text-red-500 font-black text-[11px] rounded-xl transition-all uppercase tracking-wider"
                >
                  Fermer
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// Composant Trading Journal
function TradingJournalPanel({ onClose }: { onClose: () => void }) {
  const [sessionData, setSessionData] = useState<any>(null);

  useEffect(() => {
    const saved = localStorage.getItem('a2sniper_risk_session');
    if (saved) {
      try {
        setSessionData(JSON.parse(saved));
      } catch (e) {}
    }
  }, []);

  const getStats = () => {
    if (!sessionData) return { wins: 0, losses: 0, profit: 0, balance: 0, capital: 0 };
    let wins = 0;
    let losses = 0;
    let profit = 0;
    
    sessionData.trades.forEach((t: any) => {
      if (t.result === 'WIN' && t.amount > 0) {
        wins++;
        profit += t.amount * (sessionData.payout / 100);
      } else if (t.result === 'LOSS' && t.amount > 0) {
        losses++;
        profit -= t.amount;
      }
    });

    return {
      wins,
      losses,
      profit,
      balance: sessionData.initialCapital + profit,
      capital: sessionData.initialCapital
    };
  };

  const stats = getStats();
  const validTrades = sessionData ? sessionData.trades.filter((t: any) => t.result && t.amount > 0) : [];

  return (
    <motion.div 
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className="absolute inset-0 z-50 bg-[#050507] flex flex-col"
    >
      <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-[#0a0a0c]">
        <div className="flex items-center gap-3">
          <BarChart4 className="w-5 h-5 text-[#D4AF37]" />
          <h3 className="text-white font-black text-sm uppercase tracking-widest">Trading Journal</h3>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-xl transition-colors">
          <X className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6 no-scrollbar scrollbar-hide">
        {!sessionData ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4 opacity-50">
            <Info className="w-12 h-12 text-gray-500" />
            <p className="text-sm font-bold text-gray-400">Aucune session sauvegardée.</p>
            <p className="text-xs text-gray-500">Utilisez le Risk Manager pour planifier et sauvegarder vos trades.</p>
          </div>
        ) : (
          <>
            {/* Vue d'ensemble */}
            <div className="bg-gradient-to-br from-[#D4AF37]/10 to-[#C5A059]/10 border border-[#D4AF37]/20 p-5 rounded-2xl space-y-4">
              <div className="flex justify-between items-center border-b border-[#D4AF37]/20 pb-3">
                <span className="text-xs font-black text-[#D4AF37] uppercase tracking-widest">Aperçu Global</span>
                <span className="text-[10px] font-bold text-gray-500">Session {sessionData.sessionCounter}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] text-gray-400 font-bold uppercase mb-1">Capital Initial</p>
                  <p className="text-lg font-black text-white">${stats.capital.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 font-bold uppercase mb-1">Balance Actuelle</p>
                  <p className="text-lg font-black text-[#D4AF37]">${stats.balance.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 font-bold uppercase mb-1">Net PnL</p>
                  <p className={`text-lg font-black ${stats.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {stats.profit >= 0 ? '+' : ''}${stats.profit.toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 font-bold uppercase mb-1">Win Rate</p>
                  <p className="text-lg font-black text-white">
                    {stats.wins + stats.losses > 0 
                      ? Math.round((stats.wins / (stats.wins + stats.losses)) * 100) 
                      : 0}%
                  </p>
                </div>
              </div>
            </div>

            {/* Historique des Trades */}
            <div>
              <p className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">Historique Détaillé</p>
              {validTrades.length === 0 ? (
                <p className="text-xs text-gray-500 italic text-center py-4 bg-[#121216] rounded-xl">Aucun trade enregistré dans cette session.</p>
              ) : (
                <div className="space-y-2">
                  {validTrades.map((t: any, idx: number) => {
                    const isWin = t.result === 'WIN';
                    const profitLoss = isWin ? t.amount * (sessionData.payout / 100) : -t.amount;
                    return (
                      <div key={idx} className="flex items-center justify-between bg-[#121216] border border-gray-800 p-3 rounded-xl hover:border-gray-700 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-[10px] ${isWin ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>
                            #{idx + 1}
                          </div>
                          <div>
                            <p className="text-xs font-black text-white">Mise: ${t.amount}</p>
                            <p className={`text-[10px] font-bold ${isWin ? 'text-green-500' : 'text-red-500'}`}>
                              {t.result}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={`text-sm font-black ${isWin ? 'text-green-400' : 'text-red-400'}`}>
                            {isWin ? '+' : ''}${profitLoss.toFixed(2)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}

// Composant Modals d'information
function InfoModal({ type, onClose, stats }: { type: 'DISCLAIMER' | 'AIDE' | 'PERF' | null, onClose: () => void, stats: any }) {
  const content = {
    DISCLAIMER: {
      title: "Risque & Conformité",
      icon: <ShieldAlert className="w-8 h-8 text-red-500" />,
      body: (
        <div className="text-left space-y-4">
          <p className="font-bold text-red-400 uppercase tracking-widest text-[10px]">Attention : Risque élevé</p>
          <p>Le trading sur options binaires et Forex comporte un niveau de risque très élevé et peut ne pas convenir à tous les investisseurs.</p>
          <ul className="list-disc pl-4 space-y-2 text-gray-300">
            <li>L'effet de levier peut jouer aussi bien en votre faveur qu'en votre défaveur.</li>
            <li>Avant de trader, examinez attentivement vos objectifs, votre expérience et votre gestion du risque.</li>
            <li><strong>Ne tradez jamais</strong> avec de l'argent que vous ne pouvez pas vous permettre de perdre.</li>
          </ul>
          <p className="italic text-gray-500 pt-2 border-t border-gray-800">L'Assistant A2Sniper fournit des analyses de pointe basées sur des algorithmes HFT, mais ne garantit en aucun cas des profits futurs.</p>
        </div>
      )
    },
    AIDE: {
      title: "Guide A2Sniper 3.0",
      icon: <Info className="w-8 h-8 text-[#D4AF37]" />,
      body: (
        <div className="text-left space-y-4">
          <p className="font-bold text-[#D4AF37] uppercase tracking-widest text-[10px]">Étapes de déploiement</p>
          <ol className="list-decimal pl-4 space-y-3 text-gray-300">
            <li><strong>Connectivité</strong> : Assurez-vous d'avoir fourni un SSID valide et que le voyant 'CONNECTED' est vert.</li>
            <li><strong>Analyse</strong> : Cliquez sur <span className="text-[#D4AF37]">Pairs de devises</span> pour voir les opportunités actuelles du marché.</li>
            <li><strong>Exécution</strong> : Suivez la direction signalée (<span className="text-green-400">CALL</span> ou <span className="text-red-400">PUT</span>) et le temps d'expiration exact affiché.</li>
            <li><strong>Gestion du risque</strong> : Utilisez l'outil <span className="text-red-400">Risk Manager</span> pour planifier vos sessions et protéger votre capital.</li>
            <li><strong>Stratégie</strong> : Notre système utilise un consensus tripartite validant les structures SMC et zones institutionnelles avant de délivrer un signal.</li>
          </ol>
        </div>
      )
    },
    PERF: {
      title: "Performance Live",
      icon: <BarChart4 className="w-8 h-8 text-[#D4AF37]" />,
      body: (
        <div className="text-left space-y-4">
          <p className="font-bold text-[#D4AF37] uppercase tracking-widest text-[10px]">Statistiques en temps réel</p>
          <div className="bg-black/50 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Winrate Global</span>
              <span className="font-black text-green-400 text-lg">{stats.winRate.toFixed(2)}%</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Signaux du jour</span>
              <span className="font-black text-white">{stats.todaySignals}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Profit estimé (lot $10)</span>
              <span className="font-black text-[#D4AF37]">+${(stats.todaySignals * 0.92 * 10 * (stats.winRate / 100)).toFixed(2)}</span>
            </div>
          </div>
          <ul className="space-y-2 text-xs text-gray-400 pt-2 border-t border-gray-800">
            <li className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
              Précision Algorithmique : 99.99%
            </li>
            <li className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full"></div>
              Latence Exécution : &lt; 150ms
            </li>
          </ul>
          <p className="text-[10px] text-gray-600 font-bold uppercase text-center mt-2">Données extraites directement du Kernel A2Sniper AI.</p>
        </div>
      )
    }
  };

  const current = content[type as keyof typeof content];

  return (
    <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="bg-[#121216] border border-gray-800 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl flex flex-col max-h-[90%]"
      >
        <div className="px-5 pt-5 pb-3 flex items-center gap-3">
          <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center border border-white/10 shadow-lg shrink-0">
            {current.icon}
          </div>
          <h3 className="text-base font-black text-white uppercase tracking-tight">{current.title}</h3>
        </div>
        <div
          className="px-6 pb-4 overflow-y-scroll text-sm text-gray-300 no-scrollbar"
        >
          {current.body}
        </div>
        <div className="px-5 pb-5 pt-2 bg-black/20">
          <button 
            onClick={onClose}
            className="w-full py-3.5 bg-gradient-to-r from-gray-800 to-gray-900 hover:from-gray-700 hover:to-gray-800 rounded-xl text-xs font-black text-white transition-all shadow-lg uppercase tracking-widest border border-gray-700"
          >
            Fermer
          </button>
        </div>
      </motion.div>
    </div>
  );
}