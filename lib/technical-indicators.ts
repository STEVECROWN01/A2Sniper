// Indicateurs techniques pour l'analyse de marché
export interface TechnicalIndicators {
  rsi: number;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  };
  bollinger: {
    upper: number;
    middle: number;
    lower: number;
  };
  ema: {
    ema9: number;
    ema21: number;
  };
  adx: number;
  volume_sma: number;
  stochastic: {
    k: number;
    d: number;
  };
}

export interface MarketData {
  symbol: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
  spread: number;
}

export class TechnicalAnalysis {
  // Calcul RSI (Relative Strength Index) - Wilder's smoothing
  static calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50;
    
    // Initial average gain/loss (simple average)
    let gains = 0;
    let losses = 0;
    
    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    // Wilder's smoothing for remaining data points
    for (let i = period + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      const currentGain = change > 0 ? change : 0;
      const currentLoss = change < 0 ? -change : 0;
      avgGain = (avgGain * (period - 1) + currentGain) / period;
      avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    }
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // Calcul MACD (Moving Average Convergence Divergence)
  static calculateMACD(prices: number[], fastPeriod: number = 12, slowPeriod: number = 26, signalPeriod: number = 9) {
    if (prices.length < slowPeriod + signalPeriod) {
      return { macd: 0, signal: 0, histogram: 0 };
    }
    
    const fastEMA = this.calculateEMAArray(prices, fastPeriod);
    const slowEMA = this.calculateEMAArray(prices, slowPeriod);
    
    // Calculate MACD line as array
    const macdLine: number[] = [];
    const startIdx = slowPeriod - 1;
    for (let i = startIdx; i < prices.length; i++) {
      macdLine.push(fastEMA[i] - slowEMA[i]);
    }
    
    // Calculate signal line from MACD line
    const signalLine = this.calculateEMAArray(macdLine, signalPeriod);
    
    const lastIdx = macdLine.length - 1;
    const macd = macdLine[lastIdx];
    const signal = signalLine[lastIdx];
    const histogram = macd - signal;
    
    return { macd, signal, histogram };
  }

  // Calcul EMA (Exponential Moving Average) - returns single value
  static calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    
    const multiplier = 2 / (period + 1);
    let ema = prices[0];
    
    for (let i = 1; i < prices.length; i++) {
      ema = (prices[i] * multiplier) + (ema * (1 - multiplier));
    }
    
    return ema;
  }

  // Calcul EMA array - returns EMA for each price point (needed for MACD)
  static calculateEMAArray(prices: number[], period: number): number[] {
    if (prices.length === 0) return [];
    
    const multiplier = 2 / (period + 1);
    const emaArray: number[] = [prices[0]];
    
    for (let i = 1; i < prices.length; i++) {
      emaArray.push((prices[i] * multiplier) + (emaArray[i - 1] * (1 - multiplier)));
    }
    
    return emaArray;
  }

  // Calcul Bollinger Bands
  static calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2) {
    if (prices.length < period) {
      const sma = prices.reduce((sum, price) => sum + price, 0) / prices.length;
      return { upper: sma, middle: sma, lower: sma };
    }
    
    const sma = prices.slice(-period).reduce((sum, price) => sum + price, 0) / period;
    
    const variance = prices.slice(-period).reduce((sum, price) => {
      return sum + Math.pow(price - sma, 2);
    }, 0) / period;
    
    const standardDeviation = Math.sqrt(variance);
    
    return {
      upper: sma + (standardDeviation * stdDev),
      middle: sma,
      lower: sma - (standardDeviation * stdDev)
    };
  }

  // Calcul ADX (Average Directional Index)
  static calculateADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (highs.length < period + 1) return 25;
    
    // Calcul simplifié pour la démo
    let trueRanges = [];
    let plusDMs = [];
    let minusDMs = [];
    
    for (let i = 1; i < highs.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trueRanges.push(tr);
      
      const plusDM = highs[i] - highs[i - 1] > lows[i - 1] - lows[i] ? 
        Math.max(highs[i] - highs[i - 1], 0) : 0;
      const minusDM = lows[i - 1] - lows[i] > highs[i] - highs[i - 1] ? 
        Math.max(lows[i - 1] - lows[i], 0) : 0;
      
      plusDMs.push(plusDM);
      minusDMs.push(minusDM);
    }
    
    // Calcul des moyennes mobiles
    const avgTR = trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
    const avgPlusDM = plusDMs.slice(-period).reduce((sum, dm) => sum + dm, 0) / period;
    const avgMinusDM = minusDMs.slice(-period).reduce((sum, dm) => sum + dm, 0) / period;
    
    const plusDI = (avgPlusDM / avgTR) * 100;
    const minusDI = (avgMinusDM / avgTR) * 100;
    
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    
    return dx; // Simplifié, normalement on calcule la moyenne mobile du DX
  }

  // Calcul Stochastic
  static calculateStochastic(highs: number[], lows: number[], closes: number[], kPeriod: number = 14, dPeriod: number = 3) {
    if (closes.length < kPeriod) return { k: 50, d: 50 };
    
    const kValues: number[] = [];
    for (let i = kPeriod - 1; i <= closes.length - 1; i++) {
      const highSlice = highs.slice(i - kPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - kPeriod + 1, i + 1);
      const highestHigh = Math.max(...highSlice);
      const lowestLow = Math.min(...lowSlice);
      const range = highestHigh - lowestLow;
      const k = range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100;
      kValues.push(k);
    }
    
    // %D is the SMA of %K values
    const dValues = kValues.slice(-dPeriod);
    const d = dValues.reduce((sum, val) => sum + val, 0) / dValues.length;
    const k = kValues[kValues.length - 1];
    
    return { k, d };
  }

  // Analyse complète des indicateurs techniques
  static analyzeMarket(marketData: MarketData[]): TechnicalIndicators {
    const closes = marketData.map(d => d.close);
    const highs = marketData.map(d => d.high);
    const lows = marketData.map(d => d.low);
    const volumes = marketData.map(d => d.volume);
    
    return {
      rsi: this.calculateRSI(closes),
      macd: this.calculateMACD(closes),
      bollinger: this.calculateBollingerBands(closes),
      ema: {
        ema9: this.calculateEMA(closes, 9),
        ema21: this.calculateEMA(closes, 21)
      },
      adx: this.calculateADX(highs, lows, closes),
      volume_sma: volumes.slice(-20).reduce((sum, vol) => sum + vol, 0) / 20,
      stochastic: this.calculateStochastic(highs, lows, closes)
    };
  }
}