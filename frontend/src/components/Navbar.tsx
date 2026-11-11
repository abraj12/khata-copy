import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  POPOVER_OPEN_EVENT,
  broadcastCloseOtherPopovers,
  useViewportPopover,
} from '../utils/useViewportPopover.js';
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
  Menu,
  X,
} from 'lucide-react';

export type NavTab =
  | 'home'
  | 'khata'
  | 'products'
  | 'suppliers'
  | 'quotations'
  | 'gst-bill'
  | 'normal-bill';

const NAV_TAB_LABELS: Record<NavTab, string> = {
  home: 'Home',
  khata: 'Khata',
  products: 'Products',
  suppliers: 'Suppliers',
  quotations: 'Quotations',
  'gst-bill': 'GST Bill',
  'normal-bill': 'Normal Bill',
};

const MOBILE_NAV_SOURCE_ID = 'navbar-mobile-drawer';
const MOBILE_NAV_ELEMENT_ID = 'main-navigation-menu';

interface NavbarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onOpenAppearance: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onTabChange, onOpenAppearance }) => {
  const { logout, owner } = useAuth();
  const headerRef = useRef<HTMLElement>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isBillMenuOpen, setIsBillMenuOpen] = useState(false);
  const closeBillMenu = useCallback(() => setIsBillMenuOpen(false), []);
  const {
    popoverId: billPopoverId,
    containerRef: billMenuRef,
    triggerRef: billTriggerRef,
    popoverStyle: billPopoverStyle,
  } = useViewportPopover({
    isOpen: isBillMenuOpen,
    onClose: closeBillMenu,
    preferredWidthPx: 208,
    offsetY: 6,
  });

  useEffect(() => {
    const handleOtherPopoverOpen = (event: Event) => {
      const customEvent = event as CustomEvent<{ id?: string }>;
      const sourceId = customEvent.detail?.id;
      if (sourceId !== MOBILE_NAV_SOURCE_ID && sourceId !== billPopoverId) {
        setIsMobileNavOpen(false);
      }
    };

    window.addEventListener(POPOVER_OPEN_EVENT, handleOtherPopoverOpen);
    return () => {
      window.removeEventListener(POPOVER_OPEN_EVENT, handleOtherPopoverOpen);
    };
  }, [billPopoverId]);

  useEffect(() => {
    if (!isMobileNavOpen) return;

    const handleOutsidePress = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (headerRef.current && target && !headerRef.current.contains(target)) {
        setIsMobileNavOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBillMenuOpen) {
        setIsMobileNavOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsidePress);
    document.addEventListener('touchstart', handleOutsidePress, { passive: true });
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleOutsidePress);
      document.removeEventListener('touchstart', handleOutsidePress);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isMobileNavOpen, isBillMenuOpen]);

  const handleSelectTab = (tab: NavTab) => {
    setIsBillMenuOpen(false);
    setIsMobileNavOpen(false);
    broadcastCloseOtherPopovers();
    onTabChange(tab);
  };

  const handleToggleMobileNav = () => {
    setIsBillMenuOpen(false);
    setIsMobileNavOpen((prev) => {
      const next = !prev;
      if (next) {
        broadcastCloseOtherPopovers(MOBILE_NAV_SOURCE_ID);
      }
      return next;
    });
  };

  const handleLogout = async () => {
    setIsBillMenuOpen(false);
    setIsMobileNavOpen(false);
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
      ref={headerRef}
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

      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between min-h-[52px] sm:min-h-[60px] py-1.5 sm:py-2.5 gap-x-2 sm:gap-x-3 gap-y-2">
          {/* Brand Identity / Store Badge */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 min-w-0 flex-1 lg:flex-initial">
            <div
              className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shadow-inner border border-[var(--khata-border)] shrink-0"
              style={{ background: 'var(--khata-surface-inset)' }}
              aria-hidden="true"
            >
              <Store className="w-4 h-4 sm:w-5 sm:h-5 text-[var(--khata-accent)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <h1 className="text-sm sm:text-base md:text-lg font-black tracking-tight text-[var(--khata-text)] leading-none shrink-0">
                  Khata
                </h1>
                <span
                  className="md:hidden inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold truncate max-w-[6rem] bg-[var(--khata-surface-inset)] text-[var(--khata-accent)] border border-[var(--khata-border)]"
                  data-testid="mobile-active-tab-badge"
                >
                  {NAV_TAB_LABELS[currentTab]}
                </span>
              </div>
              <p className="text-[10px] sm:text-[11px] text-[var(--khata-text-muted)] font-medium mt-0.5 truncate">
                Algions AI Labs Private Limited
              </p>
            </div>
          </div>

          {/* Navigation Tabs (Collapsible behind Menu toggle on phones; always visible on md+ / desktop) */}
          <nav
            id={MOBILE_NAV_ELEMENT_ID}
            className={`${
              isMobileNavOpen ? 'flex' : 'hidden'
            } md:flex flex-wrap items-center gap-1.5 sm:gap-2 order-3 lg:order-2 w-full lg:w-auto justify-center lg:justify-start pt-2 md:pt-1 lg:pt-0 mt-0.5 md:mt-0 border-t border-[var(--khata-border)] md:border-t-0 max-h-[calc(100vh-4.5rem)] overflow-y-auto md:max-h-none md:overflow-visible`}
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
                    onClick={() => handleSelectTab('gst-bill')}
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
                    onClick={() => handleSelectTab('normal-bill')}
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

          {/* Controls: Notifications, Appearance, Owner Phone, Logout, Mobile Menu Toggle */}
          <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2 order-2 lg:order-3 shrink-0">
            <NotificationCenterButton />

            {/* Persistent Appearance & Accessibility Button */}
            <button
              type="button"
              onClick={() => {
                setIsBillMenuOpen(false);
                setIsMobileNavOpen(false);
                broadcastCloseOtherPopovers();
                onOpenAppearance();
              }}
              title="Appearance & Accessibility"
              aria-label="Open Appearance & Accessibility settings"
              className="neu-btn-secondary text-xs px-2 sm:px-3 py-1.5 sm:py-2 inline-flex items-center justify-center gap-1.5 min-h-[38px] sm:min-h-[40px]"
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
              className="neu-btn-secondary text-rose-500 hover:text-rose-600 text-xs px-2 sm:px-3.5 py-1.5 sm:py-2 inline-flex items-center justify-center gap-1.5 min-h-[38px] sm:min-h-[40px]"
              aria-label="Log out of Khata"
            >
              {isLoggingOut ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LogOut className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{isLoggingOut ? 'Logging out...' : 'Logout'}</span>
            </button>

            {/* Mobile Navigation Collapsible Toggle ("Hider" on phones only, hidden on md+/desktop) */}
            <button
              type="button"
              onClick={handleToggleMobileNav}
              aria-expanded={isMobileNavOpen}
              aria-controls={MOBILE_NAV_ELEMENT_ID}
              aria-label={isMobileNavOpen ? 'Hide navigation menu' : 'Show navigation menu'}
              title={isMobileNavOpen ? 'Hide menu' : 'Show navigation menu'}
              className={`md:hidden inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all border min-h-[38px] ${
                isMobileNavOpen
                  ? 'bg-[var(--khata-accent)] text-white border-[var(--khata-accent)] shadow-sm'
                  : 'neu-btn-secondary text-[var(--khata-text)] border-[var(--khata-border)]'
              }`}
            >
              {isMobileNavOpen ? (
                <X className="w-4 h-4 shrink-0" aria-hidden="true" />
              ) : (
                <Menu className="w-4 h-4 shrink-0" aria-hidden="true" />
              )}
              <span>{isMobileNavOpen ? 'Close' : 'Menu'}</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
