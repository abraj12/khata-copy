import React from 'react';
import { useAuth } from '../features/auth/AuthProvider.js';
import { Store, LogOut, BookOpen, Tag } from 'lucide-react';

interface NavbarProps {
  currentTab: 'khata' | 'products';
  onTabChange: (tab: 'khata' | 'products') => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onTabChange }) => {
  const { logout, owner } = useAuth();

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-600/30">
              <Store className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-black text-slate-900 leading-tight">Khata</h1>
              <p className="text-xs text-slate-400 font-medium">Single Shopkeeper Ledger</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center space-x-1 sm:space-x-2">
            <button
              onClick={() => onTabChange('khata')}
              className={`inline-flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition ${
                currentTab === 'khata'
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span>Khata</span>
            </button>

            <button
              onClick={() => onTabChange('products')}
              className={`inline-flex items-center space-x-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-bold transition ${
                currentTab === 'products'
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              <Tag className="w-4 h-4" />
              <span>Products</span>
            </button>
          </nav>

          {/* Owner info & Logout */}
          <div className="flex items-center space-x-3">
            <div className="hidden sm:block text-right">
              <span className="block text-xs font-bold text-slate-900">Owner</span>
              <span className="block text-[11px] font-mono text-slate-400">{owner?.phone || 'Configured Phone'}</span>
            </div>

            <button
              onClick={() => logout()}
              title="Logout"
              className="inline-flex items-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 border border-rose-200 transition"
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
