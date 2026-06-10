'use client';

import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, Zap, Shield, Target, Users, Star, Check, ArrowRight, Play, ExternalLink } from 'lucide-react';
import { pricingPlans } from '@/lib/mock-data';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export default function HomePage() {
  const router = useRouter();
  const [selectedPlan, setSelectedPlan] = useState(1);
  const [showDemo, setShowDemo] = useState(false);
  const [email, setEmail] = useState('');

  const features = [
    {
      icon: <Zap className="w-6 h-6" />,
      title: "Signaux IA en temps réel",
      description: "Algorithmes d'apprentissage automatique analysant les marchés 24/7"
    },
    {
      icon: <Target className="w-6 h-6" />,
      title: "Consensus Multi-Modèles",
      description: "Taux de réussite exceptionnel confirmé par des milliers de signaux réels"
    },
    {
      icon: <Shield className="w-6 h-6" />,
      title: "Gestion du Risque",
      description: "Protocoles intégrés pour protéger votre capital et sécuriser vos gains"
    },
    {
      icon: <Users className="w-6 h-6" />,
      title: "Accès VIP Founders",
      description: "Rejoignez un cercle exclusif de traders professionnels et performants"
    }
  ];

  const testimonials = [
    {
      name: "Marc Dubois",
      role: "Trader Professionnel",
      avatar: "https://images.pexels.com/photos/1043471/pexels-photo-1043471.jpeg?auto=compress&cs=tinysrgb&w=150",
      content: "J'ai optimisé mes performances de manière fulgurante avec A2Sniper. Les analyses sont d'une précision remarquable.",
      rating: 5
    },
    {
      name: "Sarah Martin",
      role: "Investisseuse",
      avatar: "https://images.pexels.com/photos/1181686/pexels-photo-1181686.jpeg?auto=compress&cs=tinysrgb&w=150",
      content: "L'interface cockpit de trading est intuitive et les résultats exceptionnels. Je recommande vivement cette plateforme.",
      rating: 5
    },
    {
      name: "Thomas Bernard",
      role: "Day Trader",
      avatar: "https://images.pexels.com/photos/1043474/pexels-photo-1043474.jpeg?auto=compress&cs=tinysrgb&w=150",
      content: "Les signaux arrivent au bon moment avec une précision incroyable. Parfait pour le trading sur Pocket Option.",
      rating: 5
    }
  ];

  const stats = [
    { value: "N/A", label: "Consensus IA" },
    { value: "50+", label: "Alertes quotidiennes" },
    { value: "10K+", label: "Membres Founders" },
    { value: "24/7", label: "Surveillance flux live" }
  ];

  const handleStartDemo = useCallback(() => {
    setShowDemo(true);
    setTimeout(() => {
      router.push('/dashboard');
    }, 1500);
  }, [router]);

  const handleSubscribeNewsletter = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      toast.success(`Merci ${email} ! Inscription à la newsletter confirmée.`);
      setEmail('');
    }
  }, [email]);

  const handleSelectPlan = useCallback((planIndex: number) => {
    setSelectedPlan(planIndex);
    router.push(`/pricing?plan=${planIndex}`);
  }, [router]);

  return (
    <div className="min-h-screen bg-[#050507] text-gray-200 relative overflow-hidden font-sans">
      
      {/* Background orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-1/4 -left-20 w-[500px] h-[500px] bg-[#D4AF37]/5 rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 -right-20 w-[500px] h-[500px] bg-[#D4AF37]/5 rounded-full blur-[150px]" />
      </div>

      {/* Header */}
      <header className="bg-[#0a0a0c]/80 border-b border-white/5 sticky top-0 z-50 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-3">
              <div className="relative w-10 h-10 rounded-xl overflow-hidden border border-[#D4AF37]/30 flex items-center justify-center bg-[#0a0a0c] shadow-[0_0_15px_rgba(212,175,55,0.1)]">
                <img src="/A2Sniper-logo.jpeg" alt="Logo" className="w-full h-full object-cover" />
              </div>
              <div>
                <h1 className="text-lg font-black tracking-widest text-white uppercase">A2Sniper <span className="text-[10px] text-[#D4AF37] font-black tracking-[0.2em] ml-1">v3.0</span></h1>
                <p className="text-[9px] text-[#D4AF37] font-black uppercase tracking-widest">Neural cockpit interface</p>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <Link 
                href="/dashboard" 
                className="bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black font-black uppercase tracking-wider text-xs px-6 py-2.5 rounded-xl transition-all duration-300 shadow-[0_0_15px_rgba(212,175,55,0.15)] hover:shadow-[0_0_25px_rgba(212,175,55,0.25)]"
              >
                Dashboard
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 md:py-32">
          <div className="text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
            >
              <div className="inline-flex items-center gap-2 bg-[#D4AF37]/10 px-4 py-1.5 rounded-full border border-[#D4AF37]/20 shadow-[0_0_15px_rgba(212,175,55,0.05)] mb-6">
                <span className="text-[10px] font-black text-[#D4AF37] uppercase tracking-[0.3em]">AI-Driven Signals Engine</span>
              </div>
              
              <h1 className="text-4xl md:text-6xl lg:text-7xl font-black text-white mb-6 tracking-tight leading-none">
                Trading Algorithmique<br />
                <span className="block mt-2 text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB]">
                  Propulsé par l'IA
                </span>
              </h1>
              <p className="text-lg md:text-xl text-gray-400 mb-10 max-w-3xl mx-auto leading-relaxed">
                Prenez l'avantage sur le marché avec nos signaux neuronaux en direct. 
                Consensus multi-modèles, gestion automatique du risque et intégration exclusive.
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
                <Link 
                  href="/dashboard" 
                  className="w-full sm:w-auto bg-gradient-to-r from-[#D4AF37] to-[#C5A059] hover:from-[#c5a059] hover:to-[#D4AF37] text-black font-black uppercase tracking-[0.2em] text-xs px-10 py-5 rounded-xl transition-all duration-300 shadow-[0_0_30px_rgba(212,175,55,0.2)]"
                >
                  Découvrir le Cockpit
                </Link>
                <button 
                  onClick={handleStartDemo}
                  disabled={showDemo}
                  className="w-full sm:w-auto border border-[#D4AF37]/30 text-white hover:text-black hover:bg-[#D4AF37] px-10 py-5 rounded-xl font-bold transition-all duration-300 flex items-center justify-center space-x-2 disabled:opacity-50"
                >
                  {showDemo ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                      <span>Vérification...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      <span>Lancer la Démo</span>
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="py-16 bg-[#0a0a0c]/60 border-y border-white/5 relative z-10 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
            {stats.map((stat, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="text-center"
              >
                <div className="text-3xl md:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] mb-2 tracking-tight">{stat.value}</div>
                <div className="text-xs text-gray-500 font-bold uppercase tracking-wider">{stat.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-24 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4 uppercase tracking-tight">
              Pourquoi choisir <span className="text-[#D4AF37]">A2Sniper</span> ?
            </h2>
            <p className="text-gray-400 max-w-2xl mx-auto font-medium">
              Une technologie de pointe conçue pour maximiser l'efficacité de vos trades.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="bg-[#0a0a0c]/60 border border-white/5 hover:border-[#D4AF37]/30 p-6 rounded-2xl backdrop-blur-md transition-all duration-300 group"
              >
                <div className="w-12 h-12 bg-[#D4AF37]/10 rounded-xl flex items-center justify-center text-[#D4AF37] mb-6 border border-[#D4AF37]/20 group-hover:scale-110 transition-transform duration-300">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-bold text-white mb-3 tracking-tight">{feature.title}</h3>
                <p className="text-sm text-gray-400 font-bold leading-relaxed">{feature.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section className="py-24 bg-[#0a0a0c]/40 border-y border-white/5 relative z-10 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4 uppercase tracking-tight">
              Abonnements <span className="text-[#D4AF37]">Founders</span>
            </h2>
            <p className="text-gray-400 max-w-2xl mx-auto font-medium">
              Débloquez l'accès complet au flux algorithmique A2Sniper.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch">
            {pricingPlans.map((plan, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className={`relative bg-[#0a0a0c]/80 p-8 rounded-2xl flex flex-col justify-between border transition-all duration-300 ${
                  plan.popular 
                    ? 'border-[#D4AF37] scale-105 shadow-[0_0_30px_rgba(212,175,55,0.15)] bg-[#0c0c0f]' 
                    : 'border-white/5 hover:border-[#D4AF37]/20'
                }`}
              >
                {plan.popular && (
                  <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
                    <span className="bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black px-6 py-1 rounded-full text-xs font-black uppercase tracking-wider">
                      Plus populaire
                    </span>
                  </div>
                )}
                
                <div>
                  <div className="text-center mb-8">
                    <h3 className="text-xl font-bold text-white mb-2">{plan.name}</h3>
                    <div className="text-4xl font-black text-[#D4AF37] mb-1">
                      ${plan.price}
                      <span className="text-xs font-bold text-gray-500 uppercase ml-1">/ mois</span>
                    </div>
                  </div>
                  
                  <ul className="space-y-4 mb-8">
                    {plan.features.map((feature, featureIndex) => (
                      <li key={featureIndex} className="flex items-start space-x-3 text-sm">
                        <Check className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                        <span className="text-gray-400 font-bold">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                
                <button
                  onClick={() => handleSelectPlan(index)}
                  className={`w-full py-4 rounded-xl font-black uppercase tracking-[0.2em] text-xs transition-all duration-300 ${
                    plan.popular
                      ? 'bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black hover:from-[#c5a059] hover:to-[#D4AF37]'
                      : 'bg-white/5 text-white hover:bg-[#D4AF37] hover:text-black border border-white/5'
                  }`}
                >
                  Choisir ce plan
                </button>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials Section */}
      <section className="py-24 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4 uppercase tracking-tight">
              Avis des <span className="text-[#D4AF37]">Traders</span>
            </h2>
            <p className="text-gray-400 max-w-2xl mx-auto font-medium">
              Découvrez les retours de notre communauté Founders exclusive.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {testimonials.map((testimonial, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="bg-[#0a0a0c]/60 border border-white/5 p-8 rounded-2xl"
              >
                <div className="flex items-center space-x-1 mb-6">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <Star key={i} className="w-4 h-4 text-[#D4AF37] fill-current" />
                  ))}
                </div>
                <p className="text-gray-400 mb-6 italic leading-relaxed">"{testimonial.content}"</p>
                <div className="flex items-center space-x-4">
                  <img 
                    src={testimonial.avatar} 
                    alt={testimonial.name}
                    className="w-10 h-10 rounded-full border border-[#D4AF37]/20 object-cover"
                  />
                  <div>
                    <p className="font-bold text-white tracking-tight">{testimonial.name}</p>
                    <p className="text-xs text-gray-500 font-bold uppercase">{testimonial.role}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-gradient-to-br from-[#0a0a0c] to-[#050507] border border-white/5 rounded-3xl p-12 text-center relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#D4AF37]/5 rounded-full blur-[100px] pointer-events-none" />
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <h2 className="text-3xl md:text-5xl font-black text-white mb-6 uppercase tracking-tight">
              Prêt à révolutionner votre trading ?
            </h2>
            <p className="text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed">
              Rejoignez des milliers de traders qui exploitent la puissance neuronale d'A2Sniper.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link 
                href="/dashboard" 
                className="inline-flex items-center justify-center space-x-2 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] text-black font-black uppercase tracking-[0.2em] text-xs px-10 py-5 rounded-xl transition-all duration-300 shadow-[0_0_20px_rgba(212,175,55,0.15)]"
              >
                <span>Accès Immédiat</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link 
                href="/telegram" 
                className="inline-flex items-center justify-center space-x-2 border border-[#D4AF37]/30 text-white hover:bg-white/5 px-10 py-5 rounded-xl font-bold transition-all duration-300"
              >
                <span>Terminal Telegram</span>
                <ExternalLink className="w-4 h-4" />
              </Link>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#0a0a0c] border-t border-white/5 text-gray-400 py-16 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          
          {/* Newsletter */}
          <div className="mb-16 text-center max-w-md mx-auto">
            <h3 className="text-xl font-bold text-white mb-3 uppercase tracking-wider">Restez Informé</h3>
            <p className="text-sm text-gray-500 mb-6">Recevez nos analyses neurales directement dans votre boîte mail.</p>
            <form onSubmit={handleSubscribeNewsletter} className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Votre email"
                className="flex-1 px-4 py-3 bg-white/[0.02] border border-white/10 rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-[#D4AF37] text-sm font-medium transition-colors"
                required
              />
              <button
                type="submit"
                className="bg-[#D4AF37] text-black font-bold uppercase tracking-wider text-xs px-6 py-3 rounded-xl hover:bg-[#c5a059] transition-colors"
              >
                S'inscrire
              </button>
            </form>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
            <div>
              <div className="flex items-center space-x-3 mb-6">
                <div className="relative w-8 h-8 rounded-lg overflow-hidden border border-[#D4AF37]/20 flex items-center justify-center bg-[#0a0a0c]">
                  <img src="/A2Sniper-logo.jpeg" alt="Logo" className="w-full h-full object-cover" />
                </div>
                <span className="text-lg font-black text-white tracking-widest uppercase">A2Sniper</span>
              </div>
              <p className="text-sm text-gray-500 font-bold leading-relaxed">
                Cockpit de trading algorithmique propulsé par l'intelligence artificielle A2Sniper.
              </p>
            </div>
            
            <div>
              <h3 className="text-sm font-bold text-white mb-6 uppercase tracking-widest">Produit</h3>
              <ul className="space-y-3 text-sm font-bold">
                <li><Link href="/dashboard" className="hover:text-white transition-colors">Dashboard</Link></li>
                <li><Link href="/signals" className="hover:text-white transition-colors">Signaux Live</Link></li>
                <li><Link href="/performance" className="hover:text-white transition-colors">Performance</Link></li>
                <li><Link href="/trading-journal" className="hover:text-white transition-colors">Journal de Trading</Link></li>
              </ul>
            </div>
            
            <div>
              <h3 className="text-sm font-bold text-white mb-6 uppercase tracking-widest">Réseaux & Comm</h3>
              <ul className="space-y-3 text-sm font-bold">
                <li><Link href="/telegram" className="hover:text-white transition-colors">Bot Telegram</Link></li>
                <li><a href="mailto:support@a2sniper.ai" className="hover:text-white transition-colors">Contact Founder</a></li>
                <li><Link href="/telegram" className="hover:text-white transition-colors">Salon Founders</Link></li>
              </ul>
            </div>
            
            <div>
              <h3 className="text-sm font-bold text-white mb-6 uppercase tracking-widest">Légal</h3>
              <ul className="space-y-3 text-sm font-bold">
                <li><Link href="/legal" className="hover:text-white transition-colors">Conditions Générales</Link></li>
                <li><Link href="/legal" className="hover:text-white transition-colors">Confidentialité</Link></li>
                <li><Link href="/legal" className="hover:text-white transition-colors">Avertissement Risques</Link></li>
              </ul>
            </div>
          </div>
          
          <div className="border-t border-white/5 mt-12 pt-8 text-center text-xs text-gray-600 font-bold uppercase tracking-widest">
            <p>&copy; {new Date().getFullYear()} A2Sniper. Tous droits réservés.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}