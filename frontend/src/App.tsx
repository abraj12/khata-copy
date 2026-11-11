import { lazy, Suspense, useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthProvider } from './features/auth/AuthProvider.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { Navbar, NavTab } from './components/Navbar.js';
import { HomeDashboard } from './features/dashboard/HomeDashboard.js';
import { ThemeAccessibilityProvider, useThemeAccessibility } from './context/ThemeAccessibilityContext.js';
import { AppearanceAccessibilityModal } from './components/AppearanceAccessibilityModal.js';

const KhataLedgerView = lazy(() =>
  import('./features/khata/KhataLedgerView.js').then((m) => ({ default: m.KhataLedgerView }))
);
const ProductsView = lazy(() =>
  import('./features/products/ProductsView.js').then((m) => ({ default: m.ProductsView }))
);
const GstBillingView = lazy(() =>
  import('./features/bills/GstBillingView.js').then((m) => ({ default: m.GstBillingView }))
);
const NormalBillingView = lazy(() =>
  import('./features/bills/NormalBillingView.js').then((m) => ({ default: m.NormalBillingView }))
);
const QuotationsView = lazy(() =>
  import('./features/quotations/QuotationsView.js').then((m) => ({ default: m.QuotationsView }))
);
const SuppliersModuleView = lazy(() =>
  import('./features/suppliers/SuppliersModuleView.js').then((m) => ({
    default: m.SuppliersModuleView,
  }))
);

function ModuleLoadingFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="neu-card p-8 flex items-center justify-center gap-2.5 text-sm font-semibold text-[var(--khata-text-muted)]"
    >
      <Loader2 className="w-5 h-5 animate-spin text-[var(--khata-accent)]" aria-hidden="true" />
      <span>Loading module...</span>
    </div>
  );
}

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
  const { syncFromServer, resetServerSync } = useThemeAccessibility();

  useEffect(() => {
    void syncFromServer();
    return () => {
      resetServerSync();
    };
  }, [syncFromServer, resetServerSync]);

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
      <div className="mhi-no-print sticky top-0 z-30">
        <Navbar
          currentTab={currentTab}
          onTabChange={handleTabChange}
          onOpenAppearance={() => setIsAppearanceOpen(true)}
        />
      </div>

      <main className="flex-1 max-w-7xl w-full min-w-0 mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-8">
        {currentTab === 'home' && <HomeDashboard onNavigate={handleTabChange} />}
        {currentTab !== 'home' && (
          <Suspense fallback={<ModuleLoadingFallback />}>
            {currentTab === 'khata' && <KhataLedgerView />}
            {currentTab === 'products' && <ProductsView />}
            {currentTab === 'gst-bill' && <GstBillingView />}
            {currentTab === 'normal-bill' && <NormalBillingView />}
            {currentTab === 'quotations' && <QuotationsView />}
            {currentTab === 'suppliers' && <SuppliersModuleView />}
          </Suspense>
        )}
      </main>

      <footer
        className="mhi-no-print py-4 border-t border-[var(--khata-border)] text-center text-xs font-medium text-[var(--khata-text-muted)] px-4"
        style={{ background: 'var(--khata-surface)' }}
      >
        Designed and managed by Algions AI Labs Pvt. Ltd.
      </footer>

      {/* Persistent Appearance & Accessibility Modal */}
      <div className="mhi-no-print sticky top-0 z-30">
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
