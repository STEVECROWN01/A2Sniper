'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, Bell, Shield, Palette, Save, Check } from 'lucide-react';

import { useAppStore } from '@/lib/store';

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

  const tabs = [
    { id: 'profile', name: 'Profil', icon: User },
    { id: 'notifications', name: 'Notifications', icon: Bell },
    { id: 'security', name: 'Sécurité', icon: Shield },
    { id: 'appearance', name: 'Apparence', icon: Palette }
  ];

  const handleSave = () => {
    // Simulation de sauvegarde
    const saveNotification = document.createElement('div');
    saveNotification.className = 'fixed top-4 right-4 bg-green-500 text-white px-6 py-3 rounded-lg shadow-lg z-50';
    saveNotification.textContent = 'Paramètres sauvegardés avec succès !';
    document.body.appendChild(saveNotification);
    setTimeout(() => {
      document.body.removeChild(saveNotification);
      setSavedMessage(true);
      setTimeout(() => setSavedMessage(false), 2000);
    }, 1000);
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
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                Paramètres
              </h1>
              <p className="text-gray-600">
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
                className="bg-white rounded-xl shadow-lg border border-gray-100 p-4"
              >
                <nav className="space-y-2">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        activeTab === tab.id
                          ? 'bg-[#D4AF37]/10 text-[#D4AF37]'
                          : 'text-gray-600 hover:bg-gray-50'
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
                  className="bg-white rounded-xl shadow-lg border border-gray-100 p-6"
                >
                  <h2 className="text-lg font-semibold text-gray-900 mb-6">
                    Informations du profil
                  </h2>
                  
                  <div className="space-y-6">
                    <div className="flex items-center space-x-4">
                      <div className="w-16 h-16 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-full flex items-center justify-center">
                        <User className="w-8 h-8 text-black" />
                      </div>
                      <div>
                        <button className="bg-[#D4AF37] text-black px-4 py-2 rounded-lg hover:bg-[#c5a059] transition-colors font-bold">
                          Changer la photo
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Nom complet
                        </label>
                        <input
                          type="text"
                          defaultValue={user?.name}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Email
                        </label>
                        <input
                          type="email"
                          defaultValue={user?.email}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Téléphone
                        </label>
                        <input
                          type="tel"
                          placeholder="+33 6 12 34 56 78"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Pays
                        </label>
                        <select className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent">
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
                  className="bg-white rounded-xl shadow-lg border border-gray-100 p-6"
                >
                  <h2 className="text-lg font-semibold text-gray-900 mb-6">
                    Préférences de notification
                  </h2>
                  
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-gray-900">Signaux de trading</h3>
                        <p className="text-sm text-gray-600">Recevoir les nouveaux signaux</p>
                      </div>
                      <button
                        onClick={() => setNotifications(prev => ({ ...prev, signals: !prev.signals }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          notifications.signals ? 'bg-[#D4AF37]' : 'bg-gray-200'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          notifications.signals ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-gray-900">Rapports de performance</h3>
                        <p className="text-sm text-gray-600">Résumé quotidien des performances</p>
                      </div>
                      <button
                        onClick={() => setNotifications(prev => ({ ...prev, performance: !prev.performance }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          notifications.performance ? 'bg-[#D4AF37]' : 'bg-gray-200'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          notifications.performance ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-gray-900">Actualités du marché</h3>
                        <p className="text-sm text-gray-600">Informations importantes sur les marchés</p>
                      </div>
                      <button
                        onClick={() => setNotifications(prev => ({ ...prev, news: !prev.news }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          notifications.news ? 'bg-[#D4AF37]' : 'bg-gray-200'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          notifications.news ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-medium text-gray-900">Emails marketing</h3>
                        <p className="text-sm text-gray-600">Offres et nouvelles fonctionnalités</p>
                      </div>
                      <button
                        onClick={() => setNotifications(prev => ({ ...prev, marketing: !prev.marketing }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          notifications.marketing ? 'bg-[#D4AF37]' : 'bg-gray-200'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          notifications.marketing ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {activeTab === 'security' && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                  className="bg-white rounded-xl shadow-lg border border-gray-100 p-6"
                >
                  <h2 className="text-lg font-semibold text-gray-900 mb-6">
                    Sécurité du compte
                  </h2>
                  
                  <div className="space-y-6">
                    <div>
                      <h3 className="font-medium text-gray-900 mb-3">Changer le mot de passe</h3>
                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Mot de passe actuel
                          </label>
                          <input
                            type="password"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Nouveau mot de passe
                          </label>
                          <input
                            type="password"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">
                            Confirmer le mot de passe
                          </label>
                          <input
                            type="password"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-6">
                      <h3 className="font-medium text-gray-900 mb-3">Authentification à deux facteurs</h3>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-600">
                            Ajoutez une couche de sécurité supplémentaire à votre compte
                          </p>
                        </div>
                        <button className="bg-[#D4AF37] text-black px-4 py-2 rounded-lg hover:bg-[#c5a059] transition-colors font-bold">
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
                  className="bg-white rounded-xl shadow-lg border border-gray-100 p-6"
                >
                  <h2 className="text-lg font-semibold text-gray-900 mb-6">
                    Apparence et affichage
                  </h2>
                  
                  <div className="space-y-6">
                    <div>
                      <h3 className="font-medium text-gray-900 mb-3">Thème</h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-[#D4AF37]">
                          <div className="w-full h-16 bg-white border rounded mb-2"></div>
                          <p className="text-sm font-medium text-center">Clair</p>
                        </div>
                        <div className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:border-[#D4AF37]">
                          <div className="w-full h-16 bg-gray-900 border rounded mb-2"></div>
                          <p className="text-sm font-medium text-center">Sombre</p>
                        </div>
                        <div className="border-[#D4AF37] border-2 rounded-lg p-4 cursor-pointer bg-[#D4AF37]/10">
                          <div className="w-full h-16 bg-gradient-to-r from-white to-gray-900 border rounded mb-2"></div>
                          <p className="text-sm font-medium text-center">Automatique</p>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="font-medium text-gray-900 mb-3">Langue</h3>
                      <select className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent">
                        <option>Français</option>
                        <option>English</option>
                        <option>Español</option>
                        <option>Deutsch</option>
                      </select>
                    </div>

                    <div>
                      <h3 className="font-medium text-gray-900 mb-3">Fuseau horaire</h3>
                      <select className="w-full md:w-64 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent">
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
                    className="flex items-center space-x-2 text-green-600"
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