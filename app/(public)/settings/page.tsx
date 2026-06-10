'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Bell, Shield, Palette, Save, Check, Camera, Key, Globe, Clock } from 'lucide-react';

import { useAppStore } from '@/lib/store';
import { toast } from 'sonner';

export default function SettingsPage() {
  const { user } = useAppStore();
  const [activeTab, setActiveTab] = useState('profile');
  const [notifications, setNotifications] = useState({
    signals: true,
    performance: true,
    news: false,
    marketing: false
  });
  const [savedMessage, setSavedMessage] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState('auto');
  const [selectedLanguage, setSelectedLanguage] = useState('Français');
  const [selectedTimezone, setSelectedTimezone] = useState('Europe/Paris');

  const tabs = [
    { id: 'profile', name: 'Profil', icon: User },
    { id: 'notifications', name: 'Notifications', icon: Bell },
    { id: 'security', name: 'Sécurité', icon: Shield },
    { id: 'appearance', name: 'Apparence', icon: Palette }
  ];

  const handleSave = () => {
    toast.success('Paramètres sauvegardés avec succès !');
    setSavedMessage(true);
    setTimeout(() => setSavedMessage(false), 2000);
  };

  const handleChangePhoto = () => {
    toast.info('Changement de photo — fonctionnalité à venir.');
  };

  const handleEnable2FA = () => {
    toast.info('Activation 2FA — fonctionnalité à venir.');
  };

  const handleThemeChange = (theme: string) => {
    setSelectedTheme(theme);
    toast.success(`Thème changé : ${theme === 'light' ? 'Clair' : theme === 'dark' ? 'Sombre' : 'Automatique'}`);
  };

  const handleLanguageChange = (lang: string) => {
    setSelectedLanguage(lang);
    toast.success(`Langue changée : ${lang}`);
  };

  const handleTimezoneChange = (tz: string) => {
    setSelectedTimezone(tz);
    toast.success(`Fuseau horaire changé : ${tz}`);
  };

  return (
    <div className="space-y-8">
          {/* Header */}
          <div className="mb-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <h1 className="text-2xl font-bold text-white mb-2">
                Paramètres
              </h1>
              <p className="text-gray-400">
                Gérez vos préférences et paramètres de compte
              </p>
            </motion.div>
          </div>

          <div className="flex flex-col lg:flex-row gap-8">
            {/* Sidebar */}
            <div className="lg:w-64">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5 }}
                className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-4"
              >
                <nav className="space-y-2">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        activeTab === tab.id
                          ? 'bg-[#D4AF37]/10 text-[#D4AF37]'
                          : 'text-gray-400 hover:bg-[#1a1a2e]'
                      }`}
                    >
                      <tab.icon className="w-5 h-5" />
                      <span>{tab.name}</span>
                    </button>
                  ))}
                </nav>
              </motion.div>
            </div>

            {/* Content */}
            <div className="flex-1">
              {activeTab === 'profile' && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                  className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6"
                >
                  <h2 className="text-lg font-semibold text-white mb-6">
                    Informations du profil
                  </h2>
                  
                  <div className="space-y-6">
                    <div className="flex items-center space-x-4">
                      <div className="w-16 h-16 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-full flex items-center justify-center">
                        <User className="w-8 h-8 text-black" />
                      </div>
                      <div>
                        <button 
                          onClick={handleChangePhoto}
                          className="bg-[#D4AF37] text-black px-4 py-2 rounded-lg hover:bg-[#c5a059] transition-colors font-bold flex items-center gap-2"
                        >
                          <Camera className="w-4 h-4" />
                          Changer la photo
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                          Nom complet
                        </label>
                        <input
                          type="text"
                          defaultValue={user?.name}
                          className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                          Email
                        </label>
                        <input
                          type="email"
                          defaultValue={user?.email}
                          className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                          Téléphone
                        </label>
                        <input
                          type="tel"
                          placeholder="+33 6 12 34 56 78"
                          className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                          Pays
                        </label>
                        <select className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white">
                          <option>France</option>
                          <option>Belgique</option>
                          <option>Suisse</option>
                          <option>Canada</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {activeTab === 'notifications' && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                  className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6"
                >
                  <h2 className="text-lg font-semibold text-white mb-6">
                    Préférences de notification
                  </h2>
                  
                  <div className="space-y-6">
                    {[
                      { key: 'signals' as const, title: 'Signaux de trading', desc: 'Recevoir les nouveaux signaux' },
                      { key: 'performance' as const, title: 'Rapports de performance', desc: 'Résumé quotidien des performances' },
                      { key: 'news' as const, title: 'Actualités du marché', desc: 'Informations importantes sur les marchés' },
                      { key: 'marketing' as const, title: 'Emails marketing', desc: 'Offres et nouvelles fonctionnalités' }
                    ].map((item) => (
                    <div key={item.key} className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-white">{item.title}</h3>
                        <p className="text-sm text-gray-500">{item.desc}</p>
                      </div>
                      <button
                        onClick={() => setNotifications(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          notifications[item.key] ? 'bg-[#D4AF37]' : 'bg-gray-700'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          notifications[item.key] ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {activeTab === 'security' && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                  className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6"
                >
                  <h2 className="text-lg font-semibold text-white mb-6">
                    Sécurité du compte
                  </h2>
                  
                  <div className="space-y-6">
                    <div>
                      <h3 className="font-medium text-white mb-3">Changer le mot de passe</h3>
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-400 mb-2">
                            Mot de passe actuel
                          </label>
                          <input
                            type="password"
                            className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-400 mb-2">
                            Nouveau mot de passe
                          </label>
                          <input
                            type="password"
                            className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-400 mb-2">
                            Confirmer le mot de passe
                          </label>
                          <input
                            type="password"
                            className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-[#1a1a2e] pt-6">
                      <h3 className="font-medium text-white mb-3">Authentification à deux facteurs</h3>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-500">
                            Ajoutez une couche de sécurité supplémentaire à votre compte
                          </p>
                        </div>
                        <button 
                          onClick={handleEnable2FA}
                          className="bg-[#D4AF37] text-black px-4 py-2 rounded-lg hover:bg-[#c5a059] transition-colors font-bold flex items-center gap-2"
                        >
                          <Key className="w-4 h-4" />
                          Activer
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {activeTab === 'appearance' && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                  className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6"
                >
                  <h2 className="text-lg font-semibold text-white mb-6">
                    Apparence et affichage
                  </h2>
                  
                  <div className="space-y-6">
                    <div>
                      <h3 className="font-medium text-white mb-3 flex items-center gap-2"><Palette className="w-4 h-4 text-[#D4AF37]" /> Thème</h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div onClick={() => handleThemeChange('light')} className={`border rounded-lg p-4 cursor-pointer hover:border-[#D4AF37] transition-colors ${selectedTheme === 'light' ? 'border-[#D4AF37] bg-[#D4AF37]/10' : 'border-[#1a1a2e]'}`}>
                          <div className="w-full h-16 bg-gray-200 border border-gray-300 rounded mb-2"></div>
                          <p className="text-sm font-medium text-center text-gray-400">Clair</p>
                        </div>
                        <div onClick={() => handleThemeChange('dark')} className={`border rounded-lg p-4 cursor-pointer hover:border-[#D4AF37] transition-colors ${selectedTheme === 'dark' ? 'border-[#D4AF37] bg-[#D4AF37]/10' : 'border-[#1a1a2e]'}`}>
                          <div className="w-full h-16 bg-gray-900 border border-gray-700 rounded mb-2"></div>
                          <p className="text-sm font-medium text-center text-gray-400">Sombre</p>
                        </div>
                        <div onClick={() => handleThemeChange('auto')} className={`border rounded-lg p-4 cursor-pointer hover:border-[#D4AF37] transition-colors ${selectedTheme === 'auto' ? 'border-[#D4AF37] bg-[#D4AF37]/10' : 'border-[#1a1a2e]'}`}>
                          <div className="w-full h-16 bg-gradient-to-r from-gray-200 to-gray-900 border border-gray-500 rounded mb-2"></div>
                          <p className="text-sm font-medium text-center text-gray-400">Automatique</p>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="font-medium text-white mb-3 flex items-center gap-2"><Globe className="w-4 h-4 text-[#D4AF37]" /> Langue</h3>
                      <select 
                        value={selectedLanguage}
                        onChange={(e) => handleLanguageChange(e.target.value)}
                        className="w-full md:w-64 px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                      >
                        <option>Français</option>
                        <option>English</option>
                        <option>Español</option>
                        <option>Deutsch</option>
                      </select>
                    </div>

                    <div>
                      <h3 className="font-medium text-white mb-3 flex items-center gap-2"><Clock className="w-4 h-4 text-[#D4AF37]" /> Fuseau horaire</h3>
                      <select
                        value={selectedTimezone}
                        onChange={(e) => handleTimezoneChange(e.target.value)}
                        className="w-full md:w-64 px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                      >
                        <option>Europe/Paris</option>
                        <option>Europe/London</option>
                        <option>America/New_York</option>
                        <option>Asia/Tokyo</option>
                      </select>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Save Button */}
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="mt-8 flex items-center space-x-4"
              >
                <button
                  onClick={handleSave}
                  className="bg-[#D4AF37] text-black px-6 py-3 rounded-lg hover:bg-[#c5a059] transition-colors flex items-center space-x-2 font-bold"
                >
                  <Save className="w-5 h-5" />
                  <span>Enregistrer les modifications</span>
                </button>
                
                {savedMessage && (
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="flex items-center space-x-2 text-green-500"
                  >
                    <Check className="w-5 h-5" />
                    <span>Modifications enregistrées</span>
                  </motion.div>
                )}
              </motion.div>
            </div>
          </div>
    </div>
  );
}
