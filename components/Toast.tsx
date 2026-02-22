import React, { useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  warning: '⚠',
  info:    'ℹ',
};

const STYLES: Record<ToastType, string> = {
  success: 'border-green-500 bg-[#0d1f10] text-green-400',
  error:   'border-red-500   bg-[#1f0d0d] text-red-400',
  warning: 'border-amber-500 bg-[#1f1a0d] text-amber-400',
  info:    'border-cyan-500  bg-[#0d1a1f] text-cyan-400',
};

const ICON_STYLES: Record<ToastType, string> = {
  success: 'text-green-400',
  error:   'text-red-400',
  warning: 'text-amber-400',
  info:    'text-cyan-400',
};

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

const ToastItem: React.FC<{ toast: ToastItem; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 5000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded border font-mono text-sm min-w-[320px] max-w-[480px] shadow-2xl ${STYLES[toast.type]}`}
      style={{ animation: 'slideInRight 0.2s ease-out' }}
    >
      <span className={`text-base font-bold shrink-0 mt-0.5 ${ICON_STYLES[toast.type]}`}>
        {ICONS[toast.type]}
      </span>
      <span className="flex-1 leading-relaxed text-slate-200">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors ml-1"
      >
        ✕
      </button>
    </div>
  );
};
