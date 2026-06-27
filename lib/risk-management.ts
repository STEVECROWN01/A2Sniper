export interface RiskParameters {
  maxRiskPerTrade: number; // Pourcentage du capital
  maxDailyRisk: number;
  maxDrawdown: number;
  stopLossPercentage: number;
  takeProfitPercentage: number;
  maxConcurrentTrades: number;
  minWinrateLevel: number;
}

export interface PositionSize {
  amount: number;
  percentage: number;
  riskAmount: number;
  kellyPercentage: number;
}

export interface TradeRisk {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  riskScore: number;
  maxLoss: number;
  expectedReturn: number;
  riskRewardRatio: number;
  recommendation: 'TAKE' | 'REDUCE' | 'AVOID';
}

export class RiskManager {
  private parameters: RiskParameters;
  private defaultParameters: RiskParameters = {
    maxRiskPerTrade: 0.02, // 2% par trade
    maxDailyRisk: 0.10, // 10% par jour
    maxDrawdown: 0.20, // 20% drawdown max
    stopLossPercentage: 0.015, // 1.5%
    takeProfitPercentage: 0.025, // 2.5%
    maxConcurrentTrades: 5,
    minWinrateLevel: 85
  };

  constructor(parameters: Partial<RiskParameters> = {}) {
    this.parameters = { ...this.defaultParameters, ...parameters };
  }

  // Optimal position size calculation (Kelly Criterion)
  calculatePositionSize(
    accountBalance: number,
    winRate: number,
    avgWin: number,
    avgLoss: number,
    analyzedWinrate: number
  ): PositionSize {
    // Formule de Kelly: f = (bp - q) / b
    // where b = odds received, p = win probability, q = loss probability
    const p = winRate / 100;
    const q = 1 - p;
    const b = avgWin / avgLoss; // Ratio gain/perte
    
    const kellyPercentage = (b * p - q) / b;
    const adjustedKelly = Math.max(0, Math.min(kellyPercentage * 0.5, 0.1)); // Limited to 10% and halved
    
    // Adjustment based on winrate analysis
    const winrateMultiplier = analyzedWinrate / 100;
    const finalPercentage = adjustedKelly * winrateMultiplier;
    
    // Application des limites de risque
    const maxRiskAmount = accountBalance * this.parameters.maxRiskPerTrade;
    const kellyAmount = accountBalance * finalPercentage;
    const finalAmount = Math.min(kellyAmount, maxRiskAmount);
    
    return {
      amount: finalAmount,
      percentage: (finalAmount / accountBalance) * 100,
      riskAmount: finalAmount * this.parameters.stopLossPercentage,
      kellyPercentage: kellyPercentage * 100
    };
  }

  // Trade risk evaluation
  evaluateTradeRisk(
    signal: { winrate: number; ml_features?: { volatility?: number; time_features?: { is_market_open?: boolean } }; technical_indicators?: { adx?: number }; entry_price: number; stop_loss: number; target_price: number },
    accountBalance: number,
    currentDrawdown: number,
    activeTrades: number
  ): TradeRisk {
    let riskScore = 0;
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM';
    
    // Facteurs de risque
    
    // 1. Niveau de Winrate (Analysis technique)
    if (signal.winrate >= 95) riskScore += 20;
    else if (signal.winrate >= 85) riskScore += 10;
    else riskScore -= 10;
    
    // 2. Market volatility
    const volatility = signal.ml_features?.volatility || 0.02;
    if (volatility < 0.01) riskScore += 15;
    else if (volatility > 0.05) riskScore -= 20;
    
    // 3. Conditions de market
    const isMarketOpen = signal.ml_features?.time_features?.is_market_open;
    if (isMarketOpen) riskScore += 10;
    else riskScore -= 15;
    
    // 4. Drawdown actuel
    if (currentDrawdown > 0.15) riskScore -= 25;
    else if (currentDrawdown < 0.05) riskScore += 10;
    
    // 5. Nombre de trades actifs
    if (activeTrades >= this.parameters.maxConcurrentTrades) riskScore -= 30;
    else if (activeTrades <= 2) riskScore += 5;
    
    // 6. Force de la tendance
    const adx = signal.technical_indicators?.adx || 25;
    if (adx > 30) riskScore += 15;
    else if (adx < 20) riskScore -= 10;
    
    // Normalisation du score (0-100)
    riskScore = Math.max(0, Math.min(100, riskScore + 50));
    
    // Risk level determination
    if (riskScore >= 70) riskLevel = 'LOW';
    else if (riskScore <= 40) riskLevel = 'HIGH';
    
    // Calculs financiers
    const entryPrice = signal.entry_price;
    const stopLoss = signal.stop_loss;
    const targetPrice = signal.target_price;
    
    const maxLoss = Math.abs(entryPrice - stopLoss) / entryPrice;
    const expectedReturn = Math.abs(targetPrice - entryPrice) / entryPrice;
    const riskRewardRatio = expectedReturn / maxLoss;
    
    // Recommandation
    let recommendation: 'TAKE' | 'REDUCE' | 'AVOID' = 'TAKE';
    
    if (riskLevel === 'HIGH' || riskScore < 30) recommendation = 'AVOID';
    else if (riskLevel === 'MEDIUM' && riskScore < 50) recommendation = 'REDUCE';
    else if (riskRewardRatio < 1.5) recommendation = 'REDUCE';
    
    return {
      riskLevel,
      riskScore,
      maxLoss: maxLoss * 100,
      expectedReturn: expectedReturn * 100,
      riskRewardRatio,
      recommendation
    };
  }

  // Verification des limites de risque quotidiennes
  checkDailyRiskLimits(
    todayTrades: { status: string; profit_loss?: number }[],
    accountBalance: number
  ): { canTrade: boolean; reason?: string; riskUsed: number } {
    const todayLosses = todayTrades
      .filter(trade => trade.status === 'LOST')
      .reduce((sum, trade) => sum + Math.abs(trade.profit_loss || 0), 0);
    
    const riskUsed = todayLosses / accountBalance;
    
    if (riskUsed >= this.parameters.maxDailyRisk) {
      return {
        canTrade: false,
        reason: `Limite de risque quotidien atteinte (${(riskUsed * 100).toFixed(1)}%)`,
        riskUsed: riskUsed * 100
      };
    }
    
    return { canTrade: true, riskUsed: riskUsed * 100 };
  }

  // Calcul du drawdown
  calculateDrawdown(trades: { profit_loss: number }[]): { current: number; maximum: number } {
    let peak = 0;
    let currentDrawdown = 0;
    let maxDrawdown = 0;
    let runningBalance = 0;
    
    for (const trade of trades) {
      runningBalance += trade.profit_loss || 0;
      
      if (runningBalance > peak) {
        peak = runningBalance;
        currentDrawdown = 0;
      } else if (peak > 0) {
        currentDrawdown = (peak - runningBalance) / peak;
        maxDrawdown = Math.max(maxDrawdown, currentDrawdown);
      }
    }
    
    return {
      current: currentDrawdown,
      maximum: maxDrawdown
    };
  }

  // Dynamic risk parameter adjustment
  adjustRiskParameters(performanceMetrics: {
    winRate: number;
    avgWin: number;
    avgLoss: number;
    sharpeRatio: number;
    maxDrawdown: number;
  }): RiskParameters {
    const adjusted = { ...this.parameters };
    
    // Adjustment based on success rate
    if (performanceMetrics.winRate > 85) {
      adjusted.maxRiskPerTrade = Math.min(0.03, adjusted.maxRiskPerTrade * 1.2);
    } else if (performanceMetrics.winRate < 70) {
      adjusted.maxRiskPerTrade = Math.max(0.01, adjusted.maxRiskPerTrade * 0.8);
    }
    
    // Adjustment based on Sharpe ratio
    if (performanceMetrics.sharpeRatio > 2) {
      adjusted.maxConcurrentTrades = Math.min(8, adjusted.maxConcurrentTrades + 1);
    } else if (performanceMetrics.sharpeRatio < 1) {
      adjusted.maxConcurrentTrades = Math.max(2, adjusted.maxConcurrentTrades - 1);
    }
    
    // Adjustment based on drawdown
    if (performanceMetrics.maxDrawdown > 0.15) {
      adjusted.minWinrateLevel = Math.min(95, adjusted.minWinrateLevel + 5);
      adjusted.maxRiskPerTrade = Math.max(0.01, adjusted.maxRiskPerTrade * 0.7);
    }
    
    // Actually update the instance parameters
    this.parameters = adjusted;
    
    return adjusted;
  }

  // Risk management recommendation generation
  generateRiskRecommendations(
    accountMetrics: {
      balance: number;
      drawdown: number;
      winRate: number;
      activeTrades: number;
    }
  ): string[] {
    const recommendations: string[] = [];
    
    if (accountMetrics.drawdown > 0.15) {
      recommendations.push('⚠️ High drawdown - Reduce position sizes');
      recommendations.push('📉 Consider a trading pause to re-evaluate the strategy');
    }
    
    if (accountMetrics.winRate < 85) {
      recommendations.push('🎯 Success Rate faible - Augmentez le seuil de winrate minimum');
      recommendations.push('📊 Analysisz les trades perdants pour identifier les patterns');
    }
    
    if (accountMetrics.activeTrades > this.parameters.maxConcurrentTrades) {
      recommendations.push('⚡ Too many active trades - Respect the simultaneous position limit');
    }
    
    if (accountMetrics.balance < 1000) {
      recommendations.push('💰 Low capital - Use very conservative positions');
      recommendations.push('📈 Focus on capital preservation');
    }
    
    return recommendations;
  }
}