import React from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: string | number;
  change?: {
    value: number;
    type: 'increase' | 'decrease';
  };
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'yellow' | 'red' | 'purple';
}

const colorClasses = {
  blue: {
    bg: 'bg-blue-500/10 border border-blue-500/20',
    text: 'text-blue-500',
    changePositive: 'text-green-500',
    changeNegative: 'text-red-500'
  },
  green: {
    bg: 'bg-green-500/10 border border-green-500/20',
    text: 'text-green-500',
    changePositive: 'text-green-500',
    changeNegative: 'text-red-500'
  },
  yellow: {
    bg: 'bg-[#D4AF37]/10 border border-[#D4AF37]/20',
    text: 'text-[#D4AF37]',
    changePositive: 'text-green-500',
    changeNegative: 'text-red-500'
  },
  red: {
    bg: 'bg-red-500/10 border border-red-500/20',
    text: 'text-red-500',
    changePositive: 'text-green-500',
    changeNegative: 'text-red-500'
  },
  purple: {
    bg: 'bg-purple-500/10 border border-purple-500/20',
    text: 'text-purple-400',
    changePositive: 'text-green-500',
    changeNegative: 'text-red-500'
  }
};

export function MetricCard({ title, value, change, icon, color }: MetricCardProps) {
  const colors = colorClasses[color];
  
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      whileHover={{ scale: 1.02 }}
      className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md hover:border-[#D4AF37]/30 transition-all cursor-pointer"
    >
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-1">{title}</p>
          <p className="text-2xl font-black text-white tracking-tight">{value}</p>
          
          {change && (
            <div className={`flex items-center mt-2.5 font-bold text-xs ${
              change.type === 'increase' ? colors.changePositive : colors.changeNegative
            }`}>
              {change.type === 'increase' ? (
                <TrendingUp className="w-3.5 h-3.5 mr-1" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5 mr-1" />
              )}
              <span>
                {change.type === 'increase' ? '+' : '-'}{Math.abs(change.value)}%
              </span>
            </div>
          )}
        </div>
        
        <div className={`w-12 h-12 ${colors.bg} rounded-xl flex items-center justify-center`}>
          <div className={colors.text}>
            {icon}
          </div>
        </div>
      </div>
    </motion.div>
  );
}