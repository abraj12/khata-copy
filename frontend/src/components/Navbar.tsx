import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../features/auth/AuthProvider.js';
import {
  Store,
  LogOut,
  BookOpen,
  Tag,
  Palette,
  Loader2,
  AlertCircle,
  FileText,
  ChevronDown,
} from 'lucide-react';

export type NavTab = 'khata' | 'products' | 'quotations' | 'gst-bill' | 'normal-bill';

interface NavbarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onOpenAppearance: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onTabChange, onOpenAppearance }) => {
  const { logout, owner } = useAuth();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isBillMenuOpen, setIsBillMenuOpen] = useState(false);
  const billMenuRef = useRef<HTMLDivElement>(null);

  // Close bill dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (billMenuRef.current && !billMenuRef.current.contains(e.target as Node)) {
        setIsBillMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
    } catch (err) {
      setLogoutError((err as Error).message || 'Logout could not be confirmed.');
    } finally {
      setIsLoggingOut(false);
    }
  };

  const isBillActive = currentTab === 'gst-bill' || currentTab === 'normal-bill';

  return (
    <header
      className="sticky top-0 z-30 border-b border-[var(--khata-border)] shadow-sm"
      style={{ background: 'var(--khata-surface)' }}
    >
      {/* Logout error banner with retry option */}
      {logoutError && (
        <div className="bg-rose-500/10 border-b border-rose-500/20 px-4 py-2 flex items-center justify-between text-xs text-rose-500">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{logoutError}</span>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="underline hover:no-underline font-semibold ml-2 focus:outline-none"
          >
            Retry
          </button>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between min-h-[64px] sm:h-16 py-2 sm:py-0 gap-y-2">
          {/* Brand Identity / Store Badge */}
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shadow-inner border border-[var(--khata-border)]"
              style={{ background: 'var(--khata-surface-inset)' }}
              aria-hidden="true"
            >
              <Store className="w-5 h-5 text-[var(--khata-accent)]" />
            </div>
            <div>
              <h1 className="text-sm sm:text-base md:text-lg font-black tracking-tight text-[var(--khata-text)] leading-none">
                Khata
              </h1>
              <p className="text-[10px] sm:text-[11px] text-[var(--khata-text-muted)] font-medium mt-0.5">
                Algions AI Labs Private Limited
              </p>
            </div>
          </div>

          {/* Navigation Tabs (Khata, Products, Bill -> GST Bill / Normal Bill) */}
          <nav
            className="flex items-center gap-1.5 sm:gap-2 order-3 sm:order-2 w-full sm:w-auto justify-center sm:justify-start pt-1 sm:pt-0"
            aria-label="Main Navigation"
          >
            {/* 1. Khata Tab */}
            <button
              onClick={() => {
                setIsBillMenuOpen(false);
                onTabChange('khata');
              }}
              className={`inline-flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[42px] sm:min-h-[44px] flex-1 sm:flex-initial ${
                currentTab === 'khata'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'khata' ? 'page' : undefined}
            >
              <BookOpen className="w-4 h-4" />
              <span>Khata</span>
            </button>

            {/* 2. Products Tab */}
            <button
              onClick={() => {
                setIsBillMenuOpen(false);
                onTabChange('products');
              }}
              className={`inline-flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[42px] sm:min-h-[44px] flex-1 sm:flex-initial ${
                currentTab === 'products'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'products' ? 'page' : undefined}
            >
              <Tag className="w-4 h-4" />
              <span>Products</span>
            </button>

                        {/* 3. Quotations Tab */}
            <button
              onClick={() => {
                setIsBillMenuOpen(false);
                onTabChange('quotations');
              }}
              className={`inline-flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[42px] sm:min-h-[44px] flex-1 sm:flex-initial ${
                currentTab === 'quotations'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'quotations' ? 'page' : undefined}
            >
              <FileText className="w-4 h-4" />
              <span>Quotations</span>
            </button>

            {/* 4. Bill Dropdown Menu (Contains GST Bill & Normal Bill) */}
            <div className="relative flex-1 sm:flex-initial" ref={billMenuRef}>
              <button
                type="button"
                onClick={() => setIsBillMenuOpen(!isBillMenuOpen)}
                className={`w-full inline-flex items-center justify-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[42px] sm:min-h-[44px] ${
                  isBillActive
                    ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                    : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
                }`}
                aria-haspopup="true"
                aria-expanded={isBillMenuOpen}
                aria-current={isBillActive ? 'page' : undefined}
              >
                <FileText className="w-4 h-4" />
                <span>Bill</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isBillMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Submenu Dropdown */}
              {isBillMenuOpen && (
                <div
                  className="absolute left-0 sm:left-auto sm:right-0 top-full mt-1.5 w-52 p-1.5 rounded-xl border border-[var(--khata-border)] shadow-xl z-50 animate-in fade-in slide-in-from-top-1"
                  style={{ background: 'var(--khata-surface)' }}
                  role="menu"
                >
                  {/* GST Bill Option */}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsBillMenuOpen(false);
                      onTabChange('gst-bill');
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-bold text-left transition ${
                      currentTab === 'gst-bill'
                        ? 'bg-[var(--khata-accent)] text-white'
                        : 'text-[var(--khata-text)] hover:bg-[var(--khata-surface-inset)] hover:text-[var(--khata-accent)]'
                    }`}
                  >
                    <FileText className="w-4 h-4" />
                    <div>
                      <div>GST Bill</div>
                      <div className="text-[10px] opacity-75 font-normal">Official Tax Invoice</div>
                    </div>
                  </button>

                  {/* Normal Bill Option */}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setIsBillMenuOpen(false);
                      onTabChange('normal-bill');
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-bold text-left transition mt-1 ${
                      currentTab === 'normal-bill'
                        ? 'bg-[var(--khata-accent)] text-white'
                        : 'text-[var(--khata-text)] hover:bg-[var(--khata-surface-inset)] hover:text-[var(--khata-accent)]'
                    }`}
                  >
                    <FileText className="w-4 h-4 text-emerald-500" />
                    <div>
                      <div>Normal Bill</div>
                      <div className="text-[10px] opacity-75 font-normal">Standard / Non-GST</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </nav>

          {/* Controls: Appearance, Owner Phone, Logout */}
          <div className="flex items-center gap-2 order-2 sm:order-3">
            {/* Persistent Appearance & Accessibility Button */}
            <button
              onClick={onOpenAppearance}
              title="Appearance & Accessibility"
              aria-label="Open Appearance & Accessibility settings"
              className="neu-btn-secondary text-xs px-2.5 sm:px-3 py-1.5 sm:py-2 flex items-center gap-1.5 min-h-[38px] sm:min-h-[44px]"
            >
              <Palette className="w-4 h-4 text-[var(--khata-accent)]" />
              <span className="hidden sm:inline">Appearance</span>
            </button>

            {/* Owner Mobile Badge */}
            <div className="hidden lg:block text-right">
              <span className="block text-[11px] font-bold text-[var(--khata-text)]">Owner</span>
              <span className="block text-[10px] text-[var(--khata-text-muted)] font-mono">
                {owner?.phone || 'Logged In'}
              </span>
            </div>

            {/* Logout Button */}
            <button
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="neu-btn-secondary text-rose-500 hover:text-rose-600 text-xs px-3 sm:px-3.5 py-1.5 sm:py-2 flex items-center gap-1.5 min-h-[38px] sm:min-h-[44px]"
              aria-label="Log out of Khata"
            >
              {isLoggingOut ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{isLoggingOut ? 'Logging out...' : 'Logout'}</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
