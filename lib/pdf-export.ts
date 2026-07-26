import jsPDF from 'jspdf';
import { A2SNIPER_LOGO_BASE64 } from './pdf-logo';

// ── A2Sniper Brand Colors ──
const BRAND = {
  gold: '#D4AF37',
  goldLight: '#E8D48B',
  darkBg: '#0A0B0E',
  darkCard: '#121216',
  darkBorder: '#1E1E24',
  white: '#FFFFFF',
  gray100: '#F3F4F6',
  gray200: '#E5E7EB',
  gray400: '#9CA3AF',
  gray500: '#6B7280',
  gray600: '#4B5563',
  gray800: '#1F2937',
  gray900: '#111827',
  green: '#22C55E',
  red: '#EF4444',
  orange: '#F97316',
  blue: '#3B82F6',
};

// ── PDF Page Layout Constants ──
export const PAGE = {
  width: 210,   // A4
  height: 297,  // A4
  marginL: 15,
  marginR: 15,
  marginT: 12,
  contentW: 180, // 210 - 15 - 15
  headerH: 50,
  footerH: 18,
};

// ── User info interface ──
export interface PDFUserInfo {
  name?: string;
  email?: string;
  plan?: string;
  userId?: string;
  avatarUrl?: string;  // URL to user's profile picture
}

/**
 * Cache for fetched avatar base64 data to avoid re-fetching.
 * Stores the CIRCULAR-CROPPED, RESIZED version ready for PDF embedding.
 */
const avatarCache = new Map<string, string>();

/**
 * Take any image source (data URL or remote URL) and produce a
 * circular-cropped, resized PNG data URL with transparent corners.
 *
 * Why: jsPDF's clip() does not reliably clip raster images across all
 * PDF viewers (often renders as a square). By pre-cropping on a canvas:
 *   - The image is genuinely circular (canvas does the clipping)
 *   - The PNG has transparent corners, so jsPDF just embeds a normal image
 *   - The result is a clean circle in every PDF viewer
 *   - We also resize to max 256x256 to keep PDF file size small
 *     (a 5MB phone photo becomes a ~20KB transparent PNG)
 *
 * Returns null if the image cannot be loaded/processed.
 */
async function circularizeAndResizeAvatar(src: string, size = 256): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const safeResolve = (val: string | null) => {
      if (!settled) { settled = true; resolve(val); }
    };

    // Safety timeout: if the image doesn't load in 5s, give up and return null
    // so the PDF export can proceed with the fallback letter avatar instead of
    // hanging forever (which would leave the user staring at a spinner).
    const timeoutId = setTimeout(() => {
      safeResolve(null);
    }, 5000);

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        clearTimeout(timeoutId);
        try {
          // Square center-crop: take the smaller dimension
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;

          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            safeResolve(null);
            return;
          }

          // Transparent background
          ctx.clearRect(0, 0, size, size);

          // Circular clip
          ctx.beginPath();
          ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();

          // Draw the image filling the circle
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

          // Export as PNG (preserves transparency for the corners)
          const dataUrl = canvas.toDataURL('image/png');
          safeResolve(dataUrl);
        } catch {
          safeResolve(null);
        }
      };
      img.onerror = () => {
        clearTimeout(timeoutId);
        safeResolve(null);
      };
      img.src = src;
    } catch {
      clearTimeout(timeoutId);
      safeResolve(null);
    }
  });
}

/**
 * Fetch a user avatar URL, circular-crop + resize it on a canvas, and cache
 * the result. Returns a PNG data URL with transparent corners ready for
 * jsPDF embedding (no further clipping needed).
 *
 * Returns null if the avatar cannot be loaded or processed.
 */
export async function fetchAvatarBase64(url: string): Promise<string | null> {
  if (avatarCache.has(url)) return avatarCache.get(url)!;
  try {
    // For data: URLs (which is what we store in the DB), we can pass directly
    // to circularizeAndResizeAvatar without fetching first.
    let imageSrc: string;
    if (url.startsWith('data:')) {
      imageSrc = url;
    } else {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      imageSrc = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    const circular = await circularizeAndResizeAvatar(imageSrc, 256);
    if (circular) avatarCache.set(url, circular);
    return circular;
  } catch {
    return null;
  }
}

/**
 * Draw the A2Sniper logo in the header band.
 * The logo is placed on the right side of the header, inside a gold-bordered circle.
 */
function drawHeaderLogo(doc: jsPDF): void {
  try {
    const logoSize = 14; // mm
    const logoX = PAGE.width - PAGE.marginR - logoSize - 2;
    const logoY = 5;
    const cx = logoX + logoSize / 2;
    const cy = logoY + logoSize / 2;
    const radius = logoSize / 2;

    // Save graphics state
    doc.saveGraphicsState();

    // Clip to circle
    doc.circle(cx, cy, radius);
    doc.clip();

    // White circle background behind logo (for contrast on dark header)
    doc.setFillColor(255, 255, 255);
    doc.circle(cx, cy, radius, 'F');

    // Add logo image filling the full circle area
    doc.addImage(A2SNIPER_LOGO_BASE64, 'JPEG', logoX, logoY, logoSize, logoSize);

    // Restore graphics state (removes clipping)
    doc.restoreGraphicsState();

    // Gold border around circle (drawn after restoring, so it's not clipped)
    doc.setDrawColor(212, 175, 55);
    doc.setLineWidth(0.5);
    doc.circle(cx, cy, radius + 0.3, 'S');
  } catch {
    // If logo fails, just skip it - text branding is still there
  }
}

/**
 * Draw user avatar image in the header (next to user info) or in the user info card.
 *
 * The cached avatarBase64 is ALREADY a circular-cropped PNG with transparent
 * corners (pre-processed by circularizeAndResizeAvatar). So we just embed it
 * directly — no jsPDF clip() needed (which is unreliable for raster images
 * across PDF viewers and was causing the avatar to render as a square).
 *
 * A gold border circle is drawn on top for branding.
 */
function drawUserAvatar(doc: jsPDF, x: number, y: number, size: number, avatarBase64: string): void {
  try {
    const cx = x + size / 2;
    const cy = y + size / 2;
    const radius = size / 2;

    // White circle background (in case the PNG has transparency issues)
    doc.setFillColor(255, 255, 255);
    doc.circle(cx, cy, radius, 'F');

    // Embed the pre-circularized PNG — no clip() needed
    // Use 'PNG' format because circularizeAndResizeAvatar exports PNG
    // (preserves transparency for the corners)
    doc.addImage(avatarBase64, 'PNG', x, y, size, size);

    // Gold border on top of the image
    doc.setDrawColor(212, 175, 55);
    doc.setLineWidth(0.5);
    doc.circle(cx, cy, radius + 0.3, 'S');
  } catch {
    // If avatar fails, fall back to initial letter
    drawUserAvatarFallback(doc, x, y, size, 'U');
  }
}

/**
 * Fallback: draw user initial in a gold-bordered circle when avatar is unavailable.
 */
function drawUserAvatarFallback(doc: jsPDF, x: number, y: number, size: number, initial: string): void {
  // Light gray circle
  doc.setFillColor(243, 244, 246);
  doc.circle(x + size / 2, y + size / 2, size / 2, 'F');

  // Gold border
  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.4);
  doc.circle(x + size / 2, y + size / 2, size / 2, 'S');

  // Initial letter
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(size * 2.5);
  doc.setTextColor(212, 175, 55);
  doc.text(initial.toUpperCase(), x + size / 2, y + size / 2 + size * 0.35, { align: 'center' });
}

/**
 * Create a new jsPDF instance with A2Sniper branding ready.
 * Draws header band with branding + footer on every page.
 * Includes user personalization if user info is provided.
 */
export function createBrandedPDF(title: string, subtitle?: string, user?: PDFUserInfo): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // ── Header band ──
  // Dark background band
  doc.setFillColor(10, 11, 14); // #0A0B0E
  doc.rect(0, 0, PAGE.width, PAGE.headerH, 'F');

  // Gold accent line at bottom of header
  doc.setDrawColor(212, 175, 55); // #D4AF37
  doc.setLineWidth(0.8);
  doc.line(0, PAGE.headerH, PAGE.width, PAGE.headerH);

  // Gold left accent stripe
  doc.setFillColor(212, 175, 55);
  doc.rect(0, 0, 3, PAGE.headerH, 'F');

  // A2Sniper Logo in header (right side)
  drawHeaderLogo(doc);

  // "A2Sniper" branding text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(212, 175, 55);
  doc.text('A2SNIPER', PAGE.marginL + 2, 14);

  // "v3.0" version tag — placed well to the right of "A2SNIPER" so it doesn't overlap.
  // "A2SNIPER" at 18pt bold is ~38mm wide; v3.0 starts at +42mm to leave clear space.
  doc.setFontSize(9);
  doc.setTextColor(156, 163, 175);
  doc.text('v3.0', PAGE.marginL + 42, 14);

  // Title
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(title.toUpperCase(), PAGE.marginL + 2, 24);

  // Subtitle
  if (subtitle) {
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(subtitle, PAGE.marginL + 2, 30);
  }

  // Export date on right — placed BELOW the logo with proper spacing.
  // Logo spans y=5 to y=19 (14mm tall). Date baseline at y=24 gives a 5mm
  // gap below the logo, and aligns horizontally with the title on the left.
  doc.setFontSize(7);
  doc.setTextColor(156, 163, 175);
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  doc.text(`Export: ${dateStr}`, PAGE.width - PAGE.marginR - 4, 24, { align: 'right' });

  // NOTE: User profile (avatar + name + email + plan badge) was previously
  // rendered in the header band. Removed per user request — the user info
  // card below the header already shows this info. Header now contains only:
  //   Left:  A2SNIPER v3.0 + title + subtitle
  //   Right: A2Sniper logo (in circle) + export date
  // This keeps the header clean and consistent across all pages.

  // ── Footer function (called per page) ──
  const drawFooter = () => {
    const pageH = doc.internal.pageSize.getHeight();
    // Gold line
    doc.setDrawColor(212, 175, 55);
    doc.setLineWidth(0.3);
    doc.line(PAGE.marginL, pageH - PAGE.footerH, PAGE.width - PAGE.marginR, pageH - PAGE.footerH);

    doc.setFontSize(6.5);
    doc.setTextColor(156, 163, 175);
    const footerText = user?.name
      ? `A2Sniper 3.0 — Rapport confidentiel pour ${user.name}`
      : 'A2Sniper 3.0 — Rapport confidentiel';
    doc.text(footerText, PAGE.marginL, pageH - 10);
    doc.text(`Page ${doc.getCurrentPageInfo().pageNumber}`, PAGE.width - PAGE.marginR, pageH - 10, { align: 'right' });
  };

  drawFooter();

  // Store footer drawer + title/subtitle for subsequent pages so
  // addBrandedPage can reproduce the exact same header.
  (doc as any)._drawFooter = drawFooter;
  (doc as any)._pdfTitle = title;
  (doc as any)._pdfSubtitle = subtitle;

  return doc;
}

/**
 * Add a new page with header + footer branding.
 * Header matches the first page header exactly: A2SNIPER v3.0 + title + subtitle
 * on the left, logo + export date on the right.
 */
export function addBrandedPage(doc: jsPDF, title?: string, subtitle?: string): void {
  doc.addPage();

  // Fall back to stored title/subtitle from createBrandedPDF so continued
  // pages match the first page header exactly.
  const effectiveTitle = title ?? (doc as any)._pdfTitle;
  const effectiveSubtitle = subtitle ?? (doc as any)._pdfSubtitle;

  // Re-draw header band (same as first page)
  doc.setFillColor(10, 11, 14);
  doc.rect(0, 0, PAGE.width, PAGE.headerH, 'F');

  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.8);
  doc.line(0, PAGE.headerH, PAGE.width, PAGE.headerH);

  doc.setFillColor(212, 175, 55);
  doc.rect(0, 0, 3, PAGE.headerH, 'F');

  // Logo in continued page header (right side, same as first page)
  drawHeaderLogo(doc);

  // "A2Sniper" branding text — same position/size as first page
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(212, 175, 55);
  doc.text('A2SNIPER', PAGE.marginL + 2, 14);

  // "v3.0" version tag — same offset as first page (no overlap)
  doc.setFontSize(9);
  doc.setTextColor(156, 163, 175);
  doc.text('v3.0', PAGE.marginL + 42, 14);

  // Title — same position/size as first page
  if (effectiveTitle) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(255, 255, 255);
    doc.text(effectiveTitle.toUpperCase(), PAGE.marginL + 2, 24);
  }

  // Subtitle — same position/size as first page
  if (effectiveSubtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(effectiveSubtitle, PAGE.marginL + 2, 30);
  }

  // Export date on right — same as first page (below the logo)
  doc.setFontSize(7);
  doc.setTextColor(156, 163, 175);
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  doc.text(`Export: ${dateStr}`, PAGE.width - PAGE.marginR - 4, 24, { align: 'right' });

  // Draw footer
  const drawFooter = (doc as any)._drawFooter;
  if (drawFooter) drawFooter();
}

/**
 * Draw a user info card at the top of the document.
 * Shows user avatar (if available), name, email, plan, and user ID.
 * Falls back to initial letter if no avatar is loaded.
 */
export function drawUserInfoCard(
  doc: jsPDF,
  y: number,
  user: PDFUserInfo
): number {
  if (!user.name && !user.email) return y;

  const cardH = 24;

  // Card background
  doc.setFillColor(249, 250, 251); // gray-50
  doc.roundedRect(PAGE.marginL, y, PAGE.contentW, cardH, 2, 2, 'F');

  // Gold left accent bar
  doc.setFillColor(212, 175, 55);
  doc.rect(PAGE.marginL, y, 2, cardH, 'F');

  // Avatar area
  const avatarSize = 14;
  const avatarX = PAGE.marginL + 6;
  const avatarY = y + (cardH - avatarSize) / 2;

  // Check for cached avatar
  if (user.avatarUrl) {
    const cachedAvatar = avatarCache.get(user.avatarUrl);
    if (cachedAvatar) {
      drawUserAvatar(doc, avatarX, avatarY, avatarSize, cachedAvatar);
    } else {
      drawUserAvatarFallback(doc, avatarX, avatarY, avatarSize, (user.name || user.email || 'U').charAt(0));
    }
  } else {
    drawUserAvatarFallback(doc, avatarX, avatarY, avatarSize, (user.name || user.email || 'U').charAt(0));
  }

  // Name + Email — vertically centered as a group in the card
  const textX = avatarX + avatarSize + 4;
  // Name baseline at card vertical center - 1, email baseline at +3 → centered pair
  const centerY = y + cardH / 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(31, 41, 55);
  doc.text(user.name || user.email?.split('@')[0] || 'Utilisateur', textX, centerY - 1);

  // Email
  if (user.email) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(107, 114, 128);
    doc.text(user.email, textX, centerY + 3);
  }

  // Plan badge on the right — with "Account Plan" label above it
  if (user.plan) {
    const planLabel = user.plan.charAt(0).toUpperCase() + user.plan.slice(1).toLowerCase();
    const planWidth = doc.getTextWidth(planLabel) + 8;

    // "Account Plan" label above the badge (small gray uppercase text)
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5.5);
    doc.setTextColor(107, 114, 128);
    doc.text('ACCOUNT PLAN', PAGE.width - PAGE.marginR - 4, centerY - 5, { align: 'right' });

    const planRgb = hexToRgb(BRAND.gold);
    doc.setFillColor(planRgb.r, planRgb.g, planRgb.b);
    // Badge positioned just below the label
    const badgeY = centerY - 2;
    doc.roundedRect(PAGE.width - PAGE.marginR - planWidth - 4, badgeY, planWidth, 6, 1, 1, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(10, 11, 14);
    doc.text(planLabel, PAGE.width - PAGE.marginR - planWidth / 2 - 4, badgeY + 4, { align: 'center' });
  }

  // (Removed) User ID text — was floating awkwardly at the bottom of the card
  // in a tiny 5.5pt gray font, looking like garbled text. The plan badge above
  // and the name/email on the left are sufficient for identification.

  // Divider line
  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.15);
  doc.line(PAGE.marginL, y + cardH, PAGE.marginL + PAGE.contentW, y + cardH);

  return y + cardH + 4;
}

/**
 * Draw a section title with gold left accent.
 */
export function drawSectionTitle(doc: jsPDF, text: string, y: number): number {
  // Gold left bar
  doc.setFillColor(212, 175, 55);
  doc.rect(PAGE.marginL, y, 2, 6, 'F');

  // Title text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(31, 41, 55); // dark text on white
  doc.text(text.toUpperCase(), PAGE.marginL + 6, y + 4.5);

  // Underline
  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.3);
  doc.line(PAGE.marginL, y + 8, PAGE.marginL + PAGE.contentW, y + 8);

  return y + 12;
}

/**
 * Draw a stat card (key-value pair with optional color).
 */
export function drawStatCard(
  doc: jsPDF,
  x: number, y: number, w: number,
  label: string, value: string,
  options?: { valueColor?: string; bgColor?: string }
): number {
  const h = 18;

  // Card background
  doc.setFillColor(249, 250, 251); // gray-50
  doc.roundedRect(x, y, w, h, 2, 2, 'F');

  // Left accent
  const accentColor = options?.valueColor || BRAND.gold;
  const rgb = hexToRgb(accentColor);
  doc.setFillColor(rgb.r, rgb.g, rgb.b);
  doc.rect(x, y, 1.5, h, 'F');

  // Label
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(107, 114, 128); // gray-500
  doc.text(label.toUpperCase(), x + 4, y + 6);

  // Value
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(rgb.r, rgb.g, rgb.b);
  doc.text(value, x + 4, y + 13.5);

  return y + h + 3;
}

/**
 * Draw a professional data table.
 */
export function drawTable(
  doc: jsPDF,
  x: number, y: number,
  headers: { label: string; width: number; align?: 'left' | 'center' | 'right' }[],
  rows: string[][],
  options?: { headerBg?: string; alternateRows?: boolean }
): number {
  const rowH = 7;
  const headerH = 8;
  // Scale column widths to fill the full content width (no empty space on right)
  const rawTotal = headers.reduce((sum, h) => sum + h.width, 0);
  const targetWidth = PAGE.contentW;
  const scale = targetWidth / rawTotal;
  const scaledHeaders = headers.map(h => ({ ...h, width: h.width * scale }));
  const totalW = targetWidth;

  // Header background
  const hRgb = hexToRgb(options?.headerBg || BRAND.darkBg);
  doc.setFillColor(hRgb.r, hRgb.g, hRgb.b);
  doc.rect(x, y, totalW, headerH, 'F');

  // Gold line under header
  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.4);
  doc.line(x, y + headerH, x + totalW, y + headerH);

  // Header text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(255, 255, 255);
  let colX = x;
  scaledHeaders.forEach(h => {
    const align = h.align || 'left';
    const textX = align === 'right' ? colX + h.width - 2 : align === 'center' ? colX + h.width / 2 : colX + 2;
    doc.text(h.label.toUpperCase(), textX, y + 5.5, { align: align === 'center' ? 'center' : align === 'right' ? 'right' : 'left' });
    colX += h.width;
  });

  let currentY = y + headerH;

  // Data rows
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  rows.forEach((row, rowIdx) => {
    // Alternate row bg
    if (options?.alternateRows !== false && rowIdx % 2 === 0) {
      doc.setFillColor(249, 250, 251);
      doc.rect(x, currentY, totalW, rowH, 'F');
    }

    colX = x;
    doc.setTextColor(31, 41, 55);
    row.forEach((cell, cellIdx) => {
      const h = scaledHeaders[cellIdx];
      const align = h.align || 'left';
      const textX = align === 'right' ? colX + h.width - 2 : align === 'center' ? colX + h.width / 2 : colX + 2;

      // Color code WIN/LOSS/positive/negative
      if (cell === 'WIN' || cell.startsWith('+')) {
        doc.setTextColor(34, 197, 94);
        doc.setFont('helvetica', 'bold');
      } else if (cell === 'LOSS' || cell.startsWith('-')) {
        doc.setTextColor(239, 68, 68);
        doc.setFont('helvetica', 'bold');
      } else {
        doc.setTextColor(31, 41, 55);
        doc.setFont('helvetica', 'normal');
      }

      doc.text(cell, textX, currentY + 5, { align: align === 'center' ? 'center' : align === 'right' ? 'right' : 'left' });
      colX += h.width;
    });
    currentY += rowH;

    // Page break check
    if (currentY > PAGE.height - PAGE.footerH - 10) {
      addBrandedPage(doc);
      currentY = PAGE.headerH + PAGE.marginT;
    }
  });

  // Bottom border
  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.2);
  doc.line(x, currentY, x + totalW, currentY);

  return currentY + 4;
}

/**
 * Draw a key-value info row.
 */
export function drawInfoRow(
  doc: jsPDF,
  x: number, y: number,
  label: string, value: string,
  options?: { valueColor?: string }
): number {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  // When value is empty (e.g. "Risk Level" / "Niveau de Risque" rows where a
  // badge is drawn separately as the value), skip the trailing colon so the
  // label doesn't end with a dangling ":". The badge acts as the value.
  if (value) {
    doc.text(`${label}:`, x, y);
  } else {
    doc.text(label, x, y);
  }

  if (value) {
    doc.setFont('helvetica', 'bold');
    const rgb = hexToRgb(options?.valueColor || BRAND.gray900);
    doc.setTextColor(rgb.r, rgb.g, rgb.b);
    doc.text(value, x + 45, y);
  }

  return y + 5.5;
}

/**
 * Draw a risk level badge.
 * The badge is vertically centered on the text baseline `y` so it aligns
 * properly with label text drawn by drawInfoRow at the same `y` coordinate.
 * Callers should pass the SAME `y` they pass to drawInfoRow (not y-1).
 */
export function drawRiskBadge(
  doc: jsPDF,
  x: number, y: number,
  level: string
): number {
  const levelMap: Record<string, { color: string; label: string }> = {
    'Low': { color: BRAND.green, label: 'FAIBLE' },
    'Medium': { color: BRAND.orange, label: 'MEDIUM' },
    'High': { color: BRAND.red, label: 'ELEVE' },
    'Critical': { color: '#DC2626', label: 'CRITIQUE' },
  };
  const info = levelMap[level] || levelMap['Medium'];
  const rgb = hexToRgb(info.color);

  // Badge dimensions
  const badgeH = 6;
  const badgeW = 28;
  // Vertically center the badge on the label text baseline `y`.
  // For font-8 text (drawInfoRow), the visual center is ~1mm above the baseline.
  // So the badge rectangle center should be at y - 1, meaning badge top = (y - 1) - badgeH/2.
  const badgeCenterY = y - 1;
  const badgeTopY = badgeCenterY - badgeH / 2;

  // Badge background
  doc.setFillColor(rgb.r, rgb.g, rgb.b);
  doc.roundedRect(x, badgeTopY, badgeW, badgeH, 1.5, 1.5, 'F');

  // Badge text — vertically centered within the badge rectangle.
  // For font-7 text, the visual center is ~1mm above the baseline, so to
  // center the text in a rectangle whose center is at badgeCenterY, the
  // text baseline should be at badgeCenterY + 1.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(255, 255, 255);
  doc.text(info.label, x + badgeW / 2, badgeCenterY + 1, { align: 'center' });

  return y + 6;
}

/**
 * Check if we need a page break, and add one if so.
 */
export function checkPageBreak(doc: jsPDF, y: number, neededSpace: number = 20): number {
  if (y + neededSpace > PAGE.height - PAGE.footerH - 10) {
    addBrandedPage(doc);
    return PAGE.headerH + PAGE.marginT;
  }
  return y;
}

/**
 * Save the PDF with a branded filename that includes the user name.
 */
export function savePDF(doc: jsPDF, filename: string, user?: PDFUserInfo): void {
  if (user?.name) {
    // Insert user name into filename for personalization
    const sanitized = user.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const parts = filename.replace('.pdf', '');
    doc.save(`${parts}-${sanitized}.pdf`);
  } else {
    doc.save(filename);
  }
}

// ── Helper ──
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}
