import { AISignal } from './ai-engine';
import { RiskManager, TradeRisk } from './risk-management';

export interface BacktestResult {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalProfit: number;
  totalLoss: number;
  netProfit: number;
  maxDrawdown: number;
  sharpeRatio: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  trades: BacktestTrade[];
}

export interface BacktestTrade {
  id: string;
  signal: AISignal;
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  direction: 'CALL' | 'PUT';
  result: 'WIN' | 'LOSS' | 'PENDING';
  profit: number;
  commission: number;
  netProfit: number;
  holdingTime: number; // en minutes
}

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialBalance: number;
  commission: number; // Pourcentage
  slippage: number; // Pourcentage
  riskPerTrade: number; // Pourcentage du capital
  minWinrate: number;
  pairs: string[];
}

export class BacktestEngine {
  private riskManager: RiskManager;
  
  constructor() {
    this.riskManager = new RiskManager();
  }

  // Exécution du backtest principal
  async runBacktest(
    signals: AISignal[],
    config: BacktestConfig
  ): Promise<BacktestResult> {
    const trades: BacktestTrade[] = [];
    let currentBalance = config.initialBalance;
    let peak = config.initialBalance;
    let maxDrawdown = 0;
    let consecutiveWins = 0;
    let consecutiveLosses = 0;
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;

    // Filtrage des signaux par période et confiance
    const filteredSignals = signals.filter(signal => {
      const signalDate = new Date(signal.timestamp);
      return signalDate >= config.startDate && 
             signalDate <= config.endDate &&
             signal.winrate >= config.minWinrate &&
             config.pairs.includes(signal.pair);
    });

    // Simulation de chaque trade
    for (const signal of filteredSignals) {
      const trade = await this.simulateTrade(signal, currentBalance, config);
      
      if (trade) {
        trades.push(trade);
        
        // Skip PENDING trades from balance/stats calculations
        if (trade.result === 'PENDING') continue;
        
        currentBalance += trade.netProfit;
        
        // Mise à jour des statistiques
        if (trade.result === 'WIN') {
          consecutiveWins++;
          consecutiveLosses = 0;
          maxConsecutiveWins = Math.max(maxConsecutiveWins, consecutiveWins);
        } else {
          consecutiveLosses++;
          consecutiveWins = 0;
          maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
        }
        
        // Calcul du drawdown
        if (currentBalance > peak) {
          peak = currentBalance;
        } else {
          const drawdown = (peak - currentBalance) / peak;
          maxDrawdown = Math.max(maxDrawdown, drawdown);
        }
      }
    }

    return this.calculateResults(trades, config.initialBalance, maxDrawdown);
  }

  // Simulation d'un trade individuel
  private async simulateTrade(
    signal: AISignal,
    balance: number,
    config: BacktestConfig
  ): Promise<BacktestTrade | null> {
    // Calcul de la taille de position
    const positionSize = balance * config.riskPerTrade;
    
    // If the signal has no actual result (is_win is undefined/null), mark as PENDING
    // We do NOT fabricate results — if we don't know the outcome, say so
    if (signal.is_win === undefined || signal.is_win === null) {
      return {
        id: `backtest_${signal.id}`,
        signal,
        entryTime: new Date(signal.timestamp),
        exitTime: new Date(signal.timestamp.getTime() + signal.expiration * 60000),
        entryPrice: signal.entry_price,
        exitPrice: signal.entry_price, // Unknown exit price
        direction: signal.direction,
        result: 'PENDING',
        profit: 0,
        commission: 0,
        netProfit: 0,
        holdingTime: signal.expiration
      };
    }
    
    const isWin = signal.is_win;
    
    // Utilisation des prix réels si disponibles
    const entryPrice = signal.entry_price;
    const exitPrice = isWin 
      ? entryPrice * (1 + 0.001) // Simulation légère si prix sortie non stocké
      : entryPrice * (1 - 0.001);
    
    const holdingTime = signal.expiration;
    
    // Calcul du profit/perte
    const priceChange = signal.direction === 'CALL' ? 
      (exitPrice - entryPrice) / entryPrice : 
      (entryPrice - exitPrice) / entryPrice;
    
    const grossProfit = positionSize * priceChange;
    const commission = positionSize * config.commission;
    const netProfit = grossProfit - commission;
    
    return {
      id: `backtest_${signal.id}`,
      signal,
      entryTime: new Date(signal.timestamp),
      exitTime: new Date(signal.timestamp.getTime() + holdingTime * 60000),
      entryPrice,
      exitPrice,
      direction: signal.direction,
      result: isWin ? 'WIN' : 'LOSS',
      profit: grossProfit,
      commission,
      netProfit,
      holdingTime
    };
  }

  // Calcul des résultats finaux — only resolved trades (WIN/LOSS) count toward winrate
  // PENDING trades are excluded from statistical calculations
  private calculateResults(
    trades: BacktestTrade[],
    initialBalance: number,
    maxDrawdown: number
  ): BacktestResult {
    const resolvedTrades = trades.filter(t => t.result !== 'PENDING');
    const winningTrades = resolvedTrades.filter(t => t.result === 'WIN');
    const losingTrades = resolvedTrades.filter(t => t.result === 'LOSS');
    
    const totalProfit = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
    const netProfit = resolvedTrades.reduce((sum, t) => sum + t.netProfit, 0);
    
    const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;
    
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    
    // Calcul du ratio de Sharpe (simplifié) — only from resolved trades
    const returns = resolvedTrades.map(t => t.netProfit / initialBalance);
    const avgReturn = returns.length > 0 ? returns.reduce((sum, r) => sum + r, 0) / returns.length : 0;
    const returnStdDev = returns.length > 0 ? Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    ) : 0;
    const sharpeRatio = returnStdDev > 0 ? avgReturn / returnStdDev : 0;
    
    // Calcul des séries consécutives — only from resolved trades
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    
    for (const trade of resolvedTrades) {
      if (trade.result === 'WIN') {
        currentWinStreak++;
        currentLossStreak = 0;
        maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
      } else {
        currentLossStreak++;
        currentWinStreak = 0;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      }
    }
    
    return {
      totalTrades: resolvedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: resolvedTrades.length > 0 ? (winningTrades.length / resolvedTrades.length) * 100 : 0,
      totalProfit,
      totalLoss,
      netProfit,
      maxDrawdown: maxDrawdown * 100,
      sharpeRatio,
      profitFactor,
      avgWin,
      avgLoss,
      largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.profit)) : 0,
      largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.profit)) : 0,
      consecutiveWins: maxWinStreak,
      consecutiveLosses: maxLossStreak,
      trades
    };
  }

  // Analyse de performance par période
  analyzePerformanceByPeriod(
    result: BacktestResult,
    period: 'daily' | 'weekly' | 'monthly'
  ): Array<{
    period: string;
    trades: number;
    winRate: number;
    profit: number;
    drawdown: number;
  }> {
    const periods = new Map();
    
    for (const trade of result.trades) {
      let periodKey: string;
      const date = trade.entryTime;
      
      switch (period) {
        case 'daily':
          periodKey = date.toISOString().split('T')[0];
          break;
        case 'weekly':
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          periodKey = weekStart.toISOString().split('T')[0];
          break;
        case 'monthly':
          periodKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          break;
      }
      
      if (!periods.has(periodKey)) {
        periods.set(periodKey, {
          period: periodKey,
          trades: [],
          profit: 0,
          peak: 0,
          drawdown: 0
        });
      }
      
      const periodData = periods.get(periodKey);
      periodData.trades.push(trade);
      periodData.profit += trade.netProfit;
      
      // Calcul du drawdown pour la période
      if (periodData.profit > periodData.peak) {
        periodData.peak = periodData.profit;
      } else if (periodData.peak > 0) {
        periodData.drawdown = Math.max(
          periodData.drawdown,
          (periodData.peak - periodData.profit) / periodData.peak * 100
        );
      }
    }
    
    return Array.from(periods.values()).map(p => ({
      period: p.period,
      trades: p.trades.length,
      winRate: p.trades.length > 0 ? 
        (p.trades.filter((t: BacktestTrade) => t.result === 'WIN').length / p.trades.length) * 100 : 0,
      profit: p.profit,
      drawdown: p.drawdown
    }));
  }

  // Optimisation des paramètres
  async optimizeParameters(
    signals: AISignal[],
    baseConfig: BacktestConfig,
    parameterRanges: {
      riskPerTrade: number[];
      minWinrate: number[];
      commission: number[];
    }
  ): Promise<{
    bestParams: Partial<BacktestConfig>;
    bestResult: BacktestResult;
    allResults: Array<{ params: Partial<BacktestConfig>; result: BacktestResult }>;
  }> {
    const results: Array<{ params: Partial<BacktestConfig>; result: BacktestResult }> = [];
    let bestResult: BacktestResult | null = null;
    let bestParams: Partial<BacktestConfig> = {};
    
    // Test de toutes les combinaisons
    for (const riskPerTrade of parameterRanges.riskPerTrade) {
      for (const minWinrate of parameterRanges.minWinrate) {
        for (const commission of parameterRanges.commission) {
          const testConfig = {
            ...baseConfig,
            riskPerTrade,
            minWinrate,
            commission
          };
          
          const result = await this.runBacktest(signals, testConfig);
          
          results.push({
            params: { riskPerTrade, minWinrate, commission },
            result
          });
          
          // Évaluation basée sur le ratio de Sharpe et le profit net
          const score = result.sharpeRatio * 0.6 + (result.netProfit / baseConfig.initialBalance) * 0.4;
          
          if (!bestResult || score > (bestResult.sharpeRatio * 0.6 + (bestResult.netProfit / baseConfig.initialBalance) * 0.4)) {
            bestResult = result;
            bestParams = { riskPerTrade, minWinrate, commission };
          }
        }
      }
    }
    
    return {
      bestParams,
      bestResult: bestResult!,
      allResults: results
    };
  }
}