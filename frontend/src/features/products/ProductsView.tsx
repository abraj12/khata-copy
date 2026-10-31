import React, { useEffect, useState } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import { Tag, Plus, Search } from 'lucide-react';

interface Product {
  id: number;
  name: string;
  buying_price: string;
  created_at: string;
}

export const ProductsView: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchProducts = async () => {
    try {
      setIsLoading(true);
      const res = await apiClient<{ success: boolean; data: Product[] }>('/api/v1/products');
      setProducts(res.data.data || []);
    } catch (err) {
      console.error('Failed to fetch products:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName || !newPrice) return;
    setError(null);

    try {
      await apiClient('/api/v1/products', {
        method: 'POST',
        body: JSON.stringify({ name: newName, buying_price: parseFloat(newPrice) }),
      });
      setNewName('');
      setNewPrice('');
      setIsAdding(false);
      fetchProducts();
    } catch (err) {
      setError((err as Error).message || 'Failed to add product');
    }
  };

  const filtered = products.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Tag className="w-5 h-5 text-indigo-600" />
            <span>Products (Owner Buying Reference)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Confidential buying price reference for the shopkeeper.
          </p>
        </div>

        <button
          onClick={() => setIsAdding(!isAdding)}
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-md transition"
        >
          <Plus className="w-4 h-4" />
          <span>{isAdding ? 'Cancel' : 'Add Product'}</span>
        </button>
      </div>

      {/* Add Product Form Modal / Collapsible */}
      {isAdding && (
        <form onSubmit={handleAddProduct} className="bg-indigo-50/70 border border-indigo-100 p-5 rounded-2xl space-y-4">
          <h3 className="text-sm font-bold text-indigo-950">Add Reference Product</h3>
          {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Product Name</label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Parle-G 250g"
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Buying Price (₹)</label>
              <input
                type="number"
                step="0.01"
                required
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                placeholder="e.g. 25.50"
                className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="submit"
              className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 rounded-xl shadow transition"
            >
              Save Product
            </button>
          </div>
        </form>
      )}

      {/* Search Input */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products..."
          className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-600 shadow-sm"
        />
      </div>

      {/* Product List */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-slate-400">Loading products...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">No products found.</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="py-3 px-4">Item Name</th>
                <th className="py-3 px-4 text-right">Buying Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filtered.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/70 transition">
                  <td className="py-3 px-4 font-semibold text-slate-900">{item.name}</td>
                  <td className="py-3 px-4 text-right font-mono font-bold text-indigo-700">
                    ₹{parseFloat(item.buying_price).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
