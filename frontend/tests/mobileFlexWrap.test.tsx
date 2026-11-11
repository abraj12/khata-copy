// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Navbar } from '../src/components/Navbar.js';
import { NotificationCenterButton } from '../src/components/NotificationCenterButton.js';
import { PdfDocumentPreviewModal } from '../src/components/PdfDocumentPreviewModal.js';
import { CustomerPickerDropdown } from '../src/features/bills/BillingCataloguePickers.js';
import { AuthProvider } from '../src/features/auth/AuthProvider.js';
import { authApi } from '../src/features/auth/authApi.js';
import { ThemeAccessibilityProvider } from '../src/context/ThemeAccessibilityContext.js';
import * as appDataApi from '../src/lib/appDataApi.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function hasFlexWrap(el: Element | null | undefined): boolean {
  if (!el) return false;
  return el.classList.contains('flex-wrap');
}

describe('Mobile responsiveness: flex-wrap containers and bounded popovers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('1. Navbar uses flex-wrap across its header bar, brand badge, main nav tabs, and utility controls', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { phone: '9876543210', role: 'OWNER' },
      csrfToken: 'csrf-mobile-test',
    } as any);
    vi.spyOn(appDataApi, 'fetchNotificationsApi').mockResolvedValue({
      success: true,
      notifications: [],
      unreadCount: 0,
      source: 'default',
    });

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <Navbar
              currentTab="home"
              onTabChange={() => {}}
              onOpenAppearance={() => {}}
            />
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const header = container.querySelector('header');
    expect(header).not.toBeNull();

    const mainNav = container.querySelector('nav[aria-label="Main Navigation"]');
    expect(hasFlexWrap(mainNav)).toBe(true);

    const headerRow = header?.querySelector('div.max-w-7xl > div');
    expect(hasFlexWrap(headerRow)).toBe(true);
    expect(headerRow?.className).not.toContain('sm:h-16');

    const brandBadge = headerRow?.children[0] ?? null;
    expect(hasFlexWrap(brandBadge)).toBe(true);

    const utilityControls = headerRow?.querySelector('div.order-2');
    expect(hasFlexWrap(utilityControls)).toBe(true);

    const billTrigger = Array.from(mainNav?.querySelectorAll('button') ?? []).find((btn) =>
      btn.textContent?.includes('Bill')
    ) as HTMLButtonElement | undefined;
    expect(billTrigger).toBeDefined();

    await act(async () => {
      billTrigger?.click();
    });

    const billMenu = container.querySelector('[role="menu"]');
    expect(billMenu).not.toBeNull();
    expect(billMenu?.className).toContain('right-0');
    expect(billMenu?.className).toContain('w-[min(13rem,calc(100vw-1.5rem))]');
    expect(billMenu?.className).not.toContain('left-0');
  });

  it('2. NotificationCenterButton constrains popover width to the mobile viewport and wraps header and alert rows', async () => {
    vi.spyOn(appDataApi, 'fetchNotificationsApi').mockResolvedValue({
      success: true,
      unreadCount: 1,
      source: 'mongodb',
      notifications: [
        {
          id: 'notif-1',
          category: 'quotation_expiry',
          severity: 'warning',
          title: 'Quotation Q-1024 expiring soon for Shri Ganesh Hardware Enterprises',
          message: 'Follow up with customer before validity expires tomorrow morning.',
          entityType: 'quotation',
          entityId: 'q-1024',
          isRead: false,
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await act(async () => {
      root.render(<NotificationCenterButton />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const trigger = container.querySelector('button[title="Notifications"]') as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const dialog = container.querySelector('[role="dialog"][aria-label="Business notifications"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.className).toContain('w-[min(24rem,calc(100vw-1.5rem))]');
    expect(dialog?.className).toContain('max-w-[calc(100vw-1.5rem)]');
    expect(dialog?.className).not.toContain('w-80');
    expect(dialog?.className).not.toContain('sm:w-96');

    const popoverHeader = dialog?.firstElementChild ?? null;
    expect(hasFlexWrap(popoverHeader)).toBe(true);
    expect(hasFlexWrap(popoverHeader?.querySelector('div.flex'))).toBe(true);

    const alertList = dialog?.children[1];
    const alertItem = alertList?.firstElementChild ?? null;
    expect(hasFlexWrap(alertItem)).toBe(true);

    const itemContent = alertItem?.querySelector('div.min-w-0');
    expect(itemContent).not.toBeNull();
    expect(hasFlexWrap(itemContent?.firstElementChild)).toBe(true);
    expect(hasFlexWrap(itemContent?.lastElementChild)).toBe(true);
  });

  it('3. PdfDocumentPreviewModal renders top toolbar, title bar, action controls, and error actions with flex-wrap', async () => {
    const fetchPdfBlob = vi.fn(async () => {
      throw new Error('Preview fetch intentionally stopped for layout check');
    });

    await act(async () => {
      root.render(
        <PdfDocumentPreviewModal
          isOpen={true}
          title="Invoice INV-2026-0099 Mobile Width Verification Title"
          subtitle="A4 Tax Document"
          fileName="inv-2026-0099.pdf"
          documentLabel="Invoice"
          headerBadge={<span>GST</span>}
          fetchPdfBlob={fetchPdfBlob}
          onClose={() => {}}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const dialog = container.querySelector('[role="dialog"][aria-label*="Invoice INV-2026-0099"]');
    expect(dialog).not.toBeNull();

    const topToolbar = dialog?.firstElementChild ?? null;
    expect(hasFlexWrap(topToolbar)).toBe(true);

    const titleSection = topToolbar?.children[0] ?? null;
    const controlsSection = topToolbar?.children[1] ?? null;
    expect(hasFlexWrap(titleSection)).toBe(true);
    expect(hasFlexWrap(controlsSection)).toBe(true);

    const titleBadgeRow = dialog?.querySelector('h3')?.parentElement ?? null;
    expect(hasFlexWrap(titleBadgeRow)).toBe(true);

    const retryButton = Array.from(dialog?.querySelectorAll('button') ?? []).find((btn) =>
      btn.textContent?.includes('Retry')
    );
    expect(retryButton).toBeDefined();
    expect(hasFlexWrap(retryButton?.parentElement)).toBe(true);
  });

  it('4. CustomerPickerDropdown aligns full-width inside mobile section header without off-screen left overflow', async () => {
    await act(async () => {
      root.render(
        <div className="relative">
          <CustomerPickerDropdown
            customers={[
              {
                id: 1,
                name: 'Shri Balaji Timber & Plywood Emporium',
                phone: '9876543210',
                address: 'Plot 14, Industrial Area Phase 2',
              },
            ]}
            search=""
            onSearchChange={() => {}}
            isLoading={false}
            isLoadingMore={false}
            error={null}
            hasMore={false}
            onLoadMore={() => {}}
            onSelectCustomer={() => {}}
          />
        </div>
      );
    });

    const picker = container.querySelector('div.relative > div.absolute');
    expect(picker).not.toBeNull();
    expect(picker?.className).toContain('left-0');
    expect(picker?.className).toContain('right-0');
    expect(picker?.className).toContain('sm:w-72');

    const optionBtn = picker?.querySelector('button');
    expect(hasFlexWrap(optionBtn)).toBe(true);
  });
});
