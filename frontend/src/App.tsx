import { useState, useEffect } from 'react';
import { AuthProvider } from './features/auth/AuthProvider.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { Navbar, NavTab } from './components/Navbar.js';
import { KhataLedgerView } from './features/khata/KhataLedgerView.js';
import { ProductsView } from './features/products/ProductsView.js';
import { GstBillingView } from './features/bills/GstBillingView.js';
import { NormalBillingView } from './features/bills/NormalBillingView.js';
import { QuotationsView } from './features/quotations/QuotationsView.js';
import { SuppliersModuleView } from './features/suppliers/SuppliersModuleView.js';
import { HomeDashboard } from './features/dashboard/HomeDashboard.js';
import { ThemeAccessibilityProvider } from './context/ThemeAccessibilityContext.js';
import { AppearanceAccessibilityModal } from './components/AppearanceAccessibilityModal.js';

export function getInitialTab(): NavTab {
  if (typeof window !== 'undefined') {
    const path = window.location.pathname;
    const hash = window.location.hash;
    if (path.startsWith('/bills/normal') || hash.includes('bills/normal')) {
      return 'normal-bill';
    }
    if (path.startsWith('/bills') || hash.includes('bills')) {
      return 'gst-bill';
    }
    if (path.startsWith('/products') || hash.includes('products')) {
      return 'products';
    }
    if (path.startsWith('/quotations') || hash.includes('quotations')) {
      return 'quotations';
    }
    if (path.startsWith('/suppliers') || hash.includes('suppliers')) {
      return 'suppliers';
    }
    if (path.startsWith('/khata') || hash.includes('khata')) {
      return 'khata';
    }
  }
  return 'home';
}

export function KhataDashboard() {
  const [currentTab, setCurrentTab] = useState<NavTab>(getInitialTab);
  const [isAppearanceOpen, setIsAppearanceOpen] = useState(false);

  // Sync tab changes with browser URL and history
  const handleTabChange = (tab: NavTab) => {
    setCurrentTab(tab);
    if (typeof window !== 'undefined') {
      let targetPath = '/';
      if (tab === 'khata') targetPath = '/khata';
      else if (tab === 'gst-bill') targetPath = '/bills/gst';
      else if (tab === 'normal-bill') targetPath = '/bills/normal';
      else if (tab === 'products') targetPath = '/products';
      else if (tab === 'quotations') targetPath = '/quotations';
      else if (tab === 'suppliers') targetPath = '/suppliers';

      if (window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath);
      }
    }
  };

  // Listen to browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      setCurrentTab(getInitialTab());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: 'var(--khata-bg)', color: 'var(--khata-text)' }}
    >
      <div className="mhi-no-print">
        <Navbar
          currentTab={currentTab}
          onTabChange={handleTabChange}
          onOpenAppearance={() => setIsAppearanceOpen(true)}
        />
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {currentTab === 'home' && <HomeDashboard onNavigate={handleTabChange} />}
        {currentTab === 'khata' && <KhataLedgerView />}
        {currentTab === 'products' && <ProductsView />}
        {currentTab === 'gst-bill' && <GstBillingView />}
        {currentTab === 'normal-bill' && <NormalBillingView />}
        {currentTab === 'quotations' && <QuotationsView />}
        {currentTab === 'suppliers' && <SuppliersModuleView />}
      </main>

      <footer
        className="mhi-no-print py-4 border-t border-[var(--khata-border)] text-center text-xs font-medium text-[var(--khata-text-muted)] px-4"
        style={{ background: 'var(--khata-surface)' }}
      >
        Designed and managed by Algions AI Labs Pvt. Ltd.
      </footer>

      {/* Persistent Appearance & Accessibility Modal */}
      <div className="mhi-no-print">
        <AppearanceAccessibilityModal
          isOpen={isAppearanceOpen}
          onClose={() => setIsAppearanceOpen(false)}
        />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ThemeAccessibilityProvider>
      <AuthProvider>
        <ProtectedRoute>
          <KhataDashboard />
        </ProtectedRoute>
      </AuthProvider>
    </ThemeAccessibilityProvider>
  );
}
