export function validateSSID(ssid: string): { status: 'valid' | 'partial' | 'invalid' | 'none', message: string } {
  if (!ssid) return { status: 'none', message: '' };
  const trimmed = ssid.trim();
  if (!trimmed.startsWith('42["auth"')) {
    return {
      status: 'invalid',
      message: 'Le message doit commencer par 42["auth",...] (trame d\'authentification Pocket Option).'
    };
  }
  try {
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}') + 1;
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      return { status: 'invalid', message: 'Format JSON de la trame invalide.' };
    }
    const payload = JSON.parse(trimmed.slice(jsonStart, jsonEnd));
    if (!payload.session) {
      return {
        status: 'invalid',
        message: 'Format non supporté. La clé "session" est manquante dans la trame.'
      };
    }
    // Check for recommended fields: uid and (isDemo or currentUrl)
    const hasUid = 'uid' in payload;
    const hasDemo = 'isDemo' in payload || ('currentUrl' in payload && payload.currentUrl.includes('demo'));
    if (!hasUid || !hasDemo) {
      return {
        status: 'partial',
        message: 'Le format de trame ne correspond pas entièrement au format recommandé (les clés "uid" et "isDemo" sont manquantes).'
      };
    }
    return {
      status: 'valid',
      message: 'Format WS valide — Connexion optimale'
    };
  } catch (e) {
    return { status: 'invalid', message: 'Erreur de lecture de la trame d\'authentification.' };
  }
}
