// Simulation des sources de données externes selon le cahier des charges

export interface DataSource {
  name: string;
  type: 'REST' | 'WebSocket';
  url: string;
  apiKey?: string;
  rateLimit: number; // requests per minute
  supported_symbols: string[];
  data_types: ('price' | 'volume' | 'news' | 'sentiment')[];
}

export interface MarketDataPoint {
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
  source: string;
}

export interface NewsData {
  id: string;
  title: string;
  content: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  impact: 'low' | 'medium' | 'high';
  symbols: string[];
  timestamp: Date;
  source: string;
}

export class DataSourceManager {
  private sources: DataSource[] = [
    {
      name: 'Alpha Vantage',
      type: 'REST',
      url: 'https://www.alphavantage.co/query',
      rateLimit: 5, // 5 requests per minute for free tier
      supported_symbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF'],
      data_types: ['price', 'volume']
    },
    {
      name: 'Yahoo Finance',
      type: 'REST',
      url: 'https://query1.finance.yahoo.com/v8/finance/chart',
      rateLimit: 2000, // 2000 requests per hour
      supported_symbols: ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'BTC-USD', 'ETH-USD'],
      data_types: ['price', 'volume']
    },
    {
      name: 'Quandl',
      type: 'REST',
      url: 'https://www.quandl.com/api/v3/datasets',
      rateLimit: 50, // 50 calls per day for free
      supported_symbols: ['FRED/DGS10', 'CHRIS/CME_ES1', 'CHRIS/ICE_DX1'],
      data_types: ['price']
    },
    {
      name: 'Finnhub WebSocket',
      type: 'WebSocket',
      url: 'wss://ws.finnhub.io',
      rateLimit: 60, // 60 connections
      supported_symbols: ['FOREX:EURUSD', 'FOREX:GBPUSD', 'FOREX:USDJPY'],
      data_types: ['price']
    }
  ];

  private connections: Map<string, WebSocket> = new Map();
  private dataBuffer: Map<string, MarketDataPoint[]> = new Map();

  // Initialisation des connexions WebSocket
  async initializeWebSocketConnections(): Promise<void> {
    const wsources = this.sources.filter(s => s.type === 'WebSocket');
    
    for (const source of wsources) {
      try {
        const ws = new WebSocket(source.url);
        
        ws.onopen = () => {
          console.log(`Connected to ${source.name}`);
          // Subscribe to symbols
          source.supported_symbols.forEach(symbol => {
            ws.send(JSON.stringify({
              type: 'subscribe',
              symbol: symbol
            }));
          });
        };

        ws.onmessage = (event) => {
          this.handleWebSocketMessage(source.name, JSON.parse(event.data));
        };

        ws.onerror = (error) => {
          console.error(`WebSocket error for ${source.name}:`, error);
        };

        ws.onclose = () => {
          console.log(`Disconnected from ${source.name}`);
          // Reconnect only this specific source after 5 seconds
          setTimeout(() => {
            this.reconnectSource(source);
          }, 5000);
        };

        this.connections.set(source.name, ws);
      } catch (error) {
        console.error(`Failed to connect to ${source.name}:`, error);
      }
    }
  }

  // Reconnect a single disconnected WebSocket source
  private async reconnectSource(source: DataSource): Promise<void> {
    if (source.type !== 'WebSocket') return;
    try {
      const ws = new WebSocket(source.url);
      ws.onopen = () => {
        console.log(`Reconnected to ${source.name}`);
        source.supported_symbols.forEach(symbol => {
          ws.send(JSON.stringify({ type: 'subscribe', symbol }));
        });
      };
      ws.onmessage = (event) => {
        this.handleWebSocketMessage(source.name, JSON.parse(event.data));
      };
      ws.onerror = (error) => {
        console.error(`WebSocket reconnection error for ${source.name}:`, error);
      };
      ws.onclose = () => {
        console.log(`Reconnection failed for ${source.name}, retrying...`);
        setTimeout(() => this.reconnectSource(source), 5000);
      };
      this.connections.set(source.name, ws);
    } catch (error) {
      console.error(`Failed to reconnect to ${source.name}:`, error);
    }
  }

  // Traitement des messages WebSocket
  private handleWebSocketMessage(sourceName: string, data: any): void {
    try {
      // Simulation de traitement des données temps réel
      const marketData: MarketDataPoint = {
        symbol: data.s || 'EURUSD',
        timestamp: new Date(data.t || Date.now()),
        open: data.o || 1.0800,
        high: data.h || 1.0820,
        low: data.l || 1.0790,
        close: data.c || 1.0810,
        volume: data.v || 1000000,
        bid: data.c - 0.0001,
        ask: data.c + 0.0001,
        spread: 0.0002,
        source: sourceName
      };

      this.addToBuffer(marketData);
      this.notifySubscribers(marketData);
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  }

  // Récupération de données REST
  async fetchRestData(symbol: string, interval: string = '1min'): Promise<MarketDataPoint[]> {
    const source = this.sources.find(s => 
      s.type === 'REST' && s.supported_symbols.includes(symbol)
    );

    if (!source) {
      throw new Error(`No REST source available for symbol: ${symbol}`);
    }

    try {
      // Attempt real API call
      const params = new URLSearchParams({
        function: 'TIME_SERIES_INTRADAY',
        symbol,
        interval,
        apikey: source.apiKey || 'demo',
      });
      const url = `${source.url}?${params.toString()}`;
      const response = await fetch(url);
      
      if (response.ok) {
        const data = await response.json();
        // Parse real API response into MarketDataPoint format
        if (data['Time Series (' + interval + ')']) {
          const timeSeries = data['Time Series (' + interval + ')'];
          return Object.entries(timeSeries).map(([timestamp, values]: [string, any]) => ({
            symbol,
            timestamp: new Date(timestamp),
            open: parseFloat(values['1. open']),
            high: parseFloat(values['2. high']),
            low: parseFloat(values['3. low']),
            close: parseFloat(values['4. close']),
            volume: parseInt(values['5. volume']),
            bid: parseFloat(values['4. close']) - 0.0001,
            ask: parseFloat(values['4. close']) + 0.0001,
            spread: 0.0002,
            source: source.name
          }));
        }
      }
      
      // Fallback to mock data if API fails
      console.warn(`API call failed for ${symbol}, falling back to mock data`);
      const mockData = this.generateMockData(symbol, 100);
      return mockData;
    } catch (error) {
      console.error(`Error fetching data from ${source.name}:`, error);
      // Fallback to mock data on network error
      const mockData = this.generateMockData(symbol, 100);
      return mockData;
    }
  }

  // Génération de données mock pour simulation
  private generateMockData(symbol: string, count: number): MarketDataPoint[] {
    const data: MarketDataPoint[] = [];
    let basePrice = 1.0800; // Prix de base pour EUR/USD
    
    // Ajustement du prix de base selon le symbole
    switch (symbol) {
      case 'GBPUSD':
        basePrice = 1.2500;
        break;
      case 'USDJPY':
        basePrice = 149.50;
        break;
      case 'AUDUSD':
        basePrice = 0.6700;
        break;
      case 'USDCHF':
        basePrice = 0.9100;
        break;
    }

    for (let i = 0; i < count; i++) {
      const timestamp = new Date(Date.now() - (count - i) * 60000); // 1 minute intervals
      const volatility = 0.001; // 0.1% volatility
      
      const change = (Math.random() - 0.5) * volatility;
      basePrice += change;
      
      const high = basePrice + Math.random() * volatility * 0.5;
      const low = basePrice - Math.random() * volatility * 0.5;
      const volume = 1000000 + Math.random() * 500000;

      data.push({
        symbol,
        timestamp,
        open: basePrice - change,
        high,
        low,
        close: basePrice,
        volume,
        bid: basePrice - 0.0001,
        ask: basePrice + 0.0001,
        spread: 0.0002,
        source: 'Mock Data'
      });
    }

    return data;
  }

  // Ajout au buffer de données
  private addToBuffer(data: MarketDataPoint): void {
    const key = data.symbol;
    if (!this.dataBuffer.has(key)) {
      this.dataBuffer.set(key, []);
    }

    const buffer = this.dataBuffer.get(key)!;
    buffer.push(data);

    // Maintenir seulement les 1000 derniers points
    if (buffer.length > 1000) {
      buffer.shift();
    }
  }

  // Notification des abonnés (simulation)
  private notifySubscribers(data: MarketDataPoint): void {
    // Ici on notifierait les composants abonnés aux mises à jour
    console.log(`New data for ${data.symbol}:`, data.close);
  }

  // Récupération des données du buffer
  getBufferedData(symbol: string, limit: number = 100): MarketDataPoint[] {
    const buffer = this.dataBuffer.get(symbol) || [];
    return buffer.slice(-limit);
  }

  // Récupération des actualités de marché (simulation)
  async getMarketNews(symbols: string[] = []): Promise<NewsData[]> {
    // Simulation d'actualités de marché
    const mockNews: NewsData[] = [
      {
        id: '1',
        title: 'Fed Maintains Interest Rates, Signals Cautious Approach',
        content: 'The Federal Reserve kept interest rates unchanged...',
        sentiment: 'neutral',
        impact: 'high',
        symbols: ['EURUSD', 'GBPUSD', 'USDJPY'],
        timestamp: new Date(Date.now() - 3600000),
        source: 'Reuters'
      },
      {
        id: '2',
        title: 'ECB President Hints at Potential Rate Cuts',
        content: 'European Central Bank President suggested...',
        sentiment: 'negative',
        impact: 'medium',
        symbols: ['EURUSD', 'EURGBP'],
        timestamp: new Date(Date.now() - 7200000),
        source: 'Bloomberg'
      }
    ];

    return symbols.length > 0 
      ? mockNews.filter(news => news.symbols.some(s => symbols.includes(s)))
      : mockNews;
  }

  // Analyse du sentiment de marché
  async getMarketSentiment(symbol: string): Promise<{
    probability: number; // -1 to 1
    winrate: number; // 0 to 1
    sources: string[];
  }> {
    // Simulation d'analyse de sentiment
    return {
      probability: (Math.random() - 0.5) * 2, // Random entre -1 et 1
      winrate: 0.7 + Math.random() * 0.3, // Random entre 0.7 et 1
      sources: ['Twitter', 'Reddit', 'News Articles', 'Economic Indicators']
    };
  }

  // Nettoyage des connexions
  cleanup(): void {
    this.connections.forEach((ws, name) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    this.connections.clear();
    this.dataBuffer.clear();
  }

  // Statistiques des sources de données
  getSourceStats(): Array<{
    name: string;
    status: 'connected' | 'disconnected' | 'error';
    lastUpdate: Date;
    dataPoints: number;
  }> {
    return this.sources.map(source => ({
      name: source.name,
      status: this.connections.has(source.name) ? 'connected' : 'disconnected',
      lastUpdate: new Date(),
      dataPoints: Array.from(this.dataBuffer.values()).reduce((sum, buffer) => sum + buffer.length, 0)
    }));
  }
}

// Instance globale du gestionnaire de sources de données
// SSR guard: only instantiate in browser environment
export const dataSourceManager = typeof window !== 'undefined' ? new DataSourceManager() : (null as unknown as DataSourceManager);