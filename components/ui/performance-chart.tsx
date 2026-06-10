import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { motion } from 'framer-motion';

interface PerformanceData {
  date: string;
  winRate: number;
  totalTrades: number;
  profit: number;
}

interface PerformanceChartProps {
  data: PerformanceData[];
  title: string;
}

export function PerformanceChart({ data, title }: PerformanceChartProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="bg-white rounded-xl shadow-lg border border-gray-100 p-6"
    >
      <h3 className="text-lg font-semibold text-gray-900 mb-6">{title}</h3>
      
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#D4AF37" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#D4AF37" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
            <XAxis 
              dataKey="date" 
              stroke="#6B7280"
              fontSize={12}
              tickFormatter={(value) => new Date(value).toLocaleDateString('fr-FR', { 
                month: 'short', 
                day: 'numeric' 
              })}
            />
            <YAxis 
              stroke="#6B7280"
              fontSize={12}
              tickFormatter={(value) => `$${value}`}
            />
            <Tooltip 
              contentStyle={{
                backgroundColor: '#1F2937',
                border: 'none',
                borderRadius: '8px',
                color: 'white'
              }}
              formatter={(value: number, name: string) => [
                name === 'profit' ? `$${value}` : `${value}%`,
                name === 'profit' ? 'Profit' : 'Taux de réussite'
              ]}
              labelFormatter={(label) => new Date(label).toLocaleDateString('fr-FR')}
            />
            <Area
              type="monotone"
              dataKey="profit"
              stroke="#D4AF37"
              strokeWidth={2}
              fill="url(#profitGradient)"
            />
            <Line
              type="monotone"
              dataKey="winRate"
              stroke="#10B981"
              strokeWidth={2}
              dot={{ fill: '#10B981', strokeWidth: 2, r: 4 }}
              activeDot={{ r: 6, stroke: '#10B981', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      
      <div className="mt-4 grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-2xl font-bold text-[#D4AF37]">
            ${data[data.length - 1]?.profit || 0}
          </div>
          <div className="text-sm text-gray-600">Profit actuel</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-green-600">
            {data[data.length - 1]?.winRate || 0}%
          </div>
          <div className="text-sm text-gray-600">Taux de réussite</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-purple-600">
            {data[data.length - 1]?.totalTrades || 0}
          </div>
          <div className="text-sm text-gray-600">Total trades</div>
        </div>
      </div>
    </motion.div>
  );
}