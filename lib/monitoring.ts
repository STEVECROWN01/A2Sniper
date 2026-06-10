// Système de monitoring et surveillance selon le cahier des charges

export interface SystemMetrics {
  timestamp: Date;
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  network_io: {
    bytes_in: number;
    bytes_out: number;
  };
  active_connections: number;
  response_time: number;
  error_rate: number;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: keyof SystemMetrics;
  threshold: number;
  operator: '>' | '<' | '=' | '>=' | '<=';
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  cooldown: number; // minutes
  last_triggered?: Date;
}

export interface Alert {
  id: string;
  rule_id: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: Date;
  resolved: boolean;
  resolved_at?: Date;
}

export interface PerformanceLog {
  id: string;
  endpoint: string;
  method: string;
  response_time: number;
  status_code: number;
  timestamp: Date;
  user_id?: string;
  error_message?: string;
}

export class MonitoringSystem {
  private metrics: SystemMetrics[] = [];
  private alerts: Alert[] = [];
  private performanceLogs: PerformanceLog[] = [];
  private alertRules: AlertRule[] = [
    {
      id: '1',
      name: 'High CPU Usage',
      metric: 'cpu_usage',
      threshold: 80,
      operator: '>',
      severity: 'high',
      enabled: true,
      cooldown: 5
    },
    {
      id: '2',
      name: 'High Memory Usage',
      metric: 'memory_usage',
      threshold: 85,
      operator: '>',
      severity: 'high',
      enabled: true,
      cooldown: 5
    },
    {
      id: '3',
      name: 'High Response Time',
      metric: 'response_time',
      threshold: 2000,
      operator: '>',
      severity: 'medium',
      enabled: true,
      cooldown: 2
    },
    {
      id: '4',
      name: 'High Error Rate',
      metric: 'error_rate',
      threshold: 5,
      operator: '>',
      severity: 'critical',
      enabled: true,
      cooldown: 1
    }
  ];

  private monitoringInterval?: NodeJS.Timeout;

  // Démarrage du monitoring
  startMonitoring(intervalMs: number = 60000): void {
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);
    
    console.log('Monitoring system started');
  }

  // Arrêt du monitoring
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    console.log('Monitoring system stopped');
  }

  // Collecte des métriques système
  // NOTE: All metric values use random variation because this is a client-side
  // monitoring stub. In production, replace with real system monitoring APIs.
  private collectMetrics(): void {
    const lastMetrics = this.metrics.length > 0 ? this.metrics[this.metrics.length - 1] : null;
    
    const metrics: SystemMetrics = {
      timestamp: new Date(),
      cpu_usage: lastMetrics ? Math.max(0, Math.min(100, lastMetrics.cpu_usage + (Math.random() - 0.5) * 10)) : 45,
      memory_usage: lastMetrics ? Math.max(0, Math.min(100, lastMetrics.memory_usage + (Math.random() - 0.5) * 5)) : 70,
      disk_usage: lastMetrics ? lastMetrics.disk_usage : 55, // Disk changes slowly
      network_io: {
        bytes_in: lastMetrics ? Math.max(0, lastMetrics.network_io.bytes_in + Math.floor((Math.random() - 0.3) * 50000)) : 500000,
        bytes_out: lastMetrics ? Math.max(0, lastMetrics.network_io.bytes_out + Math.floor((Math.random() - 0.3) * 40000)) : 400000
      },
      active_connections: lastMetrics ? Math.max(1, lastMetrics.active_connections + Math.floor((Math.random() - 0.5) * 20)) : 100,
      response_time: lastMetrics ? Math.max(10, lastMetrics.response_time + (Math.random() - 0.5) * 50) : 200,
      error_rate: this.calculateErrorRateFromLogs()
    };

    this.metrics.push(metrics);
    
    // Maintenir seulement les 1440 dernières métriques (24h si collecte chaque minute)
    if (this.metrics.length > 1440) {
      this.metrics.shift();
    }

    // Vérifier les règles d'alerte
    this.checkAlertRules(metrics);
  }

  // Vérification des règles d'alerte
  private checkAlertRules(metrics: SystemMetrics): void {
    for (const rule of this.alertRules) {
      if (!rule.enabled) continue;

      // Vérifier le cooldown
      if (rule.last_triggered) {
        const cooldownMs = rule.cooldown * 60 * 1000;
        if (Date.now() - rule.last_triggered.getTime() < cooldownMs) {
          continue;
        }
      }

      const metricValue = metrics[rule.metric] as number | { bytes_in: number; bytes_out: number };
      let triggered = false;

      const numericValue = typeof metricValue === 'number' ? metricValue : 0;

      switch (rule.operator) {
        case '>':
          triggered = numericValue > rule.threshold;
          break;
        case '<':
          triggered = numericValue < rule.threshold;
          break;
        case '>=':
          triggered = numericValue >= rule.threshold;
          break;
        case '<=':
          triggered = numericValue <= rule.threshold;
          break;
        case '=':
          triggered = numericValue === rule.threshold;
          break;
      }

      if (triggered) {
        this.triggerAlert(rule, numericValue);
      }
    }
  }

  // Calculate error rate from performance logs instead of random
  private calculateErrorRateFromLogs(): number {
    if (this.performanceLogs.length === 0) return 0;
    const recentLogs = this.performanceLogs.slice(-100);
    const errorCount = recentLogs.filter(log => log.status_code >= 400).length;
    return (errorCount / recentLogs.length) * 100;
  }

  // Déclenchement d'une alerte
  private triggerAlert(rule: AlertRule, value: number): void {
    const alert: Alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      rule_id: rule.id,
      message: `${rule.name}: ${rule.metric} is ${value} (threshold: ${rule.threshold})`,
      severity: rule.severity,
      timestamp: new Date(),
      resolved: false
    };

    this.alerts.push(alert);
    rule.last_triggered = new Date();

    // Notification (simulation)
    this.sendNotification(alert);

    console.log(`ALERT: ${alert.message}`);
  }

  // Envoi de notification
  private sendNotification(alert: Alert): void {
    // Simulation d'envoi de notification
    // En production, ceci enverrait des emails, SMS, webhooks, etc.
    
    const channels = {
      low: ['email'],
      medium: ['email', 'slack'],
      high: ['email', 'slack', 'sms'],
      critical: ['email', 'slack', 'sms', 'phone']
    };

    const notificationChannels = channels[alert.severity];
    
    console.log(`Sending ${alert.severity} alert via:`, notificationChannels);
  }

  // Enregistrement des performances
  logPerformance(log: Omit<PerformanceLog, 'id' | 'timestamp'>): void {
    const performanceLog: PerformanceLog = {
      id: `perf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: new Date(),
      ...log
    };

    this.performanceLogs.push(performanceLog);

    // Maintenir seulement les 10000 derniers logs
    if (this.performanceLogs.length > 10000) {
      this.performanceLogs.shift();
    }

    // Vérifier si c'est une erreur
    if (performanceLog.status_code >= 400) {
      this.updateErrorRate();
    }
  }

  // Mise à jour du taux d'erreur
  private updateErrorRate(): void {
    const recentLogs = this.performanceLogs.slice(-100); // 100 derniers logs
    const errorCount = recentLogs.filter(log => log.status_code >= 400).length;
    const errorRate = (errorCount / recentLogs.length) * 100;

    // Mettre à jour la métrique d'erreur dans les métriques actuelles
    if (this.metrics.length > 0) {
      this.metrics[this.metrics.length - 1].error_rate = errorRate;
    }
  }

  // Récupération des métriques
  getMetrics(hours: number = 1): SystemMetrics[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.metrics.filter(m => m.timestamp >= cutoff);
  }

  // Récupération des alertes
  getAlerts(resolved: boolean | null = null): Alert[] {
    if (resolved === null) {
      return this.alerts;
    }
    return this.alerts.filter(a => a.resolved === resolved);
  }

  // Résolution d'une alerte
  resolveAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolved_at = new Date();
      return true;
    }
    return false;
  }

  // Récupération des logs de performance
  getPerformanceLogs(hours: number = 1): PerformanceLog[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.performanceLogs.filter(log => log.timestamp >= cutoff);
  }

  // Statistiques de performance
  getPerformanceStats(hours: number = 1): {
    avg_response_time: number;
    error_rate: number;
    total_requests: number;
    requests_per_minute: number;
    slowest_endpoints: Array<{
      endpoint: string;
      avg_response_time: number;
      request_count: number;
    }>;
  } {
    const logs = this.getPerformanceLogs(hours);
    
    if (logs.length === 0) {
      return {
        avg_response_time: 0,
        error_rate: 0,
        total_requests: 0,
        requests_per_minute: 0,
        slowest_endpoints: []
      };
    }

    const totalResponseTime = logs.reduce((sum, log) => sum + log.response_time, 0);
    const errorCount = logs.filter(log => log.status_code >= 400).length;
    const minutesSpan = hours * 60;

    // Analyse par endpoint
    const endpointStats = new Map<string, { total_time: number; count: number }>();
    
    logs.forEach(log => {
      const key = `${log.method} ${log.endpoint}`;
      const existing = endpointStats.get(key) || { total_time: 0, count: 0 };
      existing.total_time += log.response_time;
      existing.count += 1;
      endpointStats.set(key, existing);
    });

    const slowestEndpoints = Array.from(endpointStats.entries())
      .map(([endpoint, stats]) => ({
        endpoint,
        avg_response_time: stats.total_time / stats.count,
        request_count: stats.count
      }))
      .sort((a, b) => b.avg_response_time - a.avg_response_time)
      .slice(0, 10);

    return {
      avg_response_time: totalResponseTime / logs.length,
      error_rate: (errorCount / logs.length) * 100,
      total_requests: logs.length,
      requests_per_minute: logs.length / minutesSpan,
      slowest_endpoints: slowestEndpoints
    };
  }

  // Santé du système
  getSystemHealth(): {
    status: 'healthy' | 'warning' | 'critical';
    uptime: number;
    active_alerts: number;
    last_check: Date;
    components: Array<{
      name: string;
      status: 'healthy' | 'warning' | 'critical';
      message?: string;
    }>;
  } {
    const activeAlerts = this.getAlerts(false);
    const criticalAlerts = activeAlerts.filter(a => a.severity === 'critical');
    const highAlerts = activeAlerts.filter(a => a.severity === 'high');

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    
    if (criticalAlerts.length > 0) {
      status = 'critical';
    } else if (highAlerts.length > 0 || activeAlerts.length > 5) {
      status = 'warning';
    }

    // Vérification des composants
    const components = [
      {
        name: 'API Server',
        status: status,
        message: status !== 'healthy' ? 'High response times detected' : undefined
      },
      {
        name: 'Database',
        status: 'healthy' as const
      },
      {
        name: 'WebSocket Server',
        status: 'healthy' as const
      },
      {
        name: 'AI Engine',
        status: 'healthy' as const
      },
      {
        name: 'Telegram Bot',
        status: 'healthy' as const
      }
    ];

    return {
      status,
      uptime: process.uptime ? process.uptime() : 0,
      active_alerts: activeAlerts.length,
      last_check: new Date(),
      components
    };
  }

  // Configuration des règles d'alerte
  updateAlertRule(ruleId: string, updates: Partial<AlertRule>): boolean {
    const rule = this.alertRules.find(r => r.id === ruleId);
    if (rule) {
      Object.assign(rule, updates);
      return true;
    }
    return false;
  }

  // Ajout d'une nouvelle règle d'alerte
  addAlertRule(rule: Omit<AlertRule, 'id'>): string {
    const newRule: AlertRule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      ...rule
    };
    
    this.alertRules.push(newRule);
    return newRule.id;
  }

  // Export des données pour analyse
  exportData(type: 'metrics' | 'alerts' | 'performance', format: 'json' | 'csv' = 'json'): string {
    let data: SystemMetrics[] | Alert[] | PerformanceLog[];
    
    switch (type) {
      case 'metrics':
        data = this.metrics;
        break;
      case 'alerts':
        data = this.alerts;
        break;
      case 'performance':
        data = this.performanceLogs;
        break;
    }

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    } else {
      // Conversion CSV simplifiée
      if (data.length === 0) return '';
      
      const headers = Object.keys(data[0]).join(',');
      const rows = data.map(item => 
        Object.values(item).map(value => 
          typeof value === 'object' ? JSON.stringify(value) : value
        ).join(',')
      );
      
      return [headers, ...rows].join('\n');
    }
  }
}

// Instance globale du système de monitoring
// SSR guard: only instantiate in browser environment
export const monitoringSystem = typeof window !== 'undefined' ? new MonitoringSystem() : (null as unknown as MonitoringSystem);