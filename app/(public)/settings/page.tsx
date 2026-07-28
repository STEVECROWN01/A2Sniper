'use client';

import { getApiUrl } from '@/lib/api-config';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Bell, Shield, Palette, Save, Check, Camera, Key, Globe, Clock, Trash2, Download, AlertTriangle, Loader2, Volume2 } from 'lucide-react';

import { useAppStore } from '@/lib/store';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { createBrandedPDF, drawSectionTitle, drawInfoRow, drawUserInfoCard, savePDF, PAGE, PDFUserInfo, fetchAvatarBase64 } from '@/lib/pdf-export';
import {
  playNotificationSound,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
  isSubscribedToPush,
  notificationsSupported,
} from '@/lib/notifications';

export default function SettingsPage() {
  useAuth();
  const { user, logout } = useAppStore();
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
      return localStorage.getItem('a2sniper_language') || 'English';
    }
    return 'English';
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

  // CRITICAL: Sync local avatarUrl from the store whenever user.avatar changes.
  // Without this, if the user reloads the page:
  //   1. Component mounts with `user === null` (auth/me fetch still in-flight)
  //   2. `avatarUrl` initializes to null
  //   3. /api/auth/me resolves, store updates with the real avatar
  //   4. Navbar re-renders with the avatar (reads user.avatar directly)
  //   5. But this component's local `avatarUrl` state stays null forever
  //      → avatar circle stays empty after reload, even though it shows in navbar.
  // This effect re-syncs local state whenever the store's user.avatar updates —
  // both when an avatar appears (login/reload) AND when it is cleared (delete).
  // We skip the sync only while a fresh upload is in progress, so we don't
  // clobber the optimistic preview with the stale store value.
  useEffect(() => {
    if (isUploadingPhoto) return;
    setAvatarUrl(user?.avatar || null);
  }, [user?.avatar, isUploadingPhoto]);

  // Delete account state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteStep, setDeleteStep] = useState<'CONFIRM' | 'OTP'>('CONFIRM');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteOtpCode, setDeleteOtpCode] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // Export data state
  const [isExporting, setIsExporting] = useState(false);
  const [justExported, setJustExported] = useState(false);

  // Notification sound + push notification state
  const [selectedNotificationSound, setSelectedNotificationSound] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('a2sniper_notification_sound') || user?.notification_sound || 'bell';
    }
    return 'bell';
  });
  const [isPlayingSound, setIsPlayingSound] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [isTogglingPush, setIsTogglingPush] = useState(false);

  // Sync notification sound from user data when it loads
  useEffect(() => {
    if (user?.notification_sound && user.notification_sound !== selectedNotificationSound) {
      setSelectedNotificationSound(user.notification_sound);
    }
  }, [user?.notification_sound]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check push subscription status on mount
  useEffect(() => {
    if (!notificationsSupported()) return;
    isSubscribedToPush().then(setPushEnabled);
  }, []);

  // Save notification preferences to localStorage when changed
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_notifications', JSON.stringify(notifications));
    }
  }, [notifications]);

  const tabs = [
    { id: 'profile', name: 'Profil', icon: User },
    { id: 'notifications', name: 'Notifications', icon: Bell },
    { id: 'security', name: 'Security', icon: Shield },
    { id: 'appearance', name: 'Apparence', icon: Palette }
  ];

  const handleSave = () => {
    toast.success('Settings saved successfully!');
    setSavedMessage(true);
    setTimeout(() => setSavedMessage(false), 2000);
  };

  /**
   * Resize an image File to a square JPEG thumbnail at the given dimension.
   * Why: phone photos are typically 2-5 MB at 3000×4000. The avatar only renders
   * at 40×40 (navbar) / 64×64 (settings). Resizing client-side to 256×256 JPEG
   * q=0.85 produces a ~15-30 KB file — ~150× smaller — making uploads near-instant
   * and saving DB storage (base64 of 30KB = ~40KB string vs ~6.7MB for a 5MB image).
   *
   * Falls back to the original file if canvas operations fail (e.g. SVG input).
   */
  const resizeImageFile = async (file: File, size = 256): Promise<File> => {
    try {
      if (!file.type.startsWith('image/')) return file;
      // Skip resize for tiny images — already small enough.
      if (file.size < 80 * 1024) return file;

      const bitmap = await createImageBitmap(file);
      // Square center-crop: take the smaller dimension and crop the rest.
      const side = Math.min(bitmap.width, bitmap.height);
      const sx = (bitmap.width - side) / 2;
      const sy = (bitmap.height - side) / 2;

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);

      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
          'image/jpeg',
          0.85
        );
      });
      bitmap.close?.();
      return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
    } catch (err) {
      console.warn('[AVATAR] resize failed, uploading original:', err);
      return file;
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type and size
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must not exceed 5 MB.');
      return;
    }

    setIsUploadingPhoto(true);
    try {
      // Resize client-side FIRST. A 5MB phone photo becomes ~20KB at 256×256.
      // This is what makes the upload fast (1-2 seconds instead of 10+ seconds).
      const resizedFile = await resizeImageFile(file, 256);

      const apiUrl = getApiUrl();
      const formData = new FormData();
      formData.append('avatar', resizedFile);

      const res = await fetch(`${apiUrl}/api/auth/upload-avatar`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        // Prefer the server-returned avatar_url; fall back to a local object URL
        // only as a transient preview (not persisted across reloads).
        const newAvatarUrl = data.avatar_url || URL.createObjectURL(resizedFile);
        setAvatarUrl(newAvatarUrl);
        // CRITICAL: Update the user object in the store so the avatar
        // appears in the header/navigation immediately and persists.
        const store = useAppStore.getState();
        if (store.user) {
          store.setUser({ ...store.user, avatar: newAvatarUrl });
        }
        toast.success('Profile photo updated!');
      } else {
        // Server returned an error — surface it to the user.
        // Do NOT store a blob: URL — it won't survive reload and would mislead
        // the user into thinking the upload succeeded.
        let detail = 'Upload failed. Please try again.';
        try {
          const errData = await res.json();
          if (errData?.detail) detail = String(errData.detail);
        } catch { /* ignore JSON parse errors */ }
        toast.error(detail);
      }
    } catch (err) {
      // Network error — surface it, do not fake success with a blob: URL.
      console.error('[AVATAR UPLOAD] Network error:', err);
      toast.error('Network error — could not reach server. Please try again.');
    } finally {
      setIsUploadingPhoto(false);
      // Reset file input so the same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const [isDeletingPhoto, setIsDeletingPhoto] = useState(false);

  const handlePhotoDelete = async () => {
    // Confirm before deleting — prevents accidental removal.
    if (!window.confirm('Remove your profile picture?')) return;

    setIsDeletingPhoto(true);
    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/auth/avatar`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        // Clear local state — fallback User icon will show.
        setAvatarUrl(null);
        // Update the store so the navbar immediately drops the avatar too.
        const store = useAppStore.getState();
        if (store.user) {
          // Destructure to drop the avatar field cleanly.
          const { avatar: _drop, ...rest } = store.user;
          void _drop;
          store.setUser({ ...rest, avatar: undefined });
        }
        toast.success('Profile photo removed.');
      } else {
        let detail = 'Could not remove photo. Please try again.';
        try {
          const errData = await res.json();
          if (errData?.detail) detail = String(errData.detail);
        } catch { /* ignore JSON parse errors */ }
        toast.error(detail);
      }
    } catch (err) {
      console.error('[AVATAR DELETE] Network error:', err);
      toast.error('Network error — could not reach server. Please try again.');
    } finally {
      setIsDeletingPhoto(false);
    }
  };

  // ─── NOTIFICATION SOUND + PUSH HANDLERS ─────────────────────────────

  const handleNotificationSoundChange = async (sound: string) => {
    setSelectedNotificationSound(sound);
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_notification_sound', sound);
    }
    // Save to backend
    try {
      const apiUrl = getApiUrl();
      await fetch(`${apiUrl}/api/notifications/sound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sound }),
      });
    } catch {
      // Non-critical — the sound is saved in localStorage as fallback
    }
  };

  const handleTestSound = () => {
    if (selectedNotificationSound === 'none') return;
    setIsPlayingSound(true);
    playNotificationSound(selectedNotificationSound);
    setTimeout(() => setIsPlayingSound(false), 1500);
  };

  const handlePushToggle = async () => {
    setIsTogglingPush(true);
    try {
      if (pushEnabled) {
        // Unsubscribe
        const ok = await unsubscribeFromPushNotifications();
        if (ok) {
          setPushEnabled(false);
          toast.success('Push notifications disabled.');
        } else {
          toast.error('Could not disable push notifications. Please try again.');
        }
      } else {
        // Subscribe
        const ok = await subscribeToPushNotifications();
        if (ok) {
          setPushEnabled(true);
          toast.success('Push notifications enabled! You will be alerted when signals fire.');
        } else {
          toast.error('Could not enable push notifications. Please check your browser settings and try again.');
        }
      }
    } catch {
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsTogglingPush(false);
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
      toast.error('New password must contain at least 8 characters.');
      return;
    }

    setIsChangingPassword(true);
    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      if (res.ok) {
        toast.success('Password changed successfully!');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.detail || 'Erreur lors du changement de mot de passe.');
      }
    } catch {
      toast.error('Network error. Please try again.');
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
    toast.success(`Theme changed: ${theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'Auto'}`);
  };

  const handleLanguageChange = (lang: string) => {
    setSelectedLanguage(lang);
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_language', lang);
    }
    toast.success(`Language changed: ${lang}`);
  };

  const handleTimezoneChange = (tz: string) => {
    setSelectedTimezone(tz);
    if (typeof window !== 'undefined') {
      localStorage.setItem('a2sniper_timezone', tz);
    }
    toast.success(`Timezone changed: ${tz}`);
  };

  const handleDeleteSendOtp = async () => {
    if (deleteConfirmText !== 'SUPPRIMER') {
      toast.error('Veuillez taper SUPPRIMER pour confirmer.');
      return;
    }

    setIsDeletingAccount(true);
    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/auth/delete-account-send-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      if (res.ok) {
        setDeleteStep('OTP');
        toast.success('OTP code sent to your email.');
      } else {
        const errorData = await res.json().catch(() => ({}));
        toast.error(errorData.detail || 'Erreur lors de l\'envoi du code OTP. Contactez le support.');
      }
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setIsDeletingAccount(true);
    try {
      const apiUrl = getApiUrl();
      const res = await fetch(`${apiUrl}/api/auth/delete-account-confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ otp_code: deleteOtpCode }),
      });

      if (res.ok) {
        toast.success('Account deleted successfully.');
        // Clear local storage preferences (NOT auth tokens — those are in httpOnly cookies)
        if (typeof window !== 'undefined') {
          localStorage.removeItem('a2sniper_user');
          localStorage.removeItem('a2sniper_notifications');
          localStorage.removeItem('a2sniper_theme');
          localStorage.removeItem('a2sniper_language');
          localStorage.removeItem('a2sniper_timezone');
          localStorage.removeItem('a2sniper_last_ssid');
        }
        // Use Zustand logout to clear store state and call backend logout
        await logout();
        setShowDeleteDialog(false);
        setDeleteConfirmText('');
        setDeleteOtpCode('');
        setDeleteStep('CONFIRM');
        setIsDeletingAccount(false);
        setTimeout(() => {
          window.location.href = '/login';
        }, 1500);
        return;
      } else {
        const errorData = await res.json().catch(() => ({}));
        toast.error(errorData.detail || 'Erreur lors de la suppression du compte. Contactez le support.');
      }
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const handleExportData = async () => {
    setIsExporting(true);
    try {
      // Try to fetch server-side data, but always generate PDF
      let serverData: any = null;
      try {
        const apiUrl = getApiUrl();
        const res = await fetch(`${apiUrl}/api/auth/export-data`, {
          credentials: 'include',
        });
        if (res.ok) serverData = await res.json();
      } catch {}

      const pdfUser: PDFUserInfo = {
        name: user?.name,
        email: user?.email,
        plan: user?.plan,
        userId: user?.id,
        avatarUrl: user?.avatar,
      };
      // Pre-load user avatar if available
      if (user?.avatar) await fetchAvatarBase64(user.avatar);
      const doc = createBrandedPDF('Export de donnees', 'Donnees du compte et parametres', pdfUser);
      let y = 58;

      // User info card
      y = drawUserInfoCard(doc, y, pdfUser);

      // User info
      y = drawSectionTitle(doc, 'Informations du compte', y);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Nom', user?.name || user?.email?.split('@')[0] || '-');
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Email', user?.email || '-');
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'ID', user?.id || '-');
      y += 2;

      // Settings
      y = drawSectionTitle(doc, 'Parametres', y);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Langue', selectedLanguage);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Fuseau Horaire', selectedTimezone);
      y = drawInfoRow(doc, PAGE.marginL + 2, y, 'Theme', selectedTheme);
      y += 2;

      // Notifications
      y = drawSectionTitle(doc, 'Notifications', y);
      if (notifications) {
        Object.entries(notifications).forEach(([key, val]) => {
          y = drawInfoRow(doc, PAGE.marginL + 2, y, key, val ? 'Activee' : 'Desactivee', { valueColor: val ? '#22C55E' : '#EF4444' });
        });
      } else {
        doc.setFontSize(8);
        doc.setTextColor(107, 114, 128);
        doc.text('No notifications configuree.', PAGE.marginL + 4, y + 4);
        y += 8;
      }

      const dateStr = new Date().toISOString().split('T')[0];
      savePDF(doc, `a2sniper-donnees-${dateStr}.pdf`, pdfUser);
      setJustExported(true);
      setTimeout(() => setJustExported(false), 2500);
      toast.success('Rapport PDF exporte avec succes !');
    } catch {
      toast.error('Export error. Please try again.');
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
                Settings
              </h1>
              <p className="text-gray-400">
                Manage your preferences and account settings
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
                      <div className="flex items-center space-x-4 flex-wrap">
                        <div className="w-16 h-16 bg-gradient-to-r from-[#D4AF37] to-[#C5A059] rounded-full flex items-center justify-center overflow-hidden relative">
                          {/* Fallback icon: always rendered as background layer */}
                          <User className="w-8 h-8 text-black absolute inset-0 m-auto" />
                          {avatarUrl && (
                            <img
                              src={avatarUrl}
                              alt="Avatar"
                              className="w-full h-full object-cover relative z-10"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = 'none';
                              }}
                            />
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
                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              onClick={() => fileInputRef.current?.click()}
                              disabled={isUploadingPhoto || isDeletingPhoto}
                              className="bg-[#D4AF37] text-black px-4 py-2 rounded-lg hover:bg-[#c5a059] transition-colors font-bold flex items-center gap-2 disabled:opacity-50"
                            >
                              {isUploadingPhoto ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Camera className="w-4 h-4" />
                              )}
                              {isUploadingPhoto ? 'Uploading...' : 'Change Photo'}
                            </button>
                            {/* Remove photo button — only shown when an avatar is present */}
                            {avatarUrl && (
                              <button
                                onClick={handlePhotoDelete}
                                disabled={isUploadingPhoto || isDeletingPhoto}
                                className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-lg hover:bg-red-500/20 transition-colors font-bold flex items-center gap-2 disabled:opacity-50"
                                title="Remove profile picture"
                              >
                                {isDeletingPhoto ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                                {isDeletingPhoto ? 'Removing...' : 'Remove'}
                              </button>
                            )}
                          </div>
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
                            Phone
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
                      Data du compte
                    </h2>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-medium text-white">Export My Data</h3>
                          <p className="text-sm text-gray-500">Download a copy of your personal data</p>
                        </div>
                        <button
                          onClick={handleExportData}
                          disabled={isExporting}
                          className={`px-4 py-2 rounded-lg transition-colors font-bold flex items-center gap-2 disabled:opacity-50 ${justExported ? 'bg-green-500 text-white border border-green-400' : 'bg-[#121216] hover:bg-[#1a1a1f] border border-gray-800 text-white'}`}
                        >
                          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : justExported ? <Check className="w-4 h-4" /> : <Download className="w-4 h-4" />}
                          {isExporting ? 'Exporting...' : justExported ? 'Exported!' : 'Export'}
                        </button>
                      </div>
                      <div className="border-t border-[#1a1a2e] pt-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="font-medium text-red-400">Supprimer le compte</h3>
                            <p className="text-sm text-gray-500">This action is irreversible</p>
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
                        onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); setDeleteOtpCode(''); setDeleteStep('CONFIRM'); }}
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
                          {deleteStep === 'CONFIRM' ? (
                            <>
                              <p className="text-sm text-gray-400 mb-6">
                                This action is irreversible. All your data will be permanently deleted.
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
                                  onClick={handleDeleteSendOtp}
                                  disabled={isDeletingAccount || deleteConfirmText !== 'SUPPRIMER'}
                                  className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-bold disabled:opacity-50 transition-colors"
                                >
                                  {isDeletingAccount ? 'Sending...' : 'Delete Permanently'}
                                </button>
                                <button
                                  onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); setDeleteOtpCode(''); setDeleteStep('CONFIRM'); }}
                                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-lg font-bold transition-colors"
                                >
                                  Annuler
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <p className="text-sm text-gray-400 mb-6">
                                An OTP code has been sent to your email. Enter it below to confirm deletion.
                              </p>
                              <input
                                type="text"
                                maxLength={6}
                                value={deleteOtpCode}
                                onChange={(e) => setDeleteOtpCode(e.target.value.replace(/[^0-9]/g, ''))}
                                placeholder="000000"
                                className="w-full px-3 py-2 bg-[#050507] border border-red-500/30 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-white text-center text-lg font-bold tracking-[0.5em] mb-4"
                              />
                              <div className="flex gap-3">
                                <button
                                  onClick={handleDeleteConfirm}
                                  disabled={isDeletingAccount || deleteOtpCode.length !== 6}
                                  className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-bold disabled:opacity-50 transition-colors"
                                >
                                  {isDeletingAccount ? 'Suppression...' : 'Confirmer la suppression'}
                                </button>
                                <button
                                  onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); setDeleteOtpCode(''); setDeleteStep('CONFIRM'); }}
                                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 px-4 py-2 rounded-lg font-bold transition-colors"
                                >
                                  Annuler
                                </button>
                              </div>
                            </>
                          )}
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
                    Notification Preferences
                  </h2>

                  <div className="space-y-6">
                    {[
                      { key: 'signals' as const, title: 'Trading Signals', desc: 'Receive new signals' },
                      { key: 'performance' as const, title: 'Performance Reports', desc: 'Daily performance summary' },
                      { key: 'news' as const, title: 'Market News', desc: 'Important market information' },
                      { key: 'marketing' as const, title: 'Marketing Emails', desc: 'Offers and new features' }
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

                  {/* ─── SIGNAL NOTIFICATION SOUND + PUSH ─────────────────── */}
                  <div className="mt-8 pt-8 border-t border-[#1a1a2e]">
                    <h3 className="text-sm font-black text-[#D4AF37] uppercase tracking-wider mb-4 flex items-center gap-2">
                      <Bell className="w-4 h-4" />
                      Signal Notification Sound
                    </h3>
                    <p className="text-xs text-gray-500 mb-4">
                      When a signal fires on the signals page, a notification sound will play on your device
                      and a push notification will appear — even if your browser is closed.
                    </p>

                    {/* Sound selector */}
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-400 mb-2">
                        Notification Sound
                      </label>
                      <div className="flex items-center gap-3 flex-wrap">
                        <select
                          value={selectedNotificationSound}
                          onChange={(e) => handleNotificationSoundChange(e.target.value)}
                          className="flex-1 min-w-[200px] bg-[#050507] border border-[#1a1a2e] rounded-lg px-4 py-2.5 text-sm font-bold text-white focus:border-[#D4AF37] focus:ring-2 focus:ring-[#D4AF37]/20 outline-none"
                        >
                          <option value="bell">🔔 Bell</option>
                          <option value="chime">🎵 Chime</option>
                          <option value="alert">⚠️ Alert</option>
                          <option value="coin">🪙 Coin</option>
                          <option value="digital">📟 Digital</option>
                          <option value="none">🔇 None</option>
                        </select>
                        <button
                          onClick={handleTestSound}
                          disabled={selectedNotificationSound === 'none'}
                          className="bg-[#D4AF37]/10 border border-[#D4AF37]/30 text-[#D4AF37] px-4 py-2.5 rounded-lg hover:bg-[#D4AF37]/20 transition-colors font-bold text-sm flex items-center gap-2 disabled:opacity-40"
                        >
                          {isPlayingSound ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                          Test Sound
                        </button>
                      </div>
                    </div>

                    {/* Push notification toggle */}
                    <div className="mt-6 p-4 bg-[#050507]/60 rounded-xl border border-[#1a1a2e]">
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex-1 min-w-[200px]">
                          <h3 className="font-bold text-white text-sm">Push Notifications</h3>
                          <p className="text-xs text-gray-500 mt-1">
                            Get notified on your device even when the browser is closed.
                            {!notificationsSupported() && (
                              <span className="block text-orange-400 mt-1">⚠️ Push notifications are not supported in this browser.</span>
                            )}
                          </p>
                          {pushEnabled && (
                            <p className="text-xs text-green-400 mt-1">✅ Push notifications are active on this device.</p>
                          )}
                        </div>
                        <button
                          onClick={handlePushToggle}
                          disabled={!notificationsSupported() || isTogglingPush}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-40 ${
                            pushEnabled ? 'bg-[#D4AF37]' : 'bg-gray-700'
                          }`}
                        >
                          {isTogglingPush ? (
                            <Loader2 className="w-4 h-4 animate-spin text-white absolute left-1" />
                          ) : (
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              pushEnabled ? 'translate-x-6' : 'translate-x-1'
                            }`} />
                          )}
                        </button>
                      </div>
                    </div>
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
                    Security du compte
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
                            placeholder="Min. 8 characters"
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
                      <h3 className="font-medium text-white mb-3">Two-Factor Authentication</h3>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-500">
                            Add an extra layer of security to your account
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
                      <h3 className="font-medium text-white mb-3 flex items-center gap-2"><Palette className="w-4 h-4 text-[#D4AF37]" /> Theme</h3>
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
                        <option>English</option>
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
                className="mt-8 flex items-center space-x-4 flex-wrap"
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
                    <span>Changes saved</span>
                  </motion.div>
                )}
              </motion.div>
            </div>
          </div>
    </div>
  );
}
