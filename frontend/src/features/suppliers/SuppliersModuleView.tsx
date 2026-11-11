import React, { useState } from 'react';
import {
  Building2,
  CreditCard,
  FileSpreadsheet,
  LayoutDashboard,
  Receipt,
  Users,
} from 'lucide-react';
import { SupplierDashboard } from './SupplierDashboard.js';
import { SuppliersView } from './SuppliersView.js';
import { SupplierDetails } from './SupplierDetails.js';
import { PurchaseBillsView } from './PurchaseBillsView.js';
import { SupplierPaymentsView } from './SupplierPaymentsView.js';
import { SupplierStatement } from './SupplierStatement.js';

export type SupplierSectionTab =
  | 'all-suppliers'
  | 'purchase-bills'
  | 'payments'
  | 'statements'
  | 'dashboard';

export const DEFAULT_SUPPLIER_SECTION_TAB: SupplierSectionTab = 'all-suppliers';

export const SuppliersModuleView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SupplierSectionTab>(DEFAULT_SUPPLIER_SECTION_TAB);
  const [detailSupplierId, setDetailSupplierId] = useState<string | null>(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('');
  const [refreshSignal, setRefreshSignal] = useState(0);

  // Trigger signals for quick actions from Dashboard / Supplier Details
  const [createBillSignal, setCreateBillSignal] = useState(0);
  const [createPaymentSignal, setCreatePaymentSignal] = useState(0);

  const bumpRefresh = () => setRefreshSignal((prev) => prev + 1);

  const handleOpenSupplierDetails = (supplierId: string) => {
    setDetailSupplierId(supplierId);
  };

  const handleOpenStatement = (supplierId: string) => {
    setDetailSupplierId(null);
    setSelectedSupplierId(supplierId);
    setActiveTab('statements');
  };

  const handleQuickNewBill = (supplierId: string) => {
    setDetailSupplierId(null);
    setSelectedSupplierId(supplierId);
    setActiveTab('purchase-bills');
    setCreateBillSignal((n) => n + 1);
  };

  const handleQuickNewPayment = (supplierId: string) => {
    setDetailSupplierId(null);
    setSelectedSupplierId(supplierId);
    setActiveTab('payments');
    setCreatePaymentSignal((n) => n + 1);
  };

  const handleOpenAllPayments = () => {
    setDetailSupplierId(null);
    setSelectedSupplierId('');
    setActiveTab('payments');
  };

  const subTabs: Array<{
    key: SupplierSectionTab;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: 'all-suppliers',
      label: 'All Suppliers',
      icon: <Users className="w-3.5 h-3.5" />,
    },
    {
      key: 'purchase-bills',
      label: 'Purchase Bills',
      icon: <Receipt className="w-3.5 h-3.5" />,
    },
    {
      key: 'payments',
      label: 'Supplier Payments',
      icon: <CreditCard className="w-3.5 h-3.5" />,
    },
    {
      key: 'statements',
      label: 'Supplier Statements',
      icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
    },
    {
      key: 'dashboard',
      label: 'Supplier Dashboard',
      icon: <LayoutDashboard className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="space-y-5">
      {/* Module Header & Sub-Navigation (hidden when printing statements/vouchers) */}
      <div className="neu-card p-4 sm:p-5 rounded-2xl space-y-3.5 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[var(--khata-accent)]/12 text-[var(--khata-accent)]">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-[var(--khata-text)] tracking-tight">
                Suppliers &amp; Purchase Accounts
              </h2>
              <p className="text-xs text-[var(--khata-text-muted)]">
                Manage suppliers, purchase bills, multi-bill payments, advances &amp; statements
              </p>
            </div>
          </div>
        </div>

        <nav
          aria-label="Suppliers sub-navigation"
          className="flex flex-wrap items-center gap-2 pt-1 border-t border-[var(--khata-border)]/70"
        >
          {subTabs.map((t) => {
            const isActive = !detailSupplierId && activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  setDetailSupplierId(null);
                  setActiveTab(t.key);
                }}
                className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer ${
                  isActive
                    ? 'bg-[var(--khata-accent)] text-white shadow'
                    : 'bg-[var(--khata-surface-inset)]/60 text-[var(--khata-text-muted)] hover:text-[var(--khata-text)]'
                }`}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Sub-Views */}
      {detailSupplierId ? (
        <SupplierDetails
          supplierId={detailSupplierId}
          refreshSignal={refreshSignal}
          onBack={() => setDetailSupplierId(null)}
          onOpenStatement={handleOpenStatement}
          onNewPurchaseBill={handleQuickNewBill}
          onNewPayment={handleQuickNewPayment}
          onOpenPurchaseBillsTab={(id) => {
            setDetailSupplierId(null);
            setSelectedSupplierId(id);
            setActiveTab('purchase-bills');
          }}
          onOpenPaymentsTab={(id) => {
            setDetailSupplierId(null);
            setSelectedSupplierId(id);
            setActiveTab('payments');
          }}
        />
      ) : activeTab === 'dashboard' ? (
        <SupplierDashboard
          refreshSignal={refreshSignal}
          onOpenAllPayments={handleOpenAllPayments}
        />
      ) : activeTab === 'all-suppliers' ? (
        <SuppliersView
          refreshSignal={refreshSignal}
          onOpenSupplierDetails={handleOpenSupplierDetails}
          onOpenStatement={handleOpenStatement}
          onNewPurchaseBill={handleQuickNewBill}
          onNewPayment={handleQuickNewPayment}
          onDataChanged={bumpRefresh}
        />
      ) : activeTab === 'purchase-bills' ? (
        <PurchaseBillsView
          initialSupplierFilter={selectedSupplierId}
          preselectedSupplierId={selectedSupplierId}
          openCreateSignal={createBillSignal}
          onDataChanged={bumpRefresh}
        />
      ) : activeTab === 'payments' ? (
        <SupplierPaymentsView
          initialSupplierFilter={selectedSupplierId}
          preselectedSupplierId={selectedSupplierId}
          openCreateSignal={createPaymentSignal}
          onDataChanged={bumpRefresh}
        />
      ) : (
        <SupplierStatement initialSupplierId={selectedSupplierId} />
      )}
    </div>
  );
};

export default SuppliersModuleView;
