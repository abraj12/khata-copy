import { useState } from 'react';
import { AuthProvider } from './features/auth/AuthProvider.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { Navbar } from './components/Navbar.js';
import { KhataLedgerView } from './features/khata/KhataLedgerView.js';
import { ProductsView } from './features/products/ProductsView.js';

export function KhataDashboard() {
  const [currentTab, setCurrentTab] = useState<'khata' | 'products'>('khata');

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Navbar currentTab={currentTab} onTabChange={setCurrentTab} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {currentTab === 'khata' ? <KhataLedgerView /> : <ProductsView />}
      </main>

      <footer className="py-4 border-t border-slate-200 bg-white text-center text-xs text-slate-400">
        Khata • Protected Single-Shopkeeper System • Algions Technologies
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ProtectedRoute>
        <KhataDashboard />
      </ProtectedRoute>
    </AuthProvider>
  );
}
