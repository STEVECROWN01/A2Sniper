"""
FOREX pair filter — restrict the system to FOREX currency pairs only.

A symbol is FOREX if: after stripping _otc/#/spaces/slashes, it's exactly
6 uppercase letters where both halves (3+3) are valid ISO 4217 currency codes.
"""

import logging
from typing import Set

logger = logging.getLogger(__name__)

ISO_4217_CURRENCIES: Set[str] = {
    'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD',
    'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AWG', 'AZN',
    'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
    'CDF', 'CLP', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK',
    'DJF', 'DKK', 'DOP', 'DZD',
    'EGP', 'ERN', 'ETB',
    'FJD',
    'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
    'HKD', 'HNL', 'HRK', 'HTG', 'HUF',
    'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
    'JMD', 'JOD',
    'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
    'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
    'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN',
    'NAD', 'NGN', 'NIO', 'NOK', 'NPR',
    'OMR',
    'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
    'QAR',
    'RON', 'RSD', 'RUB', 'RWF',
    'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
    'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
    'UAH', 'UGX', 'UYU', 'UZS',
    'VES', 'VND', 'VUV',
    'WST',
    'XAF', 'XCD', 'XOF', 'XPF',
    'YER',
    'ZAR', 'ZMW',
}


def is_forex_pair(symbol: str) -> bool:
    if not symbol or not isinstance(symbol, str):
        return False
    s = symbol.strip()
    if not s:
        return False
    if s.startswith('#'):
        s = s[1:]
    s = s.replace('_otc', '').replace('_OTC', '').replace(' OTC', '').replace('/', '')
    if len(s) != 6:
        return False
    if not s.isalpha() or not s.isupper():
        return False
    return s[:3] in ISO_4217_CURRENCIES and s[3:] in ISO_4217_CURRENCIES
