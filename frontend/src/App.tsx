import { useState } from 'react';
import { AuthProvider } from './features/auth/AuthProvider.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { Navbar } from './components/Navbar.js';
import { KhataLedgerView } from './features/khata/KhataLedgerView.js';
import { ProductsView } from './features/products/ProductsView.js';
import { ThemeAccessibilityProvider } from './context/ThemeAccessibilityContext.js';
import { AppearanceAccessibilityModal } from './components/AppearanceAccessibilityModal.js';

export function KhataDashboard() {
  const [currentTab, setCurrentTab] = useState<'khata' | 'products'>('khata');
  const [isAppearanceOpen, setIsAppearanceOpen] = useState(false);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: 'var(--khata-bg)', color: 'var(--khata-text)' }}
    >
      <Navbar
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        onOpenAppearance={() => setIsAppearanceOpen(true)}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {currentTab === 'khata' ? <KhataLedgerView /> : <ProductsView />}
      </main>

      <footer
        className="py-4 border-t border-[var(--khata-border)] text-center text-xs font-medium text-[var(--khata-text-muted)] px-4"
        style={{ background: 'var(--khata-surface)' }}
      >
        Designed and managed by Algions AI Labs Pvt. Ltd.
      </footer>

      {/* Persistent Appearance & Accessibility Modal */}
      <AppearanceAccessibilityModal
        isOpen={isAppearanceOpen}
        onClose={() => setIsAppearanceOpen(false)}
      />
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
