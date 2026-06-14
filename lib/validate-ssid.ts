/**
 * Normalize an SSID string by fixing common copy-paste errors.
 * - Strips doubled prefix: 42["auth",42["auth",{...}] → 42["auth",{...}]
 * - Ensures proper bracket structure
 */
function normalizeSSID(ssid: string): string {
  let normalized = ssid.trim();

  // Fix doubled prefix: 42["auth",42["auth",{...}]  →  42["auth",{...}]
  // This happens when users accidentally copy the WS frame label twice
  const doubledPattern = '42["auth",42["auth",';
  if (normalized.includes(doubledPattern)) {
    normalized = normalized.replace(doubledPattern, '42["auth",');
  }

  // Also handle: 42["auth", 42["auth",{  (with space)
  const doubledPatternSpace = '42["auth", 42["auth",';
  if (normalized.includes(doubledPatternSpace)) {
    normalized = normalized.replace(doubledPatternSpace, '42["auth",');
  }

  return normalized;
}

export function validateSSID(ssid: string): { status: 'valid' | 'partial' | 'invalid' | 'none', message: string; normalized?: string } {
  if (!ssid) return { status: 'none', message: '', normalized: '' };
  const trimmed = normalizeSSID(ssid);
  if (!trimmed.startsWith('42["auth"')) {
    return {
      status: 'invalid',
      message: 'Le message doit commencer par 42["auth",...] (trame d\'authentification Pocket Option).',
      normalized: trimmed
    };
  }
  try {
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}') + 1;
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      return { status: 'invalid', message: 'Format JSON de la trame invalide.', normalized: trimmed };
    }
    const payload = JSON.parse(trimmed.slice(jsonStart, jsonEnd));
    if (!payload.session) {
      return {
        status: 'invalid',
        message: 'Format non supporté. La clé "session" est manquante dans la trame.',
        normalized: trimmed
      };
    }
    // Check for recommended fields: uid and (isDemo or currentUrl)
    const hasUid = 'uid' in payload;
    const hasDemo = 'isDemo' in payload || ('currentUrl' in payload && payload.currentUrl.includes('demo'));
    if (!hasUid || !hasDemo) {
      return {
        status: 'partial',
        message: 'Le format de trame ne correspond pas entièrement au format recommandé (les clés "uid" et "isDemo" sont manquantes).',
        normalized: trimmed
      };
    }
    return {
      status: 'valid',
      message: 'Format WS valide — Connexion optimale',
      normalized: trimmed
    };
  } catch (e) {
    return { status: 'invalid', message: 'Erreur de lecture de la trame d\'authentification.', normalized: trimmed };
  }
}
