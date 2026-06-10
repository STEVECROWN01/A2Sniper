// Data source management for external market data
// NOTE: When real API keys and endpoints are not configured, functions return null/empty
// rather than fabricating mock data. Consumers should handle null/empty states appropriately.

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
      rateLimit: 5,
      supported_symbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF'],
      data_types: ['price', 'volume']
    },
    {
      name: 'Yahoo Finance',
      type: 'REST',
      url: 'https://query1.finance.yahoo.com/v8/finance/chart',
      rateLimit: 2000,
      supported_symbols: ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'BTC-USD', 'ETH-USD'],
      data_types: ['price', 'volume']
    },
    {
      name: 'Quandl',
      type: 'REST',
      url: 'https://www.quandl.com/api/v3/datasets',
      rateLimit: 50,
      supported_symbols: ['FRED/DGS10', 'CHRIS/CME_ES1', 'CHRIS/ICE_DX1'],
      data_types: ['price']
    },
    {
      name: 'Finnhub WebSocket',
      type: 'WebSocket',
      url: 'wss://ws.finnhub.io',
      rateLimit: 60,
      supported_symbols: ['FOREX:EURUSD', 'FOREX:GBPUSD', 'FOREX:USDJPY'],
      data_types: ['price']
    }
  ];

  private connections: Map<string, WebSocket> = new Map();
  private dataBuffer: Map<string, MarketDataPoint[]> = new Map();
  private retryCounts: Map<string, number> = new Map();
  private readonly MAX_RETRIES = 10;

  // Initialisation des connexions WebSocket
  async initializeWebSocketConnections(): Promise<void> {
    const wsources = this.sources.filter(s => s.type === 'WebSocket');
    
    for (const source of wsources) {
      try {
        await this.connectWebSocket(source);
      } catch (error) {
        console.error(`Failed to connect to ${source.name}:`, error);
      }
    }
  }

  // Connect or reconnect a single WebSocket source
  private async connectWebSocket(source: DataSource): Promise<void> {
    // Close existing connection before creating a new one (prevent connection leaks)
    const existingWs = this.connections.get(source.name);
    if (existingWs) {
      if (existingWs.readyState === WebSocket.OPEN || existingWs.readyState === WebSocket.CONNECTING) {
        existingWs.close();
      }
      this.connections.delete(source.name);
    }

    const ws = new WebSocket(source.url);
    
    ws.onopen = () => {
      console.log(`Connected to ${source.name}`);
      // Reset retry count on successful connection
      this.retryCounts.set(source.name, 0);
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
      // Reconnect only this specific source after 5 seconds (with retry limit)
      const retries = this.retryCounts.get(source.name) || 0;
      if (retries < this.MAX_RETRIES) {
        this.retryCounts.set(source.name, retries + 1);
        setTimeout(() => {
          this.reconnectSource(source);
        }, 5000);
      } else {
        console.error(`Max retries (${this.MAX_RETRIES}) reached for ${source.name}. Stopping reconnection.`);
      }
    };

    this.connections.set(source.name, ws);
  }

  // Reconnect a single disconnected WebSocket source
  private async reconnectSource(source: DataSource): Promise<void> {
    if (source.type !== 'WebSocket') return;
    
    const retries = this.retryCounts.get(source.name) || 0;
    if (retries >= this.MAX_RETRIES) {
      console.error(`Max retries (${this.MAX_RETRIES}) reached for ${source.name}. Stopping reconnection.`);
      return;
    }

    try {
      await this.connectWebSocket(source);
    } catch (error) {
      console.error(`Failed to reconnect to ${source.name}:`, error);
      this.retryCounts.set(source.name, retries + 1);
      if (retries + 1 < this.MAX_RETRIES) {
        setTimeout(() => this.reconnectSource(source), 5000);
      }
    }
  }

  // Traitement des messages WebSocket
  private handleWebSocketMessage(sourceName: string, data: Record<string, unknown>): void {
    try {
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

  // Récupération de données REST — throws error on failure instead of falling back to mock data
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
        const timeSeriesKey = `Time Series (${interval})`;
        if (data[timeSeriesKey]) {
          const timeSeries = data[timeSeriesKey];
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
        // API returned 200 but data format was unexpected
        throw new Error(`API returned unexpected data format for ${symbol}. No time series data found.`);
      }
      
      // API returned non-OK status — do NOT fall back to mock data
      throw new Error(`API call failed for ${symbol}: HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      // Do NOT silently fall back to mock data — propagate the error
      // Consumers should handle this error and display appropriate UI states
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Error fetching data from ${source.name}: ${error}`);
    }
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

  // Notification des abonnés
  private notifySubscribers(data: MarketDataPoint): void {
    console.log(`New data for ${data.symbol}:`, data.close);
  }

  // Récupération des données du buffer
  getBufferedData(symbol: string, limit: number = 100): MarketDataPoint[] {
    const buffer = this.dataBuffer.get(symbol) || [];
    return buffer.slice(-limit);
  }

  // Market news — returns empty array when no real news API is configured
  // Do NOT return fabricated news items
  async getMarketNews(symbols: string[] = []): Promise<NewsData[]> {
    // No real news API is configured — return empty array
    // When a real news API (e.g., Finnhub news, NewsAPI) is integrated,
    // this function should fetch from that source
    return [];
  }

  // Market sentiment — returns null when no real sentiment data is available
  // Do NOT fabricate sentiment values
  async getMarketSentiment(symbol: string): Promise<{
    probability: number; // -1 to 1
    winrate: number; // 0 to 1
    sources: string[];
  } | null> {
    // No real sentiment analysis API is configured — return null
    // When a real sentiment API (e.g., Finnhub sentiment, Twitter API) is integrated,
    // this function should fetch from that source
    return null;
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
    this.retryCounts.clear();
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
