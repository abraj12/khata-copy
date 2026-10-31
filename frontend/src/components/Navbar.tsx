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
      style={{ backgroundColor: 'var(--khata-surface)' }}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center border border-[var(--khata-border)] shadow-sm"
              style={{
                backgroundColor: 'var(--khata-surface-inset)',
                color: 'var(--khata-accent)',
              }}
            >
              <Store className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-black tracking-tight text-[var(--khata-text)] leading-tight">
                Khata
              </h1>
              <p className="text-[11px] text-[var(--khata-text-muted)] font-medium">
                Single-Shopkeeper Ledger
              </p>
            </div>
          </div>

          {/* Navigation Tabs (Only Khata and Products) */}
          <nav className="flex items-center gap-2" aria-label="Main Navigation">
            <button
              onClick={() => onTabChange('khata')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border ${
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
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border ${
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
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Persistent Appearance & Accessibility Button */}
            <button
              onClick={onOpenAppearance}
              title="Appearance & Accessibility"
              aria-label="Open Appearance & Accessibility settings"
              className="neu-btn-secondary text-xs px-2.5 py-2 flex items-center gap-1.5"
            >
              <Palette className="w-4 h-4 text-[var(--khata-accent)]" />
              <span className="hidden md:inline">Appearance</span>
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
              className="neu-btn-danger text-xs px-2.5 sm:px-3 py-2 flex items-center gap-1.5"
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
