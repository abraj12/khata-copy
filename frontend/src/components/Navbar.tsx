import React from 'react';
import { useAuth } from '../features/auth/AuthProvider.js';
import { Store, LogOut, BookOpen, Tag, Palette } from 'lucide-react';

interface NavbarProps {
  currentTab: 'khata' | 'products';
  onTabChange: (tab: 'khata' | 'products') => void;
  onOpenAppearance: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onTabChange, onOpenAppearance }) => {
  const { logout, owner } = useAuth();

  return (
    <header
      className="sticky top-0 z-30 border-b border-[var(--khata-border)] shadow-sm"
      style={{ background: 'var(--khata-surface)' }}
    >
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between py-2 sm:py-0 sm:h-16 gap-2">
          {/* Brand Identity */}
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center border border-[var(--khata-border)] shadow-sm flex-shrink-0"
              style={{
                background: 'var(--khata-surface-inset)',
                color: 'var(--khata-accent)',
              }}
            >
              <Store className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-sm sm:text-base md:text-lg font-black tracking-tight text-[var(--khata-text)] leading-none">
                Khata
              </h1>
              <p className="text-[10px] sm:text-[11px] text-[var(--khata-text-muted)] font-medium mt-0.5">
                Single-Shopkeeper Ledger
              </p>
            </div>
          </div>

          {/* Navigation Tabs (Products & Khata only) */}
          <nav
            className="flex items-center gap-1.5 sm:gap-2 order-3 sm:order-2 w-full sm:w-auto justify-center sm:justify-start pt-1 sm:pt-0"
            aria-label="Main Navigation"
          >
            <button
              onClick={() => onTabChange('khata')}
              className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[42px] sm:min-h-[44px] flex-1 sm:flex-initial ${
                currentTab === 'khata'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'khata' ? 'page' : undefined}
            >
              <BookOpen className="w-4 h-4" />
              <span>Khata</span>
            </button>

            <button
              onClick={() => onTabChange('products')}
              className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[42px] sm:min-h-[44px] flex-1 sm:flex-initial ${
                currentTab === 'products'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'products' ? 'page' : undefined}
            >
              <Tag className="w-4 h-4" />
              <span>Products</span>
            </button>
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
              <span className="block text-[10px] font-mono text-[var(--khata-text-muted)]">
                {owner?.phone || 'Authorized'}
              </span>
            </div>

            {/* Logout Button */}
            <button
              onClick={() => logout()}
              title="Logout"
              aria-label="Logout"
              className="neu-btn-danger text-xs px-2.5 sm:px-3 py-1.5 sm:py-2 flex items-center gap-1.5 min-h-[38px] sm:min-h-[44px]"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
