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
import { computeClampedPopoverGeometry } from '../src/utils/useViewportPopover.js';
import App from '../src/App.js';

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

  it('5. computeClampedPopoverGeometry keeps Notification & Bill popovers strictly within 280px–1280px viewports', () => {
    // 280px extreme mobile width where Bell button is left/mid-bar (right edge at 180px)
    const ultraNarrowBell = computeClampedPopoverGeometry(
      { left: 140, right: 180, bottom: 52, width: 40, height: 38 },
      384,
      280,
      640,
      8
    );
    expect(ultraNarrowBell).not.toBeNull();
    expect(ultraNarrowBell!.left).toBe(12);
    expect(ultraNarrowBell!.width).toBe(256); // 280 - 24
    expect(ultraNarrowBell!.left + ultraNarrowBell!.width).toBeLessThanOrEqual(280 - 12);

    // 360px phone where Bill button is in column 1 (right edge at 110px)
    const col1Bill = computeClampedPopoverGeometry(
      { left: 12, right: 110, bottom: 102, width: 98, height: 40 },
      208,
      360,
      740,
      6
    );
    expect(col1Bill).not.toBeNull();
    expect(col1Bill!.left).toBe(12);
    expect(col1Bill!.width).toBe(208);
    expect(col1Bill!.left + col1Bill!.width).toBeLessThanOrEqual(360 - 12);
    expect(col1Bill!.top).toBe(108);

    // 1280px desktop where Bell button sits at right: 1180
    const desktopBell = computeClampedPopoverGeometry(
      { left: 1140, right: 1180, bottom: 56, width: 40, height: 40 },
      384,
      1280,
      800,
      8
    );
    expect(desktopBell).not.toBeNull();
    expect(desktopBell!.left).toBe(1180 - 384);
    expect(desktopBell!.width).toBe(384);
  });

  it('6. Navbar Bill dropdown and NotificationCenterButton clamp to 360px mobile viewport and dismiss each other', async () => {
    const origInnerWidth = window.innerWidth;
    const origInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });

    try {
      vi.spyOn(authApi, 'me').mockResolvedValue({
        authenticated: true,
        owner: { phone: '9876543210', role: 'OWNER' },
        csrfToken: 'csrf-popover-test',
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
              <Navbar currentTab="home" onTabChange={() => {}} onOpenAppearance={() => {}} />
            </AuthProvider>
          </ThemeAccessibilityProvider>
        );
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const bellBtn = container.querySelector('button[title="Notifications"]') as HTMLButtonElement;
      const billBtn = Array.from(container.querySelectorAll('nav button')).find((b) =>
        b.textContent?.includes('Bill')
      ) as HTMLButtonElement;
      expect(bellBtn).toBeDefined();
      expect(billBtn).toBeDefined();

      // Simulate mobile placement where Bell sits left-of-Logout (~right: 240px)
      bellBtn.getBoundingClientRect = () =>
        ({ left: 200, right: 240, top: 12, bottom: 50, width: 40, height: 38, x: 200, y: 12, toJSON: () => ({}) }) as DOMRect;
      // Simulate wrapped col-1 placement for Bill button (~right: 112px)
      billBtn.getBoundingClientRect = () =>
        ({ left: 12, right: 112, top: 64, bottom: 104, width: 100, height: 40, x: 12, y: 64, toJSON: () => ({}) }) as DOMRect;

      // Open Notification popover first
      await act(async () => {
        bellBtn.click();
      });
      await act(async () => {
        await Promise.resolve();
      });

      const notifDialog = container.querySelector('[role="dialog"][aria-label="Business notifications"]') as HTMLElement | null;
      expect(notifDialog).not.toBeNull();
      expect(notifDialog!.style.position).toBe('fixed');
      expect(notifDialog!.style.left).toBe('12px');
      expect(notifDialog!.style.width).toBe('336px');

      // Now open Bill dropdown — should automatically close Notifications popover and clamp inside viewport
      await act(async () => {
        billBtn.click();
      });
      expect(container.querySelector('[role="dialog"][aria-label="Business notifications"]')).toBeNull();
      const billMenu = container.querySelector('[role="menu"]') as HTMLElement | null;
      expect(billMenu).not.toBeNull();
      expect(billMenu!.style.position).toBe('fixed');
      expect(billMenu!.style.left).toBe('12px');
      expect(billMenu!.style.width).toBe('208px');
      expect(billMenu!.style.top).toBe('110px');

      // Opening Notifications again closes Bill menu
      await act(async () => {
        bellBtn.click();
      });
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(container.querySelector('[role="dialog"][aria-label="Business notifications"]')).not.toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: origInnerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: origInnerHeight });
    }
  });

  it('7. App keeps Navbar sticky at top-0 and Footer sticky at bottom-0 while scrolling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, expenses: [], pagination: { total: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    try {
      vi.spyOn(authApi, 'me').mockResolvedValue({
        authenticated: true,
        owner: { phone: '9876543210', role: 'OWNER' },
        csrfToken: 'csrf-sticky-test',
      } as any);
      vi.spyOn(appDataApi, 'fetchNotificationsApi').mockResolvedValue({
        success: true,
        notifications: [],
        unreadCount: 0,
        source: 'default',
      });
      vi.spyOn(appDataApi, 'fetchPreferencesApi').mockResolvedValue({
        success: true,
        source: 'default',
        preferences: {
          preferenceKey: 'owner',
          theme: {},
          dashboardDefaults: { defaultDatePreset: 'all_time' },
          printPreferences: { defaultPaperSize: 'A4', autoOpenPreview: true },
          updatedAt: null,
        },
      });

      await act(async () => {
        root.render(<App />);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const header = container.querySelector('header');
      expect(header).not.toBeNull();
      const stickyWrapper = header?.parentElement;
      expect(stickyWrapper?.className).toContain('sticky');
      expect(stickyWrapper?.className).toContain('top-0');
      expect(stickyWrapper?.className).toContain('mhi-no-print');

      const footer = container.querySelector('footer');
      expect(footer).not.toBeNull();
      expect(footer?.className).toContain('sticky');
      expect(footer?.className).toContain('bottom-0');
      expect(footer?.className).toContain('z-10');
      expect(footer?.className).toContain('mhi-no-print');
      expect(footer?.className).toContain('print:hidden');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('8. Navbar hides main nav behind a mobile-only Menu toggle on phone viewports while remaining always visible on md+ desktop', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { phone: '9876543210', role: 'OWNER' },
      csrfToken: 'csrf-mobile-hider',
    } as any);
    vi.spyOn(appDataApi, 'fetchNotificationsApi').mockResolvedValue({
      success: true,
      notifications: [],
      unreadCount: 0,
      source: 'default',
    });

    const onTabChange = vi.fn();

    await act(async () => {
      root.render(
        <ThemeAccessibilityProvider>
          <AuthProvider>
            <Navbar
              currentTab="products"
              onTabChange={onTabChange}
              onOpenAppearance={() => {}}
            />
          </AuthProvider>
        </ThemeAccessibilityProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const mainNav = container.querySelector('nav[aria-label="Main Navigation"]') as HTMLElement;
    const toggleBtn = container.querySelector('button[aria-controls="main-navigation-menu"]') as HTMLButtonElement;
    const activeBadge = container.querySelector('[data-testid="mobile-active-tab-badge"]') as HTMLElement;
    const bellBtn = container.querySelector('button[title="Notifications"]') as HTMLButtonElement;

    expect(mainNav).not.toBeNull();
    expect(toggleBtn).not.toBeNull();
    expect(activeBadge?.textContent?.trim()).toBe('Products');
    expect(activeBadge?.className).toContain('md:hidden');

    // Collapsed on phone by default, always flex on md+ desktop; toggle only shows below md
    expect(toggleBtn.className).toContain('md:hidden');
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(toggleBtn.textContent).toContain('Menu');
    expect(mainNav.classList.contains('hidden')).toBe(true);
    expect(mainNav.classList.contains('md:flex')).toBe(true);

    // Open Notification popover first, then opening mobile Menu should close Notification popover
    await act(async () => {
      bellBtn.click();
    });
    expect(container.querySelector('[role="dialog"][aria-label="Business notifications"]')).not.toBeNull();

    await act(async () => {
      toggleBtn.click();
    });
    expect(container.querySelector('[role="dialog"][aria-label="Business notifications"]')).toBeNull();
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(toggleBtn.textContent).toContain('Close');
    expect(mainNav.classList.contains('hidden')).toBe(false);
    expect(mainNav.classList.contains('flex')).toBe(true);

    // Clicking Bill dropdown inside open mobile nav keeps mobile nav open so GST/Normal Bill can be picked
    const billTrigger = Array.from(mainNav.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Bill')
    ) as HTMLButtonElement;
    await act(async () => {
      billTrigger.click();
    });
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');

    // Selecting GST Bill from submenu switches tab and collapses both Bill dropdown and mobile nav
    const gstOption = Array.from(container.querySelectorAll('[role="menuitem"]')).find((b) =>
      b.textContent?.includes('GST Bill')
    ) as HTMLButtonElement;
    await act(async () => {
      gstOption.click();
    });
    expect(onTabChange).toHaveBeenCalledWith('gst-bill');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(mainNav.classList.contains('hidden')).toBe(true);

    // Re-open mobile nav, then pressing Escape collapses it
    await act(async () => {
      toggleBtn.click();
    });
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(mainNav.classList.contains('hidden')).toBe(true);

    // Re-open mobile nav, then clicking Khata tab switches tab and collapses mobile nav
    await act(async () => {
      toggleBtn.click();
    });
    const khataBtn = Array.from(mainNav.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Khata'
    ) as HTMLButtonElement;
    await act(async () => {
      khataBtn.click();
    });
    expect(onTabChange).toHaveBeenCalledWith('khata');
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(mainNav.classList.contains('hidden')).toBe(true);

    // Re-open mobile nav, then opening Notifications collapses mobile nav
    await act(async () => {
      toggleBtn.click();
    });
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      bellBtn.click();
    });
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(mainNav.classList.contains('hidden')).toBe(true);
  });

  it('9. Navbar maintains symmetric 2x3 mobile grid, aligned 2-tier md/lg and single-row xl layout, and @layer components button sizing', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const candidateInWorkspace = path.resolve(process.cwd(), 'src', 'index.css');
    const candidateFromRoot = path.resolve(process.cwd(), 'frontend', 'src', 'index.css');
    const cssPath = fs.existsSync(candidateInWorkspace) ? candidateInWorkspace : candidateFromRoot;
    const cssText = fs.readFileSync(cssPath, 'utf-8');
    const layerIdx = cssText.indexOf('@layer components');
    const neuSecondaryIdx = cssText.indexOf('.neu-btn-secondary');
    expect(layerIdx).toBeGreaterThan(-1);
    expect(neuSecondaryIdx).toBeGreaterThan(layerIdx);

    vi.spyOn(authApi, 'me').mockResolvedValue({
      authenticated: true,
      owner: { phone: '9876543210', role: 'OWNER' },
      csrfToken: 'csrf-alignment-test',
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
      await Promise.resolve();
    });

    const headerRow = container.querySelector('header div.max-w-7xl > div') as HTMLElement;
    const utilityControls = headerRow?.querySelector('div.order-2') as HTMLElement;
    const mainNav = container.querySelector('nav[aria-label="Main Navigation"]') as HTMLElement;

    // Desktop xl single-row ordering + md/lg centered 2-tier alignment
    expect(headerRow.className).toContain('xl:flex-nowrap');
    expect(utilityControls.className).toContain('xl:order-3');
    expect(mainNav.className).toContain('order-3');
    expect(mainNav.className).toContain('xl:order-2');
    expect(mainNav.className).toContain('xl:w-auto');

    // Symmetrical 2-column portrait mobile grid -> 3-column sm grid -> auto inline md+
    const navItems = Array.from(mainNav.children) as HTMLElement[];
    expect(navItems).toHaveLength(6);
    for (const item of navItems) {
      expect(item.className).toContain('basis-[calc(50%-0.25rem)]');
      expect(item.className).toContain('sm:basis-[calc(33.333%-0.375rem)]');
      expect(item.className).toContain('md:basis-auto');
      expect(item.className).toContain('min-w-0');
    }

    // All top header utility buttons share consistent mobile height alignment
    const utilityButtons = Array.from(utilityControls.querySelectorAll('button')) as HTMLButtonElement[];
    expect(utilityButtons.length).toBe(4);
    for (const btn of utilityButtons) {
      expect(btn.className).toContain('min-h-[38px]');
    }
  });
});
