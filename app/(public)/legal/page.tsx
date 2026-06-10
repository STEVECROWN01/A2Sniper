'use client';

import { motion } from 'framer-motion';
import { Shield, FileText, AlertTriangle, Mail } from 'lucide-react';

export default function LegalPage() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[#D4AF37]/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-[#D4AF37]" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white uppercase tracking-tight">
              Centre Légal & Documentation
            </h1>
            <p className="text-sm text-gray-400 font-bold">
              Informations relatives à l'utilisation de notre plateforme
            </p>
          </div>
        </div>
      </motion.div>

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md"
        >
          <div className="w-10 h-10 rounded-xl bg-[#D4AF37]/10 flex items-center justify-center mb-4">
            <FileText className="w-5 h-5 text-[#D4AF37]" />
          </div>
          <h2 className="text-lg font-black text-white mb-2">Conditions d'Utilisation</h2>
          <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-4">Dernière mise à jour : 11 Mai 2026</p>
          <div className="space-y-3 text-xs text-gray-400 leading-relaxed">
            <p>1. L'accès à A2Sniper est réservé aux personnes majeures.</p>
            <p>2. Les signaux fournis sont à titre informatif uniquement.</p>
            <p>3. Toute reproduction est strictement interdite.</p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="bg-[#0a0a0c]/80 border border-white/5 p-6 rounded-2xl backdrop-blur-md"
        >
          <div className="w-10 h-10 rounded-xl bg-[#D4AF37]/10 flex items-center justify-center mb-4">
            <AlertTriangle className="w-5 h-5 text-[#D4AF37]" />
          </div>
          <h2 className="text-lg font-black text-white mb-2">Avertissement des Risques</h2>
          <p className="text-[10px] text-red-400 font-black uppercase tracking-wider mb-4">CRITIQUE</p>
          <p className="text-xs text-red-400/80 font-bold leading-relaxed">
            Le trading comporte des risques financiers importants. Ne misez jamais de l'argent que vous ne pouvez pas vous permettre de perdre.
          </p>
        </motion.div>
      </div>

      {/* CTA Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        className="bg-gradient-to-br from-[#0a0a0c] to-[#050507] border border-[#D4AF37]/20 p-8 rounded-2xl text-center"
      >
        <div className="w-12 h-12 rounded-xl bg-[#D4AF37]/10 flex items-center justify-center mx-auto mb-4">
          <Mail className="w-6 h-6 text-[#D4AF37]" />
        </div>
        <h2 className="text-xl font-black text-white uppercase tracking-wider mb-3">Besoin d'aide ?</h2>
        <p className="text-xs text-gray-400 font-bold mb-6 max-w-lg mx-auto leading-relaxed">
          Notre équipe de support est disponible 24/7 pour répondre à vos questions techniques ou légales.
        </p>
        <a
          href="mailto:support@a2sniper.ai"
          className="inline-flex items-center space-x-2 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black px-8 py-3.5 rounded-xl font-black text-xs uppercase tracking-[0.15em] hover:from-[#C5A059] hover:to-[#D4AF37] transition-all active:scale-95"
        >
          <Mail className="w-4 h-4" />
          <span>Contacter le support</span>
        </a>
      </motion.div>
    </div>
  );
}
