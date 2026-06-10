export interface Signal {
  id: string;
  pair: string;
  direction: 'CALL' | 'PUT';
  winrate: number;
  payout: number;
  entry_price: number;
  expiration: number;
  status: 'ACTIVE' | 'WON' | 'LOST' | 'EXPIRED';
  timestamp: Date;
  result_price?: number;
  profit_loss?: number;
  smc_structure: string;
  smc_zone: string;
  chart_pattern: string;
  fibonacci: string;
  rsi_status: string;
  is_win?: boolean | null;
}

export interface PerformanceData {
  date: string;
  winRate: number;
  totalTrades: number;
  profit: number;
}

export interface UserStats {
  totalTrades: number;
  winRate: number;
  totalProfit: number;
  todaySignals: number;
  performance: number;
}

export const mockSignals: Signal[] = [];

export const mockPerformanceData: PerformanceData[] = [];

export const mockUserStats: UserStats = {
  totalTrades: 0,
  winRate: 0,
  totalProfit: 0,
  todaySignals: 0,
  performance: 0
};

export const tradingPairs = [
  { symbol: 'EUR/USD OTC', name: 'Euro / US Dollar OTC', type: 'forex' },
  { symbol: 'GBP/USD OTC', name: 'British Pound / US Dollar OTC', type: 'forex' },
  { symbol: 'USD/JPY OTC', name: 'US Dollar / Japanese Yen OTC', type: 'forex' },
  { symbol: 'AUD/USD OTC', name: 'Australian Dollar / US Dollar OTC', type: 'forex' },
  { symbol: 'USD/CHF OTC', name: 'US Dollar / Swiss Franc OTC', type: 'forex' },
  { symbol: 'EUR/GBP OTC', name: 'Euro / British Pound OTC', type: 'forex' },
  { symbol: 'USD/CAD OTC', name: 'US Dollar / Canadian Dollar OTC', type: 'forex' },
  { symbol: 'NZD/USD OTC', name: 'New Zealand Dollar / US Dollar OTC', type: 'forex' },
];


export const pricingPlans = [
  {
    name: 'Standard',
    price: 198,
    quarterly: 178, // -10%
    annual: 159, // -20%
    features: [
      'Jusqu\'à 20 signaux/jour',
      'Accès Bot Telegram',
    ],
    assets: ['Forex OTC'],
    support: 'Email 48h',
    api_access: false
  },
  {
    name: 'Premium',
    price: 298,
    quarterly: 268, // -10%
    annual: 238, // -20%
    features: [
      'Jusqu\'à 35 signaux/jour',
      'Analyse SMC détaillée par signal',
      'Commande /analyse à la demande',
      'Commande /structure SMC',
      'Dashboard web avancé',
      'Support Chat 4h'
    ],
    popular: true,
    brokers: ['Pocket Option'],
    assets: ['Forex OTC'],
    support: 'Chat 4h',
    api_access: false
  },
  {
    name: 'Pro',
    price: 398,
    quarterly: 358, // -10%
    annual: 318, // -20%
    features: [
      'Signaux illimités',
      'Accès Signaux Sniper Winrate élevé',
      'Backtesting sur 5 ans',
      'Accès API Full Access',
      'Coaching personnalisé (4h/mois)',
      'Rapport de performance mensuel PDF'
    ],
    brokers: ['Pocket Option'],
    assets: ['Forex OTC'],
    support: 'Téléphone 1h + Priorité',
    api_access: true
  }
];

// Courtiers supportés selon le cahier des charges
export const supportedBrokers = [
  {
    name: 'Pocket Option',
    url: 'https://po.trade',
    logo: 'https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=50',
    rating: 4.5,
    features: ['Options binaires', 'Forex'],
    min_deposit: 50
  },
  {
    name: 'Quotex',
    url: 'https://qxbroker.com',
    logo: 'https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=50',
    rating: 4.3,
    features: ['Options binaires', 'Trading digital'],
    min_deposit: 10
  },
  {
    name: 'IQ Option',
    url: 'https://iqoption.com',
    logo: 'https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=50',
    rating: 4.2,
    features: ['Options binaires', 'Forex', 'CFD'],
    min_deposit: 10
  },
  {
    name: 'Deriv',
    url: 'https://deriv.com',
    logo: 'https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=50',
    rating: 4.1,
    features: ['Options binaires', 'CFD', 'Multipliers'],
    min_deposit: 5
  },
  {
    name: 'Nadex',
    url: 'https://nadex.com',
    logo: 'https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=50',
    rating: 4.0,
    features: ['Options binaires US', 'Spreads'],
    min_deposit: 250
  },
  {
    name: 'Olymp Trade',
    url: 'https://olymptrade.com',
    logo: 'https://images.pexels.com/photos/6801648/pexels-photo-6801648.jpeg?auto=compress&cs=tinysrgb&w=50',
    rating: 3.9,
    features: ['Options binaires', 'Forex'],
    min_deposit: 10
  }
];

// Actifs OTC supportés — EXCLUSIVEMENT Pocket Option OTC
export const supportedAssets = {
  forex: [
    'EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC', 'AUD/USD OTC', 'USD/CHF OTC', 'EUR/GBP OTC',
    'USD/CAD OTC', 'NZD/USD OTC', 'EUR/JPY OTC', 'GBP/JPY OTC', 'AUD/JPY OTC', 'CHF/JPY OTC'
  ],
};

// Métriques de performance — valeurs réalistes (N/A jusqu'à ce que les données réelles soient disponibles)
export const performanceMetrics = {
  accuracy: 0, // À remplir par les données réelles de l'API
  verified_success_rate: 0, // À remplir par les données réelles de l'API
  signals_per_day: { min: 0, max: 0 }, // À remplir par les données réelles
  execution_time: 0, // À remplir par les données réelles
  profit_loss_ratio: 0, // À remplir par les données réelles
  uptime: 0, // À remplir par les données réelles
  response_time: 0 // À remplir par les données réelles
};

// Nouvelles données selon spécifications du document
export const technicalIndicatorsConfig = {
  RSI: { period: 14, oversold: 30, overbought: 70 },
  MACD: { fast: 12, slow: 26, signal: 9 },
  BollingerBands: { period: 20, stdDev: 2 },
  EMA: { periods: [9, 21] },
  ADX: { period: 14, threshold: 25 },
  Volume: { threshold: 1.5 } // 1.5x moyenne
};

// Modèles d'apprentissage automatique selon spécifications
export const mlModelsConfig = {
  RandomForest: {
    type: 'classification',
    target: 'Call vs Put',
    validation: 'k-fold cross-validation',
    features: ['price_momentum', 'volume_ratio', 'volatility', 'technical_indicators']
  },
  XGBoost: {
    type: 'gradient_boosting',
    target: 'success_probability',
    optimization: 'probability_refinement'
  },
  LSTM: {
    type: 'recurrent_neural_network',
    target: 'temporal_dynamics',
    features: ['time_series_correlations', 'long_term_patterns']
  }
};

// Configuration de génération et diffusion des signaux
export const signalConfig = {
  frequency: {
    calculation: '1_minute', // Calcul toutes les minutes
    diffusion: 'instantaneous' // Diffusion instantanée
  },
  format: '[HH:MM:SS] – Actif: [EUR/USD] – Direction: [Call/Put] – Expiration: [1–5 min] – Winrate: [95%]',
  winrate_based: true,
  model_ensemble: true,
  user_adjustable_thresholds: true,
  filtering: {
    minimum_threshold: true,
    profit_loss_ratio_priority: true
  }
};

// Interface Telegram selon spécifications
export const telegramInterface = {
  commands: {
    '/start': 'onboarding_and_authentication',
    '/signals': 'latest_received_signals',
    '/performance': 'success_statistics_ratio_history',
    '/settings': 'assets_timeframes_winrate_thresholds',
    '/help': 'usage_guide'
  },
  user_management: {
    authentication_tokens: true,
    two_step_validation: true,
    subscription_plan_ACL: true
  }
};

// Dashboards web selon spécifications
export const webDashboards = {
  main_dashboard: {
    chronological_signals_view: true,
    cumulative_performance_charts: true
  },
  reports: {
    csv_pdf_export: true,
    custom_backtesting: true,
    portfolio_simulation: true
  },
  dynamic_filters: {
    by_asset: true,
    by_period: true,
    by_winrate: true,
    by_broker: true
  }
};

// Support du risque et backtesting selon spécifications
export const riskAndBacktesting = {
  risk_management: {
    stop_loss_take_profit_settings: true,
    optimal_position_size_kelly_formula: true
  },
  backtesting: {
    historical_data_years: 5,
    performance_report_generation: true,
    continuous_learning_periodic_retraining: true
  }
};