import React, { useState, useCallback } from 'react';
import { broadcastCloseOtherPopovers, useViewportPopover } from '../utils/useViewportPopover.js';
import { useAuth } from '../features/auth/AuthProvider.js';
import { NotificationCenterButton } from './NotificationCenterButton.js';
import {
  Store,
  Home,
  LogOut,
  BookOpen,
  Tag,
  Palette,
  Loader2,
  AlertCircle,
  FileText,
  ChevronDown,
  Building2,
} from 'lucide-react';

export type NavTab =
  | 'home'
  | 'khata'
  | 'products'
  | 'suppliers'
  | 'quotations'
  | 'gst-bill'
  | 'normal-bill';

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
  const closeBillMenu = useCallback(() => setIsBillMenuOpen(false), []);
  const {
    containerRef: billMenuRef,
    triggerRef: billTriggerRef,
    popoverStyle: billPopoverStyle,
  } = useViewportPopover({
    isOpen: isBillMenuOpen,
    onClose: closeBillMenu,
    preferredWidthPx: 208,
    offsetY: 6,
  });

  const handleSelectTab = (tab: NavTab) => {
    setIsBillMenuOpen(false);
    broadcastCloseOtherPopovers();
    onTabChange(tab);
  };

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
        <div className="bg-rose-500/10 border-b border-rose-500/20 px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-rose-500">
          <div className="flex flex-wrap items-center gap-1.5 font-medium min-w-0">
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

      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between min-h-[60px] py-2 sm:py-2.5 gap-x-3 gap-y-2">
          {/* Brand Identity / Store Badge */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 min-w-0 flex-1 lg:flex-initial">
            <div
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shadow-inner border border-[var(--khata-border)] shrink-0"
              style={{ background: 'var(--khata-surface-inset)' }}
              aria-hidden="true"
            >
              <Store className="w-5 h-5 text-[var(--khata-accent)]" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base md:text-lg font-black tracking-tight text-[var(--khata-text)] leading-none">
                Khata
              </h1>
              <p className="text-[10px] sm:text-[11px] text-[var(--khata-text-muted)] font-medium mt-0.5 truncate max-w-[11rem] sm:max-w-none">
                Algions AI Labs Private Limited
              </p>
            </div>
          </div>

          {/* Navigation Tabs (Home, Khata, Products, Quotations, Suppliers, Bill -> GST Bill / Normal Bill) */}
          <nav
            className="flex flex-wrap items-center gap-1.5 sm:gap-2 order-3 lg:order-2 w-full lg:w-auto justify-center lg:justify-start pt-1 lg:pt-0"
            aria-label="Main Navigation"
          >
            {/* 0. Home Tab */}
            <button
              type="button"
              onClick={() => handleSelectTab('home')}
              className={`inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[40px] sm:min-h-[42px] flex-1 basis-[calc(33.333%-0.375rem)] min-w-[96px] sm:min-w-0 sm:basis-auto lg:flex-initial whitespace-nowrap ${
                currentTab === 'home'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'home' ? 'page' : undefined}
            >
              <Home className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>Home</span>
            </button>

            {/* 1. Khata Tab */}
            <button
              type="button"
              onClick={() => handleSelectTab('khata')}
              className={`inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[40px] sm:min-h-[42px] flex-1 basis-[calc(33.333%-0.375rem)] min-w-[96px] sm:min-w-0 sm:basis-auto lg:flex-initial whitespace-nowrap ${
                currentTab === 'khata'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'khata' ? 'page' : undefined}
            >
              <BookOpen className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>Khata</span>
            </button>

            {/* 2. Products Tab */}
            <button
              type="button"
              onClick={() => handleSelectTab('products')}
              className={`inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[40px] sm:min-h-[42px] flex-1 basis-[calc(33.333%-0.375rem)] min-w-[96px] sm:min-w-0 sm:basis-auto lg:flex-initial whitespace-nowrap ${
                currentTab === 'products'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'products' ? 'page' : undefined}
            >
              <Tag className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>Products</span>
            </button>

            {/* 3. Quotations Tab */}
            <button
              type="button"
              onClick={() => handleSelectTab('quotations')}
              className={`inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[40px] sm:min-h-[42px] flex-1 basis-[calc(33.333%-0.375rem)] min-w-[96px] sm:min-w-0 sm:basis-auto lg:flex-initial whitespace-nowrap ${
                currentTab === 'quotations'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'quotations' ? 'page' : undefined}
            >
              <FileText className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>Quotations</span>
            </button>

            {/* Suppliers Navigation Tab */}
            <button
              type="button"
              onClick={() => handleSelectTab('suppliers')}
              className={`inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[40px] sm:min-h-[42px] flex-1 basis-[calc(33.333%-0.375rem)] min-w-[96px] sm:min-w-0 sm:basis-auto lg:flex-initial whitespace-nowrap ${
                currentTab === 'suppliers'
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                  : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
              }`}
              aria-current={currentTab === 'suppliers' ? 'page' : undefined}
            >
              <Building2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span>Suppliers</span>
            </button>

            {/* 4. Bill Dropdown Menu (Contains GST Bill & Normal Bill) */}
            <div className="relative flex-1 basis-[calc(33.333%-0.375rem)] min-w-[96px] sm:min-w-0 sm:basis-auto lg:flex-initial" ref={billMenuRef}>
              <button
                ref={billTriggerRef}
                type="button"
                onClick={() => setIsBillMenuOpen((prev) => !prev)}
                className={`w-full inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all border min-h-[40px] sm:min-h-[42px] whitespace-nowrap ${
                  isBillActive
                    ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-md'
                    : 'bg-[var(--khata-surface-inset)] text-[var(--khata-text)] border-[var(--khata-border)] hover:border-[var(--khata-accent)]'
                }`}
                aria-haspopup="true"
                aria-expanded={isBillMenuOpen}
                aria-current={isBillActive ? 'page' : undefined}
              >
                <FileText className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span>Bill</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isBillMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Submenu Dropdown */}
              {isBillMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1.5 w-[min(13rem,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-5rem)] overflow-y-auto p-1.5 rounded-xl border border-[var(--khata-border)] shadow-xl z-50 animate-in fade-in slide-in-from-top-1"
                  style={{ background: 'var(--khata-surface)', ...billPopoverStyle }}
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

          {/* Controls: Notifications, Appearance, Owner Phone, Logout */}
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2 order-2 lg:order-3 shrink-0">
            <NotificationCenterButton />

            {/* Persistent Appearance & Accessibility Button */}
            <button
              type="button"
              onClick={() => {
                setIsBillMenuOpen(false);
                broadcastCloseOtherPopovers();
                onOpenAppearance();
              }}
              title="Appearance & Accessibility"
              aria-label="Open Appearance & Accessibility settings"
              className="neu-btn-secondary text-xs px-2.5 sm:px-3 py-1.5 sm:py-2 inline-flex items-center justify-center gap-1.5 min-h-[38px] sm:min-h-[40px]"
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
              type="button"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="neu-btn-secondary text-rose-500 hover:text-rose-600 text-xs px-2.5 sm:px-3.5 py-1.5 sm:py-2 inline-flex items-center justify-center gap-1.5 min-h-[38px] sm:min-h-[40px]"
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
