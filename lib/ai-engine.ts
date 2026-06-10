import { TechnicalIndicators, MarketData, TechnicalAnalysis } from './technical-indicators';

export interface MLFeatures {
  price_change_1m: number;
  price_change_5m: number;
  volume_ratio: number;
  volatility: number;
  trend_strength: number;
  support_resistance: number;
  market_sentiment: number;
  time_features: {
    hour: number;
    day_of_week: number;
    is_market_open: boolean;
  };
}

export interface SignalScore {
  base_probability: number;
  technical_winrate: number;
  ml_probability: number;
  volume_winrate: number;
  trend_winrate: number;
  final_winrate: number;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  isSimulation: boolean;
}

export interface AISignal {
  id: string;
  pair: string;
  direction: 'CALL' | 'PUT';
  winrate: number;
  entry_price: number;
  target_price: number;
  stop_loss: number;
  expiration: number;
  technical_indicators: TechnicalIndicators;
  ml_features: MLFeatures;
  signal_score: SignalScore;
  timestamp: Date;
  reasoning: string[];
  is_win?: boolean;
}

export class AITradingEngine {
  private readonly winrateThreshold = 85;
  private readonly riskLevels = {
    LOW: { maxRisk: 0.02, minWinrate: 90 },
    MEDIUM: { maxRisk: 0.05, minWinrate: 85 },
    HIGH: { maxRisk: 0.10, minWinrate: 75 }
  };

  // Nouvelles méthodes pour conformité au document
  
  // Collecte de données marché selon spécifications
  async collectMarketData(): Promise<MarketData[]> {
    // Simulation de collecte multi-sources (Alpha Vantage, Yahoo Finance, Quandl)
    const sources = ['Alpha Vantage', 'Yahoo Finance', 'Quandl', 'WebSocket'];
    const data: MarketData[] = [];
    
    for (const source of sources) {
      // Simulation de données haute fréquence (mise à jour toutes les secondes)
      const sourceData = this.generateHighFrequencyData(source);
      data.push(...sourceData);
    }
    
    return this.normalizeAndFilter(data);
  }
  
  // Pipeline ETL selon spécifications
  private normalizeAndFilter(rawData: MarketData[]): MarketData[] {
    // 1. Extraction (ETL)
    const extracted = rawData.filter(d => d.close > 0 && d.volume > 0);
    
    // 2. Nettoyage (outliers, données manquantes)
    const cleaned = extracted.filter(d => {
      const priceChange = Math.abs(d.high - d.low) / d.close;
      return priceChange < 0.1; // Suppression des outliers > 10%
    });
    
    // 3. Normalisation (alignement des timeframes)
    const normalized = this.alignTimeframes(cleaned);
    
    return normalized;
  }
  
  // Génération de données haute fréquence
  private generateHighFrequencyData(source: string): MarketData[] {
    const data: MarketData[] = [];
    const now = Date.now();
    
    // Génération de 60 points (1 minute de données par seconde)
    for (let i = 0; i < 60; i++) {
      const timestamp = new Date(now - (60 - i) * 1000);
      const basePrice = 1.0800 + Math.random() * 0.01;
      
      data.push({
        symbol: 'EUR/USD OTC',
        timestamp,
        open: basePrice,
        high: basePrice + Math.random() * 0.001,
        low: basePrice - Math.random() * 0.001,
        close: basePrice + (Math.random() - 0.5) * 0.001,
        volume: 1000000 + Math.random() * 500000,
        bid: basePrice - 0.0001,
        ask: basePrice + 0.0001,
        spread: 0.0002
      });
    }
    
    return data;
  }
  
  // Alignement des timeframes
  private alignTimeframes(data: MarketData[]): MarketData[] {
    // Agrégation par minute pour uniformiser les timeframes
    const minuteData = new Map<string, MarketData[]>();
    
    data.forEach(point => {
      const minute = new Date(point.timestamp);
      minute.setSeconds(0, 0);
      const key = minute.toISOString();
      
      if (!minuteData.has(key)) {
        minuteData.set(key, []);
      }
      minuteData.get(key)!.push(point);
    });
    
    // Création de bougies par minute
    const aggregated: MarketData[] = [];
    minuteData.forEach((points, timeKey) => {
      if (points.length > 0) {
        const open = points[0].open;
        const close = points[points.length - 1].close;
        const high = Math.max(...points.map(p => p.high));
        const low = Math.min(...points.map(p => p.low));
        const volume = points.reduce((sum, p) => sum + p.volume, 0);
        
        aggregated.push({
          symbol: points[0].symbol,
          timestamp: new Date(timeKey),
          open,
          high,
          low,
          close,
          volume,
          bid: close - 0.0001,
          ask: close + 0.0001,
          spread: 0.0002
        });
      }
    });
    
    return aggregated.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  
  // Génération de signaux selon format spécifié
  generateFormattedSignal(signal: AISignal): string {
    const time = signal.timestamp.toLocaleTimeString('fr-FR');
    const direction = signal.direction;
    const expiration = signal.expiration;
    const winrate = signal.winrate;
    
    return `[${time}] – Actif: [${signal.pair}] – Direction: [${direction}] – Expiration: [${expiration} min] – Winrate: [${winrate}%]`;
  }
  
  private signalIntervalId: ReturnType<typeof setInterval> | null = null;

  // Calcul de signaux toutes les minutes selon spécifications
  startSignalGeneration(callback: (signal: string) => void): void {
    this.signalIntervalId = setInterval(async () => {
      try {
        const marketData = await this.collectMarketData();
        const signal = await this.generateSignal('EUR/USD OTC', marketData);
        
        if (signal && signal.winrate >= this.winrateThreshold) {
          const formattedSignal = this.generateFormattedSignal(signal);
          callback(formattedSignal);
        }
      } catch (error) {
        console.error('Erreur génération signal:', error);
      }
    }, 60000); // Toutes les minutes
  }

  // Arrêt de la génération de signaux
  stopSignalGeneration(): void {
    if (this.signalIntervalId !== null) {
      clearInterval(this.signalIntervalId);
      this.signalIntervalId = null;
    }
  }

  // Rule-based analysis using Random Forest-like logic (NOT a trained ML model)
  // This is a heuristic analysis function, not a machine learning model
  private analyzeWithRandomForestLogic(features: MLFeatures): number {
    // Heuristic analysis based on features
    let score = 0.5;
    
    // Momentum analysis
    if (Math.abs(features.price_change_1m) > 0.001) {
      score += features.price_change_1m > 0 ? 0.1 : -0.1;
    }
    
    // Volume analysis
    if (features.volume_ratio > 1.2) {
      score += 0.15;
    }
    
    // Volatility analysis
    if (features.volatility > 0.02) {
      score += features.trend_strength > 0 ? 0.1 : -0.1;
    }
    
    // Time factors
    const { hour, is_market_open } = features.time_features;
    if (is_market_open && (hour >= 8 && hour <= 16)) {
      score += 0.05; // Active trading hours
    }
    
    return Math.max(0, Math.min(1, score));
  }

  // Rule-based analysis using XGBoost-like logic (NOT a trained ML model)
  // This is a heuristic analysis function, not a gradient boosting model
  private analyzeWithXGBoostLogic(features: MLFeatures, technicals: TechnicalIndicators): number {
    let score = 0.5;
    
    // Analyse RSI
    if (technicals.rsi < 30) score += 0.2; // Survente
    else if (technicals.rsi > 70) score -= 0.2; // Surachat
    
    // Analyse MACD
    if (technicals.macd.histogram > 0) score += 0.15;
    else score -= 0.15;
    
    // Analyse Bollinger Bands
    const bbUpper = technicals.bollinger.upper;
    const bbLower = technicals.bollinger.lower;
    const bbRange = bbUpper - bbLower;
    const currentPrice = technicals.bollinger.middle;
    const bbPosition = bbRange > 0 ? (currentPrice - bbLower) / bbRange : 0.5;
    if (bbPosition < 0.2) score += 0.1; // Proche de la bande inférieure
    else if (bbPosition > 0.8) score -= 0.1; // Proche de la bande supérieure
    
    // Analyse ADX
    if (technicals.adx > 25) {
      score += features.trend_strength > 0 ? 0.1 : -0.1;
    }
    
    return Math.max(0, Math.min(1, score));
  }

  // Rule-based analysis using LSTM-like logic (NOT a trained ML model)
  // This is a heuristic pattern analysis, not a recurrent neural network
  private analyzeWithLSTMLogic(marketHistory: MarketData[]): number {
    if (marketHistory.length < 10) return 0.5;
    
    // Analyse des patterns temporels
    const recentPrices = marketHistory.slice(-10).map(d => d.close);
    const priceChanges = recentPrices.slice(1).map((price, i) => price - recentPrices[i]);
    
    // Détection de tendance
    const upMoves = priceChanges.filter(change => change > 0).length;
    const trendScore = upMoves / priceChanges.length;
    
    // Analyse de la volatilité récente
    const volatility = this.calculateVolatility(recentPrices);
    const volatilityScore = volatility < 0.02 ? 0.6 : 0.4;
    
    return (trendScore * 0.7) + (volatilityScore * 0.3);
  }

  // Calcul de la volatilité
  private calculateVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;
    
    const returns = prices.slice(1).map((price, i) => Math.log(price / prices[i]));
    const meanReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }

  // Extraction des features ML
  private extractMLFeatures(marketData: MarketData[]): MLFeatures {
    if (marketData.length < 10) {
      throw new Error('Données insuffisantes pour l\'analyse');
    }

    const latest = marketData[marketData.length - 1];
    const previous1m = marketData[marketData.length - 2];
    const previous5m = marketData[marketData.length - 6] || previous1m;
    
    const recentVolumes = marketData.slice(-20).map(d => d.volume);
    const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
    
    const recentPrices = marketData.slice(-20).map(d => d.close);
    const volatility = this.calculateVolatility(recentPrices);
    
    // Calcul du trend strength
    const ema9 = TechnicalAnalysis.calculateEMA(recentPrices, 9);
    const ema21 = TechnicalAnalysis.calculateEMA(recentPrices, 21);
    const trendStrength = (ema9 - ema21) / ema21;
    
    // Support/Resistance simplifié
    const highs = marketData.slice(-50).map(d => d.high);
    const lows = marketData.slice(-50).map(d => d.low);
    const resistance = Math.max(...highs);
    const support = Math.min(...lows);
    const supportResistance = (latest.close - support) / (resistance - support);
    
    const now = new Date();
    
    return {
      price_change_1m: (latest.close - previous1m.close) / previous1m.close,
      price_change_5m: (latest.close - previous5m.close) / previous5m.close,
      volume_ratio: latest.volume / avgVolume,
      volatility,
      trend_strength: trendStrength,
      support_resistance: supportResistance,
      market_sentiment: this.calculateSentiment((latest.close - previous1m.close) / previous1m.close, trendStrength),
      time_features: {
        hour: now.getHours(),
        day_of_week: now.getDay(),
        is_market_open: this.isMarketOpen(now)
      }
    };
  }

  // Calcul du sentiment de marché (déterministe, basé sur les indicateurs)
  private calculateSentiment(priceChange1m: number, trendStrength: number): number {
    // Base sentiment from price momentum
    let sentiment = 0.5;
    if (priceChange1m > 0.001) sentiment += 0.15;
    else if (priceChange1m < -0.001) sentiment -= 0.15;
    else sentiment += priceChange1m * 50; // Small changes scaled

    // Adjust for trend strength
    if (trendStrength > 0.01) sentiment += 0.1;
    else if (trendStrength < -0.01) sentiment -= 0.1;

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, sentiment));
  }

  // Vérification des heures de marché
  private isMarketOpen(date: Date): boolean {
    const hour = date.getHours();
    const day = date.getDay();
    
    // Marché forex ouvert 24h/5j
    if (day === 0 || day === 6) return false; // Weekend
    if (day === 1 && hour < 1) return false; // Lundi avant 1h
    if (day === 5 && hour > 21) return false; // Vendredi après 21h
    
    return true;
  }

  // Calcul du winrate final
  private calculateFinalWinrate(scores: Omit<SignalScore, 'final_winrate' | 'risk_level'>): SignalScore {
    const weights = {
      base_probability: 0.25,
      technical_winrate: 0.30,
      ml_probability: 0.25,
      volume_winrate: 0.15,
      trend_winrate: 0.05
    };
    
    const finalWinrate = Object.entries(weights).reduce((total, [key, weight]) => {
      return total + (scores[key as keyof typeof scores] * weight);
    }, 0) * 100;
    
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM';
    if (finalWinrate >= 90) riskLevel = 'LOW';
    else if (finalWinrate < 85) riskLevel = 'HIGH';
    
    return {
      ...scores,
      final_winrate: finalWinrate,
      risk_level: riskLevel,
      isSimulation: true // All analysis is rule-based, not from trained ML models
    };
  }

  // Génération des raisons du signal
  private generateReasoning(technicals: TechnicalIndicators, features: MLFeatures, direction: 'CALL' | 'PUT'): string[] {
    const reasons: string[] = [];
    
    // Analyse RSI
    if (technicals.rsi < 30) {
      reasons.push(`RSI en survente (${technicals.rsi.toFixed(1)}) - Signal d'achat potentiel`);
    } else if (technicals.rsi > 70) {
      reasons.push(`RSI en surachat (${technicals.rsi.toFixed(1)}) - Signal de vente potentiel`);
    }
    
    // Analyse MACD
    if (technicals.macd.histogram > 0) {
      reasons.push('MACD au-dessus de la ligne de signal - Momentum haussier');
    } else {
      reasons.push('MACD en-dessous de la ligne de signal - Momentum baissier');
    }
    
    // Analyse du volume
    if (features.volume_ratio > 1.5) {
      reasons.push(`Volume élevé (${(features.volume_ratio * 100).toFixed(0)}% de la moyenne) - Confirmation du mouvement`);
    }
    
    // Analyse de tendance
    if (Math.abs(features.trend_strength) > 0.01) {
      const trendDirection = features.trend_strength > 0 ? 'haussière' : 'baissière';
      reasons.push(`Tendance ${trendDirection} confirmée par les EMA`);
    }
    
    // Analyse ADX
    if (technicals.adx > 25) {
      reasons.push(`Force de tendance élevée (ADX: ${technicals.adx.toFixed(1)}) - Mouvement directionnel fort`);
    }
    
    return reasons;
  }

  // Génération d'un signal AI complet
  async generateSignal(pair: string, marketData: MarketData[]): Promise<AISignal | null> {
    try {
      // Extraction des features et indicateurs
      const mlFeatures = this.extractMLFeatures(marketData);
      const technicals = TechnicalAnalysis.analyzeMarket(marketData);
      
      // Calculate scores from rule-based analysis (NOT trained ML models)
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[A2Sniper] AI Engine: All analysis functions are rule-based heuristics, NOT trained ML models. ' +
          'Results should not be interpreted as ML predictions. isSimulation: true flag is set on all outputs.'
        );
      }
      
      const rfScore = this.analyzeWithRandomForestLogic(mlFeatures);
      const xgbScore = this.analyzeWithXGBoostLogic(mlFeatures, technicals);
      const lstmScore = this.analyzeWithLSTMLogic(marketData);
      
      // Technical scores
      const technicalScore = this.calculateTechnicalScore(technicals);
      const volumeScore = Math.min(1, mlFeatures.volume_ratio / 2);
      const trendScore = Math.abs(mlFeatures.trend_strength) * 10;
      
      // Final score — marked as simulation since these are heuristics, not trained models
      const signalScore = this.calculateFinalWinrate({
        base_probability: (rfScore + xgbScore + lstmScore) / 3,
        technical_winrate: technicalScore,
        ml_probability: Math.max(rfScore, xgbScore, lstmScore),
        volume_winrate: volumeScore,
        trend_winrate: trendScore
      });
      
      // Filtrage par seuil de winrate
      if (signalScore.final_winrate < this.winrateThreshold) {
        return null;
      }
      
      // Détermination de la direction
      const direction: 'CALL' | 'PUT' = signalScore.base_probability > 0.5 ? 'CALL' : 'PUT';
      
      // Calcul des prix cibles
      const currentPrice = marketData[marketData.length - 1].close;
      const volatility = mlFeatures.volatility;
      const targetDistance = volatility * 2;
      const stopDistance = volatility * 1.5;
      
      const targetPrice = direction === 'CALL' ? 
        currentPrice * (1 + targetDistance) : 
        currentPrice * (1 - targetDistance);
      
      const stopLoss = direction === 'CALL' ? 
        currentPrice * (1 - stopDistance) : 
        currentPrice * (1 + stopDistance);
      
      // Génération du signal
      const signal: AISignal = {
        id: `signal_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        pair,
        direction,
        winrate: Math.round(signalScore.final_winrate),
        entry_price: currentPrice,
        target_price: targetPrice,
        stop_loss: stopLoss,
        expiration: this.calculateExpiration(signalScore.final_winrate),
        technical_indicators: technicals,
        ml_features: mlFeatures,
        signal_score: signalScore,
        timestamp: new Date(),
        reasoning: this.generateReasoning(technicals, mlFeatures, direction)
      };
      
      return signal;
    } catch (error) {
      console.error('Erreur lors de la génération du signal:', error);
      return null;
    }
  }

  // Calcul du score technique
  private calculateTechnicalScore(technicals: TechnicalIndicators): number {
    let score = 0.5;
    
    // RSI
    if (technicals.rsi < 30) score += 0.2;
    else if (technicals.rsi > 70) score -= 0.2;
    else if (technicals.rsi >= 40 && technicals.rsi <= 60) score += 0.1;
    
    // MACD
    if (technicals.macd.histogram > 0) score += 0.15;
    else score -= 0.15;
    
    // Bollinger Bands
    const bbUpper = technicals.bollinger.upper;
    const bbLower = technicals.bollinger.lower;
    const bbRange = bbUpper - bbLower;
    const bbPosition = bbRange > 0 ? (technicals.bollinger.middle - bbLower) / bbRange : 0.5;
    if (bbPosition < 0.2) score += 0.1;
    else if (bbPosition > 0.8) score -= 0.1;
    
    // EMA
    if (technicals.ema.ema9 > technicals.ema.ema21) score += 0.1;
    else score -= 0.1;
    
    // ADX
    if (technicals.adx > 25) score += 0.05;
    
    return Math.max(0, Math.min(1, score));
  }

  // Calcul de l'expiration optimale
  private calculateExpiration(winrate: number): number {
    if (winrate >= 95) return 1; // 1 minute pour haute précision
    if (winrate >= 90) return 3; // 3 minutes
    if (winrate >= 85) return 5; // 5 minutes
    return 5; // Par défaut
  }

  // Validation du signal
  validateSignal(signal: AISignal): boolean {
    // Vérifications de base
    if (signal.winrate < this.winrateThreshold) return false;
    if (!signal.pair || !signal.direction) return false;
    if (signal.entry_price <= 0) return false;
    
    // Vérification des niveaux de risque
    const riskConfig = this.riskLevels[signal.signal_score.risk_level];
    if (signal.winrate < riskConfig.minWinrate) return false;
    
    // Vérification de la cohérence des prix
    const priceRange = Math.abs(signal.target_price - signal.entry_price) / signal.entry_price;
    if (priceRange > 0.1) return false; // Mouvement trop important
    
    return true;
  }
}