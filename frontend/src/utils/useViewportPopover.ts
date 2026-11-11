import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const POPOVER_OPEN_EVENT = 'khata:popover-open';
const VIEWPORT_MARGIN_PX = 12;

export interface PopoverGeometry {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * Compute viewport-safe fixed coordinates for a dropdown/popover anchored to a trigger button.
 * Returns null when layout geometry is unavailable (e.g. non-visual test environments).
 */
export function computeClampedPopoverGeometry(
  triggerRect: Pick<DOMRect, 'left' | 'right' | 'bottom' | 'width' | 'height'>,
  preferredWidthPx: number,
  viewportWidth: number,
  viewportHeight: number,
  offsetY = 8
): PopoverGeometry | null {
  if (triggerRect.width <= 0 && triggerRect.height <= 0) {
    return null;
  }

  const safeViewportW = Math.max(240, viewportWidth);
  const safeViewportH = Math.max(240, viewportHeight);
  const maxAllowedWidth = Math.max(180, safeViewportW - VIEWPORT_MARGIN_PX * 2);
  const width = Math.round(Math.min(preferredWidthPx, maxAllowedWidth));

  // Default right-aligned to the trigger button, then clamp within horizontal viewport margins.
  const desiredLeft = triggerRect.right - width;
  const maxLeft = Math.max(VIEWPORT_MARGIN_PX, safeViewportW - width - VIEWPORT_MARGIN_PX);
  const left = Math.round(Math.max(VIEWPORT_MARGIN_PX, Math.min(desiredLeft, maxLeft)));

  const maxTop = Math.max(VIEWPORT_MARGIN_PX, safeViewportH - 160);
  const top = Math.round(Math.min(Math.max(VIEWPORT_MARGIN_PX, triggerRect.bottom + offsetY), maxTop));
  const maxHeight = Math.round(Math.max(140, safeViewportH - top - VIEWPORT_MARGIN_PX));

  return { top, left, width, maxHeight };
}

export function broadcastCloseOtherPopovers(activeId = '__dismiss_all__'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(POPOVER_OPEN_EVENT, { detail: { id: activeId } }));
}

interface UseViewportPopoverOptions {
  isOpen: boolean;
  onClose: () => void;
  preferredWidthPx: number;
  offsetY?: number;
}

export function useViewportPopover({
  isOpen,
  onClose,
  preferredWidthPx,
  offsetY = 8,
}: UseViewportPopoverOptions) {
  const popoverId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [geometry, setGeometry] = useState<PopoverGeometry | null>(null);

  const updateGeometry = useCallback(() => {
    if (typeof window === 'undefined' || !triggerRef.current) {
      setGeometry(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    setGeometry(
      computeClampedPopoverGeometry(
        rect,
        preferredWidthPx,
        window.innerWidth,
        window.innerHeight,
        offsetY
      )
    );
  }, [offsetY, preferredWidthPx]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setGeometry(null);
      return;
    }
    broadcastCloseOtherPopovers(popoverId);
    updateGeometry();
  }, [isOpen, popoverId, updateGeometry]);

  useEffect(() => {
    const handleOtherPopoverOpen = (event: Event) => {
      const customEvent = event as CustomEvent<{ id?: string }>;
      if (customEvent.detail?.id !== popoverId && isOpen) {
        onClose();
      }
    };

    window.addEventListener(POPOVER_OPEN_EVENT, handleOtherPopoverOpen);
    return () => {
      window.removeEventListener(POPOVER_OPEN_EVENT, handleOtherPopoverOpen);
    };
  }, [isOpen, onClose, popoverId]);

  useEffect(() => {
    if (!isOpen) return;

    const handleOutsidePress = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (containerRef.current && target && !containerRef.current.contains(target)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    const handleViewportChange = () => {
      updateGeometry();
    };

    document.addEventListener('mousedown', handleOutsidePress);
    document.addEventListener('touchstart', handleOutsidePress, { passive: true });
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.addEventListener('scroll', handleViewportChange, { passive: true, capture: true });

    return () => {
      document.removeEventListener('mousedown', handleOutsidePress);
      document.removeEventListener('touchstart', handleOutsidePress);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isOpen, onClose, updateGeometry]);

  const popoverStyle: CSSProperties = geometry
    ? {
        position: 'fixed',
        top: `${geometry.top}px`,
        left: `${geometry.left}px`,
        right: 'auto',
        width: `${geometry.width}px`,
        maxHeight: `${geometry.maxHeight}px`,
        marginTop: '0px',
      }
    : {};

  return {
    containerRef,
    triggerRef,
    popoverStyle,
    geometry,
  };
}
