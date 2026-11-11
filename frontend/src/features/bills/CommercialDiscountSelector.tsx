import React from 'react';
import { CommercialDiscountType } from '../../utils/lineItemDraft.js';

interface CommercialDiscountSelectorProps {
  discountType: CommercialDiscountType;
  discountValue: string;
  discountAmountText?: string;
  onChangeType: (nextType: CommercialDiscountType) => void;
  onChangeValue: (nextValue: string) => void;
}

export const CommercialDiscountSelector: React.FC<CommercialDiscountSelectorProps> = ({
  discountType,
  discountValue,
  discountAmountText,
  onChangeType,
  onChangeValue,
}) => {
  return (
    <div className="p-3 rounded-xl border border-[var(--khata-border)] bg-[var(--khata-surface-inset)] space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase text-[var(--khata-text-muted)]">
          Commercial Discount
        </span>
        {discountType && discountAmountText && Number(discountAmountText) > 0 && (
          <span className="text-[11px] font-mono font-bold text-emerald-600 dark:text-emerald-400">
            -₹{discountAmountText}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => {
            onChangeType(null);
            onChangeValue('0');
          }}
          className={`flex-1 min-w-[64px] px-2.5 py-1.5 rounded-lg text-xs font-bold border transition cursor-pointer ${
            discountType === null
              ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)] text-white shadow-sm'
              : 'border-[var(--khata-border)] bg-[var(--khata-surface)] text-[var(--khata-text)] hover:border-[var(--khata-accent)]'
          }`}
        >
          None
        </button>
        <button
          type="button"
          onClick={() => onChangeType('percentage')}
          className={`flex-1 min-w-[84px] px-2.5 py-1.5 rounded-lg text-xs font-bold border transition cursor-pointer ${
            discountType === 'percentage'
              ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)] text-white shadow-sm'
              : 'border-[var(--khata-border)] bg-[var(--khata-surface)] text-[var(--khata-text)] hover:border-[var(--khata-accent)]'
          }`}
        >
          Percentage (%)
        </button>
        <button
          type="button"
          onClick={() => onChangeType('fixed')}
          className={`flex-1 min-w-[78px] px-2.5 py-1.5 rounded-lg text-xs font-bold border transition cursor-pointer ${
            discountType === 'fixed'
              ? 'border-[var(--khata-accent)] bg-[var(--khata-accent)] text-white shadow-sm'
              : 'border-[var(--khata-border)] bg-[var(--khata-surface)] text-[var(--khata-text)] hover:border-[var(--khata-accent)]'
          }`}
        >
          Fixed (₹)
        </button>
      </div>

      {discountType && (
        <div className="pt-1 flex flex-wrap items-center gap-2">
          <input
            type="number"
            step="0.01"
            min="0"
            max={discountType === 'percentage' ? '100' : undefined}
            inputMode="decimal"
            aria-label={discountType === 'percentage' ? 'Discount percentage value' : 'Discount fixed amount'}
            value={discountValue}
            onChange={(e) => onChangeValue(e.target.value)}
            placeholder={discountType === 'percentage' ? 'e.g. 10' : 'e.g. 500'}
            className="neu-input text-xs w-36 py-1.5 font-bold"
          />
          <span className="text-[11px] text-[var(--khata-text-muted)]">
            {discountType === 'percentage' ? '% off subtotal (max 100%)' : '₹ flat off subtotal'}
          </span>
        </div>
      )}
    </div>
  );
};
