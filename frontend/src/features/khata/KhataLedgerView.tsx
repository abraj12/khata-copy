import React, { useEffect, useState } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import { Users, CreditCard, ArrowUpRight, ArrowDownLeft, Plus } from 'lucide-react';

interface Customer {
  id: number;
  name: string;
  phone?: string;
  balance?: number;
}

interface LedgerEntry {
  id: number;
  customer_id: number;
  type: 'UDHAR_GIVEN' | 'PAYMENT_RECEIVED';
  amount: number;
  description?: string;
  entry_date?: string;
  created_at?: string;
}

interface Summary {
  totalCustomers: number;
  totalUdharOutstanding: number;
  totalPaymentsReceived: number;
}

export const KhataLedgerView: React.FC = () => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [summary, setSummary] = useState<Summary>({
    totalCustomers: 0,
    totalUdharOutstanding: 0,
    totalPaymentsReceived: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [entryType, setEntryType] = useState<'UDHAR_GIVEN' | 'PAYMENT_RECEIVED'>('UDHAR_GIVEN');
  const [entryAmount, setEntryAmount] = useState('');
  const [entryDesc, setEntryDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchLedgerData = async () => {
    try {
      setIsLoading(true);
      const [ledgerRes, summaryRes] = await Promise.all([
        apiClient<{ customers: Customer[]; entries: LedgerEntry[] }>('/api/v1/ledger'),
        apiClient<{ summary: Summary }>('/api/v1/ledger/summary'),
      ]);

      setCustomers(ledgerRes.data.customers || []);
      setEntries(ledgerRes.data.entries || []);
      setSummary(summaryRes.data.summary || {
        totalCustomers: 0,
        totalUdharOutstanding: 0,
        totalPaymentsReceived: 0,
      });
    } catch (err) {
      console.error('Failed to fetch ledger:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLedgerData();
  }, []);

  const handleRecordEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomerId || !entryAmount) return;
    setError(null);

    try {
      await apiClient('/api/v1/ledger/entry', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: Number(selectedCustomerId),
          type: entryType,
          amount: parseFloat(entryAmount),
          description: entryDesc,
        }),
      });

      setEntryAmount('');
      setEntryDesc('');
      setIsRecording(false);
      fetchLedgerData();
    } catch (err) {
      setError((err as Error).message || 'Failed to record entry');
    }
  };

  return (
    <div className="space-y-6">
      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Credit Outstanding (Udhar)</span>
            <div className="w-8 h-8 rounded-full bg-rose-50 flex items-center justify-center text-rose-600">
              <ArrowUpRight className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-rose-600 font-mono">
            ₹{summary.totalUdharOutstanding.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-slate-400 mt-1">Amount to collect from customers</p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Payments Collected</span>
            <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600">
              <ArrowDownLeft className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-emerald-600 font-mono">
            ₹{summary.totalPaymentsReceived.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
          <p className="text-xs text-slate-400 mt-1">Total credit recovered</p>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Active Customers</span>
            <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <p className="mt-2 text-2xl font-black text-slate-900 font-mono">
            {summary.totalCustomers}
          </p>
          <p className="text-xs text-slate-400 mt-1">Registered Khata accounts</p>
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-between bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-600" />
            <span>Khata Ledger Entries</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">Record credit (Udhar) given or payment received.</p>
        </div>

        <button
          onClick={() => setIsRecording(!isRecording)}
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>{isRecording ? 'Close' : 'Record Transaction'}</span>
        </button>
      </div>

      {/* Record Transaction Form */}
      {isRecording && (
        <form onSubmit={handleRecordEntry} className="bg-slate-100/80 border border-slate-200 p-6 rounded-2xl space-y-4">
          <h3 className="text-sm font-bold text-slate-900">New Ledger Transaction</h3>
          {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Customer</label>
              <select
                required
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
              >
                <option value="">Select Customer...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.phone ? `(${c.phone})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Transaction Type</label>
              <select
                value={entryType}
                onChange={(e) => setEntryType(e.target.value as 'UDHAR_GIVEN' | 'PAYMENT_RECEIVED')}
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
              >
                <option value="UDHAR_GIVEN">Udhar Given (Customer Credit)</option>
                <option value="PAYMENT_RECEIVED">Payment Received (Deposit)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Amount (₹)</label>
              <input
                type="number"
                step="0.01"
                required
                value={entryAmount}
                onChange={(e) => setEntryAmount(e.target.value)}
                placeholder="0.00"
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Description / Note</label>
            <input
              type="text"
              value={entryDesc}
              onChange={(e) => setEntryDesc(e.target.value)}
              placeholder="e.g. 5kg sugar + oil"
              className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="submit"
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-5 py-2.5 rounded-xl shadow transition"
            >
              Record Entry
            </button>
          </div>
        </form>
      )}

      {/* Ledger Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-slate-400">Loading ledger entries...</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">No ledger transactions recorded yet.</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Customer</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Description</th>
                <th className="py-3 px-4 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {entries.map((item) => {
                const customer = customers.find((c) => c.id === item.customer_id);
                const isUdhar = item.type === 'UDHAR_GIVEN';
                return (
                  <tr key={item.id} className="hover:bg-slate-50/70 transition">
                    <td className="py-3 px-4 text-xs font-mono text-slate-500">
                      {item.entry_date || (item.created_at ? item.created_at.split('T')[0] : 'Today')}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-900">{customer ? customer.name : `Customer #${item.customer_id}`}</td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                          isUdhar ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {isUdhar ? 'Udhar Given' : 'Payment Received'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{item.description || '—'}</td>
                    <td
                      className={`py-3 px-4 text-right font-mono font-bold ${
                        isUdhar ? 'text-rose-600' : 'text-emerald-600'
                      }`}
                    >
                      {isUdhar ? '+ ₹' : '- ₹'}{Number(item.amount).toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
