/**
 * SSID Validation & Normalization for Pocket Option WebSocket Auth
 *
 * Handles ALL common copy-paste issues that break SSID validation:
 * - Invisible characters (BOM, zero-width spaces, non-breaking spaces, etc.)
 * - Smart/curly quotes from word processors
 * - Newlines, carriage returns, tabs
 * - Doubled prefix from accidental double-copy
 * - Extra whitespace around the frame
 * - Mixed quote styles
 */

/**
 * Strip ALL invisible and problematic characters from a pasted SSID string.
 * This is the #1 cause of "invalid SSID" errors — browsers and DevTools
 * inject invisible characters when you copy text.
 */
function deepCleanSSID(raw: string): string {
  let cleaned = raw;

  // 1. Remove BOM (Byte Order Mark) — common when copying from Chrome DevTools
  cleaned = cleaned.replace(/^\uFEFF/, '');

  // 2. Remove ALL zero-width and invisible Unicode characters
  // Zero-width space, zero-width non-joiner, zero-width joiner,
  // word joiner, zero-width no-break space, left-to-right mark,
  // right-to-left mark, left-to-right embedding, etc.
  cleaned = cleaned.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u200E\u200F\u202A-\u202E\u00AD]/g, '');

  // 3. Replace smart/curly quotes with straight quotes
  // This happens when users copy from chat apps, email, or rich text editors
  cleaned = cleaned.replace(/[\u201C\u201D]/g, '"');  // " " → "
  cleaned = cleaned.replace(/[\u2018\u2019]/g, "'");  // ' ' → '

  // 4. Replace non-breaking spaces with regular spaces
  cleaned = cleaned.replace(/\u00A0/g, ' ');

  // 5. Remove all newlines, carriage returns, and tabs inside the frame
  // DevTools sometimes wraps long frames across multiple lines
  cleaned = cleaned.replace(/[\r\n\t]+/g, '');

  // 6. Remove any trailing/leading whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Normalize an SSID string by fixing common copy-paste errors.
 * - Deep-cleans invisible characters
 * - Strips doubled prefix: 42["auth",42["auth",{...}] → 42["auth",{...}]
 * - Handles extra whitespace between tokens
 * - Ensures proper bracket structure
 */
function normalizeSSID(ssid: string): string {
  // Step 1: Deep clean invisible characters
  let normalized = deepCleanSSID(ssid);

  // Step 2: Fix doubled prefix: 42["auth",42["auth",{...}]  →  42["auth",{...}]
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

  // Step 3: Handle cases where DevTools prepends the frame number
  // e.g., "4:42["auth",...]" or "42:42["auth",...]"
  const framePrefixMatch = normalized.match(/^\d+:(42\["auth")/);
  if (framePrefixMatch) {
    normalized = normalized.replace(/^\d+:/, '');
  }

  // Step 4: Handle cases where there's extra text before the actual frame
  // e.g., when the user selects too much text in DevTools
  const authStart = normalized.indexOf('42["auth"');
  if (authStart > 0) {
    normalized = normalized.substring(authStart);
  }

  return normalized;
}

export interface SSIDValidationResult {
  status: 'valid' | 'partial' | 'invalid' | 'none';
  message: string;
  normalized?: string;
  details?: {
    hasSession: boolean;
    hasUid: boolean;
    hasDemo: boolean;
    isDemoAccount: boolean;
    uid?: number;
    sessionPreview?: string;
  };
}

export function validateSSID(ssid: string): SSIDValidationResult {
  if (!ssid || !ssid.trim()) {
    return { status: 'none', message: '', normalized: '' };
  }

  const trimmed = normalizeSSID(ssid);

  // Check if the frame starts with the expected prefix
  if (!trimmed.startsWith('42["auth"')) {
    // Try to detect what the user pasted and give a helpful message
    if (trimmed.startsWith('42[')) {
      return {
        status: 'invalid',
        message: 'La trame ne semble pas être une trame d\'authentification. Elle commence par 42[ mais pas par 42["auth". Assurez-vous de copier la trame "auth" depuis l\'onglet WS.',
        normalized: trimmed
      };
    }
    if (trimmed.startsWith('40') || trimmed.startsWith('40[')) {
      return {
        status: 'invalid',
        message: 'Ceci est une trame de connexion (40), pas d\'authentification. Cherchez la trame commençant par 42["auth",...] dans l\'onglet WS.',
        normalized: trimmed
      };
    }
    if (trimmed.includes('"session"') || trimmed.includes('"uid"')) {
      return {
        status: 'invalid',
        message: 'La trame contient des données d\'authentification mais ne commence pas par 42["auth". Vérifiez que vous avez copié l\'intégralité du message depuis le début.',
        normalized: trimmed
      };
    }
    return {
      status: 'invalid',
      message: 'Le message doit commencer par 42["auth",...] (trame d\'authentification Pocket Option). Ouvrez F12 → Network → WS et copiez la trame "auth".',
      normalized: trimmed
    };
  }

  try {
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}') + 1;
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      return {
        status: 'invalid',
        message: 'Format JSON de la trame invalide. L\'accolade ouvrante ou fermante est manquante.',
        normalized: trimmed
      };
    }

    const jsonStr = trimmed.slice(jsonStart, jsonEnd);
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Try one more fix: sometimes there are escaped quotes issues
      // Replace any double-escaped quotes
      const fixedJson = jsonStr.replace(/\\"/g, '"');
      try {
        payload = JSON.parse(fixedJson);
      } catch {
        return {
          status: 'invalid',
          message: `Impossible de lire le JSON de la trame. Vérifiez que vous avez copié le message exact depuis DevTools sans modification.`,
          normalized: trimmed
        };
      }
    }

    const hasSession = 'session' in payload;
    const hasUid = 'uid' in payload;
    const hasDemo = 'isDemo' in payload || ('currentUrl' in payload && String(payload.currentUrl).includes('demo'));
    const isDemoAccount = payload.isDemo === 1 || payload.isDemo === true ||
      ('currentUrl' in payload && String(payload.currentUrl).includes('demo'));

    if (!hasSession) {
      return {
        status: 'invalid',
        message: 'Format non supporté. La clé "session" est manquante dans la trame. Assurez-vous de copier la trame d\'authentification complète.',
        normalized: trimmed,
        details: { hasSession, hasUid, hasDemo, isDemoAccount }
      };
    }

    // Build details
    const details: SSIDValidationResult['details'] = {
      hasSession,
      hasUid,
      hasDemo,
      isDemoAccount,
    };
    if (hasUid && typeof payload.uid === 'number') {
      details.uid = payload.uid;
    }
    if (hasSession && typeof payload.session === 'string') {
      details.sessionPreview = payload.session.length > 20
        ? payload.session.substring(0, 20) + '...'
        : payload.session;
    }

    if (!hasUid || !hasDemo) {
      return {
        status: 'partial',
        message: `Format détecté mais incomplet (clés manquantes: ${[
          !hasUid && '"uid"',
          !hasDemo && '"isDemo"'
        ].filter(Boolean).join(', ')}). La connexion peut échouer si ces champs sont requis.`,
        normalized: trimmed,
        details
      };
    }

    const modeLabel = isDemoAccount ? 'COMPTE DÉMO' : 'COMPTE RÉEL';
    return {
      status: 'valid',
      message: `Format WS valide — ${modeLabel} (uid: ${payload.uid}) — Le SSID reste actif tant que vous ne déconnectez pas votre compte Pocket Option`,
      normalized: trimmed,
      details
    };
  } catch (e) {
    return {
      status: 'invalid',
      message: 'Erreur de lecture de la trame d\'authentification. Essayez de copier à nouveau depuis DevTools (F12 → Network → WS).',
      normalized: trimmed
    };
  }
}
