'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Star, Zap, Shield, Crown, X, CreditCard } from 'lucide-react';
import { toast } from 'sonner';

const plans = [
  {
    name: 'Standard',
    price: 198,
    originalPrice: 298,
    discount: 33,
    description: 'Parfait pour débuter avec les signaux Assistant',
    features: [
      'Jusqu\'à 20 signaux/jour',
      'Accès Bot Telegram privé',
      'Score de confluence affiché',
      'Support par email (48h)'
    ],
    limitations: [
      'Pas d\'accès API',
      'Pas d\'analyse SMC détaillée'
    ],
    popular: false
  },
  {
    name: 'Premium',
    price: 298,
    originalPrice: 398,
    discount: 25,
    description: 'Le choix des traders sérieux',
    features: [
      'Jusqu\'à 35 signaux/jour',
      'Analyse SMC détaillée par signal',
      'Commandes /analyse et /structure',
      'Dashboard web avancé',
      'Support chat en direct (4h)'
    ],
    limitations: [],
    popular: true
  },
  {
    name: 'Pro',
    price: 398,
    originalPrice: 598,
    discount: 33,
    description: 'Pour les traders professionnels',
    features: [
      'Signaux illimités',
      'Signaux Sniper Score 10/10 + alerte VIP',
      'Backtesting sur 5 ans',
      'Accès API Full Access',
      'Coaching personnalisé (4h/mois)',
      'Rapport mensuel PDF',
      'Support prioritaire'
    ],
    limitations: [],
    popular: false
  }
];

const paymentMethods = [
  { id: 'card', name: 'Carte bancaire', icon: CreditCard, description: 'Visa, Mastercard, Amex' },
  { id: 'paypal', name: 'PayPal', icon: CreditCard, description: 'Paiement sécurisé' },
  { id: 'crypto', name: 'Crypto', icon: Zap, description: 'Bitcoin, Ethereum' }
];

export function SubscriptionPlans() {
  const [selectedPlan, setSelectedPlan] = useState<number | null>(null);
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState('card');
  const [isProcessing, setIsProcessing] = useState(false);

  const getBillingMultiplier = () => {
    switch (billingCycle) {
      case 'quarterly': return 3 * 0.9; // 10% discount on 3 months
      case 'yearly': return 12 * 0.8; // 20% discount on 12 months
      default: return 1;
    }
  };

  const handleSelectPlan = (planIndex: number) => {
    setSelectedPlan(planIndex);
    setShowPaymentModal(true);
  };

  const handlePayment = async () => {
    setIsProcessing(true);
    // TODO: Integrate with real payment processor (Stripe, PayPal SDK, crypto gateway)
    // For now, validate the flow and show confirmation
    if (selectedPlan === null) {
      toast.error('Aucun plan sélectionné');
      setIsProcessing(false);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    setIsProcessing(false);
    setShowPaymentModal(false);
    toast.info(`Paiement en attente de l\'intégration du processeur. Plan ${plans[selectedPlan].name} sélectionné.`);
  };

  return (
    <div className="py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        
        {/* Header */}
        <div className="text-center mb-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-3xl md:text-4xl font-black text-white uppercase tracking-tight mb-4">
              Abonnements <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB]">Founders</span>
            </h1>
            <p className="text-sm text-gray-400 font-bold max-w-2xl mx-auto mb-8">
              Débloquez l'accès complet au flux algorithmique A2Sniper et propulsez vos performances.
            </p>
            
            {/* Cycle de facturation */}
            <div className="inline-flex bg-white/[0.02] border border-white/5 rounded-xl p-1">
              <button
                onClick={() => setBillingCycle('monthly')}
                className={`px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-colors ${
                  billingCycle === 'monthly'
                    ? 'bg-[#D4AF37] text-black shadow-sm'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Mensuel
              </button>
              <button
                onClick={() => setBillingCycle('quarterly')}
                className={`px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-colors flex items-center gap-1.5 ${
                  billingCycle === 'quarterly'
                    ? 'bg-[#D4AF37] text-black shadow-sm'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                <span>Trimestriel</span>
                <span className="text-[9px] bg-black/10 px-1 py-0.5 rounded font-black">-10%</span>
              </button>
              <button
                onClick={() => setBillingCycle('yearly')}
                className={`px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-colors flex items-center gap-1.5 ${
                  billingCycle === 'yearly'
                    ? 'bg-[#D4AF37] text-black shadow-sm'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                <span>Annuel</span>
                <span className="text-[9px] bg-black/10 px-1 py-0.5 rounded font-black">-20%</span>
              </button>
            </div>
          </motion.div>
        </div>

        {/* Plans */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16 items-stretch">
          {plans.map((plan, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className={`relative bg-[#0a0a0c]/80 rounded-2xl border transition-all flex flex-col justify-between ${
                plan.popular 
                  ? 'border-[#D4AF37] scale-105 shadow-[0_0_30px_rgba(212,175,55,0.15)] bg-[#0c0c0f]' 
                  : 'border-white/5 hover:border-[#D4AF37]/20'
              }`}
            >
              {plan.popular && (
                <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
                  <span className="bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black px-6 py-1.5 rounded-full text-xs font-black uppercase tracking-wider flex items-center space-x-1">
                    <Star className="w-3.5 h-3.5" />
                    <span>Plus populaire</span>
                  </span>
                </div>
              )}

              <div className="p-8 flex-1 flex flex-col justify-between">
                <div>
                  {/* Header du plan */}
                  <div className="text-center mb-8">
                    <h3 className="text-xl font-bold text-white mb-2">{plan.name}</h3>
                    <p className="text-xs text-gray-500 font-bold leading-relaxed mb-4">{plan.description}</p>
                    
                    <div className="mb-4">
                      <div className="flex items-center justify-center space-x-2">
                        <span className="text-4xl font-black text-[#D4AF37]">
                          ${Math.round(plan.price * getBillingMultiplier())}
                        </span>
                        <div className="text-left font-bold">
                          <div className="text-xs text-gray-600 line-through">
                            ${Math.round(plan.originalPrice * getBillingMultiplier())}
                          </div>
                          <div className="text-[10px] text-gray-500 uppercase tracking-wider">
                            /{billingCycle === 'monthly' ? 'mois' : billingCycle === 'quarterly' ? '3 mois' : 'an'}
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-green-500 font-bold mt-1">
                        Économisez {plan.discount}%
                      </div>
                    </div>
                  </div>

                  {/* Fonctionnalités */}
                  <div className="space-y-4 mb-8 text-xs font-bold">
                    {plan.features.map((feature, featureIndex) => (
                      <div key={featureIndex} className="flex items-start space-x-3">
                        <Check className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                        <span className="text-gray-300">{feature}</span>
                      </div>
                    ))}
                    
                    {plan.limitations.map((limitation, limitIndex) => (
                      <div key={limitIndex} className="flex items-start space-x-3 opacity-40">
                        <X className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                        <span className="text-gray-500">{limitation}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Bouton d'action */}
                <button
                  onClick={() => handleSelectPlan(index)}
                  className={`w-full py-4 px-6 rounded-xl font-black uppercase tracking-[0.2em] text-xs transition-all ${
                    plan.popular
                      ? 'bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black hover:from-[#c5a059] hover:to-[#D4AF37] shadow-[0_0_20px_rgba(212,175,55,0.15)]'
                      : 'bg-white/5 text-white hover:bg-[#D4AF37] hover:text-black border border-white/5'
                  }`}
                >
                  Choisir {plan.name}
                </button>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Garanties */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="bg-gradient-to-br from-[#0a0a0c] to-[#050507] border border-white/5 rounded-2xl p-8"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
            <div className="flex flex-col items-center p-4">
              <Shield className="w-10 h-10 text-[#D4AF37] mb-4" />
              <h3 className="text-sm font-bold text-white uppercase mb-2 tracking-wider">Garantie 30 jours</h3>
              <p className="text-xs text-gray-500 font-bold">Remboursement intégral si vous n'êtes pas satisfait</p>
            </div>
            <div className="flex flex-col items-center p-4">
              <Zap className="w-10 h-10 text-[#D4AF37] mb-4" />
              <h3 className="text-sm font-bold text-white uppercase mb-2 tracking-wider">Activation instantanée</h3>
              <p className="text-xs text-gray-500 font-bold">Accès immédiat après confirmation de la blockchain ou banque</p>
            </div>
            <div className="flex flex-col items-center p-4">
              <Crown className="w-10 h-10 text-[#D4AF37] mb-4" />
              <h3 className="text-sm font-bold text-white uppercase mb-2 tracking-wider">Support premium</h3>
              <p className="text-xs text-gray-500 font-bold">Équipe dédiée en direct 24/7 sur le cockpit</p>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Modal de paiement */}
      {showPaymentModal && selectedPlan !== null && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-[#0a0a0c] border border-white/10 rounded-2xl max-w-md w-full p-8"
          >
            <div className="text-center mb-6">
              <h3 className="text-lg font-black text-white uppercase tracking-wider mb-2">
                Sécuriser l'abonnement
              </h3>
              <p className="text-xs text-gray-400 font-bold">
                Plan {plans[selectedPlan].name} - <span className="text-[#D4AF37] font-black">${Math.round(plans[selectedPlan].price * getBillingMultiplier())}</span>
              </p>
            </div>

            {/* Méthodes de paiement */}
            <div className="space-y-3 mb-6">
              {paymentMethods.map((method) => (
                <button
                  key={method.id}
                  onClick={() => setSelectedPayment(method.id)}
                  className={`w-full p-4 rounded-xl border-2 transition-all flex items-center space-x-3 text-white ${
                    selectedPayment === method.id
                      ? 'border-[#D4AF37] bg-[#D4AF37]/10'
                      : 'border-white/5 bg-white/[0.02] hover:border-white/10'
                  }`}
                >
                  <method.icon className="w-5 h-5 text-[#D4AF37]" />
                  <div className="text-left font-bold">
                    <div className="text-xs uppercase tracking-wider">{method.name}</div>
                    <div className="text-[10px] text-gray-500">{method.description}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Boutons d'action */}
            <div className="flex space-x-3 text-xs font-black uppercase">
              <button
                onClick={() => setShowPaymentModal(false)}
                className="flex-1 py-3.5 px-4 bg-white/5 text-gray-400 hover:text-white rounded-xl transition-colors"
              >
                Annuler
              </button>
              <button
                onClick={handlePayment}
                disabled={isProcessing}
                className="flex-1 py-3.5 px-4 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black hover:from-[#c5a059] hover:to-[#D4AF37] rounded-xl transition-all disabled:opacity-50 flex items-center justify-center space-x-2"
              >
                {isProcessing ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-black"></div>
                    <span>Traitement...</span>
                  </>
                ) : (
                  <span>Confirmer</span>
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}