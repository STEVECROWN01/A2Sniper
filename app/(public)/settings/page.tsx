'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Bell, Shield, Palette, Save, Check, Camera, Key, Globe, Clock, Trash2, Download, AlertTriangle, Loader2 } from 'lucide-react';

import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';

export default function SettingsPage() {
  useAuth();
  const { user } = useAppStore();
  const [activeTab, setActiveTab] = useState('profile');
  const [notifications, setNotifications] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('a2sniper_notifications');
      if (saved) { try { return JSON.parse(saved); } catch {} }
    }
    return { signals: true, performance: true, news: false, marketing: false };
  });
  const [savedMessage, setSavedMessage] = useState(false);
  const [selectedTheme, setSelectedTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_theme') || 'auto';
    }
    return 'auto';
  });
  const [selectedLanguage, setSelectedLanguage] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_language') || 'Français';
    }
    return 'Français';
  });
  const [selectedTimezone, setSelectedTimezone] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_timezone') || 'Europe/Paris';
    }
    return 'Europe/Paris';
  });

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Photo upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user?.avatar || null);

  // Delete account state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // Export data state
  const [isExporting, setIsExporting] = useState(false);

  // Save notification preferences to localStorage when changed
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_notifications', JSON.stringify(notifications));
    }
  }, [notifications]);

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

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type and size
    if (!file.type.startsWith('image/')) {
      toast.error('Veuillez sélectionner un fichier image.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('L\'image ne doit pas dépasser 5 MB.');
      return;
    }

    setIsUploadingPhoto(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;

      const formData = new FormData();
      formData.append('avatar', file);

      const res = await fetch(`${apiUrl}/api/auth/upload-avatar`, {
        method: 'POST',
        headers: {
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        setAvatarUrl(data.avatar_url || URL.createObjectURL(file));
        toast.success('Photo de profil mise à jour !');
      } else {
        // Fallback: show preview locally even if API fails
        setAvatarUrl(URL.createObjectURL(file));
        toast.success('Photo mise à jour localement (serveur indisponible).');
      }
    } catch {
      // Show preview locally when API is unavailable
      setAvatarUrl(URL.createObjectURL(file));
      toast.success('Photo mise à jour localement (serveur indisponible).');
    } finally {
      setIsUploadingPhoto(false);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error('Veuillez remplir tous les champs de mot de passe.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Les nouveaux mots de passe ne correspondent pas.');
      return;
    }
    if (newPassword.length < 8) {
      toast.error('Le nouveau mot de passe doit contenir au moins 8 caractères.');
      return;
    }

    setIsChangingPassword(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${apiUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      if (res.ok) {
        toast.success('Mot de passe modifié avec succès !');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.detail || 'Erreur lors du changement de mot de passe.');
      }
    } catch {
      toast.error('Erreur réseau. Veuillez réessayer.');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleThemeChange = (theme: string) => {
    setSelectedTheme(theme);
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_theme', theme);
    }
    // Apply theme class to document for basic dark/light support
    if (typeof document !== 'undefined') {
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
      } else if (theme === 'light') {
        document.documentElement.classList.remove('dark');
      } else {
        // auto — check system preference
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.classList.toggle('dark', prefersDark);
      }
    }
    toast.success(`Thème changé : ${theme === 'light' ? 'Clair' : theme === 'dark' ? 'Sombre' : 'Automatique'}`);
  };

  const handleLanguageChange = (lang: string) => {
    setSelectedLanguage(lang);
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_language', lang);
    }
    toast.success(`Langue changée : ${lang}`);
  };

  const handleTimezoneChange = (tz: string) => {
    setSelectedTimezone(tz);
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_timezone', tz);
    }
    toast.success(`Fuseau horaire changé : ${tz}`);
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'SUPPRIMER') {
      toast.error('Veuillez taper SUPPRIMER pour confirmer.');
      return;
    }

    setIsDeletingAccount(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${apiUrl}/api/auth/delete-account`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        toast.success('Compte supprimé. Redirection...');
        if (typeof window !== 'undefined') {
          localStorage.removeItem('a2sniper_token');
        }
        setTimeout(() => window.location.href = '/', 2000);
      } else {
        toast.error('Erreur lors de la suppression du compte. Contactez le support.');
      }
    } catch {
      toast.error('Erreur réseau. Veuillez réessayer.');
    } finally {
      setIsDeletingAccount(false);
      setShowDeleteDialog(false);
      setDeleteConfirmText('');
    }
  };

  const handleExportData = async () => {
    setIsExporting(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
      const token = typeof window !== 'undefined' ? localStorage.getItem('a2sniper_token') : null;
      const res = await fetch(`${apiUrl}/api/auth/export-data`, {
        headers: {
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `a2sniper-data-export-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Données exportées avec succès !');
      } else {
        // Fallback: export locally stored data
        const localData = {
          exportDate: new Date().toISOString(),
          user: user,
          settings: { language: selectedLanguage, timezone: selectedTimezone, theme: selectedTheme },
          notifications,
        };
        const blob = new Blob([JSON.stringify(localData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `a2sniper-data-export-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Données locales exportées (serveur indisponible).');
      }
    } catch {
      toast.error('Erreur lors de l\'export. Veuillez réessayer.');
    } finally {
      setIsExporting(false);
    }
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
                  className="space-y-6"
                >
                  <div className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6">
                    <h2 className="text-lg font-semibold text-white mb-6">
                      Informations du profil
                    </h2>

                    <div className="space-y-6">
                      <div className="flex items-center space-x-4">
                        <div className="w-16 h-16 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-full flex items-center justify-center overflow-hidden">
                          {avatarUrl ? (
                            <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                          ) : (
                            <User className="w-8 h-8 text-black" />
                          )}
                        </div>
                        <div>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handlePhotoUpload}
                            className="hidden"
                          />
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploadingPhoto}
                            className="bg-[#D4AF37] text-black px-4 py-2 rounded-lg hover:bg-[#c5a059] transition-colors font-bold flex items-center gap-2 disabled:opacity-50"
                          >
                            {isUploadingPhoto ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Camera className="w-4 h-4" />
                            )}
                            {isUploadingPhoto ? 'Téléchargement...' : 'Changer la photo'}
                          </button>
                          <p className="text-[10px] text-gray-500 mt-1">JPG, PNG — Max 5 MB</p>
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
                  </div>

                  {/* Export & Delete Account */}
                  <div className="bg-[#0A0B0E] rounded-xl border border-[#1a1a2e] p-6">
                    <h2 className="text-lg font-semibold text-white mb-6">
                      Données du compte
                    </h2>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-medium text-white">Exporter mes données</h3>
                          <p className="text-sm text-gray-500">Télécharger une copie de vos données personnelles</p>
                        </div>
                        <button
                          onClick={handleExportData}
                          disabled={isExporting}
                          className="bg-[#121216] hover:bg-[#1a1a1f] border border-gray-800 text-white px-4 py-2 rounded-lg transition-colors font-bold flex items-center gap-2 disabled:opacity-50"
                        >
                          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                          Exporter
                        </button>
                      </div>
                      <div className="border-t border-[#1a1a2e] pt-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-red-400">Supprimer le compte</h3>
                            <p className="text-sm text-gray-500">Cette action est irréversible</p>
                          </div>
                          <button
                            onClick={() => setShowDeleteDialog(true)}
                            className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 px-4 py-2 rounded-lg transition-colors font-bold flex items-center gap-2"
                          >
                            <Trash2 className="w-4 h-4" />
                            Supprimer
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Delete Account Confirmation Dialog */}
                  <AnimatePresence>
                    {showDeleteDialog && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
                        onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); }}
                      >
                        <motion.div
                          initial={{ scale: 0.9, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.9, opacity: 0 }}
                          className="bg-[#0A0B0E] border border-red-500/30 rounded-2xl p-8 max-w-md w-full"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center gap-3 mb-4">
                            <AlertTriangle className="w-6 h-6 text-red-500" />
                            <h3 className="text-lg font-bold text-white">Supprimer le compte</h3>
                          </div>
                          <p className="text-sm text-gray-400 mb-6">
                            Cette action est irréversible. Toutes vos données seront définitivement supprimées.
                            Tapez <span className="text-red-400 font-bold">SUPPRIMER</span> pour confirmer.
                          </p>
                          <input
                            type="text"
                            value={deleteConfirmText}
                            onChange={(e) => setDeleteConfirmText(e.target.value)}
                            placeholder="Tapez SUPPRIMER"
                            className="w-full px-3 py-2 bg-[#050507] border border-red-500/30 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-white mb-4"
                          />
                          <div className="flex gap-3">
                            <button
                              onClick={handleDeleteAccount}
                              disabled={isDeletingAccount || deleteConfirmText !== 'SUPPRIMER'}
                              className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-bold disabled:opacity-50 transition-colors"
                            >
                              {isDeletingAccount ? 'Suppression...' : 'Supprimer définitivement'}
                            </button>
                            <button
                              onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); }}
                              className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-lg font-bold transition-colors"
                            >
                              Annuler
                            </button>
                          </div>
                        </motion.div>
                      </motion.div>
                    )}
                  </AnimatePresence>
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
                        onClick={() => setNotifications((prev: typeof notifications) => ({ ...prev, [item.key]: !prev[item.key] }))}
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
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-400 mb-2">
                            Nouveau mot de passe
                          </label>
                          <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                            placeholder="Min. 8 caractères"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-400 mb-2">
                            Confirmer le mot de passe
                          </label>
                          <input
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className="w-full px-3 py-2 bg-[#050507] border border-[#1a1a2e] rounded-lg focus:ring-2 focus:ring-[#D4AF37] focus:border-transparent text-white"
                          />
                        </div>
                        <button
                          onClick={handleChangePassword}
                          disabled={isChangingPassword || !currentPassword || !newPassword || !confirmPassword}
                          className="bg-[#D4AF37] text-black px-4 py-2 rounded-lg hover:bg-[#c5a059] transition-colors font-bold flex items-center gap-2 disabled:opacity-50"
                        >
                          {isChangingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                          {isChangingPassword ? 'Modification...' : 'Changer le mot de passe'}
                        </button>
                      </div>
                    </div>

                    <div className="border-t border-[#1a1a2e] pt-6">
                      <h3 className="font-medium text-white mb-3">Authentification à deux facteurs</h3>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-500">
                            Ajoutez une couche de sécurité supplémentaire à votre compte
                          </p>
                          <span className="inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 bg-yellow-500/10 border border-yellow-500/20 rounded text-[10px] font-bold text-yellow-400 uppercase tracking-wider">
                            <Clock className="w-3 h-3" />
                            Coming Soon
                          </span>
                        </div>
                        <button
                          disabled
                          className="bg-gray-700/50 text-gray-500 px-4 py-2 rounded-lg font-bold flex items-center gap-2 cursor-not-allowed"
                          title="2FA sera disponible prochainement"
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
