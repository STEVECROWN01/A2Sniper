import jsPDF from 'jspdf';

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
  headerH: 42,
  footerH: 18,
};

/**
 * Create a new jsPDF instance with A2Sniper branding ready.
 * Draws header band + footer on every page.
 */
export function createBrandedPDF(title: string, subtitle?: string): jsPDF {
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

  // "A2Sniper" branding text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(212, 175, 55);
  doc.text('A2SNIPER', PAGE.marginL + 2, 17);

  // "3.0" version tag
  doc.setFontSize(9);
  doc.setTextColor(156, 163, 175);
  doc.text('v3.0', PAGE.marginL + 50, 17);

  // Title
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(title.toUpperCase(), PAGE.marginL + 2, 30);

  // Subtitle
  if (subtitle) {
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(subtitle, PAGE.marginL + 2, 37);
  }

  // Export date on right
  doc.setFontSize(7);
  doc.setTextColor(156, 163, 175);
  const dateStr = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  doc.text(`Export: ${dateStr}`, PAGE.width - PAGE.marginR, 17, { align: 'right' });

  // ── Footer function (called per page) ──
  const drawFooter = () => {
    const pageH = doc.internal.pageSize.getHeight();
    // Gold line
    doc.setDrawColor(212, 175, 55);
    doc.setLineWidth(0.3);
    doc.line(PAGE.marginL, pageH - PAGE.footerH, PAGE.width - PAGE.marginR, pageH - PAGE.footerH);

    doc.setFontSize(6.5);
    doc.setTextColor(156, 163, 175);
    doc.text('A2Sniper 3.0 — Rapport confidentiel', PAGE.marginL, pageH - 8);
    doc.text(`Page ${doc.getCurrentPageInfo().pageNumber}`, PAGE.width - PAGE.marginR, pageH - 8, { align: 'right' });
  };

  drawFooter();

  // Store footer drawer for subsequent pages
  (doc as any)._drawFooter = drawFooter;

  return doc;
}

/**
 * Add a new page with header + footer branding.
 */
export function addBrandedPage(doc: jsPDF, title?: string): void {
  doc.addPage();

  // Re-draw header
  doc.setFillColor(10, 11, 14);
  doc.rect(0, 0, PAGE.width, PAGE.headerH, 'F');

  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.8);
  doc.line(0, PAGE.headerH, PAGE.width, PAGE.headerH);

  doc.setFillColor(212, 175, 55);
  doc.rect(0, 0, 3, PAGE.headerH, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(212, 175, 55);
  doc.text('A2SNIPER', PAGE.marginL + 2, 17);

  if (title) {
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text(title.toUpperCase(), PAGE.marginL + 2, 30);
  }

  // Draw footer
  const drawFooter = (doc as any)._drawFooter;
  if (drawFooter) drawFooter();
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
  const totalW = headers.reduce((sum, h) => sum + h.width, 0);

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
  headers.forEach(h => {
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
      const h = headers[cellIdx];
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
  doc.text(`${label}:`, x, y);

  doc.setFont('helvetica', 'bold');
  const rgb = hexToRgb(options?.valueColor || BRAND.gray900);
  doc.setTextColor(rgb.r, rgb.g, rgb.b);
  doc.text(value, x + 45, y);

  return y + 5.5;
}

/**
 * Draw a risk level badge.
 */
export function drawRiskBadge(
  doc: jsPDF,
  x: number, y: number,
  level: string
): number {
  const levelMap: Record<string, { color: string; label: string }> = {
    'Low': { color: BRAND.green, label: 'FAIBLE' },
    'Medium': { color: BRAND.orange, label: 'MOYEN' },
    'High': { color: BRAND.red, label: 'ELEVE' },
    'Critical': { color: '#DC2626', label: 'CRITIQUE' },
  };
  const info = levelMap[level] || levelMap['Medium'];
  const rgb = hexToRgb(info.color);

  // Badge background
  doc.setFillColor(rgb.r, rgb.g, rgb.b);
  doc.roundedRect(x, y - 3, 28, 6, 1, 1, 'F');

  // Badge text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(255, 255, 255);
  doc.text(info.label, x + 14, y + 0.5, { align: 'center' });

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
 * Save the PDF with a branded filename.
 */
export function savePDF(doc: jsPDF, filename: string): void {
  doc.save(filename);
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
